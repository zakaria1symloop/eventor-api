import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { likeContains } from '../common/dto/transforms.js';
import { AuditLevel, AuditSource } from '../common/enums/admin.enums.js';
import {
  BookingDisputeStatus,
  BookingLineKind,
  BookingSource,
  BookingStatus,
  RescheduleStatus,
} from '../common/enums/booking.enums.js';
import {
  AvailabilityKind,
  type PriceType,
} from '../common/enums/catalog.enums.js';
import { FileVariantKind } from '../common/enums/file.enums.js';
import { MessageKind } from '../common/enums/messaging.enums.js';
import { PartyRole, UserRole } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import {
  paginateWithCounts,
  type Paginated,
} from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import {
  MessagingService,
  SUPPORT_LABEL,
  SYSTEM_LABEL,
} from '../messaging/messaging.service.js';
import { PACK_VISIBLE_SQL } from '../packs/packs.policy.js';
import { SERVICE_VISIBLE_SQL } from '../services/services.policy.js';
import { SequencesService } from '../sequences/sequences.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  BOOKING_EVENTS,
  type BookingCancelledEvent,
  type BookingEvent,
  type BookingPriceChangedEvent,
  type BookingReminderEvent,
  type BookingRescheduledEvent,
  type BookingStatusChangedEvent,
} from './bookings.events.js';
import {
  addDays,
  allowedTransitions,
  assertEventTimes,
  canTransition,
  computeFee,
  computeLines,
  computeTotals,
  fromCents,
  isEditable,
  packLines,
  reminderRetryAfter,
  REMINDER_INTERVAL_HOURS,
  checkInOutcome,
  checkInRefusal,
  serviceQuantity,
  targetStatus,
  timeSpan,
  toCents,
  type LineInput,
  type StatusAction,
} from './bookings.policy.js';
import {
  BOOKING_SORT_FIELDS,
  type BookingDetailDto,
  type BookingFiltersDto,
  type BookingRowDto,
  type BookingsQueryDto,
  type BookingTabCountsDto,
  type BookingTimelineEntryDto,
  type ChangePriceDto,
  type ChangeStatusDto,
  type CreateBookingDto,
  type RemindResultDto,
  type RescheduleBookingDto,
  type RescheduleDto,
  type UpdateBookingDto,
} from './dto/bookings.dto.js';
import { BookingLine } from './entities/booking-line.entity.js';
import { BookingReschedule } from './entities/booking-reschedule.entity.js';
import { Booking } from './entities/booking.entity.js';
import { InvoicesService } from './invoices.service.js';

const HOUR = 3_600_000;
export const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;
export const dateOnly = (value: Date | string): string =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
const hhmm = (value: string | null | undefined): string | null =>
  value ? String(value).slice(0, 5) : null;
const toTime = (value: string | null | undefined): string | null =>
  value ? `${value.slice(0, 5)}:00` : null;

/** Today in Africa/Algiers (event dates are local dates). */
export function algiersToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Algiers',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export const REFERENCE_PATTERN = /^#?EVT-\d{1,8}$/i;

const SORT_COLUMNS: Record<(typeof BOOKING_SORT_FIELDS)[number], string> = {
  eventDate: 'b.event_date',
  createdAt: 'b.created_at',
  total: 'b.total',
};

const FROM = `FROM bookings b
  JOIN users cu ON cu.id = b.client_id
  JOIN users pu ON pu.id = b.provider_id
  LEFT JOIN provider_profiles pp ON pp.user_id = b.provider_id AND pp.deleted_at IS NULL
  LEFT JOIN services s ON s.id = b.service_id
  LEFT JOIN packs pk ON pk.id = b.pack_id
  LEFT JOIN wilayas w ON w.code = b.wilaya_code`;

/**
 * FROM for counters: the joins above are each at most one row per booking (inner joins
 * follow NOT NULL foreign keys), so counts only need them when a filter reads them.
 */
const COUNT_FROM = 'FROM bookings b';
const needsJoins = (filters: BookingFiltersDto) => Boolean(filters.categoryId);

export type BookingOwnerColumn =
  'service_id' | 'pack_id' | 'client_id' | 'provider_id';

export interface TransitionOptions {
  actorId: string | null;
  reason: string | null;
  note: string | null;
  notify: boolean;
  cancelledBy?: PartyRole;
  /** Party whose account action caused a cancellation (not notified). */
  causedByUserId?: string | null;
  /** Skip the availability re-check on accept (jobs never accept). */
  source?: AuditSource;
  auditAction?: string;
}

/** BKG-01…BKG-07: bookings, their status machine, reschedules, price changes and reminders. */
@Injectable()
export class BookingsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly settings: SettingsService,
    private readonly sequences: SequencesService,
    private readonly files: FilesService,
    private readonly invoices: InvoicesService,
    private readonly messaging: MessagingService,
  ) {}

  private avatar(fileId: string | null | undefined): string | null {
    return fileId
      ? this.files.signedUrl(fileId, { variant: FileVariantKind.Thumb })
      : null;
  }

  // ── list ────────────────────────────────────────────────────

  private async where(
    filters: BookingFiltersDto,
    options: { tab: boolean },
  ): Promise<{ sql: string; params: unknown[] }> {
    const clauses = ['b.deleted_at IS NULL'];
    const params: unknown[] = [];
    const add = (sql: string, ...values: unknown[]) => {
      clauses.push(sql);
      params.push(...values);
    };
    if (options.tab && filters.tab && filters.tab !== 'all') {
      if (filters.tab === 'disputed') add("b.dispute_status = 'open'");
      else add('b.status = ?', filters.tab);
    }
    if (filters.noReply)
      add(
        "b.status = 'pending' AND b.created_at <= ?",
        await this.noReplyCutoff(),
      );
    if (filters.q) {
      if (REFERENCE_PATTERN.test(filters.q))
        add('b.reference = ?', filters.q.replace(/^#/, '').toUpperCase());
      else {
        const like = likeContains(filters.q);
        // Id subqueries rather than LIKE on the joined columns: each small table is scanned
        // once (materialised) instead of once per booking, and counters need no join.
        add(
          `(b.client_id IN (SELECT qcu.id FROM users qcu WHERE qcu.full_name LIKE ?)
            OR b.provider_id IN (SELECT qpu.id FROM users qpu WHERE qpu.full_name LIKE ?)
            OR b.provider_id IN (SELECT qpp.user_id FROM provider_profiles qpp WHERE qpp.deleted_at IS NULL AND qpp.business_name LIKE ?)
            OR b.service_id IN (SELECT qs.id FROM services qs WHERE qs.title_en LIKE ? OR qs.title_ar LIKE ?)
            OR b.pack_id IN (SELECT qpk.id FROM packs qpk WHERE qpk.name_en LIKE ? OR qpk.name_ar LIKE ?))`,
          like,
          like,
          like,
          like,
          like,
          like,
          like,
        );
      }
    }
    if (filters.clientId) add('b.client_id = ?', filters.clientId);
    if (filters.providerId) add('b.provider_id = ?', filters.providerId);
    if (filters.serviceId) add('b.service_id = ?', filters.serviceId);
    if (filters.packId) add('b.pack_id = ?', filters.packId);
    if (filters.academicRequestId)
      add('b.academic_request_id = ?', filters.academicRequestId);
    if (filters.categoryId) {
      add(
        '(s.category_id = ? OR EXISTS (SELECT 1 FROM pack_items fpi JOIN services fps ON fps.id = fpi.service_id WHERE fpi.pack_id = b.pack_id AND fps.category_id = ?))',
        filters.categoryId,
        filters.categoryId,
      );
    }
    if (filters.wilaya?.length) add('b.wilaya_code IN (?)', filters.wilaya);
    if (filters.eventDateFrom) add('b.event_date >= ?', filters.eventDateFrom);
    if (filters.eventDateTo) add('b.event_date <= ?', filters.eventDateTo);
    if (filters.createdFrom)
      add('b.created_at >= ?', new Date(`${filters.createdFrom}T00:00:00Z`));
    if (filters.createdTo)
      add(
        'b.created_at < ?',
        new Date(`${addDays(filters.createdTo, 1)}T00:00:00Z`),
      );
    if (filters.amountMin !== undefined) add('b.total >= ?', filters.amountMin);
    if (filters.amountMax !== undefined) add('b.total <= ?', filters.amountMax);
    if (filters.source) add('b.source = ?', filters.source);
    if (filters.disputeStatus)
      add('b.dispute_status = ?', filters.disputeStatus);
    return { sql: clauses.join(' AND '), params };
  }

  private async noReplyCutoff(now = new Date()): Promise<Date> {
    const hours = await this.settings.get('booking_reply_deadline_hours');
    return new Date(now.getTime() - Number(hours) * HOUR);
  }

  async count(filters: BookingFiltersDto): Promise<number> {
    const where = await this.where(filters, { tab: true });
    const [{ n }] = await this.dataSource.query(
      `SELECT COUNT(*) AS n ${needsJoins(filters) ? FROM : COUNT_FROM} WHERE ${where.sql}`,
      where.params,
    );
    return Number(n);
  }

  async fetchRows(
    filters: BookingFiltersDto,
    sort: string | undefined,
    page: { offset: number; limit: number },
  ): Promise<BookingRowDto[]> {
    const [field, direction] = Object.entries(
      toOrder(sort, BOOKING_SORT_FIELDS, ['createdAt', 'DESC']),
    )[0]! as [(typeof BOOKING_SORT_FIELDS)[number], 'ASC' | 'DESC'];
    const where = await this.where(filters, { tab: true });
    const cutoff = await this.noReplyCutoff();
    const rows: any[] = await this.dataSource.query(
      `SELECT b.id, b.reference, b.service_id, s.title_en, s.title_ar, b.pack_id, pk.name_en AS pack_name_en, pk.name_ar AS pack_name_ar,
              b.client_id, cu.full_name AS client_name, cu.avatar_file_id AS client_avatar, b.provider_id, pu.full_name AS provider_name, pp.business_name,
              b.event_date, b.start_time, b.end_time, b.event_type, b.wilaya_code, w.name AS wilaya_name, w.name_ar AS wilaya_name_ar, b.guests, b.total,
              b.status, b.dispute_status, (b.status = 'pending' AND b.created_at <= ?) AS no_reply, b.responded_at, b.created_at, b.source
       ${FROM} WHERE ${where.sql} ORDER BY ${SORT_COLUMNS[field]} ${direction}, b.id ${direction} LIMIT ? OFFSET ?`,
      [cutoff, ...where.params, page.limit, page.offset],
    );
    return rows.map((r) => this.toRow(r));
  }

  private toRow(r: any): BookingRowDto {
    return {
      id: r.id,
      reference: r.reference,
      service: r.service_id
        ? { id: r.service_id, titleEn: r.title_en, titleAr: r.title_ar }
        : null,
      pack: r.pack_id
        ? { id: r.pack_id, nameEn: r.pack_name_en, nameAr: r.pack_name_ar }
        : null,
      client: {
        id: r.client_id,
        fullName: r.client_name,
        avatarUrl: this.avatar(r.client_avatar),
      },
      provider: {
        id: r.provider_id,
        fullName: r.provider_name,
        businessName: r.business_name ?? null,
      },
      eventDate: dateOnly(r.event_date),
      startTime: hhmm(r.start_time),
      endTime: hhmm(r.end_time),
      eventType: r.event_type,
      wilaya: {
        code: Number(r.wilaya_code),
        name: r.wilaya_name ?? '',
        nameAr: r.wilaya_name_ar ?? '',
      },
      guests: r.guests === null ? null : Number(r.guests),
      total: String(r.total),
      status: r.status,
      disputeStatus: r.dispute_status,
      noReply: Number(r.no_reply) === 1,
      respondedAt: iso(r.responded_at),
      createdAt: iso(r.created_at)!,
      source: r.source,
    };
  }

  async list(
    query: BookingsQueryDto,
  ): Promise<Paginated<BookingRowDto, BookingTabCountsDto>> {
    const [rows, counts] = await Promise.all([
      this.fetchRows(query, query.sort, {
        offset: (query.page - 1) * query.limit,
        limit: query.limit,
      }),
      this.tabCounts(query),
    ]);
    // Counters follow every filter but the tab, so the current tab's counter is the total
    // (`noReply` narrows both, as it is a filter rather than a tab).
    return paginateWithCounts(rows, counts[query.tab ?? 'all'], query, counts);
  }

  async tabCounts(filters: BookingFiltersDto): Promise<BookingTabCountsDto> {
    const where = await this.where(filters, { tab: false });
    const cutoff = await this.noReplyCutoff();
    const [raw] = await this.dataSource.query(
      `SELECT COUNT(*) AS all_n, SUM(b.status = 'pending') AS pending, SUM(b.status = 'accepted') AS accepted, SUM(b.status = 'completed') AS completed,
              SUM(b.status = 'declined') AS declined, SUM(b.status = 'cancelled') AS cancelled, SUM(b.dispute_status = 'open') AS disputed,
              SUM(b.status = 'pending' AND b.created_at <= ?) AS no_reply
       ${needsJoins(filters) ? FROM : COUNT_FROM} WHERE ${where.sql}`,
      [cutoff, ...where.params],
    );
    const n = (value: unknown) => Number(value ?? 0);
    return {
      all: n(raw.all_n),
      pending: n(raw.pending),
      accepted: n(raw.accepted),
      completed: n(raw.completed),
      declined: n(raw.declined),
      cancelled: n(raw.cancelled),
      disputed: n(raw.disputed),
      noReply: n(raw.no_reply),
    };
  }

  // ── detail ──────────────────────────────────────────────────

  /** A UUID or a reference (`EVT-002041`, `#EVT-002041`). */
  async resolveId(idOrReference: string): Promise<string> {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrReference,
      );
    if (!isUuid && !REFERENCE_PATTERN.test(idOrReference))
      throw AppException.of('BOOKING_NOT_FOUND');
    const [row] = await this.dataSource.query(
      `SELECT id FROM bookings WHERE ${isUuid ? 'id' : 'reference'} = ? AND deleted_at IS NULL`,
      [isUuid ? idOrReference : idOrReference.replace(/^#/, '').toUpperCase()],
    );
    if (!row) throw AppException.of('BOOKING_NOT_FOUND');
    return row.id;
  }

  private async load(
    em: EntityManager,
    id: string,
    lock = false,
  ): Promise<Booking> {
    const booking = await em
      .getRepository(Booking)
      .findOne({
        where: { id },
        ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
      });
    if (!booking) throw AppException.of('BOOKING_NOT_FOUND');
    return booking;
  }

  async get(
    id: string,
    em: EntityManager = this.dataSource.manager,
  ): Promise<BookingDetailDto> {
    const cutoff = await this.noReplyCutoff();
    const deadlineHours = Number(
      await this.settings.get('booking_reply_deadline_hours'),
    );
    const [r] = await em.query(
      `SELECT b.*, s.title_en, s.title_ar, s.price_type, s.base_price, s.cancellation_policy_en, s.cancellation_policy_ar,
              pk.name_en AS pack_name_en, pk.name_ar AS pack_name_ar, pk.price AS pack_price,
              cu.full_name AS client_name, cu.avatar_file_id AS client_avatar, cu.email AS client_email, cu.phone AS client_phone, cu.status AS client_status,
              pu.full_name AS provider_name, pu.avatar_file_id AS provider_avatar, pu.email AS provider_email, pu.phone AS provider_phone, pu.status AS provider_status,
              pp.business_name, pp.avg_rating, pp.rating_count, pp.avg_reply_minutes, pp.reply_rate, pp.completed_bookings_count, pp.accepting_bookings,
              w.name AS wilaya_name, w.name_ar AS wilaya_name_ar, co.name AS commune_name, co.name_ar AS commune_name_ar,
              cb.full_name AS created_by_name, ar.reference AS academic_reference, ar.title AS academic_title,
              (b.status = 'pending' AND b.created_at <= ?) AS no_reply,
              (SELECT COUNT(*) FROM bookings cb2 WHERE cb2.client_id = b.client_id AND cb2.deleted_at IS NULL) AS client_bookings
       ${FROM}
       LEFT JOIN communes co ON co.id = b.commune_id
       LEFT JOIN users cb ON cb.id = b.created_by_id
       LEFT JOIN academic_requests ar ON ar.id = b.academic_request_id
       WHERE b.id = ? AND b.deleted_at IS NULL`,
      [cutoff, id],
    );
    if (!r) throw AppException.of('BOOKING_NOT_FOUND');

    const [
      lines,
      statusRows,
      rescheduleRows,
      priceRows,
      invoice,
      [conversation],
      [dispute],
      history,
      [cover],
    ] = await Promise.all([
      em.query(
        'SELECT id, kind, label, quantity, unit_amount, amount, service_id, position FROM booking_lines WHERE booking_id = ? AND deleted_at IS NULL ORDER BY position, created_at',
        [id],
      ),
      em.query(
        'SELECT sc.*, u.full_name FROM booking_status_changes sc LEFT JOIN users u ON u.id = sc.actor_id WHERE sc.booking_id = ? ORDER BY sc.created_at',
        [id],
      ),
      em.query(
        'SELECT br.*, u.full_name FROM booking_reschedules br LEFT JOIN users u ON u.id = br.proposed_by_id WHERE br.booking_id = ? AND br.deleted_at IS NULL ORDER BY br.created_at',
        [id],
      ),
      em.query(
        'SELECT pc.*, u.full_name FROM booking_price_changes pc LEFT JOIN users u ON u.id = pc.actor_id WHERE pc.booking_id = ? ORDER BY pc.created_at',
        [id],
      ),
      this.invoices.summary(id, em),
      em.query(
        "SELECT id, kind FROM conversations WHERE booking_id = ? AND deleted_at IS NULL ORDER BY FIELD(kind, 'direct', 'dispute', 'support'), created_at DESC LIMIT 1",
        [id],
      ),
      em.query(
        'SELECT id, reference, status, type, opened_by_role, created_at FROM disputes WHERE booking_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',
        [id],
      ),
      em.query(
        `SELECT a.id, a.action, a.actor_id, u.full_name, a.level, a.changes, a.note, a.created_at FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.object_type = 'booking' AND a.object_id = ? ORDER BY a.created_at DESC LIMIT 50`,
        [id],
      ),
      r.service_id
        ? em.query(
            'SELECT file_id FROM service_photos WHERE service_id = ? ORDER BY position LIMIT 1',
            [r.service_id],
          )
        : em.query(
            'SELECT file_id FROM pack_photos WHERE pack_id = ? ORDER BY position LIMIT 1',
            [r.pack_id],
          ),
    ]);
    const lastMessages: any[] = conversation
      ? await em.query(
          `SELECT m.id, m.kind, m.body, m.body_masked, m.status, m.created_at, m.sender_id, u.full_name, u.role FROM messages m LEFT JOIN users u ON u.id = m.sender_id
           WHERE m.conversation_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 3`,
          [conversation.id],
        )
      : [];

    const person = (actorId: string | null, name: string | null) =>
      actorId ? { id: actorId, fullName: name ?? 'Deleted user' } : null;
    const blankEntry = {
      fromStatus: null,
      toStatus: null,
      reason: null,
      note: null,
      notified: null,
      oldDate: null,
      newDate: null,
      rescheduleStatus: null,
      oldTotal: null,
      newTotal: null,
    };
    const timeline: BookingTimelineEntryDto[] = [
      ...statusRows.map((s: any) => ({
        ...blankEntry,
        type: 'status' as const,
        at: iso(s.created_at)!,
        actor: person(s.actor_id, s.full_name),
        fromStatus: s.from_status,
        toStatus: s.to_status,
        reason: s.reason,
        note: s.note,
        notified: Number(s.notified) === 1,
      })),
      ...rescheduleRows.map((s: any) => ({
        ...blankEntry,
        type: 'reschedule' as const,
        at: iso(s.created_at)!,
        actor: person(s.proposed_by_id, s.full_name),
        reason: s.reason,
        oldDate: dateOnly(s.old_date),
        newDate: dateOnly(s.new_date),
        rescheduleStatus: s.status,
      })),
      ...priceRows.map((s: any) => ({
        ...blankEntry,
        type: 'price' as const,
        at: iso(s.created_at)!,
        actor: person(s.actor_id, s.full_name),
        reason: s.reason,
        oldTotal: String(s.old_total),
        newTotal: String(s.new_total),
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    const pending = rescheduleRows
      .filter((s: any) => s.status === RescheduleStatus.Pending)
      .at(-1);
    const fee = computeFee(String(r.total), String(r.fee_percent));
    const status = r.status as BookingStatus;
    const today = algiersToday();
    const row = this.toRow({
      ...r,
      client_name: r.client_name,
      client_avatar: r.client_avatar,
      provider_name: r.provider_name,
    });

    return {
      ...row,
      client: {
        ...row.client,
        email: r.client_email,
        phone: r.client_phone,
        bookingsCount: Number(r.client_bookings),
        status: r.client_status,
      },
      provider: {
        ...row.provider,
        avatarUrl: this.avatar(r.provider_avatar),
        email: r.provider_email,
        phone: r.provider_phone,
        rating: Number(r.avg_rating ?? 0),
        ratingCount: Number(r.rating_count ?? 0),
        avgReplyMinutes:
          r.avg_reply_minutes === null || r.avg_reply_minutes === undefined
            ? null
            : Number(r.avg_reply_minutes),
        replyRate:
          r.reply_rate === null || r.reply_rate === undefined
            ? null
            : Number(r.reply_rate),
        completedBookingsCount: Number(r.completed_bookings_count ?? 0),
        acceptingBookings: Number(r.accepting_bookings ?? 0) === 1,
        status: r.provider_status,
      },
      offer: r.service_id
        ? {
            kind: 'service',
            id: r.service_id,
            titleEn: r.title_en,
            titleAr: r.title_ar,
            coverUrl: this.avatar(cover?.file_id),
            priceType: r.price_type,
            basePrice: String(r.base_price),
            cancellationPolicyEn: r.cancellation_policy_en,
            cancellationPolicyAr: r.cancellation_policy_ar,
          }
        : {
            kind: 'pack',
            id: r.pack_id,
            titleEn: r.pack_name_en,
            titleAr: r.pack_name_ar,
            coverUrl: this.avatar(cover?.file_id),
            priceType: null,
            basePrice: String(r.pack_price),
            cancellationPolicyEn: null,
            cancellationPolicyAr: null,
          },
      locationText: r.location_text,
      commune: r.commune_id
        ? { id: r.commune_id, name: r.commune_name, nameAr: r.commune_name_ar }
        : null,
      clientNote: r.client_note,
      lines: lines.map((l: any) => ({
        id: l.id,
        kind: l.kind,
        label: l.label,
        quantity: Number(l.quantity),
        unitAmount: String(l.unit_amount),
        amount: String(l.amount),
        serviceId: l.service_id,
        position: Number(l.position),
      })),
      subtotal: String(r.subtotal),
      discountTotal: String(r.discount_total),
      feePercent: String(r.fee_percent),
      feeAmount: fee.feeAmount,
      providerAmount: fee.providerAmount,
      declineReason: r.decline_reason,
      cancelledBy: r.cancelled_by,
      cancelReason: r.cancel_reason,
      reminderSentAt: iso(r.reminder_sent_at),
      completedAt: iso(r.completed_at),
      reviewRequestedAt: iso(r.review_requested_at),
      replyDeadlineAt:
        status === BookingStatus.Pending
          ? new Date(
              new Date(r.created_at).getTime() + deadlineHours * HOUR,
            ).toISOString()
          : null,
      createdBy: person(r.created_by_id, r.created_by_name),
      academicRequest: r.academic_request_id
        ? {
            id: r.academic_request_id,
            reference: r.academic_reference,
            title: r.academic_title,
          }
        : null,
      timeline,
      pendingReschedule: pending ? this.toReschedule(pending) : null,
      invoice,
      conversation: conversation
        ? {
            id: conversation.id,
            kind: conversation.kind,
            lastMessages: lastMessages.reverse().map((m) => ({
              id: m.id,
              kind: m.kind,
              senderLabel: !m.sender_id
                ? SYSTEM_LABEL
                : m.role === UserRole.Admin
                  ? SUPPORT_LABEL
                  : m.full_name,
              body: m.body,
              bodyMasked: m.body_masked,
              status: m.status,
              createdAt: iso(m.created_at)!,
            })),
          }
        : null,
      dispute: dispute
        ? {
            id: dispute.id,
            reference: dispute.reference,
            status: dispute.status,
            type: dispute.type,
            openedByRole: dispute.opened_by_role,
            createdAt: iso(dispute.created_at)!,
          }
        : null,
      allowedTransitions: allowedTransitions(
        {
          status,
          eventDate: dateOnly(r.event_date),
          disputeStatus: r.dispute_status,
        },
        today,
      ),
      history: history.map((h: any) => ({
        id: h.id,
        action: h.action,
        actor: person(h.actor_id, h.full_name),
        level: h.level,
        changes:
          typeof h.changes === 'string' ? JSON.parse(h.changes) : h.changes,
        note: h.note,
        createdAt: iso(h.created_at)!,
      })),
      updatedAt: iso(r.updated_at)!,
    };
  }

  private toReschedule(s: any): RescheduleDto {
    return {
      id: s.id,
      oldDate: dateOnly(s.old_date),
      oldStart: hhmm(s.old_start),
      oldEnd: hhmm(s.old_end),
      newDate: dateOnly(s.new_date),
      newStart: hhmm(s.new_start),
      newEnd: hhmm(s.new_end),
      proposedBy: {
        id: s.proposed_by_id,
        fullName: s.full_name ?? 'Deleted user',
      },
      reason: s.reason,
      forced: Number(s.forced) === 1,
      status: s.status,
      createdAt: iso(s.created_at)!,
      resolvedAt: iso(s.resolved_at),
    };
  }

  // ── availability ────────────────────────────────────────────

  /**
   * Whether the provider can take one more event on `date` (status-rules §5
   * "provider free"). Locks the provider row first so concurrent bookings for the
   * same provider queue up (`SELECT … FOR UPDATE`). Capacity is the service's
   * `max_events_per_day` (for a pack: the smallest among its items); held and
   * booked rows of other bookings count, and a manual block covering the day
   * (or overlapping the booked hours) makes the date unavailable.
   */
  async isAvailable(
    em: EntityManager,
    input: {
      providerId: string;
      serviceId: string | null;
      packId: string | null;
      date: string;
      startTime: string | null;
      endTime: string | null;
      excludeBookingId?: string;
    },
  ): Promise<boolean> {
    await em.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [
      input.providerId,
    ]);
    const serviceIds: string[] = input.serviceId
      ? [input.serviceId]
      : (
          await em.query(
            'SELECT service_id FROM pack_items WHERE pack_id = ?',
            [input.packId],
          )
        ).map((r: { service_id: string }) => r.service_id);
    const [capacityRow] = serviceIds.length
      ? await em.query(
          'SELECT COALESCE(MIN(max_events_per_day), 1) AS n FROM services WHERE id IN (?)',
          [serviceIds],
        )
      : [{ n: 1 }];
    const rows: {
      kind: AvailabilityKind;
      service_id: string | null;
      start_time: string | null;
      end_time: string | null;
      booking_id: string | null;
    }[] = await em.query(
      'SELECT kind, service_id, start_time, end_time, booking_id FROM availability_blocks WHERE provider_id = ? AND date = ? AND deleted_at IS NULL FOR UPDATE',
      [input.providerId, input.date],
    );
    // Minutes from midnight, so an overnight booking (18:00 → 02:00) still meets a 20:00–22:00 block.
    const booked = timeSpan(input.startTime, input.endTime);
    const overlaps = (start: string | null, end: string | null) => {
      const block = timeSpan(hhmm(start), hhmm(end));
      if (!block) return true;
      if (!booked) return false;
      return booked.start < block.end && block.start < booked.end;
    };
    const blocked = rows.some(
      (b) =>
        b.kind === AvailabilityKind.Blocked &&
        (b.service_id === null || serviceIds.includes(b.service_id)) &&
        overlaps(b.start_time, b.end_time),
    );
    if (blocked) return false;
    const taken = rows.filter(
      (b) =>
        b.kind !== AvailabilityKind.Blocked &&
        b.booking_id !== input.excludeBookingId,
    ).length;
    return taken < Number(capacityRow.n);
  }

  /**
   * A client may not request the same service (or pack) twice for overlapping
   * hours of one date while the first booking is pending or accepted. A booking
   * without times covers the whole day.
   */
  private async assertNotDuplicate(
    em: EntityManager,
    dto: Pick<CreateBookingDto, 'clientId' | 'serviceId' | 'packId' | 'eventDate' | 'startTime' | 'endTime'>,
  ): Promise<void> {
    const rows: { reference: string; start_time: string | null; end_time: string | null }[] = await em.query(
      `SELECT reference, start_time, end_time FROM bookings
        WHERE client_id = ? AND ${dto.serviceId ? 'service_id' : 'pack_id'} = ? AND event_date = ?
          AND status IN ('pending', 'accepted') AND deleted_at IS NULL`,
      [dto.clientId, dto.serviceId ?? dto.packId, dto.eventDate],
    );
    const wanted = timeSpan(dto.startTime, dto.endTime);
    const clash = rows.find((r) => {
      const existing = timeSpan(hhmm(r.start_time), hhmm(r.end_time));
      if (!wanted || !existing) return true;
      return wanted.start < existing.end && existing.start < wanted.end;
    });
    if (clash) throw AppException.of('BOOKING_DUPLICATE', { reference: clash.reference, date: dto.eventDate });
  }

  private async assertAvailable(
    em: EntityManager,
    input: Parameters<BookingsService['isAvailable']>[1],
  ): Promise<void> {
    if (!(await this.isAvailable(em, input)))
      throw AppException.of('DATE_UNAVAILABLE', { date: input.date });
  }

  // ── create ──────────────────────────────────────────────────

  async create(
    auth: AuthUser,
    dto: CreateBookingDto,
  ): Promise<BookingDetailDto> {
    if ((dto.serviceId === undefined) === (dto.packId === undefined)) {
      throw new AppException(400, 'VALIDATION_FAILED', [
        {
          field: 'serviceId',
          code: 'EXACTLY_ONE',
          message: 'Send exactly one of serviceId or packId',
        },
      ]);
    }
    if (dto.packId && dto.extras?.length) {
      throw new AppException(400, 'VALIDATION_FAILED', [
        {
          field: 'extras',
          code: 'SERVICE_ONLY',
          message: 'extras are only allowed with serviceId',
        },
      ]);
    }
    const id = await runInTransaction(this.dataSource, (em, afterCommit) =>
      this.createInTransaction(em, afterCommit, auth, dto),
    );
    return this.get(id);
  }

  /** The create rules and effects inside the caller's transaction (academic requests book proposals with it). Returns the booking id. */
  async createInTransaction(
    em: EntityManager,
    afterCommit: AfterCommit,
    auth: AuthUser,
    dto: CreateBookingDto,
    options: { source?: BookingSource } = {},
  ): Promise<string> {
    const [client] = await em.query(
      'SELECT id, role, full_name FROM users WHERE id = ? AND deleted_at IS NULL',
      [dto.clientId],
    );
    if (!client) throw AppException.of('USER_NOT_FOUND');
    if (client.role !== UserRole.Client) throw AppException.of('NOT_A_CLIENT');
    assertEventTimes(dto.startTime, dto.endTime);

    let providerId: string;
    let lines: LineInput[];
    let feeKey: 'platform_fee_percent' | 'pack_fee_percent';
    let label: string;
    if (dto.serviceId) {
      const [service] = await em.query(
        `SELECT s.id, s.provider_id, s.title_en, s.base_price, s.price_type, s.deleted_at, ${SERVICE_VISIBLE_SQL} AS visible
           FROM services s JOIN users u ON u.id = s.provider_id WHERE s.id = ?`,
        [dto.serviceId],
      );
      if (!service || service.deleted_at)
        throw AppException.of('SERVICE_NOT_FOUND');
      if (Number(service.visible) !== 1)
        throw AppException.of('SERVICE_UNAVAILABLE_FOR_BOOKING');
      providerId = service.provider_id;
      label = service.title_en;
      feeKey = 'platform_fee_percent';
      lines = [
        {
          kind: BookingLineKind.Service,
          label: service.title_en,
          quantity: serviceQuantity(service.price_type as PriceType, {
            guests: dto.guests,
            startTime: dto.startTime,
            endTime: dto.endTime,
          }),
          unitAmount: String(service.base_price),
          serviceId: service.id,
        },
      ];
      if (dto.extras?.length) {
        const extras: any[] = await em.query(
          'SELECT id, name_en, price FROM service_extras WHERE id IN (?) AND service_id = ? AND deleted_at IS NULL',
          [dto.extras.map((e) => e.extraId), service.id],
        );
        const invalid = dto.extras
          .filter((e) => !extras.some((x) => x.id === e.extraId))
          .map((e) => e.extraId);
        if (invalid.length)
          throw AppException.of('BOOKING_EXTRA_INVALID', { extraIds: invalid });
        for (const extra of dto.extras) {
          const row = extras.find((x) => x.id === extra.extraId);
          lines.push({
            kind: BookingLineKind.Extra,
            label: row.name_en,
            quantity: extra.quantity,
            unitAmount: String(row.price),
            serviceId: service.id,
          });
        }
      }
    } else {
      const [pack] = await em.query(
        `SELECT p.id, p.provider_id, p.name_en, p.price, p.deleted_at, ${PACK_VISIBLE_SQL} AS visible FROM packs p JOIN users u ON u.id = p.provider_id WHERE p.id = ?`,
        [dto.packId],
      );
      if (!pack || pack.deleted_at) throw AppException.of('PACK_NOT_FOUND');
      if (Number(pack.visible) !== 1) throw AppException.of('PACK_UNAVAILABLE');
      providerId = pack.provider_id;
      label = pack.name_en;
      feeKey = 'pack_fee_percent';
      const items: any[] = await em.query(
        'SELECT s.id AS service_id, s.title_en, s.base_price FROM pack_items pi JOIN services s ON s.id = pi.service_id WHERE pi.pack_id = ? ORDER BY pi.position',
        [pack.id],
      );
      lines = packLines(
        { price: String(pack.price), nameEn: pack.name_en },
        items.map((i) => ({
          serviceId: i.service_id,
          titleEn: i.title_en,
          basePrice: String(i.base_price),
        })),
      );
    }

    const [profile] = await em.query(
      'SELECT accepting_bookings FROM provider_profiles WHERE user_id = ? AND deleted_at IS NULL',
      [providerId],
    );
    if (!profile || Number(profile.accepting_bookings) !== 1)
      throw AppException.of('PROVIDER_NOT_ACCEPTING');

    const minNoticeDays = Number(
      await this.settings.get('booking_min_notice_days'),
    );
    const minDate = addDays(algiersToday(), minNoticeDays);
    if (dto.eventDate < minDate)
      throw AppException.of('MIN_NOTICE', { minDate });
    await this.assertPlace(em, dto.wilayaCode, dto.communeId ?? null);
    if (
      dto.academicRequestId &&
      !(
        await em.query(
          'SELECT id FROM academic_requests WHERE id = ? AND deleted_at IS NULL',
          [dto.academicRequestId],
        )
      ).length
    ) {
      throw AppException.of('ACADEMIC_REQUEST_NOT_FOUND');
    }

    await this.assertAvailable(em, {
      providerId,
      serviceId: dto.serviceId ?? null,
      packId: dto.packId ?? null,
      date: dto.eventDate,
      startTime: dto.startTime ?? null,
      endTime: dto.endTime ?? null,
    });
    // After assertAvailable, which locks the provider row: two identical taps can't both pass.
    if ((options.source ?? BookingSource.Dashboard) !== BookingSource.Dashboard) {
      await this.assertNotDuplicate(em, dto);
    }

    const computed = computeLines(lines);
    const totals = computeTotals(computed);
    if (toCents(totals.total) < 0)
      throw AppException.of('BOOKING_TOTAL_NEGATIVE');
    const feePercent = Number(await this.settings.get(feeKey)).toFixed(2);
    const repository = em.getRepository(Booking);
    const booking = await repository.save(
      repository.create({
        reference: await this.sequences.next('booking', em),
        clientId: dto.clientId,
        providerId,
        serviceId: dto.serviceId ?? null,
        packId: dto.packId ?? null,
        academicRequestId: dto.academicRequestId ?? null,
        status: BookingStatus.Pending,
        disputeStatus: BookingDisputeStatus.None,
        eventType: dto.eventType,
        eventDate: dto.eventDate,
        startTime: toTime(dto.startTime),
        endTime: toTime(dto.endTime),
        locationText: dto.locationText ?? null,
        communeId: dto.communeId ?? null,
        wilayaCode: dto.wilayaCode,
        guests: dto.guests ?? null,
        clientNote: dto.clientNote ?? null,
        ...totals,
        feePercent,
        source: options.source ?? BookingSource.Dashboard,
        createdById: auth.id,
      }),
    );
    await this.saveLines(em, booking.id, computed);
    await this.recordStatus(
      em,
      booking.id,
      null,
      BookingStatus.Pending,
      auth.id,
      null,
      null,
      true,
    );
    await em.query(
      'INSERT INTO availability_blocks (id, created_at, updated_at, provider_id, service_id, date, start_time, end_time, kind, booking_id, note) VALUES (UUID(), NOW(6), NOW(6), ?, ?, ?, ?, ?, ?, ?, NULL)',
      [
        providerId,
        dto.serviceId ?? null,
        dto.eventDate,
        booking.startTime,
        booking.endTime,
        AvailabilityKind.Held,
        booking.id,
      ],
    );
    const conversationId = await this.messaging.ensureDirectConversation(
      em,
      afterCommit,
      {
        clientId: dto.clientId,
        providerId,
        bookingId: booking.id,
        serviceId: dto.serviceId ?? null,
      },
    );
    await this.messaging.insertMessage(em, afterCommit, {
      conversationId,
      senderId: null,
      kind: MessageKind.System,
      body: `Booking ${booking.reference} requested for ${dto.eventDate} (${label}).`,
    });
    await this.audit.log(
      {
        action: 'booking.created',
        objectType: 'booking',
        objectId: booking.id,
        objectLabel: booking.reference,
        level: AuditLevel.Normal,
        changes: {
          clientId: dto.clientId,
          providerId,
          serviceId: dto.serviceId ?? null,
          packId: dto.packId ?? null,
          eventDate: dto.eventDate,
          total: totals.total,
          feePercent,
          conversationId,
        },
      },
      em,
    );
    this.events.emitAfterCommit<BookingEvent>(
      afterCommit,
      BOOKING_EVENTS.created,
      this.eventBase(booking, true),
    );
    return booking.id;
  }

  private async assertPlace(
    em: EntityManager,
    wilayaCode: number,
    communeId: string | null,
  ): Promise<void> {
    if (
      !(await em.query('SELECT code FROM wilayas WHERE code = ?', [wilayaCode]))
        .length
    )
      throw AppException.of('WILAYA_NOT_FOUND');
    if (communeId) {
      const [commune] = await em.query(
        'SELECT wilaya_code FROM communes WHERE id = ? AND deleted_at IS NULL',
        [communeId],
      );
      if (!commune) throw AppException.of('COMMUNE_NOT_FOUND');
      if (Number(commune.wilaya_code) !== Number(wilayaCode))
        throw AppException.of('COMMUNE_WILAYA_MISMATCH');
    }
  }

  private async saveLines(
    em: EntityManager,
    bookingId: string,
    lines: ReturnType<typeof computeLines>,
  ): Promise<void> {
    await em.query('DELETE FROM booking_lines WHERE booking_id = ?', [
      bookingId,
    ]);
    const repository = em.getRepository(BookingLine);
    await repository.save(
      lines.map((l) =>
        repository.create({
          bookingId,
          kind: l.kind,
          label: l.label,
          quantity: l.quantity,
          unitAmount: l.unitAmount,
          amount: l.amount,
          serviceId: l.serviceId,
          position: l.position,
        }),
      ),
    );
  }

  private async recordStatus(
    em: EntityManager,
    bookingId: string,
    from: BookingStatus | null,
    to: BookingStatus,
    actorId: string | null,
    reason: string | null,
    note: string | null,
    notified: boolean,
  ): Promise<void> {
    await em.query(
      'INSERT INTO booking_status_changes (id, created_at, booking_id, from_status, to_status, actor_id, reason, note, notified) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        new Date(),
        bookingId,
        from,
        to,
        actorId,
        reason,
        note,
        notified ? 1 : 0,
      ],
    );
  }

  private eventBase(
    booking: Pick<Booking, 'id' | 'reference' | 'clientId' | 'providerId'>,
    notify: boolean,
  ): BookingEvent {
    return {
      bookingId: booking.id,
      reference: booking.reference,
      clientId: booking.clientId,
      providerId: booking.providerId,
      notify,
    };
  }

  // ── status ──────────────────────────────────────────────────

  async changeStatus(
    auth: AuthUser,
    id: string,
    dto: ChangeStatusDto,
  ): Promise<BookingDetailDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const booking = await this.load(em, id, true);
      await this.applyTransition(em, afterCommit, booking, dto.status, {
        actorId: auth.id,
        reason: dto.reason ?? null,
        note: dto.note,
        notify: dto.notify,
        cancelledBy: dto.cancelledBy ?? PartyRole.Admin,
      });
    });
    return this.get(id);
  }

  /**
   * One status move with its effects (status-rules §5): status change row,
   * availability, invoice, counters, chat, audit and `booking.<status>` event.
   * The booking must be locked by the caller.
   */
  async applyTransition(
    em: EntityManager,
    afterCommit: AfterCommit,
    booking: Booking,
    action: StatusAction,
    options: TransitionOptions,
  ): Promise<void> {
    const from = booking.status;
    const to = targetStatus(action);
    if (!canTransition(from, action))
      throw AppException.of('BOOKING_INVALID_TRANSITION', { from, to: action });
    const now = new Date();
    const changes: Record<string, unknown> = {
      status: { from, to },
      notify: options.notify,
    };
    const update: Partial<Booking> = { status: to };

    switch (action) {
      case 'accepted': {
        await this.assertAvailable(em, {
          providerId: booking.providerId,
          serviceId: booking.serviceId,
          packId: booking.packId,
          date: dateOnly(booking.eventDate),
          startTime: hhmm(booking.startTime),
          endTime: hhmm(booking.endTime),
          excludeBookingId: booking.id,
        });
        update.respondedAt = booking.respondedAt ?? now;
        const moved = await em.query(
          "UPDATE availability_blocks SET kind = 'booked', updated_at = ? WHERE booking_id = ? AND deleted_at IS NULL",
          [now, booking.id],
        );
        if (Number(moved?.affectedRows ?? 0) === 0) {
          await em.query(
            "INSERT INTO availability_blocks (id, created_at, updated_at, provider_id, service_id, date, start_time, end_time, kind, booking_id, note) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, 'booked', ?, NULL)",
            [
              now,
              now,
              booking.providerId,
              booking.serviceId,
              dateOnly(booking.eventDate),
              booking.startTime,
              booking.endTime,
              booking.id,
            ],
          );
        }
        break;
      }
      case 'declined':
        update.respondedAt = booking.respondedAt ?? now;
        update.declineReason = options.reason;
        await this.releaseAvailability(em, booking.id, now);
        break;
      case 'cancelled': {
        update.cancelledBy = options.cancelledBy ?? PartyRole.Admin;
        update.cancelReason = options.reason;
        await this.releaseAvailability(em, booking.id, now);
        changes.voidedInvoices = await this.invoices.voidAll(em, booking.id);
        changes.cancelledBy = update.cancelledBy;
        break;
      }
      case 'completed':
        update.completedAt = now;
        if (dateOnly(booking.eventDate) >= algiersToday(now))
          changes.earlyCompletion = true;
        await this.bumpCounters(em, booking, +1);
        break;
      case 'reopen': {
        update.completedAt = null;
        await this.bumpCounters(em, booking, -1);
        const [review] = await em.query(
          'SELECT id FROM reviews WHERE booking_id = ? AND deleted_at IS NULL LIMIT 1',
          [booking.id],
        );
        if (!review) update.reviewRequestedAt = null;
        break;
      }
    }

    await em.getRepository(Booking).update(booking.id, update as never);
    Object.assign(booking, update);
    await this.recordStatus(
      em,
      booking.id,
      from,
      to,
      options.actorId,
      options.reason,
      options.note,
      options.notify,
    );

    if (action === 'accepted') {
      await this.invoices.issue(em, afterCommit, booking.id, options.notify);
      const [conversation] = await em.query(
        "SELECT id FROM conversations WHERE booking_id = ? AND kind = 'direct' AND deleted_at IS NULL LIMIT 1",
        [booking.id],
      );
      if (conversation) {
        await this.messaging.insertMessage(em, afterCommit, {
          conversationId: conversation.id,
          senderId: null,
          kind: MessageKind.System,
          body: `Booking ${booking.reference} accepted. Contact details are now visible to both of you.`,
        });
      }
    }

    await this.audit.log(
      {
        action: options.auditAction ?? 'booking.status_changed',
        objectType: 'booking',
        objectId: booking.id,
        objectLabel: booking.reference,
        level:
          action === 'cancelled' || action === 'reopen'
            ? AuditLevel.Sensitive
            : AuditLevel.Normal,
        changes: { ...changes, reason: options.reason },
        note: options.note,
        ...(options.actorId === null
          ? {
              actorId: null,
              actorRole: null,
              source: options.source ?? AuditSource.System,
            }
          : {}),
      },
      em,
    );

    const base = this.eventBase(booking, options.notify);
    if (action === 'cancelled') {
      this.events.emitAfterCommit<BookingCancelledEvent>(
        afterCommit,
        BOOKING_EVENTS.cancelled,
        {
          ...base,
          cancelledBy: update.cancelledBy as PartyRole,
          reason: options.reason ?? '',
          causedByUserId: options.causedByUserId ?? null,
        },
      );
    } else {
      const name =
        action === 'reopen' ? BOOKING_EVENTS.reopened : BOOKING_EVENTS[action];
      this.events.emitAfterCommit<BookingStatusChangedEvent>(
        afterCommit,
        name,
        {
          ...base,
          from,
          to,
          reason: options.reason,
          note: options.note,
          actorId: options.actorId,
        },
      );
    }
  }

  private async releaseAvailability(
    em: EntityManager,
    bookingId: string,
    now = new Date(),
  ): Promise<void> {
    await em.query(
      'UPDATE availability_blocks SET deleted_at = ? WHERE booking_id = ? AND deleted_at IS NULL',
      [now, bookingId],
    );
  }

  /** Completed-booking counters: services / packs `bookings_count`, provider `completed_bookings_count`. */
  private async bumpCounters(
    em: EntityManager,
    booking: Booking,
    delta: 1 | -1,
  ): Promise<void> {
    const expression = (column: string) =>
      delta > 0 ? `${column} + 1` : `GREATEST(${column} - 1, 0)`;
    if (booking.serviceId)
      await em.query(
        `UPDATE services SET bookings_count = ${expression('bookings_count')} WHERE id = ?`,
        [booking.serviceId],
      );
    if (booking.packId)
      await em.query(
        `UPDATE packs SET bookings_count = ${expression('bookings_count')} WHERE id = ?`,
        [booking.packId],
      );
    await em.query(
      `UPDATE provider_profiles SET completed_bookings_count = ${expression('completed_bookings_count')} WHERE user_id = ?`,
      [booking.providerId],
    );
  }

  /** Accepted bookings from today on (Africa/Algiers) for a service, pack or user. */
  async upcomingAccepted(
    em: EntityManager,
    column: BookingOwnerColumn,
    id: string,
  ): Promise<number> {
    const [row] = await em.query(
      `SELECT COUNT(*) AS n FROM bookings WHERE ${column} = ? AND status = 'accepted' AND event_date >= ? AND deleted_at IS NULL`,
      [id, algiersToday()],
    );
    return Number(row.n);
  }

  /**
   * Cancels every pending booking of a service, pack or account through the
   * status machine (status rows, released availability, audit, `booking.cancelled`
   * without notifying `causedByUserId`). Used by account block / delete and
   * service / pack deletion.
   */
  async cancelPendingFor(
    em: EntityManager,
    afterCommit: AfterCommit,
    input: {
      column: BookingOwnerColumn;
      id: string;
      reason: string;
      actorId: string | null;
      causedByUserId: string | null;
    },
  ): Promise<number> {
    const pending: { id: string }[] = await em.query(
      `SELECT id FROM bookings WHERE ${input.column} = ? AND status = 'pending' AND deleted_at IS NULL ORDER BY created_at FOR UPDATE`,
      [input.id],
    );
    for (const { id } of pending) {
      const booking = await this.load(em, id, true);
      await this.applyTransition(em, afterCommit, booking, 'cancelled', {
        actorId: input.actorId,
        reason: input.reason,
        note: null,
        notify: true,
        cancelledBy: PartyRole.Admin,
        causedByUserId: input.causedByUserId,
      });
    }
    return pending.length;
  }

  // ── reschedule ──────────────────────────────────────────────

  async reschedule(
    auth: AuthUser,
    id: string,
    dto: RescheduleBookingDto,
  ): Promise<BookingDetailDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const booking = await this.load(em, id, true);
      if (!isEditable(booking.status))
        throw AppException.of('BOOKING_NOT_EDITABLE', {
          status: booking.status,
        });
      if (dto.date < algiersToday())
        throw AppException.of('BOOKING_DATE_PAST', { date: dto.date });
      const newStart =
        dto.startTime === undefined ? hhmm(booking.startTime) : dto.startTime;
      const newEnd =
        dto.endTime === undefined ? hhmm(booking.endTime) : dto.endTime;
      assertEventTimes(newStart, newEnd);
      const force = dto.force ?? false;
      const [open] = await em.query(
        "SELECT id FROM booking_reschedules WHERE booking_id = ? AND status = 'pending' AND deleted_at IS NULL LIMIT 1",
        [id],
      );
      if (open) throw AppException.of('RESCHEDULE_PENDING_EXISTS');
      if (!force) {
        await this.assertAvailable(em, {
          providerId: booking.providerId,
          serviceId: booking.serviceId,
          packId: booking.packId,
          date: dto.date,
          startTime: newStart,
          endTime: newEnd,
          excludeBookingId: booking.id,
        });
      }
      const apply = booking.status === BookingStatus.Pending || force;
      const now = new Date();
      const repository = em.getRepository(BookingReschedule);
      const oldDate = dateOnly(booking.eventDate);
      const row = await repository.save(
        repository.create({
          bookingId: id,
          oldDate,
          oldStart: booking.startTime,
          oldEnd: booking.endTime,
          newDate: dto.date,
          newStart: toTime(newStart),
          newEnd: toTime(newEnd),
          proposedById: auth.id,
          reason: dto.reason,
          forced: force,
          status: apply ? RescheduleStatus.Accepted : RescheduleStatus.Pending,
          resolvedAt: apply ? now : null,
        }),
      );
      if (apply)
        await this.moveBooking(em, booking, dto.date, newStart, newEnd, now);
      await this.audit.log(
        {
          action: apply ? 'booking.rescheduled' : 'booking.reschedule_proposed',
          objectType: 'booking',
          objectId: id,
          objectLabel: booking.reference,
          level: AuditLevel.Normal,
          changes: {
            eventDate: { from: oldDate, to: dto.date },
            startTime: { from: hhmm(booking.startTime), to: newStart },
            endTime: { from: hhmm(booking.endTime), to: newEnd },
            force,
            rescheduleId: row.id,
          },
          note: dto.reason,
        },
        em,
      );
      this.events.emitAfterCommit<BookingRescheduledEvent>(
        afterCommit,
        apply ? BOOKING_EVENTS.rescheduled : BOOKING_EVENTS.rescheduleProposed,
        {
          ...this.eventBase(booking, true),
          oldDate,
          newDate: dto.date,
          applied: apply,
        },
      );
    });
    return this.get(id);
  }

  private async moveBooking(
    em: EntityManager,
    booking: Booking,
    date: string,
    start: string | null,
    end: string | null,
    now: Date,
  ): Promise<void> {
    await em
      .getRepository(Booking)
      .update(booking.id, {
        eventDate: date,
        startTime: toTime(start),
        endTime: toTime(end),
      });
    await em.query(
      'UPDATE availability_blocks SET date = ?, start_time = ?, end_time = ?, updated_at = ? WHERE booking_id = ? AND deleted_at IS NULL',
      [date, toTime(start), toTime(end), now, booking.id],
    );
  }

  async cancelReschedule(
    auth: AuthUser,
    id: string,
    rescheduleId: string,
  ): Promise<BookingDetailDto> {
    await runInTransaction(this.dataSource, async (em) => {
      const booking = await this.load(em, id, true);
      const row = await em
        .getRepository(BookingReschedule)
        .findOne({
          where: { id: rescheduleId, bookingId: id },
          lock: { mode: 'pessimistic_write' },
        });
      if (!row) throw AppException.of('RESCHEDULE_NOT_FOUND');
      if (row.status !== RescheduleStatus.Pending)
        throw AppException.of('RESCHEDULE_NOT_PENDING', { status: row.status });
      await em
        .getRepository(BookingReschedule)
        .update(row.id, {
          status: RescheduleStatus.Cancelled,
          resolvedAt: new Date(),
        });
      await this.audit.log(
        {
          action: 'booking.reschedule_cancelled',
          objectType: 'booking',
          objectId: id,
          objectLabel: booking.reference,
          level: AuditLevel.Normal,
          changes: { rescheduleId, newDate: dateOnly(row.newDate) },
        },
        em,
      );
    });
    return this.get(id);
  }

  /**
   * The other party answers a reschedule proposal (status-rules §5 "either
   * party proposes and the other accepts"). Accepting moves the booking and its
   * availability row; rejecting only closes the proposal. The proposer cannot
   * answer their own proposal — they cancel it instead.
   */
  async respondToReschedule(
    auth: AuthUser,
    id: string,
    rescheduleId: string,
    action: 'accept' | 'reject',
  ): Promise<void> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const booking = await this.load(em, id, true);
      const row = await em.getRepository(BookingReschedule).findOne({
        where: { id: rescheduleId, bookingId: id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw AppException.of('RESCHEDULE_NOT_FOUND');
      if (row.status !== RescheduleStatus.Pending)
        throw AppException.of('RESCHEDULE_NOT_PENDING', { status: row.status });
      if (row.proposedById === auth.id) throw AppException.of('NOT_OWNER');
      if (!isEditable(booking.status))
        throw AppException.of('BOOKING_NOT_EDITABLE', {
          status: booking.status,
        });

      const now = new Date();
      const newDate = dateOnly(row.newDate);
      const newStart = hhmm(row.newStart);
      const newEnd = hhmm(row.newEnd);
      if (action === 'accept') {
        await this.assertAvailable(em, {
          providerId: booking.providerId,
          serviceId: booking.serviceId,
          packId: booking.packId,
          date: newDate,
          startTime: newStart,
          endTime: newEnd,
          excludeBookingId: booking.id,
        });
        await this.moveBooking(em, booking, newDate, newStart, newEnd, now);
      }
      await em.getRepository(BookingReschedule).update(row.id, {
        status:
          action === 'accept'
            ? RescheduleStatus.Accepted
            : RescheduleStatus.Rejected,
        resolvedAt: now,
      });
      await this.audit.log(
        {
          action:
            action === 'accept'
              ? 'booking.reschedule_accepted'
              : 'booking.reschedule_rejected',
          objectType: 'booking',
          objectId: id,
          objectLabel: booking.reference,
          level: AuditLevel.Normal,
          changes: {
            rescheduleId,
            eventDate: { from: dateOnly(row.oldDate), to: newDate },
          },
        },
        em,
      );
      this.events.emitAfterCommit<BookingRescheduledEvent>(
        afterCommit,
        action === 'accept'
          ? BOOKING_EVENTS.rescheduled
          : BOOKING_EVENTS.rescheduleProposed,
        {
          ...this.eventBase(booking, true),
          oldDate: dateOnly(row.oldDate),
          newDate,
          applied: action === 'accept',
        },
      );
    });
  }

  /**
   * status-rules §5 "All good": after the event either party confirms, and when
   * **both** have, the booking completes immediately instead of waiting for the
   * dispute window to run out. Returns what happened, so the caller can answer
   * with the refreshed booking.
   */
  async checkIn(
    auth: AuthUser,
    id: string,
    party: PartyRole.Client | PartyRole.Provider,
  ): Promise<'recorded' | 'complete'> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const booking = await this.load(em, id, true);
      const mine =
        party === PartyRole.Client ? 'clientCheckedInAt' : 'providerCheckedInAt';
      const theirs =
        party === PartyRole.Client ? 'providerCheckedInAt' : 'clientCheckedInAt';
      const outcome = checkInOutcome({
        status: booking.status,
        disputeStatus: booking.disputeStatus,
        eventDate: dateOnly(booking.eventDate),
        today: algiersToday(),
        otherCheckedIn: booking[theirs] !== null,
      });
      const refusal = checkInRefusal(outcome);
      if (refusal) throw refusal;

      const now = new Date();
      await em.getRepository(Booking).update(id, { [mine]: now } as never);
      Object.assign(booking, { [mine]: now });
      await this.audit.log(
        {
          action: 'booking.checked_in',
          objectType: 'booking',
          objectId: id,
          objectLabel: booking.reference,
          level: AuditLevel.Info,
          changes: { party, bothConfirmed: outcome === 'complete' },
        },
        em,
      );
      if (outcome === 'complete') {
        await this.applyTransition(em, afterCommit, booking, 'completed', {
          actorId: auth.id,
          reason: null,
          note: 'Both parties confirmed the event went well.',
          notify: true,
        });
      }
      return outcome as 'recorded' | 'complete';
    });
  }

  // ── price ───────────────────────────────────────────────────

  async changePrice(
    auth: AuthUser,
    id: string,
    dto: ChangePriceDto,
  ): Promise<BookingDetailDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const booking = await this.load(em, id, true);
      if (!isEditable(booking.status))
        throw AppException.of('BOOKING_NOT_EDITABLE', {
          status: booking.status,
        });
      const computed = computeLines(
        dto.lines.map((l) => ({ ...l, serviceId: l.serviceId ?? null })),
      );
      const totals = computeTotals(computed);
      if (toCents(totals.total) < 0)
        throw AppException.of('BOOKING_TOTAL_NEGATIVE');
      const before: any[] = await em.query(
        'SELECT kind, label, quantity, unit_amount, amount, service_id FROM booking_lines WHERE booking_id = ? ORDER BY position',
        [id],
      );
      await this.saveLines(em, id, computed);
      await em.getRepository(Booking).update(id, totals);
      await em.query(
        'INSERT INTO booking_price_changes (id, created_at, booking_id, old_total, new_total, lines_before, lines_after, reason, actor_id) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          new Date(),
          id,
          booking.total,
          totals.total,
          JSON.stringify(
            before.map((l) => ({
              kind: l.kind,
              label: l.label,
              quantity: Number(l.quantity),
              unitAmount: String(l.unit_amount),
              amount: String(l.amount),
              serviceId: l.service_id,
            })),
          ),
          JSON.stringify(computed.map(({ position: _position, ...l }) => l)),
          dto.reason,
          auth.id,
        ],
      );
      let invoiceVersion: number | null = null;
      if (booking.status === BookingStatus.Accepted) {
        invoiceVersion = (await this.invoices.issue(em, afterCommit, id, true))
          .version;
      }
      await this.audit.log(
        {
          action: 'booking.price_changed',
          objectType: 'booking',
          objectId: id,
          objectLabel: booking.reference,
          level: AuditLevel.Sensitive,
          changes: {
            total: { from: String(booking.total), to: totals.total },
            lines: computed.length,
            invoiceVersion,
            difference: fromCents(
              toCents(totals.total) - toCents(booking.total),
            ),
          },
          note: dto.reason,
        },
        em,
      );
      this.events.emitAfterCommit<BookingPriceChangedEvent>(
        afterCommit,
        BOOKING_EVENTS.priceChanged,
        {
          ...this.eventBase(booking, true),
          oldTotal: String(booking.total),
          newTotal: totals.total,
        },
      );
    });
    return this.get(id);
  }

  // ── remind ──────────────────────────────────────────────────

  async remind(
    auth: AuthUser,
    id: string,
    now = new Date(),
  ): Promise<RemindResultDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const booking = await this.load(em, id, true);
      if (booking.status !== BookingStatus.Pending)
        throw AppException.of('BOOKING_NOT_EDITABLE', {
          status: booking.status,
        });
      const wait = reminderRetryAfter(booking.reminderSentAt, now);
      if (wait > 0)
        throw AppException.of('REMINDER_TOO_SOON', { retryAfterSeconds: wait });
      await em.getRepository(Booking).update(id, { reminderSentAt: now });
      await this.audit.log(
        {
          action: 'booking.reminder_sent',
          objectType: 'booking',
          objectId: id,
          objectLabel: booking.reference,
          level: AuditLevel.Info,
          changes: { providerId: booking.providerId },
        },
        em,
      );
      this.events.emitAfterCommit<BookingReminderEvent>(
        afterCommit,
        BOOKING_EVENTS.reminderSent,
        { ...this.eventBase(booking, true), automatic: false },
      );
      return {
        id,
        reminderSentAt: now.toISOString(),
        nextReminderAt: new Date(
          now.getTime() + REMINDER_INTERVAL_HOURS * HOUR,
        ).toISOString(),
      };
    });
  }

  // ── event details ───────────────────────────────────────────

  async update(
    auth: AuthUser,
    id: string,
    dto: UpdateBookingDto,
  ): Promise<BookingDetailDto> {
    if (dto.eventDate !== undefined) throw AppException.of('USE_RESCHEDULE');
    await runInTransaction(this.dataSource, async (em) => {
      const booking = await this.load(em, id, true);
      if (!isEditable(booking.status))
        throw AppException.of('BOOKING_NOT_EDITABLE', {
          status: booking.status,
        });
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const update: Partial<Booking> = {};
      const set = <K extends keyof Booking>(
        key: K,
        value: Booking[K],
        current: unknown = booking[key],
      ) => {
        if (value === undefined || current === value) return;
        changes[key as string] = { from: current, to: value };
        update[key] = value;
      };
      set('eventType', dto.eventType as Booking['eventType']);
      assertEventTimes(
        dto.startTime === undefined ? hhmm(booking.startTime) : dto.startTime,
        dto.endTime === undefined ? hhmm(booking.endTime) : dto.endTime,
      );
      if (dto.startTime !== undefined)
        set('startTime', toTime(dto.startTime), booking.startTime);
      if (dto.endTime !== undefined)
        set('endTime', toTime(dto.endTime), booking.endTime);
      set('locationText', dto.locationText as string | null);
      set('guests', dto.guests as number | null);
      set('clientNote', dto.clientNote as string | null);
      const wilayaCode = dto.wilayaCode ?? booking.wilayaCode;
      const communeId =
        dto.communeId !== undefined
          ? dto.communeId
          : dto.wilayaCode !== undefined &&
              dto.wilayaCode !== booking.wilayaCode
            ? null
            : booking.communeId;
      if (dto.wilayaCode !== undefined || dto.communeId !== undefined) {
        await this.assertPlace(em, wilayaCode, communeId);
        set('wilayaCode', wilayaCode);
        set('communeId', communeId);
      }
      if (Object.keys(update).length === 0) return;
      await em.getRepository(Booking).update(id, update as never);
      if (update.startTime !== undefined || update.endTime !== undefined) {
        await em.query(
          'UPDATE availability_blocks SET start_time = ?, end_time = ? WHERE booking_id = ? AND deleted_at IS NULL',
          [
            update.startTime !== undefined
              ? update.startTime
              : booking.startTime,
            update.endTime !== undefined ? update.endTime : booking.endTime,
            id,
          ],
        );
      }
      await this.audit.log(
        {
          action: 'booking.updated',
          objectType: 'booking',
          objectId: id,
          objectLabel: booking.reference,
          level: AuditLevel.Normal,
          changes,
        },
        em,
      );
    });
    return this.get(id);
  }
}
