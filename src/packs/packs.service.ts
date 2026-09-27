import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, In, type DataSource, type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { BookingsService } from '../bookings/bookings.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Wilaya } from '../catalog/entities/wilaya.entity.js';
import { likeContains } from '../common/dto/transforms.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { BookingStatus } from '../common/enums/booking.enums.js';
import { EventType, PackStatus, PriceType, ServiceStatus } from '../common/enums/catalog.enums.js';
import { UserRole, UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { PACK_GALLERY, PhotoGallery, SERVICE_GALLERY, type PhotoDto, type UploadedPhotoFile } from '../files/photo-gallery.js';
import { Service } from '../services/entities/service.entity.js';
import { fromCents, toCents } from '../services/services.policy.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderProfile } from '../users/entities/provider-profile.entity.js';
import { User } from '../users/entities/user.entity.js';
import { iso } from '../users/users.service.js';
import {
  PACK_SORT_FIELDS,
  type CreatePackDto,
  type PackDeletedDto,
  type PackDetailDto,
  type PackFiltersDto,
  type PackItemDto,
  type PackRowDto,
  type PacksQueryDto,
  type PackTabCountsDto,
  type UpdatePackDto,
} from './dto/packs.dto.js';
import { PackItem } from './entities/pack-item.entity.js';
import { Pack } from './entities/pack.entity.js';
import { PackHealthService } from './pack-health.service.js';
import { PACK_EVENTS, type PackEvent } from './packs.events.js';
import { canPackTransition, PACK_VISIBLE_SQL, packAttentionReasons, packPricing, packPublishMissing, type PackAction, type PackItemState } from './packs.policy.js';

const SORT_COLUMNS: Record<(typeof PACK_SORT_FIELDS)[number], string> = {
  createdAt: 'p.created_at',
  price: 'p.price',
  bookingsCount: 'p.bookings_count',
  rating: 'p.avg_rating',
  name: 'p.name_en',
};

interface RawPackRow {
  id: string;
  name_en: string;
  name_ar: string;
  provider_id: string;
  provider_name: string | null;
  business_name: string | null;
  provider_status: UserStatus | null;
  provider_verification: VerificationStatus | null;
  price: string;
  event_type: EventType;
  wilaya_code: number;
  wilaya_name: string | null;
  wilaya_name_ar: string | null;
  avg_rating: string;
  rating_count: number;
  bookings_count: number;
  status: PackStatus;
  needs_attention: number;
  visible: number | string;
  created_at: Date;
  updated_at: Date;
}

interface RawItemRow {
  pack_id: string;
  position: number;
  service_id: string;
  title_en: string;
  title_ar: string;
  status: ServiceStatus;
  deleted_at: Date | null;
  base_price: string;
  price_type: PriceType;
  avg_rating: string;
  category_id: string;
  category_name_en: string | null;
  category_name_ar: string | null;
}

/** PCK-01…PCK-03: Ready Packs of one provider's own services. */
@Injectable()
export class PacksService {
  readonly gallery: PhotoGallery;
  private readonly serviceGallery: PhotoGallery;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    files: FilesService,
    private readonly settings: SettingsService,
    private readonly health: PackHealthService,
    private readonly bookings: BookingsService,
  ) {
    this.gallery = new PhotoGallery(files, PACK_GALLERY);
    this.serviceGallery = new PhotoGallery(files, SERVICE_GALLERY);
  }

  // ── list ────────────────────────────────────────────────────

  filtered(filters: PackFiltersDto, em: EntityManager = this.dataSource.manager): SelectQueryBuilder<Pack> {
    const qb = em
      .getRepository(Pack)
      .createQueryBuilder('p')
      .leftJoin(User, 'u', 'u.id = p.provider_id')
      .leftJoin(ProviderProfile, 'pp', 'pp.user_id = p.provider_id AND pp.deleted_at IS NULL')
      .leftJoin(Wilaya, 'w', 'w.code = p.wilaya_code');
    if (filters.q) {
      const like = likeContains(filters.q);
      qb.andWhere(
        new Brackets((w) =>
          w
            .where('p.name_en LIKE :qLike', { qLike: like })
            .orWhere('p.name_ar LIKE :qLike')
            .orWhere('u.full_name LIKE :qLike')
            .orWhere('pp.business_name LIKE :qLike'),
        ),
      );
    }
    if (filters.providerId) qb.andWhere('p.provider_id = :providerId', { providerId: filters.providerId });
    if (filters.eventType) qb.andWhere('p.event_type = :eventType', { eventType: filters.eventType });
    if (filters.wilaya?.length) qb.andWhere('p.wilaya_code IN (:...wilayas)', { wilayas: filters.wilaya });
    if (filters.priceMin !== undefined) qb.andWhere('p.price >= :priceMin', { priceMin: filters.priceMin });
    if (filters.priceMax !== undefined) qb.andWhere('p.price <= :priceMax', { priceMax: filters.priceMax });
    return qb;
  }

  tabbed(filters: PackFiltersDto, em: EntityManager = this.dataSource.manager): SelectQueryBuilder<Pack> {
    const qb = this.filtered(filters, em);
    if (filters.tab === 'needs_attention') qb.andWhere('p.needs_attention = 1');
    else if (filters.tab && filters.tab !== 'all') qb.andWhere('p.status = :tabStatus', { tabStatus: filters.tab });
    return qb;
  }

  async fetchRows(filters: PackFiltersDto, sort: string | undefined, page: { offset: number; limit: number }, em: EntityManager = this.dataSource.manager): Promise<PackRowDto[]> {
    const [field, direction] = Object.entries(toOrder(sort, PACK_SORT_FIELDS, ['createdAt', 'DESC']))[0]! as [(typeof PACK_SORT_FIELDS)[number], 'ASC' | 'DESC'];
    const raw = await this.selectRow(this.tabbed(filters, em))
      .orderBy(SORT_COLUMNS[field], direction)
      .addOrderBy('p.id', 'ASC')
      .offset(page.offset)
      .limit(page.limit)
      .getRawMany<RawPackRow>();
    return this.toRows(raw, em);
  }

  async list(query: PacksQueryDto): Promise<Paginated<PackRowDto, PackTabCountsDto>> {
    const [rows, total, counts] = await Promise.all([
      this.fetchRows(query, query.sort, { offset: (query.page - 1) * query.limit, limit: query.limit }),
      this.tabbed(query).getCount(),
      this.tabCounts(query),
    ]);
    return paginateWithCounts(rows, total, query, counts);
  }

  async tabCounts(filters: PackFiltersDto): Promise<PackTabCountsDto> {
    const raw = await this.filtered({ ...filters, tab: undefined })
      .select('COUNT(*)', 'all_n')
      .addSelect("SUM(p.status = 'published')", 'published')
      .addSelect("SUM(p.status = 'draft')", 'draft')
      .addSelect("SUM(p.status = 'unpublished')", 'unpublished')
      .addSelect('SUM(p.needs_attention = 1)', 'attention')
      .getRawOne<Record<string, string | null>>();
    const n = (value: string | null | undefined) => Number(value ?? 0);
    return { all: n(raw?.all_n), published: n(raw?.published), draft: n(raw?.draft), unpublished: n(raw?.unpublished), needs_attention: n(raw?.attention) };
  }

  private selectRow(qb: SelectQueryBuilder<Pack>): SelectQueryBuilder<Pack> {
    return qb
      .select('p.id', 'id')
      .addSelect('p.name_en', 'name_en')
      .addSelect('p.name_ar', 'name_ar')
      .addSelect('p.provider_id', 'provider_id')
      .addSelect('u.full_name', 'provider_name')
      .addSelect('pp.business_name', 'business_name')
      .addSelect('u.status', 'provider_status')
      .addSelect('u.verification_status', 'provider_verification')
      .addSelect('p.price', 'price')
      .addSelect('p.event_type', 'event_type')
      .addSelect('p.wilaya_code', 'wilaya_code')
      .addSelect('w.name', 'wilaya_name')
      .addSelect('w.name_ar', 'wilaya_name_ar')
      .addSelect('p.avg_rating', 'avg_rating')
      .addSelect('p.rating_count', 'rating_count')
      .addSelect('p.bookings_count', 'bookings_count')
      .addSelect('p.status', 'status')
      .addSelect('p.needs_attention', 'needs_attention')
      .addSelect(PACK_VISIBLE_SQL, 'visible')
      .addSelect('p.created_at', 'created_at')
      .addSelect('p.updated_at', 'updated_at');
  }

  private async itemRows(em: EntityManager, packIds: string[]): Promise<RawItemRow[]> {
    if (packIds.length === 0) return [];
    return em.query(
      `SELECT pi.pack_id, pi.position, s.id AS service_id, s.title_en, s.title_ar, s.status, s.deleted_at, s.base_price, s.price_type, s.avg_rating,
              s.category_id, c.name_en AS category_name_en, c.name_ar AS category_name_ar
       FROM pack_items pi JOIN services s ON s.id = pi.service_id LEFT JOIN categories c ON c.id = s.category_id
       WHERE pi.pack_id IN (?) ORDER BY pi.pack_id, pi.position, pi.created_at`,
      [packIds],
    );
  }

  private async toRows(raw: RawPackRow[], em: EntityManager): Promise<PackRowDto[]> {
    const ids = raw.map((r) => r.id);
    const [covers, items] = await Promise.all([this.gallery.covers(em, ids), this.itemRows(em, ids)]);
    const byPack = new Map<string, RawItemRow[]>();
    for (const item of items) byPack.set(item.pack_id, [...(byPack.get(item.pack_id) ?? []), item]);
    return raw.map((r) => {
      const packItems = byPack.get(r.id) ?? [];
      const pricing = packPricing(String(r.price), packItems.map((i) => ({ basePrice: String(i.base_price), deleted: i.deleted_at !== null })));
      const attentionReasons = packAttentionReasons(this.itemStates(packItems), {
        status: r.provider_status ?? UserStatus.Blocked,
        verificationStatus: r.provider_verification ?? VerificationStatus.Pending,
        deleted: r.provider_status === null || r.provider_status === undefined,
      });
      return {
        id: r.id,
        nameEn: r.name_en,
        nameAr: r.name_ar,
        coverUrl: this.gallery.coverUrl(covers.get(r.id)),
        provider: {
          id: r.provider_id,
          fullName: r.provider_name ?? 'Deleted user',
          businessName: r.business_name,
          status: r.provider_status ?? UserStatus.Blocked,
          verificationStatus: r.provider_verification ?? VerificationStatus.Pending,
        },
        itemsCount: packItems.length,
        itemsSummary: packItems.map((i) => ({ nameEn: i.category_name_en ?? '', nameAr: i.category_name_ar ?? '' })),
        price: String(r.price),
        ...pricing,
        eventType: r.event_type,
        wilaya: { code: Number(r.wilaya_code), name: r.wilaya_name ?? '', nameAr: r.wilaya_name_ar ?? '' },
        rating: Number(r.avg_rating),
        ratingCount: Number(r.rating_count),
        bookingsCount: Number(r.bookings_count),
        status: r.status,
        needsAttention: Number(r.needs_attention) === 1,
        attentionReasons,
        visibleInApp: Number(r.visible) === 1,
        createdAt: iso(r.created_at)!,
        updatedAt: iso(r.updated_at)!,
      };
    });
  }

  /** Wilaya codes each service covers, in one query (publish coverage rule). */
  private async itemWilayas(em: EntityManager, serviceIds: string[]): Promise<Map<string, number[]>> {
    const map = new Map<string, number[]>();
    if (serviceIds.length === 0) return map;
    const rows: { service_id: string; wilaya_code: number }[] = await em.query(
      'SELECT service_id, wilaya_code FROM service_wilayas WHERE service_id IN (?)',
      [serviceIds],
    );
    for (const row of rows) map.set(row.service_id, [...(map.get(row.service_id) ?? []), Number(row.wilaya_code)]);
    return map;
  }

  // ── detail ──────────────────────────────────────────────────

  async load(id: string, em: EntityManager = this.dataSource.manager, lock = false): Promise<Pack> {
    const pack = await em.getRepository(Pack).findOne({ where: { id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!pack) throw AppException.of('PACK_NOT_FOUND');
    return pack;
  }

  async get(id: string, em: EntityManager = this.dataSource.manager): Promise<PackDetailDto> {
    const pack = await this.load(id, em);
    const raw = await this.selectRow(this.filtered({}, em).andWhere('p.id = :id', { id })).getRawOne<RawPackRow>();
    if (!raw) throw AppException.of('PACK_NOT_FOUND');
    const [[row], items, photos, bookingRows, provider, createdBy] = await Promise.all([
      this.toRows([raw], em),
      this.itemRows(em, [id]),
      this.gallery.list(em, id),
      em.query('SELECT status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM bookings WHERE pack_id = ? AND deleted_at IS NULL GROUP BY status', [id]),
      em.getRepository(User).findOne({ where: { id: pack.providerId }, withDeleted: true }),
      em.getRepository(User).findOne({ where: { id: pack.createdById }, withDeleted: true }),
    ]);
    const covers = await this.serviceGallery.covers(
      em,
      items.map((i) => i.service_id),
    );
    const states = this.itemStates(items, await this.itemWilayas(em, items.map((i) => i.service_id)));
    const providerState = this.providerState(provider);
    const byStatus = new Map<string, { n: number; amount: string }>(bookingRows.map((b: any) => [b.status, { n: Number(b.n), amount: String(b.amount) }]));
    const count = (status: BookingStatus) => byStatus.get(status)?.n ?? 0;

    return {
      ...row!,
      descriptionEn: pack.descriptionEn,
      descriptionAr: pack.descriptionAr,
      maxGuests: pack.maxGuests,
      items: items.map(
        (i): PackItemDto => ({
          position: Number(i.position),
          service: {
            id: i.service_id,
            titleEn: i.title_en,
            titleAr: i.title_ar,
            coverUrl: this.serviceGallery.coverUrl(covers.get(i.service_id)),
            category: { id: i.category_id, nameEn: i.category_name_en ?? '', nameAr: i.category_name_ar ?? '' },
            status: i.status,
            priceType: i.price_type,
            rating: Number(i.avg_rating),
          },
          price: String(i.base_price),
          availability: i.deleted_at ? 'deleted' : i.status === ServiceStatus.Published ? 'available' : i.status === ServiceStatus.Hidden ? 'hidden' : 'not_published',
        }),
      ),
      photos,
      attentionReasons: packAttentionReasons(states, providerState),
      publishMissing: packPublishMissing({ nameEn: pack.nameEn, nameAr: pack.nameAr, price: pack.price, items: states, provider: providerState, wilayaCode: pack.wilayaCode }),
      stats: {
        bookings: {
          pending: count(BookingStatus.Pending),
          accepted: count(BookingStatus.Accepted),
          declined: count(BookingStatus.Declined),
          cancelled: count(BookingStatus.Cancelled),
          completed: count(BookingStatus.Completed),
          total: [...byStatus.values()].reduce((a, b) => a + b.n, 0),
        },
        revenue: fromCents(toCents(byStatus.get(BookingStatus.Completed)?.amount ?? '0')),
      },
      createdBy: createdBy ? { id: createdBy.id, fullName: createdBy.fullName } : null,
    };
  }

  private itemStates(items: RawItemRow[], wilayas?: Map<string, number[]>): PackItemState[] {
    return items.map((i) => ({
      serviceId: i.service_id,
      status: i.status,
      deleted: i.deleted_at !== null,
      basePrice: String(i.base_price),
      ...(wilayas ? { wilayaCodes: wilayas.get(i.service_id) ?? [] } : {}),
    }));
  }

  private providerState(user: User | null) {
    return {
      status: user?.status ?? UserStatus.Blocked,
      verificationStatus: user?.verificationStatus ?? VerificationStatus.Pending,
      deleted: !user || user.deletedAt !== null,
    };
  }

  // ── create / update ─────────────────────────────────────────

  private async assertProvider(em: EntityManager, providerId: string): Promise<User> {
    const user = await em.getRepository(User).findOne({ where: { id: providerId } });
    if (!user || user.role !== UserRole.Provider) throw AppException.of('NOT_A_PROVIDER', { providerId });
    return user;
  }

  private async assertWilaya(em: EntityManager, code: number, mustBeOpen: boolean): Promise<void> {
    const wilaya = await em.getRepository(Wilaya).findOne({ where: { code } });
    if (!wilaya) throw new AppException(422, 'WILAYA_NOT_FOUND', { wilayaCodes: [code] });
    if (mustBeOpen && !wilaya.isOpen) throw AppException.of('WILAYA_CLOSED', { closed: [code] });
  }

  /** Every service exists (not deleted) and belongs to the provider. */
  private async assertItems(em: EntityManager, providerId: string, serviceIds: string[]): Promise<void> {
    const services = await em.getRepository(Service).find({ where: { id: In(serviceIds) }, select: { id: true, providerId: true } });
    const found = new Map(services.map((s) => [s.id, s]));
    const missing = serviceIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw AppException.of('PACK_SERVICE_NOT_FOUND', { serviceIds: missing });
    const others = services.filter((s) => s.providerId !== providerId).map((s) => s.id);
    if (others.length > 0) throw AppException.of('PACK_SERVICE_OTHER_PROVIDER', { serviceIds: others, providerId });
  }

  private async replaceItems(em: EntityManager, packId: string, serviceIds: string[]): Promise<void> {
    await em.getRepository(PackItem).delete({ packId });
    await em.getRepository(PackItem).insert(serviceIds.map((serviceId, position) => ({ packId, serviceId, position, createdAt: new Date() })));
  }

  private async assertPublishable(em: EntityManager, pack: Pack): Promise<void> {
    const [items, provider] = await Promise.all([this.itemRows(em, [pack.id]), em.getRepository(User).findOne({ where: { id: pack.providerId }, withDeleted: true })]);
    const states = this.itemStates(items, await this.itemWilayas(em, items.map((i) => i.service_id)));
    const missing = packPublishMissing({ nameEn: pack.nameEn, nameAr: pack.nameAr, price: pack.price, items: states, provider: this.providerState(provider), wilayaCode: pack.wilayaCode });
    if (missing.length === 0) return;
    // The coverage rule has its own code so the app can point at the wilaya picker.
    if (missing.includes('wilayaNotCovered')) {
      throw AppException.of('PACK_WILAYA_NOT_COVERED', { missing, wilayaCode: pack.wilayaCode });
    }
    throw AppException.of('PACK_PUBLISH_INVALID', { missing });
  }

  async create(auth: AuthUser, dto: CreatePackDto): Promise<PackDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const provider = await this.assertProvider(em, dto.providerId);
      await this.assertWilaya(em, dto.wilayaCode, true);
      await this.assertItems(em, dto.providerId, dto.serviceIds);
      const repository = em.getRepository(Pack);
      const pack = await repository.save(
        repository.create({
          providerId: dto.providerId,
          nameEn: dto.nameEn,
          nameAr: dto.nameAr ?? '',
          descriptionEn: dto.descriptionEn ?? null,
          descriptionAr: dto.descriptionAr ?? null,
          eventType: dto.eventType,
          wilayaCode: dto.wilayaCode,
          price: dto.price,
          maxGuests: dto.maxGuests ?? null,
          status: PackStatus.Draft,
          createdById: auth.id,
        }),
      );
      await this.replaceItems(em, pack.id, dto.serviceIds);
      await this.health.recompute(em, afterCommit, { packIds: [pack.id] });
      await this.audit.log(
        {
          action: 'pack.created',
          objectType: 'pack',
          objectId: pack.id,
          objectLabel: pack.nameEn,
          level: AuditLevel.Normal,
          changes: { providerId: { from: null, to: pack.providerId }, price: { from: null, to: pack.price }, serviceIds: { from: null, to: dto.serviceIds } },
          note: `Created for ${provider.fullName}`,
        },
        em,
      );
      return this.get(pack.id, em);
    });
  }

  async update(auth: AuthUser, id: string, dto: UpdatePackDto): Promise<PackDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const pack = await this.load(id, em, true);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const currentIds = (await em.getRepository(PackItem).find({ where: { packId: id }, order: { position: 'ASC' } })).map((i) => i.serviceId);
      const nextProvider = dto.providerId ?? pack.providerId;
      const nextIds = dto.serviceIds ?? currentIds;

      if (nextProvider !== pack.providerId) {
        await this.assertProvider(em, nextProvider);
        changes.providerId = { from: pack.providerId, to: nextProvider };
      }
      if (changes.providerId || JSON.stringify(nextIds) !== JSON.stringify(currentIds)) {
        await this.assertItems(em, nextProvider, nextIds);
      }
      if (dto.wilayaCode !== undefined && dto.wilayaCode !== pack.wilayaCode) await this.assertWilaya(em, dto.wilayaCode, true);

      for (const field of ['providerId', 'nameEn', 'nameAr', 'descriptionEn', 'descriptionAr', 'eventType', 'wilayaCode', 'price', 'maxGuests'] as const) {
        const next = dto[field];
        if (next !== undefined && next !== pack[field]) {
          changes[field] = { from: pack[field], to: next };
          (pack as any)[field] = next;
        }
      }
      if (JSON.stringify(nextIds) !== JSON.stringify(currentIds)) {
        await this.replaceItems(em, id, nextIds);
        changes.serviceIds = { from: currentIds, to: nextIds };
      }
      if (Object.keys(changes).length > 0) {
        await em.getRepository(Pack).save(pack);
        if (pack.status === PackStatus.Published) await this.assertPublishable(em, pack);
        await this.health.recompute(em, afterCommit, { packIds: [id] });
        await this.audit.log({ action: 'pack.updated', objectType: 'pack', objectId: id, objectLabel: pack.nameEn, level: AuditLevel.Normal, changes }, em);
      }
      return this.get(id, em);
    });
  }

  async transition(auth: AuthUser, id: string, action: PackAction): Promise<PackDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const pack = await this.load(id, em, true);
      const from = pack.status;
      if (!canPackTransition(action, from)) throw AppException.of('PACK_INVALID_TRANSITION', { status: from, action });
      if (action === 'publish') await this.assertPublishable(em, pack);
      const to = action === 'publish' ? PackStatus.Published : PackStatus.Unpublished;
      await em.getRepository(Pack).update(id, { status: to });
      await this.health.recompute(em, afterCommit, { packIds: [id] });
      await this.audit.log(
        { action: `pack.${action}ed`, objectType: 'pack', objectId: id, objectLabel: pack.nameEn, level: AuditLevel.Normal, changes: { status: { from, to } } },
        em,
      );
      this.events.emitAfterCommit<PackEvent>(afterCommit, action === 'publish' ? PACK_EVENTS.published : PACK_EVENTS.unpublished, { packId: id, providerId: pack.providerId });
      return this.get(id, em);
    });
  }

  async duplicate(auth: AuthUser, id: string): Promise<PackDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const source = await this.load(id, em);
      const items = await em.getRepository(PackItem).find({ where: { packId: id }, order: { position: 'ASC' } });
      const repository = em.getRepository(Pack);
      const copy = await repository.save(
        repository.create({
          providerId: source.providerId,
          nameEn: `${source.nameEn} (copy)`.slice(0, 160),
          nameAr: source.nameAr ? `${source.nameAr} (نسخة)`.slice(0, 160) : '',
          descriptionEn: source.descriptionEn,
          descriptionAr: source.descriptionAr,
          eventType: source.eventType,
          wilayaCode: source.wilayaCode,
          price: source.price,
          maxGuests: source.maxGuests,
          status: PackStatus.Draft,
          createdById: auth.id,
        }),
      );
      if (items.length > 0) await this.replaceItems(em, copy.id, items.map((i) => i.serviceId));
      await em.query('INSERT INTO pack_photos (id, created_at, pack_id, file_id, position) SELECT UUID(), ?, ?, file_id, position FROM pack_photos WHERE pack_id = ?', [
        new Date(),
        copy.id,
        id,
      ]);
      await this.health.recompute(em, afterCommit, { packIds: [copy.id] });
      await this.audit.log(
        { action: 'pack.duplicated', objectType: 'pack', objectId: copy.id, objectLabel: copy.nameEn, level: AuditLevel.Normal, changes: { sourcePackId: id } },
        em,
      );
      return this.get(copy.id, em);
    });
  }

  async remove(auth: AuthUser, id: string): Promise<PackDeletedDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const pack = await this.load(id, em, true);
      const upcoming = await this.bookings.upcomingAccepted(em, 'pack_id', id);
      if (upcoming > 0) throw AppException.of('PACK_HAS_BOOKINGS', { upcomingBookings: upcoming });
      const cancelledBookings = await this.bookings.cancelPendingFor(em, afterCommit, { column: 'pack_id', id, reason: 'pack_deleted', actorId: auth.id, causedByUserId: pack.providerId });
      await em.getRepository(Pack).softDelete(id);
      await this.audit.log(
        { action: 'pack.deleted', objectType: 'pack', objectId: id, objectLabel: pack.nameEn, level: AuditLevel.Sensitive, changes: { status: pack.status, cancelledBookings } },
        em,
      );
      this.events.emitAfterCommit<PackEvent>(afterCommit, PACK_EVENTS.deleted, { packId: id, providerId: pack.providerId });
      return { id, cancelledBookings };
    });
  }

  // ── photos ──────────────────────────────────────────────────

  async addPhoto(auth: AuthUser, id: string, file: UploadedPhotoFile): Promise<PhotoDto[]> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const pack = await this.load(id, em, true);
      const max = await this.settings.get('max_photos_per_pack');
      const fileId = await this.gallery.add(em, afterCommit, id, file, max, pack.providerId);
      await this.audit.log({ action: 'pack.photo_added', objectType: 'pack', objectId: id, objectLabel: pack.nameEn, level: AuditLevel.Info, changes: { fileId } }, em);
      return this.gallery.list(em, id);
    });
  }

  async reorderPhotos(auth: AuthUser, id: string, ids: string[]): Promise<PhotoDto[]> {
    return runInTransaction(this.dataSource, async (em) => {
      const pack = await this.load(id, em, true);
      await this.gallery.reorder(em, id, ids);
      await this.audit.log({ action: 'pack.photos_reordered', objectType: 'pack', objectId: id, objectLabel: pack.nameEn, level: AuditLevel.Info, changes: { order: ids } }, em);
      return this.gallery.list(em, id);
    });
  }

  async removePhoto(auth: AuthUser, id: string, photoId: string): Promise<PhotoDto[]> {
    return runInTransaction(this.dataSource, async (em) => {
      const pack = await this.load(id, em, true);
      const { fileId } = await this.gallery.remove(em, id, photoId);
      await this.audit.log({ action: 'pack.photo_removed', objectType: 'pack', objectId: id, objectLabel: pack.nameEn, level: AuditLevel.Info, changes: { photoId, fileId } }, em);
      return this.gallery.list(em, id);
    });
  }
}
