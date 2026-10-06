import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, In, type DataSource, type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { BookingsService } from '../bookings/bookings.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Category } from '../catalog/entities/category.entity.js';
import { Wilaya } from '../catalog/entities/wilaya.entity.js';
import { likeContains } from '../common/dto/transforms.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { BookingStatus } from '../common/enums/booking.enums.js';
import { PriceType, ServiceStatus } from '../common/enums/catalog.enums.js';
import { FileVariantKind } from '../common/enums/file.enums.js';
import { UserRole, UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import type { Lang } from '../common/i18n/language.js';
import { paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { PhotoGallery, SERVICE_GALLERY, type PhotoDto, type UploadedPhotoFile } from '../files/photo-gallery.js';
import { PackHealthService } from '../packs/pack-health.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderProfile } from '../users/entities/provider-profile.entity.js';
import { User } from '../users/entities/user.entity.js';
import { algiersToday, iso } from '../users/users.service.js';
import {
  SERVICE_SORT_FIELDS,
  type CreateServiceDto,
  type HideServiceDto,
  type ServiceDeletedDto,
  type ServiceDetailDto,
  type ServiceFiltersDto,
  type ServiceRowDto,
  type ServicesQueryDto,
  type ServiceTabCountsDto,
  type UpdateServiceDto,
} from './dto/services.dto.js';
import { ServiceExtra } from './entities/service-extra.entity.js';
import { ServiceHour } from './entities/service-hour.entity.js';
import { ServiceWilaya } from './entities/service-wilaya.entity.js';
import { Service } from './entities/service.entity.js';
import { SERVICE_EVENTS, type ServiceEvent, type ServiceHiddenEvent } from './services.events.js';
import { assertValidHours, type HourRange } from './scheduling.policy.js';
import {
  canTransition,
  featureRefusal,
  fromCents,
  MAX_FEATURED_SERVICES,
  SERVICE_VISIBLE_SQL,
  serviceVisibilityReasons,
  servicePublishMissing,
  toCents,
  type ServiceAction,
} from './services.policy.js';

const SORT_COLUMNS: Record<(typeof SERVICE_SORT_FIELDS)[number], string> = {
  createdAt: 's.created_at',
  bookingsCount: 's.bookings_count',
  rating: 's.avg_rating',
  price: 's.base_price',
  title: 's.title_en',
};

const REPORTED_SQL = "EXISTS (SELECT 1 FROM reports r WHERE r.target_type = 'service' AND r.target_id = s.id AND r.status = 'open' AND r.deleted_at IS NULL)";

interface RawServiceRow {
  id: string;
  title_en: string;
  title_ar: string;
  category_id: string;
  category_name_en: string | null;
  category_name_ar: string | null;
  provider_id: string;
  provider_name: string | null;
  business_name: string | null;
  provider_status: UserStatus | null;
  provider_verification: VerificationStatus | null;
  base_price: string;
  price_type: PriceType;
  avg_rating: string;
  rating_count: number;
  bookings_count: number;
  status: ServiceStatus;
  is_featured: number;
  visible: number | string;
  created_at: Date;
  updated_at: Date;
}

const UPDATABLE_FIELDS = [
  'titleEn',
  'titleAr',
  'descriptionEn',
  'descriptionAr',
  'cancellationPolicyEn',
  'cancellationPolicyAr',
  'basePrice',
  'priceType',
  'maxEventsPerDay',
  'maxGuests',
  'concurrentClients',
  'availableFrom',
  'availableUntil',
] as const;

/** Full-text on titles (words of 3+ letters, prefix), plus title / provider name / business name contains. */
export function serviceSearch(q: string): Brackets {
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  return new Brackets((w) => {
    if (words.length > 0) w.where('MATCH(s.title_en, s.title_ar) AGAINST (:ft IN BOOLEAN MODE)', { ft: words.map((word) => `+${word}*`).join(' ') });
    else w.where('1 = 0');
    w.orWhere('s.title_en LIKE :qLike', { qLike: likeContains(q) })
      .orWhere('s.title_ar LIKE :qLike')
      .orWhere('u.full_name LIKE :qLike')
      .orWhere('pp.business_name LIKE :qLike');
  });
}

/** SRV-01…SRV-06: service list, detail, editor, photos, moderation actions and deletion. */
@Injectable()
export class ServicesService {
  readonly gallery: PhotoGallery;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly files: FilesService,
    private readonly settings: SettingsService,
    private readonly packHealth: PackHealthService,
    private readonly bookings: BookingsService,
  ) {
    this.gallery = new PhotoGallery(files, SERVICE_GALLERY);
  }

  // ── list ────────────────────────────────────────────────────

  filtered(filters: ServiceFiltersDto, em: EntityManager = this.dataSource.manager, joins: 'row' | 'filters' = 'row'): SelectQueryBuilder<Service> {
    // Counters skip the joins no filter reads (each is at most one row per service).
    const qb = em.getRepository(Service).createQueryBuilder('s').leftJoin(User, 'u', 'u.id = s.provider_id');
    if (joins === 'row' || filters.q) qb.leftJoin(ProviderProfile, 'pp', 'pp.user_id = s.provider_id AND pp.deleted_at IS NULL');
    if (joins === 'row') qb.leftJoin(Category, 'c', 'c.id = s.category_id');

    if (filters.q) qb.andWhere(serviceSearch(filters.q));
    if (filters.categoryId) qb.andWhere('s.category_id = :categoryId', { categoryId: filters.categoryId });
    if (filters.providerId) qb.andWhere('s.provider_id = :providerId', { providerId: filters.providerId });
    if (filters.wilaya?.length) {
      qb.andWhere('EXISTS (SELECT 1 FROM service_wilayas swf WHERE swf.service_id = s.id AND swf.wilaya_code IN (:...wilayas))', { wilayas: filters.wilaya });
    }
    if (filters.priceMin !== undefined) qb.andWhere('s.base_price >= :priceMin', { priceMin: filters.priceMin });
    if (filters.priceMax !== undefined) qb.andWhere('s.base_price <= :priceMax', { priceMax: filters.priceMax });
    if (filters.priceType) qb.andWhere('s.price_type = :priceType', { priceType: filters.priceType });
    if (filters.ratingMin !== undefined) qb.andWhere('s.avg_rating >= :ratingMin', { ratingMin: filters.ratingMin });
    if (filters.ratingMax !== undefined) qb.andWhere('s.avg_rating <= :ratingMax', { ratingMax: filters.ratingMax });
    if (filters.status) qb.andWhere('s.status = :status', { status: filters.status });
    if (filters.featured !== undefined) qb.andWhere('s.is_featured = :featured', { featured: filters.featured ? 1 : 0 });
    if (filters.providerStatus) qb.andWhere('u.status = :providerStatus', { providerStatus: filters.providerStatus });
    if (filters.createdFrom) qb.andWhere('s.created_at >= :createdFrom', { createdFrom: new Date(`${filters.createdFrom}T00:00:00.000Z`) });
    if (filters.createdTo) qb.andWhere('s.created_at < :createdTo', { createdTo: new Date(new Date(`${filters.createdTo}T00:00:00.000Z`).getTime() + 86_400_000) });
    return qb;
  }

  tabbed(filters: ServiceFiltersDto, em: EntityManager = this.dataSource.manager): SelectQueryBuilder<Service> {
    const qb = this.filtered(filters, em);
    switch (filters.tab) {
      case 'published':
      case 'draft':
      case 'hidden':
        qb.andWhere('s.status = :tabStatus', { tabStatus: filters.tab });
        break;
      case 'waiting_approval':
        qb.andWhere("u.verification_status <> 'verified'");
        break;
      case 'reported':
        qb.andWhere(REPORTED_SQL);
        break;
      default:
        break;
    }
    return qb;
  }

  async fetchRows(filters: ServiceFiltersDto, sort: string | undefined, page: { offset: number; limit: number }, em: EntityManager = this.dataSource.manager): Promise<ServiceRowDto[]> {
    const [field, direction] = Object.entries(toOrder(sort, SERVICE_SORT_FIELDS, ['createdAt', 'DESC']))[0]! as [(typeof SERVICE_SORT_FIELDS)[number], 'ASC' | 'DESC'];
    const raw = await this.selectRow(this.tabbed(filters, em))
      .orderBy(SORT_COLUMNS[field], direction)
      .addOrderBy('s.id', direction)
      .offset(page.offset)
      .limit(page.limit)
      .getRawMany<RawServiceRow>();
    return this.toRows(raw, em);
  }

  async list(query: ServicesQueryDto): Promise<Paginated<ServiceRowDto, ServiceTabCountsDto>> {
    const [rows, counts] = await Promise.all([
      this.fetchRows(query, query.sort, { offset: (query.page - 1) * query.limit, limit: query.limit }),
      this.tabCounts(query),
    ]);
    return paginateWithCounts(rows, counts[query.tab ?? 'all'], query, counts);
  }

  async tabCounts(filters: ServiceFiltersDto): Promise<ServiceTabCountsDto> {
    const raw = await this.filtered({ ...filters, tab: undefined }, this.dataSource.manager, 'filters')
      .select('COUNT(*)', 'all_n')
      .addSelect("SUM(s.status = 'published')", 'published')
      .addSelect("SUM(s.status = 'draft')", 'draft')
      .addSelect("SUM(s.status = 'hidden')", 'hidden')
      .addSelect("SUM(u.verification_status <> 'verified')", 'waiting')
      .addSelect(`SUM(${REPORTED_SQL})`, 'reported')
      .getRawOne<Record<string, string | null>>();
    const n = (value: string | null | undefined) => Number(value ?? 0);
    return {
      all: n(raw?.all_n),
      published: n(raw?.published),
      draft: n(raw?.draft),
      hidden: n(raw?.hidden),
      waiting_approval: n(raw?.waiting),
      reported: n(raw?.reported),
    };
  }

  private selectRow(qb: SelectQueryBuilder<Service>): SelectQueryBuilder<Service> {
    return qb
      .select('s.id', 'id')
      .addSelect('s.title_en', 'title_en')
      .addSelect('s.title_ar', 'title_ar')
      .addSelect('s.category_id', 'category_id')
      .addSelect('c.name_en', 'category_name_en')
      .addSelect('c.name_ar', 'category_name_ar')
      .addSelect('s.provider_id', 'provider_id')
      .addSelect('u.full_name', 'provider_name')
      .addSelect('pp.business_name', 'business_name')
      .addSelect('u.status', 'provider_status')
      .addSelect('u.verification_status', 'provider_verification')
      .addSelect('s.base_price', 'base_price')
      .addSelect('s.price_type', 'price_type')
      .addSelect('s.avg_rating', 'avg_rating')
      .addSelect('s.rating_count', 'rating_count')
      .addSelect('s.bookings_count', 'bookings_count')
      .addSelect('s.status', 'status')
      .addSelect('s.is_featured', 'is_featured')
      .addSelect(SERVICE_VISIBLE_SQL, 'visible')
      .addSelect('s.created_at', 'created_at')
      .addSelect('s.updated_at', 'updated_at');
  }

  private async toRows(raw: RawServiceRow[], em: EntityManager): Promise<ServiceRowDto[]> {
    const ids = raw.map((r) => r.id);
    const [covers, wilayaRows] = await Promise.all([
      this.gallery.covers(em, ids),
      ids.length
        ? em.query(
            `SELECT sw.service_id, w.code, w.name, w.name_ar FROM service_wilayas sw JOIN wilayas w ON w.code = sw.wilaya_code
             WHERE sw.service_id IN (?) ORDER BY w.code`,
            [ids],
          )
        : [],
    ]);
    const wilayas = new Map<string, { code: number; name: string; nameAr: string }[]>();
    for (const w of wilayaRows as { service_id: string; code: number; name: string; name_ar: string }[]) {
      wilayas.set(w.service_id, [...(wilayas.get(w.service_id) ?? []), { code: Number(w.code), name: w.name, nameAr: w.name_ar }]);
    }
    return raw.map((r) => ({
      id: r.id,
      titleEn: r.title_en,
      titleAr: r.title_ar,
      coverUrl: this.gallery.coverUrl(covers.get(r.id)),
      category: { id: r.category_id, nameEn: r.category_name_en ?? '', nameAr: r.category_name_ar ?? '' },
      provider: {
        id: r.provider_id,
        fullName: r.provider_name ?? 'Deleted user',
        businessName: r.business_name,
        status: r.provider_status ?? UserStatus.Blocked,
        verificationStatus: r.provider_verification ?? VerificationStatus.Pending,
      },
      basePrice: String(r.base_price),
      priceType: r.price_type,
      rating: Number(r.avg_rating),
      ratingCount: Number(r.rating_count),
      bookingsCount: Number(r.bookings_count),
      status: r.status,
      isFeatured: Number(r.is_featured) === 1,
      visibleInApp: Number(r.visible) === 1,
      wilayas: wilayas.get(r.id) ?? [],
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
    }));
  }

  // ── detail ──────────────────────────────────────────────────

  async load(id: string, em: EntityManager = this.dataSource.manager, lock = false): Promise<Service> {
    const service = await em.getRepository(Service).findOne({ where: { id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!service) throw AppException.of('SERVICE_NOT_FOUND');
    return service;
  }

  async get(id: string, em: EntityManager = this.dataSource.manager): Promise<ServiceDetailDto> {
    const service = await this.load(id, em);
    const raw = await this.selectRow(this.filtered({}, em).andWhere('s.id = :id', { id })).getRawOne<RawServiceRow>();
    if (!raw) throw AppException.of('SERVICE_NOT_FOUND');
    const [[row], extras, photos, wilayaRows, bookingRows, ratingRows, [favourites], packRows, provider, category] = await Promise.all([
      this.toRows([raw], em),
      em.getRepository(ServiceExtra).find({ where: { serviceId: id }, order: { position: 'ASC', createdAt: 'ASC' } }),
      this.gallery.list(em, id),
      em.query('SELECT w.code, w.name, w.name_ar, w.is_open FROM service_wilayas sw JOIN wilayas w ON w.code = sw.wilaya_code WHERE sw.service_id = ? ORDER BY w.code', [id]),
      em.query('SELECT status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM bookings WHERE service_id = ? AND deleted_at IS NULL GROUP BY status', [id]),
      em.query("SELECT rating, COUNT(*) AS n FROM reviews WHERE service_id = ? AND status = 'published' AND deleted_at IS NULL GROUP BY rating", [id]),
      em.query('SELECT COUNT(*) AS n FROM favourites WHERE service_id = ? AND deleted_at IS NULL', [id]),
      em.query(
        `SELECT p.id, p.name_en, p.name_ar, p.status, p.needs_attention FROM pack_items pi JOIN packs p ON p.id = pi.pack_id
         WHERE pi.service_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at DESC`,
        [id],
      ),
      this.providerCard(service.providerId, em),
      em.getRepository(Category).findOne({ where: { id: service.categoryId } }),
    ]);
    const hiddenBy = service.hiddenById ? await em.getRepository(User).findOne({ where: { id: service.hiddenById }, withDeleted: true }) : null;

    const byStatus = new Map<string, { n: number; amount: string }>(bookingRows.map((b: any) => [b.status, { n: Number(b.n), amount: String(b.amount) }]));
    const count = (status: BookingStatus) => byStatus.get(status)?.n ?? 0;
    const stars = new Map<number, number>(ratingRows.map((r: any) => [Number(r.rating), Number(r.n)]));
    const wilayaDetails = wilayaRows.map((w: any) => ({ code: Number(w.code), name: w.name, nameAr: w.name_ar, isOpen: Number(w.is_open) === 1 }));
    const providerUser = await em.getRepository(User).findOne({ where: { id: service.providerId }, withDeleted: true });

    return {
      ...row!,
      descriptionEn: service.descriptionEn,
      descriptionAr: service.descriptionAr,
      cancellationPolicyEn: service.cancellationPolicyEn,
      cancellationPolicyAr: service.cancellationPolicyAr,
      facts: service.facts ?? [],
      maxEventsPerDay: service.maxEventsPerDay,
      maxGuests: service.maxGuests,
      concurrentClients: service.concurrentClients,
      availableFrom: service.availableFrom,
      availableUntil: service.availableUntil,
      hours: await this.hoursOf(em, id),
      featuredPosition: service.featuredPosition,
      favouritesCount: service.favouritesCount,
      extras: extras.map((e) => ({ id: e.id, nameEn: e.nameEn, nameAr: e.nameAr, price: e.price, position: e.position })),
      photos,
      wilayaDetails,
      hidden:
        service.status === ServiceStatus.Hidden
          ? {
              reason: service.hiddenReason ?? 'other',
              message: service.hiddenNote,
              allowResubmit: service.allowResubmit,
              hiddenBy: hiddenBy ? { id: hiddenBy.id, fullName: hiddenBy.fullName } : null,
              hiddenAt: iso(service.hiddenAt),
            }
          : null,
      visibilityReasons: serviceVisibilityReasons({
        status: service.status,
        deleted: false,
        provider: {
          status: providerUser?.status ?? UserStatus.Blocked,
          verificationStatus: providerUser?.verificationStatus ?? VerificationStatus.Pending,
          deleted: !providerUser || providerUser.deletedAt !== null,
        },
        openWilayas: wilayaDetails.filter((w: { isOpen: boolean }) => w.isOpen).length,
        availableUntil: service.availableUntil,
        today: algiersToday(),
      }),
      publishMissing: servicePublishMissing({
        titleEn: service.titleEn,
        titleAr: service.titleAr,
        descriptionEn: service.descriptionEn,
        descriptionAr: service.descriptionAr,
        basePrice: service.basePrice,
        priceType: service.priceType,
        photos: photos.length,
        categoryUsable: !!category?.isVisible,
        wilayas: wilayaDetails.length,
      }),
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
        ratingBreakdown: { 5: stars.get(5) ?? 0, 4: stars.get(4) ?? 0, 3: stars.get(3) ?? 0, 2: stars.get(2) ?? 0, 1: stars.get(1) ?? 0 },
        favourites: Number(favourites.n),
        packsCount: packRows.length,
        packs: packRows.map((p: any) => ({ id: p.id, nameEn: p.name_en, nameAr: p.name_ar, status: p.status, needsAttention: Number(p.needs_attention) === 1 })),
      },
      providerCard: provider,
    };
  }

  private async providerCard(providerId: string, em: EntityManager): Promise<ServiceDetailDto['providerCard']> {
    const [user, profile, [services], [packs], [bookings]] = await Promise.all([
      em.getRepository(User).findOne({ where: { id: providerId }, withDeleted: true }),
      em.getRepository(ProviderProfile).findOne({ where: { userId: providerId }, withDeleted: true }),
      em.query('SELECT COUNT(*) AS n FROM services WHERE provider_id = ? AND deleted_at IS NULL', [providerId]),
      em.query('SELECT COUNT(*) AS n FROM packs WHERE provider_id = ? AND deleted_at IS NULL', [providerId]),
      em.query("SELECT COUNT(*) AS n, COALESCE(SUM(status = 'completed'), 0) AS completed FROM bookings WHERE provider_id = ? AND deleted_at IS NULL", [providerId]),
    ]);
    return {
      id: providerId,
      fullName: user?.fullName ?? 'Deleted user',
      businessName: profile?.businessName ?? null,
      status: user?.status ?? UserStatus.Blocked,
      verificationStatus: user?.verificationStatus ?? VerificationStatus.Pending,
      avatarUrl: user?.avatarFileId ? this.files.signedUrl(user.avatarFileId, { variant: FileVariantKind.Thumb }) : null,
      phone: user?.phone ?? null,
      email: user?.email ?? '',
      rating: Number(profile?.avgRating ?? 0),
      ratingCount: profile?.ratingCount ?? 0,
      acceptingBookings: profile?.acceptingBookings ?? false,
      servicesCount: Number(services.n),
      packsCount: Number(packs.n),
      bookingsCount: Number(bookings.n),
      completedBookingsCount: Number(bookings.completed),
    };
  }

  // ── create / update ─────────────────────────────────────────

  private async assertProvider(em: EntityManager, providerId: string): Promise<User> {
    const user = await em.getRepository(User).findOne({ where: { id: providerId } });
    if (!user || user.role !== UserRole.Provider) throw AppException.of('NOT_A_PROVIDER', { providerId });
    return user;
  }

  private async assertCategory(em: EntityManager, categoryId: string): Promise<void> {
    const category = await em.getRepository(Category).findOne({ where: { id: categoryId } });
    if (!category) throw new AppException(422, 'CATEGORY_NOT_FOUND', { categoryId });
    if (!category.isVisible) throw AppException.of('CATEGORY_HIDDEN', { categoryId });
  }

  /** Every code must exist; `added` ones must be open. */
  private async assertWilayas(em: EntityManager, codes: number[], added: number[]): Promise<void> {
    if (codes.length === 0) return;
    const wilayas = await em.getRepository(Wilaya).find({ where: { code: In(codes) } });
    if (wilayas.length !== new Set(codes).size) {
      const known = new Set(wilayas.map((w) => w.code));
      throw new AppException(422, 'WILAYA_NOT_FOUND', { wilayaCodes: codes.filter((c) => !known.has(c)) });
    }
    const closed = wilayas.filter((w) => added.includes(w.code) && !w.isOpen).map((w) => w.code);
    if (closed.length > 0) throw AppException.of('WILAYA_CLOSED', { closed });
  }

  private async replaceExtras(em: EntityManager, serviceId: string, extras: UpdateServiceDto['extras'] & object): Promise<void> {
    await em.getRepository(ServiceExtra).delete({ serviceId });
    if (extras.length === 0) return;
    await em.getRepository(ServiceExtra).save(extras.map((e, position) => em.getRepository(ServiceExtra).create({ serviceId, nameEn: e.nameEn, nameAr: e.nameAr, price: e.price, position })));
  }

  /** The service's weekly hours as `HH:mm` ranges, by weekday then start. */
  async hoursOf(em: EntityManager, serviceId: string): Promise<HourRange[]> {
    const rows = await em.getRepository(ServiceHour).find({ where: { serviceId }, order: { weekday: 'ASC', startTime: 'ASC' } });
    return rows.map((h) => ({ weekday: h.weekday, startTime: h.startTime.slice(0, 5), endTime: h.endTime.slice(0, 5) }));
  }

  private async replaceHours(em: EntityManager, serviceId: string, hours: HourRange[]): Promise<void> {
    assertValidHours(hours);
    await em.getRepository(ServiceHour).delete({ serviceId });
    if (hours.length === 0) return;
    await em.getRepository(ServiceHour).insert(hours.map((h) => ({ serviceId, weekday: h.weekday, startTime: h.startTime, endTime: h.endTime })));
  }

  private assertPeriod(from: string | null | undefined, until: string | null | undefined): void {
    if (from && until && until < from) {
      throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'availableUntil', code: 'BEFORE_FROM', message: 'availableUntil must not be before availableFrom' }]);
    }
  }

  private async replaceWilayas(em: EntityManager, serviceId: string, codes: number[]): Promise<void> {
    await em.getRepository(ServiceWilaya).delete({ serviceId });
    if (codes.length === 0) return;
    await em.getRepository(ServiceWilaya).insert(codes.map((wilayaCode) => ({ serviceId, wilayaCode, createdAt: new Date() })));
  }

  /** Throws 422 SERVICE_PUBLISH_INVALID with `details.missing` unless the service passes the publish guard. */
  async assertPublishable(em: EntityManager, service: Service): Promise<void> {
    const [photos, [wilayas], category] = await Promise.all([
      this.gallery.count(em, service.id),
      em.query('SELECT COUNT(*) AS n FROM service_wilayas WHERE service_id = ?', [service.id]),
      em.getRepository(Category).findOne({ where: { id: service.categoryId } }),
    ]);
    const missing = servicePublishMissing({
      titleEn: service.titleEn,
      titleAr: service.titleAr,
      descriptionEn: service.descriptionEn,
      descriptionAr: service.descriptionAr,
      basePrice: service.basePrice,
      priceType: service.priceType,
      photos,
      categoryUsable: !!category?.isVisible,
      wilayas: Number(wilayas.n),
    });
    if (missing.length > 0) throw AppException.of('SERVICE_PUBLISH_INVALID', { missing });
  }

  async create(auth: AuthUser, dto: CreateServiceDto): Promise<ServiceDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const provider = await this.assertProvider(em, dto.providerId);
      await this.assertCategory(em, dto.categoryId);
      const wilayaCodes = dto.wilayaCodes ?? [];
      await this.assertWilayas(em, wilayaCodes, wilayaCodes);
      this.assertPeriod(dto.availableFrom, dto.availableUntil);

      const repository = em.getRepository(Service);
      const service = await repository.save(
        repository.create({
          providerId: dto.providerId,
          categoryId: dto.categoryId,
          titleEn: dto.titleEn,
          titleAr: dto.titleAr ?? '',
          descriptionEn: dto.descriptionEn ?? '',
          descriptionAr: dto.descriptionAr ?? '',
          cancellationPolicyEn: dto.cancellationPolicyEn ?? null,
          cancellationPolicyAr: dto.cancellationPolicyAr ?? null,
          facts: dto.facts ?? null,
          basePrice: dto.basePrice,
          priceType: dto.priceType,
          maxEventsPerDay: dto.maxEventsPerDay ?? 1,
          maxGuests: dto.maxGuests ?? null,
          concurrentClients: dto.concurrentClients ?? 1,
          availableFrom: dto.availableFrom ?? null,
          availableUntil: dto.availableUntil ?? null,
          status: ServiceStatus.Draft,
        }),
      );
      await this.replaceWilayas(em, service.id, wilayaCodes);
      await this.replaceExtras(em, service.id, dto.extras ?? []);
      await this.replaceHours(em, service.id, dto.hours ?? []);
      if (dto.status === ServiceStatus.Published) {
        await this.assertPublishable(em, service);
        await repository.update(service.id, { status: ServiceStatus.Published });
      }
      await this.audit.log(
        {
          action: 'service.created',
          objectType: 'service',
          objectId: service.id,
          objectLabel: service.titleEn,
          level: AuditLevel.Normal,
          changes: {
            providerId: { from: null, to: service.providerId },
            categoryId: { from: null, to: service.categoryId },
            titleEn: { from: null, to: service.titleEn },
            basePrice: { from: null, to: service.basePrice },
            status: { from: null, to: dto.status ?? ServiceStatus.Draft },
          },
          note: `Created for ${provider.fullName}`,
        },
        em,
      );
      if (dto.status === ServiceStatus.Published) this.emit(afterCommit, SERVICE_EVENTS.published, await this.eventPayload(em, service));
      return this.get(service.id, em);
    });
  }

  async update(auth: AuthUser, id: string, dto: UpdateServiceDto): Promise<ServiceDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const service = await this.load(id, em, true);
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      if (dto.providerId !== undefined && dto.providerId !== service.providerId) {
        await this.assertProvider(em, dto.providerId);
        const [inPacks] = await em.query('SELECT COUNT(DISTINCT pi.pack_id) AS n FROM pack_items pi JOIN packs p ON p.id = pi.pack_id WHERE pi.service_id = ? AND p.deleted_at IS NULL', [id]);
        if (Number(inPacks.n) > 0) throw AppException.of('SERVICE_IN_PACKS', { packsCount: Number(inPacks.n) });
        changes.providerId = { from: service.providerId, to: dto.providerId };
        service.providerId = dto.providerId;
      }
      if (dto.categoryId !== undefined && dto.categoryId !== service.categoryId) {
        await this.assertCategory(em, dto.categoryId);
        changes.categoryId = { from: service.categoryId, to: dto.categoryId };
        service.categoryId = dto.categoryId;
      }
      for (const field of UPDATABLE_FIELDS) {
        const next = dto[field];
        if (next !== undefined && next !== service[field]) {
          changes[field] = { from: service[field], to: next };
          (service as any)[field] = next;
        }
      }
      if (dto.facts !== undefined && JSON.stringify(dto.facts) !== JSON.stringify(service.facts)) {
        changes.facts = { from: service.facts, to: dto.facts };
        service.facts = dto.facts;
      }

      if (dto.wilayaCodes !== undefined) {
        const current = (await em.getRepository(ServiceWilaya).find({ where: { serviceId: id } })).map((w) => w.wilayaCode).sort((a, b) => a - b);
        const next = [...dto.wilayaCodes].sort((a, b) => a - b);
        if (JSON.stringify(current) !== JSON.stringify(next)) {
          await this.assertWilayas(em, next, next.filter((c) => !current.includes(c)));
          await this.replaceWilayas(em, id, next);
          changes.wilayaCodes = { from: current, to: next };
        }
      }
      this.assertPeriod(service.availableFrom, service.availableUntil);
      if (dto.hours !== undefined) {
        const current = await this.hoursOf(em, id);
        const shape = (list: HourRange[]) => JSON.stringify([...list].map((h) => [h.weekday, h.startTime, h.endTime]).sort());
        if (shape(current) !== shape(dto.hours)) {
          await this.replaceHours(em, id, dto.hours);
          changes.hours = { from: current, to: dto.hours };
        }
      }
      if (dto.extras !== undefined) {
        const current = await em.getRepository(ServiceExtra).find({ where: { serviceId: id }, order: { position: 'ASC' } });
        const shape = (list: { nameEn: string; nameAr: string; price: string }[]) => JSON.stringify(list.map((e) => [e.nameEn, e.nameAr, fromCents(toCents(e.price))]));
        if (shape(current) !== shape(dto.extras)) {
          await this.replaceExtras(em, id, dto.extras);
          changes.extras = { from: current.length, to: dto.extras.length };
        }
      }

      const from = service.status;
      let event: string | null = null;
      if (dto.status !== undefined && dto.status !== from) {
        const action: ServiceAction = dto.status === ServiceStatus.Published ? 'publish' : 'unpublish';
        if (!canTransition(action, from)) throw AppException.of('SERVICE_INVALID_TRANSITION', { status: from, action });
        service.status = dto.status;
        if (dto.status === ServiceStatus.Draft) this.clearFeatured(service);
        changes.status = { from, to: dto.status };
        event = action === 'publish' ? SERVICE_EVENTS.published : SERVICE_EVENTS.unpublished;
      }
      if (service.status === ServiceStatus.Published) await this.assertPublishable(em, service);

      if (Object.keys(changes).length > 0) {
        await em.getRepository(Service).save(service);
        if (changes.status) await this.compactFeatured(em);
        const health = changes.status || changes.providerId ? await this.packHealth.recompute(em, afterCommit, { serviceIds: [id] }) : null;
        await this.audit.log(
          {
            action: 'service.updated',
            objectType: 'service',
            objectId: id,
            objectLabel: service.titleEn,
            level: AuditLevel.Normal,
            changes: { ...changes, ...(health?.nowNeedingAttention.length ? { packsNeedingAttention: health.nowNeedingAttention } : {}) },
          },
          em,
        );
        this.emit(afterCommit, event ?? SERVICE_EVENTS.updated, await this.eventPayload(em, service));
      }
      return this.get(id, em);
    });
  }

  // ── moderation actions ──────────────────────────────────────

  private clearFeatured(service: Service): void {
    service.isFeatured = false;
    service.featuredPosition = null;
  }

  /** Renumbers featured positions 1…n after one leaves the list. */
  private async compactFeatured(em: EntityManager): Promise<void> {
    const rows: { id: string; featured_position: number | null }[] = await em.query(
      'SELECT id, featured_position FROM services WHERE is_featured = 1 AND deleted_at IS NULL ORDER BY featured_position, updated_at, id FOR UPDATE',
    );
    for (const [index, row] of rows.entries()) {
      if (Number(row.featured_position) !== index + 1) await em.query('UPDATE services SET featured_position = ? WHERE id = ?', [index + 1, row.id]);
    }
  }

  async transition(auth: AuthUser, id: string, action: ServiceAction, dto?: HideServiceDto): Promise<ServiceDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const service = await this.load(id, em, true);
      const from = service.status;
      if (!canTransition(action, from)) throw AppException.of('SERVICE_INVALID_TRANSITION', { status: from, action });

      let level = AuditLevel.Normal;
      let note: string | null = null;
      switch (action) {
        case 'publish':
          await this.assertPublishable(em, service);
          service.status = ServiceStatus.Published;
          break;
        case 'show':
          await this.assertPublishable(em, service);
          service.status = ServiceStatus.Published;
          service.hiddenReason = null;
          service.hiddenNote = null;
          service.hiddenById = null;
          service.hiddenAt = null;
          service.allowResubmit = true;
          break;
        case 'unpublish':
          service.status = ServiceStatus.Draft;
          this.clearFeatured(service);
          break;
        case 'hide':
          service.status = ServiceStatus.Hidden;
          service.hiddenReason = dto!.reason;
          service.hiddenNote = dto!.message ?? null;
          service.hiddenById = auth.id;
          service.hiddenAt = new Date();
          service.allowResubmit = dto!.allowResubmit;
          this.clearFeatured(service);
          level = AuditLevel.Sensitive;
          note = dto!.message ?? null;
          break;
      }
      await em.getRepository(Service).save(service);
      await this.compactFeatured(em);
      const health = await this.packHealth.recompute(em, afterCommit, { serviceIds: [id] });
      await this.audit.log(
        {
          action: `service.${action === 'show' ? 'shown' : action === 'hide' ? 'hidden' : `${action}ed`}`,
          objectType: 'service',
          objectId: id,
          objectLabel: service.titleEn,
          level,
          changes: {
            status: { from, to: service.status },
            ...(action === 'hide' ? { reason: dto!.reason, allowResubmit: dto!.allowResubmit } : {}),
            packsNeedingAttention: health.nowNeedingAttention,
            packsResolved: health.resolved,
          },
          note,
        },
        em,
      );
      const payload = await this.eventPayload(em, service);
      if (action === 'hide') {
        this.emit<ServiceHiddenEvent>(afterCommit, SERVICE_EVENTS.hidden, { ...payload, reason: dto!.reason, message: dto!.message ?? null, allowResubmit: dto!.allowResubmit });
      } else {
        this.emit(afterCommit, action === 'show' ? SERVICE_EVENTS.shown : action === 'publish' ? SERVICE_EVENTS.published : SERVICE_EVENTS.unpublished, payload);
      }
      return this.get(id, em);
    });
  }

  async feature(auth: AuthUser, id: string, featured: boolean): Promise<ServiceDetailDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const current: { id: string; featured_position: number | null }[] = await em.query(
        'SELECT id, featured_position FROM services WHERE is_featured = 1 AND deleted_at IS NULL FOR UPDATE',
      );
      const service = await this.load(id, em, true);
      if (featured) {
        const refusal = featureRefusal(service.status, current.length, service.isFeatured);
        if (refusal === 'FEATURED_LIMIT') throw AppException.of('FEATURED_LIMIT', { max: MAX_FEATURED_SERVICES });
        if (refusal) throw AppException.of('SERVICE_INVALID_TRANSITION', { status: service.status, action: 'feature' });
        if (service.isFeatured) return this.get(id, em);
        const position = current.reduce((max, row) => Math.max(max, Number(row.featured_position ?? 0)), 0) + 1;
        await em.getRepository(Service).update(id, { isFeatured: true, featuredPosition: position });
      } else {
        if (!service.isFeatured) return this.get(id, em);
        await em.getRepository(Service).update(id, { isFeatured: false, featuredPosition: null });
        await this.compactFeatured(em);
      }
      await this.audit.log(
        {
          action: featured ? 'service.featured' : 'service.unfeatured',
          objectType: 'service',
          objectId: id,
          objectLabel: service.titleEn,
          level: AuditLevel.Normal,
          changes: { isFeatured: { from: service.isFeatured, to: featured } },
        },
        em,
      );
      return this.get(id, em);
    });
  }

  async remove(auth: AuthUser, id: string, force: boolean): Promise<ServiceDeletedDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const service = await this.load(id, em, true);
      const upcoming = await this.bookings.upcomingAccepted(em, 'service_id', id);
      if (upcoming > 0 && !force) throw AppException.of('SERVICE_HAS_BOOKINGS', { upcomingBookings: upcoming });
      const cancelledBookings = await this.bookings.cancelPendingFor(em, afterCommit, { column: 'service_id', id, reason: 'service_deleted', actorId: auth.id, causedByUserId: service.providerId });
      await em.getRepository(Service).update(id, { isFeatured: false, featuredPosition: null });
      await em.getRepository(Service).softDelete(id);
      await em.query("UPDATE availability_blocks SET deleted_at = ? WHERE service_id = ? AND kind = 'blocked' AND deleted_at IS NULL", [new Date(), id]);
      await this.compactFeatured(em);
      const health = await this.packHealth.recompute(em, afterCommit, { serviceIds: [id] });
      await this.audit.log(
        {
          action: 'service.deleted',
          objectType: 'service',
          objectId: id,
          objectLabel: service.titleEn,
          level: AuditLevel.Sensitive,
          changes: { status: service.status, cancelledBookings, keptUpcomingBookings: upcoming, force, packsNeedingAttention: health.nowNeedingAttention },
        },
        em,
      );
      this.emit(afterCommit, SERVICE_EVENTS.deleted, await this.eventPayload(em, service));
      return { id, cancelledBookings, keptUpcomingBookings: upcoming, packsNeedingAttention: health.nowNeedingAttention.length };
    });
  }

  // ── photos ──────────────────────────────────────────────────

  async addPhoto(auth: AuthUser, id: string, file: UploadedPhotoFile): Promise<PhotoDto[]> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const service = await this.load(id, em, true);
      const max = await this.settings.get('max_photos_per_service');
      const fileId = await this.gallery.add(em, afterCommit, id, file, max, service.providerId);
      await this.audit.log(
        { action: 'service.photo_added', objectType: 'service', objectId: id, objectLabel: service.titleEn, level: AuditLevel.Info, changes: { fileId } },
        em,
      );
      return this.gallery.list(em, id);
    });
  }

  async reorderPhotos(auth: AuthUser, id: string, ids: string[]): Promise<PhotoDto[]> {
    return runInTransaction(this.dataSource, async (em) => {
      const service = await this.load(id, em, true);
      await this.gallery.reorder(em, id, ids);
      await this.audit.log(
        { action: 'service.photos_reordered', objectType: 'service', objectId: id, objectLabel: service.titleEn, level: AuditLevel.Info, changes: { order: ids } },
        em,
      );
      return this.gallery.list(em, id);
    });
  }

  async removePhoto(auth: AuthUser, id: string, photoId: string): Promise<PhotoDto[]> {
    return runInTransaction(this.dataSource, async (em) => {
      const service = await this.load(id, em, true);
      const photos = await this.gallery.rows(em, [id]);
      if (!photos.some((p) => p.id === photoId)) throw AppException.of('PHOTO_NOT_FOUND');
      if (service.status === ServiceStatus.Published && photos.length === 1) throw AppException.of('SERVICE_PUBLISH_INVALID', { missing: ['photos'] });
      const { fileId } = await this.gallery.remove(em, id, photoId);
      await this.audit.log(
        { action: 'service.photo_removed', objectType: 'service', objectId: id, objectLabel: service.titleEn, level: AuditLevel.Info, changes: { photoId, fileId } },
        em,
      );
      return this.gallery.list(em, id);
    });
  }

  // ── events ──────────────────────────────────────────────────

  private emit<T extends object>(afterCommit: AfterCommit, name: string, payload: T): void {
    this.events.emitAfterCommit(afterCommit, name, payload);
  }

  private async eventPayload(em: EntityManager, service: Service): Promise<ServiceEvent> {
    const user = await em.getRepository(User).findOne({ where: { id: service.providerId }, withDeleted: true });
    return {
      serviceId: service.id,
      providerId: service.providerId,
      titleEn: service.titleEn,
      titleAr: service.titleAr,
      provider: { userId: service.providerId, email: user?.email ?? '', name: user?.fullName ?? '', lang: (user?.language ?? 'en') as Lang },
    };
  }
}
