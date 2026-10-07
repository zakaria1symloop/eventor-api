import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { AvailabilityKind } from '../common/enums/catalog.enums.js';
import { UserRole } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { runInTransaction } from '../database/transaction.js';
import { User } from '../users/entities/user.entity.js';
import { algiersToday, dateOnly } from '../users/users.service.js';
import type { AvailabilityBlockDto, AvailabilityDayDto, AvailabilityMonthDto, CreateAvailabilityBlockDto } from './dto/availability.dto.js';
import { AvailabilityBlock } from './entities/availability-block.entity.js';
import { Service } from './entities/service.entity.js';

const hhmm = (value: string | null): string | null => (value ? String(value).slice(0, 5) : null);

/** Day status for the month grid: booked > held > blocked (whole day, all services) > partial > free. */
export function dayStatus(items: Pick<AvailabilityBlockDto, 'kind' | 'startTime' | 'service'>[]): AvailabilityDayDto['status'] {
  if (items.some((i) => i.kind === AvailabilityKind.Booked)) return 'booked';
  if (items.some((i) => i.kind === AvailabilityKind.Held)) return 'held';
  if (items.some((i) => i.kind === AvailabilityKind.Blocked && !i.startTime && !i.service)) return 'blocked';
  return items.length > 0 ? 'partial' : 'free';
}

/** SRV-04 Availability tab: month grid, manual blocks. */
@Injectable()
export class AvailabilityService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  private async provider(em: EntityManager, id: string): Promise<User> {
    const user = await em.getRepository(User).findOne({ where: { id } });
    if (!user) throw AppException.of('USER_NOT_FOUND');
    if (user.role !== UserRole.Provider) throw AppException.of('NOT_A_PROVIDER');
    return user;
  }

  async month(providerId: string, month: string): Promise<AvailabilityMonthDto> {
    const em = this.dataSource.manager;
    await this.provider(em, providerId);
    const [year, mon] = month.split('-').map(Number) as [number, number];
    const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const first = `${month}-01`;
    const last = `${month}-${String(daysInMonth).padStart(2, '0')}`;

    const [blocks, bookings, [capacity]] = await Promise.all([
      em.query(
        `SELECT ab.id, ab.kind, ab.date, ab.start_time, ab.end_time, ab.note, s.id AS service_id, s.title_en, s.title_ar,
                b.id AS booking_id, b.reference, b.status AS booking_status, cu.full_name AS client_name
         FROM availability_blocks ab
         LEFT JOIN services s ON s.id = ab.service_id
         LEFT JOIN bookings b ON b.id = ab.booking_id
         LEFT JOIN users cu ON cu.id = b.client_id
         WHERE ab.provider_id = ? AND ab.date BETWEEN ? AND ? AND ab.deleted_at IS NULL
         ORDER BY ab.date, ab.start_time, ab.created_at`,
        [providerId, first, last],
      ),
      // Bookings without an availability row (created before the booking module writes them).
      em.query(
        `SELECT b.id, b.reference, b.status, b.event_date, b.start_time, b.end_time, s.id AS service_id, s.title_en, s.title_ar, cu.full_name AS client_name
         FROM bookings b LEFT JOIN services s ON s.id = b.service_id JOIN users cu ON cu.id = b.client_id
         WHERE b.provider_id = ? AND b.event_date BETWEEN ? AND ? AND b.status IN ('pending', 'accepted') AND b.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM availability_blocks ab WHERE ab.booking_id = b.id AND ab.deleted_at IS NULL)
         ORDER BY b.event_date, b.start_time`,
        [providerId, first, last],
      ),
      // 255 stands for "no daily limit" inside MAX, then becomes null.
      em.query('SELECT MAX(COALESCE(max_events_per_day, 255)) AS n, COUNT(*) AS services FROM services WHERE provider_id = ? AND deleted_at IS NULL', [providerId]),
    ]);

    const byDay = new Map<string, AvailabilityBlockDto[]>();
    const push = (date: string, item: AvailabilityBlockDto) => byDay.set(date, [...(byDay.get(date) ?? []), item]);
    for (const b of blocks) {
      const date = dateOnly(b.date);
      push(date, {
        id: b.id,
        kind: b.kind,
        date,
        startTime: hhmm(b.start_time),
        endTime: hhmm(b.end_time),
        service: b.service_id ? { id: b.service_id, titleEn: b.title_en, titleAr: b.title_ar } : null,
        booking: b.booking_id ? { id: b.booking_id, reference: b.reference, status: b.booking_status, clientName: b.client_name ?? null } : null,
        note: b.note,
        removable: b.kind === AvailabilityKind.Blocked,
      });
    }
    for (const b of bookings) {
      const date = dateOnly(b.event_date);
      push(date, {
        id: null,
        kind: b.status === 'accepted' ? AvailabilityKind.Booked : AvailabilityKind.Held,
        date,
        startTime: hhmm(b.start_time),
        endTime: hhmm(b.end_time),
        service: b.service_id ? { id: b.service_id, titleEn: b.title_en, titleAr: b.title_ar } : null,
        booking: { id: b.id, reference: b.reference, status: b.status, clientName: b.client_name ?? null },
        note: null,
        removable: false,
      });
    }

    const days: AvailabilityDayDto[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${month}-${String(day).padStart(2, '0')}`;
      const items = byDay.get(date) ?? [];
      days.push({ date, status: dayStatus(items), items });
    }
    const highest = Number(capacity.services) === 0 ? 1 : Number(capacity.n);
    return { providerId, month, maxEventsPerDay: highest === 255 ? null : highest, days };
  }

  async createBlock(auth: AuthUser, providerId: string, dto: CreateAvailabilityBlockDto): Promise<AvailabilityBlockDto> {
    if ((dto.startTime === undefined) !== (dto.endTime === undefined)) {
      const field = dto.startTime === undefined ? 'startTime' : 'endTime';
      throw new AppException(400, 'VALIDATION_FAILED', [{ field, code: 'REQUIRED', message: 'startTime and endTime go together' }]);
    }
    if (dto.startTime && dto.endTime && dto.endTime <= dto.startTime) {
      throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'endTime', code: 'AFTER_START', message: 'endTime must be after startTime' }]);
    }
    return runInTransaction(this.dataSource, async (em) => {
      const provider = await this.provider(em, providerId);
      if (dto.date < algiersToday()) throw AppException.of('AVAILABILITY_DATE_PAST', { date: dto.date });
      let service: Service | null = null;
      if (dto.serviceId) {
        service = await em.getRepository(Service).findOne({ where: { id: dto.serviceId } });
        if (!service || service.providerId !== providerId) throw AppException.of('AVAILABILITY_SERVICE_INVALID', { serviceId: dto.serviceId });
      }
      const repository = em.getRepository(AvailabilityBlock);
      const block = await repository.save(
        repository.create({
          providerId,
          serviceId: service?.id ?? null,
          date: dto.date,
          startTime: dto.startTime ? `${dto.startTime}:00` : null,
          endTime: dto.endTime ? `${dto.endTime}:00` : null,
          kind: AvailabilityKind.Blocked,
          bookingId: null,
          note: dto.note ?? null,
        }),
      );
      await this.audit.log(
        {
          action: 'availability.blocked',
          objectType: 'availability_block',
          objectId: block.id,
          objectLabel: `${provider.fullName} · ${dto.date}`,
          level: AuditLevel.Normal,
          changes: { providerId, date: dto.date, startTime: dto.startTime ?? null, endTime: dto.endTime ?? null, serviceId: service?.id ?? null },
          note: dto.note ?? null,
        },
        em,
      );
      return {
        id: block.id,
        kind: block.kind,
        date: dto.date,
        startTime: dto.startTime ?? null,
        endTime: dto.endTime ?? null,
        service: service ? { id: service.id, titleEn: service.titleEn, titleAr: service.titleAr } : null,
        booking: null,
        note: block.note,
        removable: true,
      };
    });
  }

  async removeBlock(auth: AuthUser, id: string): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const block = await em.getRepository(AvailabilityBlock).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!block) throw AppException.of('AVAILABILITY_BLOCK_NOT_FOUND');
      if (block.kind !== AvailabilityKind.Blocked) throw AppException.of('AVAILABILITY_BLOCK_NOT_REMOVABLE', { kind: block.kind });
      await em.getRepository(AvailabilityBlock).softDelete(id);
      await this.audit.log(
        {
          action: 'availability.unblocked',
          objectType: 'availability_block',
          objectId: id,
          objectLabel: dateOnly(block.date),
          level: AuditLevel.Normal,
          changes: { providerId: block.providerId, date: dateOnly(block.date), serviceId: block.serviceId },
        },
        em,
      );
    });
  }
}
