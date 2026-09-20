import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, In, type DataSource, type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { ServiceStatus } from '../common/enums/catalog.enums.js';
import { UserRole } from '../common/enums/user.enums.js';
import { likeContains } from '../common/dto/transforms.js';
import { AppException } from '../common/errors/app.exception.js';
import { paginate, paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction } from '../database/transaction.js';
import { assertWilayaCloseConfirmed, communeKey } from './catalog.policy.js';
import { parseCommunesCsv, type CsvLineError } from './communes-csv.js';
import {
  COMMUNE_SORT_FIELDS,
  WILAYA_SORT_FIELDS,
  type CommuneDto,
  type CommunesImportResultDto,
  type CommunesQueryDto,
  type CreateCommuneDto,
  type UpdateCommuneDto,
  type UpdateWilayaDto,
  type WilayaDto,
  type WilayaFiltersDto,
  type WilayasQueryDto,
  type WilayaTabCountsDto,
} from './dto/locations.dto.js';
import { Commune } from './entities/commune.entity.js';
import { Wilaya } from './entities/wilaya.entity.js';

type CountMap = Map<number, number>;

/** LOC-01 / LOC-02: wilayas (seeded, open/closed) and their communes. */
@Injectable()
export class LocationsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  // ── wilayas ────────────────────────────────────────────────

  filteredWilayas(filters: WilayaFiltersDto, em: EntityManager = this.dataSource.manager): SelectQueryBuilder<Wilaya> {
    const qb = em.getRepository(Wilaya).createQueryBuilder('wilaya');
    if (filters.tab === 'open') qb.andWhere('wilaya.isOpen = 1');
    if (filters.tab === 'closed') qb.andWhere('wilaya.isOpen = 0');
    if (filters.region?.length) qb.andWhere('wilaya.region IN (:...regions)', { regions: filters.region });
    if (filters.q) {
      const like = likeContains(filters.q);
      qb.andWhere(
        new Brackets((w) => {
          w.where('wilaya.name LIKE :like', { like }).orWhere('wilaya.nameAr LIKE :like');
          if (/^\d{1,3}$/.test(filters.q!)) w.orWhere('wilaya.code = :code', { code: Number(filters.q) });
        }),
      );
    }
    return qb;
  }

  async listWilayas(query: WilayasQueryDto): Promise<Paginated<WilayaDto, WilayaTabCountsDto>> {
    const [field, direction] = Object.entries(toOrder(query.sort, WILAYA_SORT_FIELDS, ['code', 'ASC']))[0]!;
    const [rows, total] = await this.filteredWilayas(query)
      .orderBy(`wilaya.${field}`, direction)
      .addOrderBy('wilaya.code', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    const grouped: { open: number | string; total: string }[] = await this.filteredWilayas({ q: query.q, region: query.region })
      .select('wilaya.isOpen', 'open')
      .addSelect('COUNT(*)', 'total')
      .groupBy('wilaya.isOpen')
      .getRawMany();
    const open = Number(grouped.find((g) => Number(g.open) === 1)?.total ?? 0);
    const closed = Number(grouped.find((g) => Number(g.open) === 0)?.total ?? 0);
    return paginateWithCounts(await this.wilayasWithCounts(rows), total, query, { all: open + closed, open, closed });
  }

  async getWilaya(code: number, em: EntityManager = this.dataSource.manager): Promise<WilayaDto> {
    const wilaya = await em.getRepository(Wilaya).findOneBy({ code });
    if (!wilaya) throw AppException.of('WILAYA_NOT_FOUND');
    return (await this.wilayasWithCounts([wilaya], em))[0]!;
  }

  /** Four grouped queries for any number of wilayas. */
  async wilayasWithCounts(wilayas: Wilaya[], em: EntityManager = this.dataSource.manager): Promise<WilayaDto[]> {
    if (wilayas.length === 0) return [];
    const counts = await this.counts(wilayas.map((w) => w.code), em);
    return wilayas.map((w) => ({
      code: w.code,
      name: w.name,
      nameAr: w.nameAr,
      region: w.region,
      isOpen: w.isOpen,
      communesCount: counts.communes.get(w.code) ?? 0,
      providersCount: counts.providers.get(w.code) ?? 0,
      servicesCount: counts.services.get(w.code) ?? 0,
      clientsCount: counts.clients.get(w.code) ?? 0,
      updatedAt: w.updatedAt.toISOString(),
    }));
  }

  private async counts(codes: number[], em: EntityManager): Promise<Record<'communes' | 'providers' | 'services' | 'clients', CountMap>> {
    const toMap = (rows: { code: number; n: string }[]): CountMap => new Map(rows.map((r) => [Number(r.code), Number(r.n)]));
    const [communes, providers, services, clients] = await Promise.all([
      em.query('SELECT wilaya_code AS code, COUNT(*) AS n FROM communes WHERE deleted_at IS NULL AND wilaya_code IN (?) GROUP BY wilaya_code', [codes]),
      em.query(
        `SELECT pw.wilaya_code AS code, COUNT(DISTINCT pw.provider_profile_id) AS n FROM provider_wilayas pw
         JOIN provider_profiles pp ON pp.id = pw.provider_profile_id AND pp.deleted_at IS NULL
         JOIN users u ON u.id = pp.user_id AND u.deleted_at IS NULL
         WHERE pw.wilaya_code IN (?) GROUP BY pw.wilaya_code`,
        [codes],
      ),
      em.query(
        `SELECT sw.wilaya_code AS code, COUNT(DISTINCT sw.service_id) AS n FROM service_wilayas sw
         JOIN services s ON s.id = sw.service_id AND s.deleted_at IS NULL AND s.status = ?
         WHERE sw.wilaya_code IN (?) GROUP BY sw.wilaya_code`,
        [ServiceStatus.Published, codes],
      ),
      em.query(
        'SELECT wilaya_code AS code, COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND role = ? AND wilaya_code IN (?) GROUP BY wilaya_code',
        [UserRole.Client, codes],
      ),
    ]);
    return { communes: toMap(communes), providers: toMap(providers), services: toMap(services), clients: toMap(clients) };
  }

  async updateWilaya(code: number, dto: UpdateWilayaDto): Promise<WilayaDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const repository = em.getRepository(Wilaya);
      const wilaya = await repository.findOne({ where: { code }, lock: { mode: 'pessimistic_write' } });
      if (!wilaya) throw AppException.of('WILAYA_NOT_FOUND');

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['isOpen', 'name', 'nameAr'] as const) {
        if (dto[field] !== undefined && dto[field] !== wilaya[field]) changes[field] = { from: wilaya[field], to: dto[field] };
      }
      if (Object.keys(changes).length === 0) return this.getWilaya(code, em);

      if (changes.isOpen && dto.isOpen === false) {
        const counts = await this.counts([code], em);
        assertWilayaCloseConfirmed({
          wasOpen: wilaya.isOpen,
          isOpen: dto.isOpen,
          confirm: dto.confirm,
          servicesCount: counts.services.get(code) ?? 0,
          providersCount: counts.providers.get(code) ?? 0,
        });
      }

      await repository.update(code, Object.fromEntries(Object.entries(changes).map(([f, c]) => [f, c.to])));
      const action = changes.isOpen ? (dto.isOpen ? 'wilaya.opened' : 'wilaya.closed') : 'wilaya.updated';
      await this.audit.log(
        {
          action,
          objectType: 'wilaya',
          objectId: String(code),
          objectLabel: `${code} ${dto.name ?? wilaya.name}`,
          level: changes.isOpen ? AuditLevel.Sensitive : AuditLevel.Normal,
          changes,
        },
        em,
      );
      return this.getWilaya(code, em);
    });
  }

  // ── communes ───────────────────────────────────────────────

  async listCommunes(code: number, query: CommunesQueryDto): Promise<Paginated<CommuneDto>> {
    if (!(await this.dataSource.getRepository(Wilaya).existsBy({ code }))) throw AppException.of('WILAYA_NOT_FOUND');
    const [field, direction] = Object.entries(toOrder(query.sort, COMMUNE_SORT_FIELDS, ['name', 'ASC']))[0]!;
    const qb = this.dataSource.getRepository(Commune).createQueryBuilder('commune').where('commune.wilayaCode = :code', { code });
    if (query.q) {
      const like = likeContains(query.q);
      qb.andWhere(
        new Brackets((w) =>
          w.where('commune.name LIKE :like', { like }).orWhere('commune.nameAr LIKE :like').orWhere('commune.postalCode LIKE :like'),
        ),
      );
    }
    const [rows, total] = await qb
      .orderBy(`commune.${field}`, direction)
      .addOrderBy('commune.id', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return paginate(await this.communesWithCounts(rows), total, query);
  }

  private async communesWithCounts(communes: Commune[], em: EntityManager = this.dataSource.manager): Promise<CommuneDto[]> {
    if (communes.length === 0) return [];
    const rows: { id: string; n: string }[] = await em.query(
      'SELECT commune_id AS id, COUNT(*) AS n FROM bookings WHERE commune_id IN (?) GROUP BY commune_id',
      [communes.map((c) => c.id)],
    );
    const bookings = new Map(rows.map((r) => [r.id, Number(r.n)]));
    return communes.map((c) => ({
      id: c.id,
      wilayaCode: c.wilayaCode,
      name: c.name,
      nameAr: c.nameAr,
      postalCode: c.postalCode,
      bookingsCount: bookings.get(c.id) ?? 0,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  /**
   * The unique index (wilaya_code, name) also covers soft-deleted rows. A deleted
   * commune with the same name is restored on create; one blocking a rename is
   * removed for good (it was unreferenced when deleted and cannot gain references).
   */
  private async findByName(em: EntityManager, wilayaCode: number, name: string, exceptId?: string): Promise<Commune | null> {
    const rows = await em.getRepository(Commune).find({ where: { wilayaCode, name }, withDeleted: true });
    return rows.find((row) => row.id !== exceptId) ?? null;
  }

  async createCommune(dto: CreateCommuneDto): Promise<CommuneDto> {
    return runInTransaction(this.dataSource, async (em) => {
      if (!(await em.getRepository(Wilaya).existsBy({ code: dto.wilayaCode }))) throw AppException.of('WILAYA_NOT_FOUND');
      const repository = em.getRepository(Commune);
      const twin = await this.findByName(em, dto.wilayaCode, dto.name);
      if (twin && !twin.deletedAt) throw AppException.of('COMMUNE_EXISTS', { id: twin.id });

      let commune: Commune;
      if (twin) {
        await repository.restore(twin.id);
        await repository.update(twin.id, { name: dto.name, nameAr: dto.nameAr, postalCode: dto.postalCode ?? null });
        commune = await repository.findOneByOrFail({ id: twin.id });
      } else {
        commune = await repository.save(
          repository.create({ wilayaCode: dto.wilayaCode, name: dto.name, nameAr: dto.nameAr, postalCode: dto.postalCode ?? null }),
        );
      }
      await this.audit.log(
        {
          action: 'commune.created',
          objectType: 'commune',
          objectId: commune.id,
          objectLabel: `${commune.name} (${commune.wilayaCode})`,
          level: AuditLevel.Normal,
          changes: {
            wilayaCode: { from: null, to: commune.wilayaCode },
            name: { from: null, to: commune.name },
            nameAr: { from: null, to: commune.nameAr },
            postalCode: { from: null, to: commune.postalCode },
          },
        },
        em,
      );
      return (await this.communesWithCounts([commune], em))[0]!;
    });
  }

  async updateCommune(id: string, dto: UpdateCommuneDto): Promise<CommuneDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const repository = em.getRepository(Commune);
      const commune = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!commune) throw AppException.of('COMMUNE_NOT_FOUND');

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['name', 'nameAr', 'postalCode'] as const) {
        if (dto[field] !== undefined && dto[field] !== commune[field]) changes[field] = { from: commune[field], to: dto[field] };
      }
      if (Object.keys(changes).length === 0) return (await this.communesWithCounts([commune], em))[0]!;

      if (changes.name) {
        const twin = await this.findByName(em, commune.wilayaCode, dto.name!, id);
        if (twin && !twin.deletedAt) throw AppException.of('COMMUNE_EXISTS', { id: twin.id });
        if (twin) await repository.delete(twin.id);
      }
      Object.assign(commune, Object.fromEntries(Object.entries(changes).map(([f, c]) => [f, c.to])));
      await repository.save(commune);
      await this.audit.log(
        { action: 'commune.updated', objectType: 'commune', objectId: id, objectLabel: `${commune.name} (${commune.wilayaCode})`, level: AuditLevel.Normal, changes },
        em,
      );
      return (await this.communesWithCounts([commune], em))[0]!;
    });
  }

  async removeCommune(id: string): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const repository = em.getRepository(Commune);
      const commune = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!commune) throw AppException.of('COMMUNE_NOT_FOUND');
      const [{ n }] = await em.query('SELECT COUNT(*) AS n FROM bookings WHERE commune_id = ?', [id]);
      if (Number(n) > 0) throw AppException.of('COMMUNE_IN_USE', { bookingsCount: Number(n) });
      await repository.softDelete(id);
      await this.audit.log(
        { action: 'commune.deleted', objectType: 'commune', objectId: id, objectLabel: `${commune.name} (${commune.wilayaCode})`, level: AuditLevel.Normal },
        em,
      );
    });
  }

  /**
   * CSV import (LOC-02). Valid lines are applied in one transaction; invalid ones
   * are reported with their line number and skipped. Rows match existing communes
   * by (wilaya, name): new → created, different Arabic name or postal code →
   * updated (an empty postal_code keeps the current one), identical → skipped.
   */
  async importCommunes(text: string): Promise<CommunesImportResultDto> {
    const parsed = parseCommunesCsv(text);
    if (!parsed.ok && parsed.reason === 'header') {
      throw AppException.of('CSV_HEADER_INVALID', { expected: 'wilaya_code,name,name_ar,postal_code', received: parsed.received.join(',') });
    }
    if (!parsed.ok) throw AppException.of('CSV_TOO_MANY_ROWS', { maxRows: 5000, rows: parsed.count });

    return runInTransaction(this.dataSource, async (em) => {
      const errors: CsvLineError[] = [...parsed.errors];
      const codes = [...new Set(parsed.rows.map((r) => r.wilayaCode))];
      const known = new Set(
        codes.length ? (await em.getRepository(Wilaya).find({ where: { code: In(codes) }, select: { code: true } })).map((w) => w.code) : [],
      );
      const existing = codes.length
        ? await em.getRepository(Commune).find({ where: { wilayaCode: In(codes) }, withDeleted: true, lock: { mode: 'pessimistic_write' } })
        : [];
      const byKey = new Map(existing.map((c) => [communeKey(c.wilayaCode, c.name), c]));
      const seen = new Map<string, number>();
      const repository = em.getRepository(Commune);
      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (const row of parsed.rows) {
        if (!known.has(row.wilayaCode)) {
          errors.push({ line: row.line, message: `Unknown wilaya code ${row.wilayaCode}` });
          continue;
        }
        const key = communeKey(row.wilayaCode, row.name);
        if (seen.has(key)) {
          errors.push({ line: row.line, message: `Duplicate of line ${seen.get(key)}` });
          continue;
        }
        seen.set(key, row.line);

        const current = byKey.get(key);
        if (!current) {
          await repository.insert({ wilayaCode: row.wilayaCode, name: row.name, nameAr: row.nameAr, postalCode: row.postalCode });
          created++;
        } else if (current.deletedAt) {
          await repository.restore(current.id);
          await repository.update(current.id, { name: row.name, nameAr: row.nameAr, postalCode: row.postalCode ?? current.postalCode });
          created++;
        } else {
          const postalCode = row.postalCode ?? current.postalCode;
          if (current.nameAr === row.nameAr && current.postalCode === postalCode) {
            skipped++;
          } else {
            await repository.update(current.id, { nameAr: row.nameAr, postalCode });
            updated++;
          }
        }
      }

      errors.sort((a, b) => a.line - b.line);
      await this.audit.log(
        {
          action: 'communes.imported',
          objectType: 'commune',
          objectId: null,
          objectLabel: `CSV import: ${created} created, ${updated} updated`,
          level: AuditLevel.Normal,
          changes: { created, updated, skipped, errors: errors.length, wilayaCodes: codes.filter((c) => known.has(c)) },
        },
        em,
      );
      return { created, updated, skipped, errors };
    });
  }
}
