import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, In, Not, type DataSource, type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { VerificationCode } from '../auth/entities/verification-code.entity.js';
import { createKeyedToken } from '../auth/refresh-token.js';
import { Category } from '../catalog/entities/category.entity.js';
import { Wilaya } from '../catalog/entities/wilaya.entity.js';
import { likeContains } from '../common/dto/transforms.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { VerificationCodePurpose } from '../common/enums/auth.enums.js';
import { BookingStatus } from '../common/enums/booking.enums.js';
import { FileVariantKind } from '../common/enums/file.enums.js';
import { DisputeStatus } from '../common/enums/moderation.enums.js';
import { UserRole, UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { paginate, paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import type { PaginationQueryDto } from '../common/pagination/pagination-query.dto.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { UserDocument } from '../verification/entities/user-document.entity.js';
import { documentSummary } from '../verification/verification.policy.js';
import {
  USER_SORT_FIELDS,
  type CreateNoteDto,
  type CreateUserDto,
  type NoteDto,
  type UpdateUserDto,
  type UserDetailDto,
  type UserFiltersDto,
  type UserRowDto,
  type UsersQueryDto,
  type UserStatsDto,
  type UserTabCountsDto,
  type WilayaRefDto,
} from './dto/users.dto.js';
import { ProviderProfile } from './entities/provider-profile.entity.js';
import { ProviderWilaya } from './entities/provider-wilaya.entity.js';
import { UserNote } from './entities/user-note.entity.js';
import { User } from './entities/user.entity.js';
import { USER_EVENTS, type UserInvitedEvent } from './users.events.js';
import { initialVerificationStatus, normalisePhone } from './users.policy.js';

export const INVITATION_TOKEN_TTL_DAYS = 7;

/** Bookings of any status, as provider or as client (index `(provider_id, status)` / `(client_id, created_at)`). */
const BOOKINGS_COUNT_SQL = (status?: BookingStatus) => {
  const statusSql = status ? ` AND b.status = '${status}'` : '';
  return (
    `(CASE WHEN u.role = 'provider' ` +
    `THEN (SELECT COUNT(*) FROM bookings b WHERE b.provider_id = u.id AND b.deleted_at IS NULL${statusSql}) ` +
    `ELSE (SELECT COUNT(*) FROM bookings b WHERE b.client_id = u.id AND b.deleted_at IS NULL${statusSql}) END)`
  );
};

const SORT_COLUMNS: Record<(typeof USER_SORT_FIELDS)[number], string> = {
  createdAt: 'u.created_at',
  fullName: 'u.full_name',
  lastActiveAt: 'u.last_active_at',
  bookingsCount: 'bookings_count',
  rating: 'pp.avg_rating',
};

const LAST_ACTIVE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;

const PROVIDER_FIELDS = ['businessName', 'categoryId', 'bioEn', 'bioAr', 'wilayaCodes', 'acceptingBookings', 'languagesSpoken', 'yearsActive'] as const;

interface RawUserRow {
  id: string;
  role: UserRole;
  full_name: string;
  email: string;
  phone: string | null;
  avatar_file_id: string | null;
  status: UserStatus;
  verification_status: VerificationStatus;
  wilaya_code: number | null;
  wilaya_name: string | null;
  wilaya_name_ar: string | null;
  business_name: string | null;
  category_id: string | null;
  category_name_en: string | null;
  category_name_ar: string | null;
  avg_rating: string | null;
  rating_count: number | null;
  bookings_count: string | number;
  last_active_at: Date | null;
  created_at: Date;
}

export const iso = (value: Date | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

/** `YYYY-MM-DD` from a DATE column (mysql2 returns a UTC-midnight Date) or a string. */
export const dateOnly = (value: Date | string): string => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

/** Today in Africa/Algiers (event dates are local dates). */
export function algiersToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const counts = (rows: { k: string; n: string | number }[]) => new Map(rows.map((r) => [r.k, Number(r.n)]));

/**
 * `q` on users (alias `u`) joined to provider profiles (alias `pp`): full-text on
 * name and email (words of 3+ characters, prefix match), exact email, exact phone
 * in any accepted format, business name contains.
 */
export function userSearch(q: string): Brackets {
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  return new Brackets((w) => {
    if (words.length > 0) {
      w.where('MATCH(u.full_name, u.email) AGAINST (:ft IN BOOLEAN MODE)', { ft: words.map((word) => `+${word}*`).join(' ') });
    } else {
      w.where('u.full_name LIKE :qPrefix', { qPrefix: `${likeContains(q).slice(1)}` });
    }
    w.orWhere('u.email = :qEmail', { qEmail: q.toLowerCase() })
      .orWhere('u.phone = :qPhone', { qPhone: normalisePhone(q) ?? q })
      .orWhere('pp.business_name LIKE :qLike', { qLike: likeContains(q) });
  });
}

/** USR-01…USR-11: list, profile, create, edit and internal notes of client and provider accounts. */
@Injectable()
export class UsersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly files: FilesService,
  ) {}

  // ── list ────────────────────────────────────────────────────

  /** Base query: clients and providers (never admins, never deleted) with every filter except the tab. */
  filtered(filters: UserFiltersDto, em: EntityManager = this.dataSource.manager, joins: 'row' | 'filters' = 'row'): SelectQueryBuilder<User> {
    const qb = em.getRepository(User).createQueryBuilder('u');
    // Counters only join what a filter reads: every join is at most one row per user, so
    // skipping unused ones changes no count but saves a join per user on large tables.
    const needsProfile = joins === 'row' || Boolean(filters.q) || Boolean(filters.categoryId) || filters.minRating !== undefined || filters.maxRating !== undefined;
    if (needsProfile) qb.leftJoin(ProviderProfile, 'pp', 'pp.user_id = u.id AND pp.deleted_at IS NULL');
    if (joins === 'row') qb.leftJoin(Category, 'c', 'c.id = pp.category_id').leftJoin(Wilaya, 'w', 'w.code = u.wilaya_code');
    qb.where('u.role IN (:...managedRoles)', { managedRoles: [UserRole.Client, UserRole.Provider] });

    if (filters.q) qb.andWhere(userSearch(filters.q));
    if (filters.role) qb.andWhere('u.role = :role', { role: filters.role });
    if (filters.status) qb.andWhere('u.status = :status', { status: filters.status });
    if (filters.verificationStatus) qb.andWhere('u.verification_status = :verificationStatus', { verificationStatus: filters.verificationStatus });
    if (filters.wilaya?.length) qb.andWhere('u.wilaya_code IN (:...wilayas)', { wilayas: filters.wilaya });
    if (filters.categoryId) qb.andWhere('pp.category_id = :categoryId', { categoryId: filters.categoryId });
    if (filters.minRating !== undefined) qb.andWhere('pp.avg_rating >= :minRating', { minRating: filters.minRating });
    if (filters.maxRating !== undefined) qb.andWhere('pp.avg_rating <= :maxRating', { maxRating: filters.maxRating });
    if (filters.joinedFrom) qb.andWhere('u.created_at >= :joinedFrom', { joinedFrom: new Date(`${filters.joinedFrom}T00:00:00.000Z`) });
    if (filters.joinedTo) {
      qb.andWhere('u.created_at < :joinedTo', { joinedTo: new Date(new Date(`${filters.joinedTo}T00:00:00.000Z`).getTime() + 86_400_000) });
    }
    if (filters.minCompletedBookings !== undefined) {
      qb.andWhere(`${BOOKINGS_COUNT_SQL(BookingStatus.Completed)} >= :minCompleted`, { minCompleted: filters.minCompletedBookings });
    }
    if (filters.maxCompletedBookings !== undefined) {
      qb.andWhere(`${BOOKINGS_COUNT_SQL(BookingStatus.Completed)} <= :maxCompleted`, { maxCompleted: filters.maxCompletedBookings });
    }
    if (filters.lastActive === 'never') qb.andWhere('u.last_active_at IS NULL');
    else if (filters.lastActive) {
      qb.andWhere('u.last_active_at >= :activeSince', { activeSince: new Date(Date.now() - LAST_ACTIVE_DAYS[filters.lastActive] * 86_400_000) });
    }
    if (filters.language) qb.andWhere('u.language = :language', { language: filters.language });
    return qb;
  }

  /** Base query plus the tab. */
  tabbed(filters: UserFiltersDto, em: EntityManager = this.dataSource.manager): SelectQueryBuilder<User> {
    const qb = this.filtered(filters, em);
    switch (filters.tab) {
      case 'clients':
        qb.andWhere("u.role = 'client'");
        break;
      case 'providers':
        qb.andWhere("u.role = 'provider'");
        break;
      case 'blocked':
        qb.andWhere("u.status = 'blocked'");
        break;
      case 'awaiting_verification':
        qb.andWhere("u.role = 'provider' AND u.verification_status = 'pending'");
        break;
      default:
        break;
    }
    return qb;
  }

  /** One page of rows in the requested order (also used by the export). */
  async fetchRows(
    filters: UserFiltersDto,
    sort: string | undefined,
    page: { offset: number; limit: number },
    em: EntityManager = this.dataSource.manager,
  ): Promise<UserRowDto[]> {
    const [field, direction] = Object.entries(toOrder(sort, USER_SORT_FIELDS, ['createdAt', 'DESC']))[0]! as [
      (typeof USER_SORT_FIELDS)[number],
      'ASC' | 'DESC',
    ];
    const raw = await this.selectRow(this.tabbed(filters, em))
      .orderBy(SORT_COLUMNS[field], direction)
      // Same direction as the sort column so MySQL can read the (column, id) index backwards.
      .addOrderBy('u.id', direction)
      .offset(page.offset)
      .limit(page.limit)
      .getRawMany<RawUserRow>();
    return this.toRows(raw, em);
  }

  async list(query: UsersQueryDto): Promise<Paginated<UserRowDto, UserTabCountsDto>> {
    const [rows, tabCounts] = await Promise.all([
      this.fetchRows(query, query.sort, { offset: (query.page - 1) * query.limit, limit: query.limit }),
      this.tabCounts(query),
    ]);
    // The tab counters follow every other filter, so the current tab's counter is the total.
    return paginateWithCounts(rows, tabCounts[query.tab ?? 'all'], query, tabCounts);
  }

  /** Tab counters in one grouped query; they follow every filter except the tab. */
  async tabCounts(filters: UserFiltersDto): Promise<UserTabCountsDto> {
    const raw = await this.filtered({ ...filters, tab: undefined }, this.dataSource.manager, 'filters')
      .select('COUNT(*)', 'all_n')
      .addSelect("SUM(u.role = 'client')", 'clients')
      .addSelect("SUM(u.role = 'provider')", 'providers')
      .addSelect("SUM(u.status = 'blocked')", 'blocked')
      .addSelect("SUM(u.role = 'provider' AND u.verification_status = 'pending')", 'awaiting')
      .getRawOne<Record<string, string | null>>();
    const n = (value: string | null | undefined) => Number(value ?? 0);
    return {
      all: n(raw?.all_n),
      clients: n(raw?.clients),
      providers: n(raw?.providers),
      blocked: n(raw?.blocked),
      awaiting_verification: n(raw?.awaiting),
    };
  }

  private selectRow(qb: SelectQueryBuilder<User>): SelectQueryBuilder<User> {
    return qb
      .select('u.id', 'id')
      .addSelect('u.role', 'role')
      .addSelect('u.full_name', 'full_name')
      .addSelect('u.email', 'email')
      .addSelect('u.phone', 'phone')
      .addSelect('u.avatar_file_id', 'avatar_file_id')
      .addSelect('u.status', 'status')
      .addSelect('u.verification_status', 'verification_status')
      .addSelect('u.wilaya_code', 'wilaya_code')
      .addSelect('w.name', 'wilaya_name')
      .addSelect('w.name_ar', 'wilaya_name_ar')
      .addSelect('pp.business_name', 'business_name')
      .addSelect('c.id', 'category_id')
      .addSelect('c.name_en', 'category_name_en')
      .addSelect('c.name_ar', 'category_name_ar')
      .addSelect('pp.avg_rating', 'avg_rating')
      .addSelect('pp.rating_count', 'rating_count')
      .addSelect(BOOKINGS_COUNT_SQL(), 'bookings_count')
      .addSelect('u.last_active_at', 'last_active_at')
      .addSelect('u.created_at', 'created_at');
  }

  private async toRows(raw: RawUserRow[], em: EntityManager): Promise<UserRowDto[]> {
    const providerIds = raw.filter((r) => r.role === UserRole.Provider).map((r) => r.id);
    const services = providerIds.length
      ? counts(
          await em.query('SELECT provider_id AS k, COUNT(*) AS n FROM services WHERE deleted_at IS NULL AND provider_id IN (?) GROUP BY provider_id', [
            providerIds,
          ]),
        )
      : new Map<string, number>();
    return raw.map((r) => {
      const isProvider = r.role === UserRole.Provider;
      return {
        id: r.id,
        role: r.role,
        fullName: r.full_name,
        email: r.email,
        phone: r.phone,
        avatarUrl: r.avatar_file_id ? this.files.signedUrl(r.avatar_file_id, { variant: FileVariantKind.Thumb }) : null,
        status: r.status,
        verificationStatus: r.verification_status,
        wilaya: r.wilaya_code !== null && r.wilaya_name ? { code: Number(r.wilaya_code), name: r.wilaya_name, nameAr: r.wilaya_name_ar ?? '' } : null,
        businessName: isProvider ? r.business_name : null,
        category: isProvider && r.category_id ? { id: r.category_id, nameEn: r.category_name_en ?? '', nameAr: r.category_name_ar ?? '' } : null,
        rating: isProvider && r.avg_rating !== null ? Number(r.avg_rating) : null,
        ratingCount: isProvider && r.rating_count !== null ? Number(r.rating_count) : null,
        bookingsCount: Number(r.bookings_count),
        servicesCount: isProvider ? (services.get(r.id) ?? 0) : null,
        lastActiveAt: iso(r.last_active_at),
        createdAt: iso(r.created_at)!,
      };
    });
  }

  async row(id: string, em: EntityManager = this.dataSource.manager): Promise<UserRowDto> {
    const raw = await this.selectRow(this.filtered({}, em).andWhere('u.id = :id', { id })).getRawOne<RawUserRow>();
    if (!raw) throw AppException.of('USER_NOT_FOUND');
    return (await this.toRows([raw], em))[0]!;
  }

  /** A client or provider (not deleted), optionally locked. */
  async load(id: string, em: EntityManager = this.dataSource.manager, lock = false): Promise<User> {
    const user = await em.getRepository(User).findOne({
      where: { id, role: In([UserRole.Client, UserRole.Provider]) },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!user) throw AppException.of('USER_NOT_FOUND');
    return user;
  }

  // ── profile ─────────────────────────────────────────────────

  async get(id: string, auth: AuthUser | null, em: EntityManager = this.dataSource.manager): Promise<UserDetailDto> {
    const user = await em.getRepository(User).findOne({
      where: { id, role: In([UserRole.Client, UserRole.Provider]) },
      relations: { blockedBy: true },
      withDeleted: false,
    });
    if (!user) throw AppException.of('USER_NOT_FOUND');
    const isProvider = user.role === UserRole.Provider;
    const col = isProvider ? 'provider_id' : 'client_id';
    const other = isProvider ? 'client_id' : 'provider_id';
    const today = algiersToday();

    const [row, profile, stats, recentBookings, recentServices, recentReviews, notes, documents] = await Promise.all([
      this.row(id, em),
      isProvider ? em.getRepository(ProviderProfile).findOne({ where: { userId: id }, relations: { category: true } }) : null,
      this.stats(user, today, em),
      em.query(
        `SELECT b.id, b.reference, b.status, b.event_date, b.total, b.created_at, s.title_en, p.name_en AS pack_name, o.id AS other_id, o.full_name AS other_name
         FROM bookings b
         LEFT JOIN services s ON s.id = b.service_id
         LEFT JOIN packs p ON p.id = b.pack_id
         JOIN users o ON o.id = b.${other}
         WHERE b.${col} = ? AND b.deleted_at IS NULL
         ORDER BY b.created_at DESC, b.id LIMIT 4`,
        [id],
      ),
      isProvider
        ? em.query(
            `SELECT id, title_en, title_ar, status, base_price, avg_rating, bookings_count FROM services
             WHERE provider_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id LIMIT 4`,
            [id],
          )
        : [],
      em.query(
        `SELECT r.id, r.rating, r.comment, r.status, r.created_at, a.id AS author_id, a.full_name AS author_name, pr.id AS provider_id, pr.full_name AS provider_name
         FROM reviews r JOIN users a ON a.id = r.author_id JOIN users pr ON pr.id = r.provider_id
         WHERE r.${isProvider ? 'provider_id' : 'author_id'} = ? AND r.deleted_at IS NULL
         ORDER BY r.created_at DESC, r.id LIMIT 3`,
        [id],
      ),
      this.noteRows(auth, id, { offset: 0, limit: 3 }, em),
      isProvider ? em.getRepository(UserDocument).find({ where: { userId: id, isCurrent: true }, select: { type: true, status: true } }) : [],
    ]);

    let wilayas: WilayaRefDto[] = [];
    if (profile) {
      const rows: { code: number; name: string; name_ar: string }[] = await em.query(
        `SELECT w.code, w.name, w.name_ar FROM provider_wilayas pw JOIN wilayas w ON w.code = pw.wilaya_code
         WHERE pw.provider_profile_id = ? ORDER BY w.code`,
        [profile.id],
      );
      wilayas = rows.map((w) => ({ code: Number(w.code), name: w.name, nameAr: w.name_ar }));
    }

    return {
      ...row,
      language: user.language,
      emailVerifiedAt: iso(user.emailVerifiedAt),
      block:
        user.status === UserStatus.Blocked && user.blockedAt
          ? {
              blockedAt: iso(user.blockedAt)!,
              until: iso(user.blockedUntil),
              reason: user.blockedReason,
              message: user.blockedMessage,
              blockedBy: user.blockedBy ? { id: user.blockedBy.id, fullName: user.blockedBy.fullName } : null,
            }
          : null,
      provider: profile
        ? {
            businessName: profile.businessName,
            category: profile.category ? { id: profile.category.id, nameEn: profile.category.nameEn, nameAr: profile.category.nameAr } : null,
            bioEn: profile.bioEn,
            bioAr: profile.bioAr,
            languagesSpoken: profile.languagesSpoken,
            yearsActive: profile.yearsActive,
            acceptingBookings: profile.acceptingBookings,
            avgRating: Number(profile.avgRating),
            ratingCount: profile.ratingCount,
            completedBookingsCount: profile.completedBookingsCount,
            replyRate: profile.replyRate,
            avgReplyMinutes: profile.avgReplyMinutes,
            wilayas,
          }
        : null,
      documents: isProvider ? { verificationStatus: user.verificationStatus, ...documentSummary(documents) } : null,
      stats: { ...stats, replyRate: profile?.replyRate ?? null },
      recent: {
        bookings: recentBookings.map((b: any) => ({
          id: b.id,
          reference: b.reference,
          status: b.status,
          eventDate: dateOnly(b.event_date),
          total: String(b.total),
          title: b.title_en ?? b.pack_name ?? null,
          counterpart: { id: b.other_id, fullName: b.other_name },
          createdAt: iso(b.created_at)!,
        })),
        services: recentServices.map((s: any) => ({
          id: s.id,
          titleEn: s.title_en,
          titleAr: s.title_ar,
          status: s.status,
          basePrice: String(s.base_price),
          avgRating: Number(s.avg_rating),
          bookingsCount: Number(s.bookings_count),
        })),
        reviews: recentReviews.map((r: any) => ({
          id: r.id,
          rating: Number(r.rating),
          comment: r.comment,
          status: r.status,
          author: { id: r.author_id, fullName: r.author_name },
          provider: { id: r.provider_id, fullName: r.provider_name },
          createdAt: iso(r.created_at)!,
        })),
        notes,
      },
      updatedAt: iso(user.updatedAt)!,
    };
  }

  private async stats(user: User, today: string, em: EntityManager): Promise<Omit<UserStatsDto, 'replyRate'>> {
    const isProvider = user.role === UserRole.Provider;
    const col = isProvider ? 'provider_id' : 'client_id';
    const [bookingRows, serviceRows, packRows, [reviewRow], [reportedRow], disputeRows] = await Promise.all([
      em.query(
        `SELECT status AS k, COUNT(*) AS n, SUM(event_date >= ?) AS upcoming, COALESCE(SUM(total), 0) AS amount
         FROM bookings WHERE ${col} = ? AND deleted_at IS NULL GROUP BY status`,
        [today, user.id],
      ),
      isProvider ? em.query('SELECT status AS k, COUNT(*) AS n FROM services WHERE provider_id = ? AND deleted_at IS NULL GROUP BY status', [user.id]) : [],
      isProvider ? em.query('SELECT status AS k, COUNT(*) AS n FROM packs WHERE provider_id = ? AND deleted_at IS NULL GROUP BY status', [user.id]) : [],
      em.query(
        `SELECT AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE ${isProvider ? 'provider_id' : 'author_id'} = ? AND deleted_at IS NULL AND status <> 'hidden'`,
        [user.id],
      ),
      em.query(
        `SELECT COUNT(DISTINCT rv.id) AS n FROM reports r JOIN reviews rv ON rv.id = r.target_id
         WHERE r.target_type = 'review' AND r.status = 'open' AND r.deleted_at IS NULL AND rv.deleted_at IS NULL AND rv.${isProvider ? 'provider_id' : 'author_id'} = ?`,
        [user.id],
      ),
      em.query(
        `SELECT d.status AS k, COUNT(*) AS n FROM disputes d JOIN bookings b ON b.id = d.booking_id
         WHERE d.deleted_at IS NULL AND b.${col} = ? GROUP BY d.status`,
        [user.id],
      ),
    ]);
    const byStatus = new Map<string, { n: number; upcoming: number; amount: string }>(
      bookingRows.map((r: any) => [r.k, { n: Number(r.n), upcoming: Number(r.upcoming ?? 0), amount: String(r.amount) }]),
    );
    const bookingCount = (status: BookingStatus) => byStatus.get(status)?.n ?? 0;
    const services = counts(serviceRows);
    const packs = counts(packRows);
    const disputes = counts(disputeRows);
    const sum = (map: Map<string, number>) => [...map.values()].reduce((a, b) => a + b, 0);
    return {
      bookings: {
        total: [...byStatus.values()].reduce((a, b) => a + b.n, 0),
        pending: bookingCount(BookingStatus.Pending),
        upcoming: byStatus.get(BookingStatus.Accepted)?.upcoming ?? 0,
        completed: bookingCount(BookingStatus.Completed),
        cancelled: bookingCount(BookingStatus.Cancelled),
      },
      services: isProvider ? { total: sum(services), published: services.get('published') ?? 0, hidden: services.get('hidden') ?? 0 } : null,
      packs: isProvider ? { total: sum(packs), published: packs.get('published') ?? 0 } : null,
      reviews: {
        avg: Number(reviewRow.n) > 0 ? Math.round(Number(reviewRow.avg) * 100) / 100 : null,
        count: Number(reviewRow.n),
        reported: Number(reportedRow.n),
      },
      disputes: { open: (disputes.get(DisputeStatus.Open) ?? 0) + (disputes.get(DisputeStatus.InReview) ?? 0), total: sum(disputes) },
      earnings: Number(byStatus.get(BookingStatus.Completed)?.amount ?? 0).toFixed(2),
    };
  }

  // ── create / update ─────────────────────────────────────────

  private async assertContactFree(em: EntityManager, email: string | undefined, phone: string | null | undefined, exceptId?: string): Promise<void> {
    const users = em.getRepository(User);
    const notSelf = exceptId ? { id: Not(exceptId) } : {};
    if (email !== undefined && (await users.exists({ where: { email, ...notSelf }, withDeleted: true }))) {
      throw AppException.of('EMAIL_TAKEN', { email });
    }
    if (phone && (await users.exists({ where: { phone, ...notSelf }, withDeleted: true }))) {
      throw AppException.of('PHONE_TAKEN', { phone });
    }
  }

  private async assertCategory(em: EntityManager, categoryId: string): Promise<void> {
    if (!(await em.getRepository(Category).exists({ where: { id: categoryId } }))) {
      throw new AppException(422, 'CATEGORY_NOT_FOUND', { categoryId });
    }
  }

  async create(auth: AuthUser, dto: CreateUserDto): Promise<UserDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      await this.assertContactFree(em, dto.email, dto.phone);
      const isProvider = dto.role === UserRole.Provider;
      if (!isProvider && (dto.businessName !== undefined || dto.categoryId !== undefined || dto.wilayaCodes !== undefined || dto.skipVerification !== undefined)) {
        throw AppException.of('NOT_A_PROVIDER');
      }
      if (isProvider) await this.assertCategory(em, dto.categoryId!);

      const users = em.getRepository(User);
      const user = await users.save(
        users.create({
          role: dto.role,
          status: UserStatus.Active,
          verificationStatus: initialVerificationStatus(dto.role, dto.skipVerification),
          fullName: dto.fullName,
          email: dto.email,
          emailVerifiedAt: null,
          phone: dto.phone,
          passwordHash: null,
          language: dto.language,
          wilayaCode: dto.wilayaCode ?? null,
        }),
      );
      if (isProvider) {
        const profile = await em.getRepository(ProviderProfile).save(
          em.getRepository(ProviderProfile).create({ userId: user.id, businessName: dto.businessName!, categoryId: dto.categoryId!, acceptingBookings: true }),
        );
        await this.replaceWilayas(em, profile.id, dto.wilayaCodes ?? (dto.wilayaCode ? [dto.wilayaCode] : []));
      }

      const codes = em.getRepository(VerificationCode);
      const code = await codes.save(
        codes.create({
          userId: user.id,
          purpose: VerificationCodePurpose.PasswordReset,
          createdAt: new Date(),
          destination: user.email,
          codeHash: 'pending',
          expiresAt: new Date(Date.now() + INVITATION_TOKEN_TTL_DAYS * 86_400_000),
          consumedAt: null,
        }),
      );
      const { token, hash } = createKeyedToken(code.id);
      await codes.update(code.id, { codeHash: hash });

      await this.audit.log(
        {
          action: 'user.created',
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.fullName,
          level: AuditLevel.Normal,
          changes: {
            role: { from: null, to: user.role },
            fullName: { from: null, to: user.fullName },
            email: { from: null, to: user.email },
            phone: { from: null, to: user.phone },
            verificationStatus: { from: null, to: user.verificationStatus },
            ...(isProvider ? { businessName: { from: null, to: dto.businessName }, categoryId: { from: null, to: dto.categoryId } } : {}),
          },
          note: dto.skipVerification ? 'Verification skipped' : null,
        },
        em,
      );
      this.events.emitAfterCommit<UserInvitedEvent>(afterCommit, USER_EVENTS.invited, {
        userId: user.id,
        email: user.email,
        name: user.fullName,
        lang: user.language,
        token,
        days: INVITATION_TOKEN_TTL_DAYS,
      });
      return this.get(user.id, auth, em);
    });
  }

  private async replaceWilayas(em: EntityManager, profileId: string, codes: number[]): Promise<void> {
    await em.getRepository(ProviderWilaya).delete({ providerProfileId: profileId });
    if (codes.length === 0) return;
    const known = await em.getRepository(Wilaya).count({ where: { code: In(codes) } });
    if (known !== new Set(codes).size) throw new AppException(422, 'WILAYA_NOT_FOUND', { wilayaCodes: codes });
    await em.getRepository(ProviderWilaya).insert(codes.map((code) => ({ providerProfileId: profileId, wilayaCode: code, createdAt: new Date() })));
  }

  async update(auth: AuthUser, id: string, dto: UpdateUserDto): Promise<UserDetailDto> {
    if (dto.role !== undefined) throw AppException.of('ROLE_IMMUTABLE');
    return runInTransaction(this.dataSource, async (em) => {
      const user = await this.load(id, em, true);
      const isProvider = user.role === UserRole.Provider;
      if (!isProvider && PROVIDER_FIELDS.some((f) => dto[f] !== undefined)) throw AppException.of('NOT_A_PROVIDER');

      const emailChanges = dto.email !== undefined && dto.email !== user.email;
      const phoneChanges = dto.phone !== undefined && dto.phone !== user.phone;
      if ((emailChanges || phoneChanges) && !dto.reason) {
        throw new AppException(400, 'VALIDATION_FAILED', [
          { field: 'reason', code: 'REQUIRED', message: 'reason is required to change the email or phone' },
        ]);
      }
      await this.assertContactFree(em, emailChanges ? dto.email : undefined, phoneChanges ? dto.phone : undefined, user.id);

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['fullName', 'email', 'phone', 'language', 'wilayaCode'] as const) {
        const next = dto[field];
        if (next !== undefined && next !== user[field]) {
          changes[field] = { from: user[field], to: next };
          (user as any)[field] = next;
        }
      }
      if (changes.wilayaCode && user.wilayaCode !== null && !(await em.getRepository(Wilaya).exists({ where: { code: user.wilayaCode } }))) {
        throw new AppException(422, 'WILAYA_NOT_FOUND', { wilayaCode: user.wilayaCode });
      }

      if (isProvider) {
        const profiles = em.getRepository(ProviderProfile);
        const profile = await profiles.findOneByOrFail({ userId: user.id });
        if (dto.categoryId !== undefined && dto.categoryId !== profile.categoryId) await this.assertCategory(em, dto.categoryId);
        for (const field of ['businessName', 'categoryId', 'bioEn', 'bioAr', 'acceptingBookings', 'yearsActive'] as const) {
          const next = dto[field];
          if (next !== undefined && next !== profile[field]) {
            changes[field] = { from: profile[field], to: next };
            (profile as any)[field] = next;
          }
        }
        if (dto.languagesSpoken !== undefined && JSON.stringify(dto.languagesSpoken) !== JSON.stringify(profile.languagesSpoken)) {
          changes.languagesSpoken = { from: profile.languagesSpoken, to: dto.languagesSpoken };
          profile.languagesSpoken = dto.languagesSpoken;
        }
        await profiles.save(profile);
        if (dto.wilayaCodes !== undefined) {
          const current = (await em.getRepository(ProviderWilaya).find({ where: { providerProfileId: profile.id } })).map((w) => w.wilayaCode).sort((a, b) => a - b);
          const next = [...dto.wilayaCodes].sort((a, b) => a - b);
          if (JSON.stringify(current) !== JSON.stringify(next)) {
            changes.wilayaCodes = { from: current, to: next };
            await this.replaceWilayas(em, profile.id, next);
          }
        }
      }

      if (Object.keys(changes).length > 0) {
        await em.getRepository(User).save(user);
        await this.audit.log(
          {
            action: emailChanges || phoneChanges ? 'user.contact_changed' : 'user.updated',
            objectType: 'user',
            objectId: user.id,
            objectLabel: user.fullName,
            level: emailChanges || phoneChanges ? AuditLevel.Security : AuditLevel.Normal,
            changes,
            note: dto.reason ?? null,
          },
          em,
        );
      }
      return this.get(user.id, auth, em);
    });
  }

  // ── notes ───────────────────────────────────────────────────

  private async noteRows(auth: AuthUser | null, userId: string, page: { offset: number; limit: number }, em: EntityManager): Promise<NoteDto[]> {
    const notes = await em.getRepository(UserNote).find({
      where: { userId },
      relations: { author: true },
      withDeleted: false,
      order: { createdAt: 'DESC', id: 'ASC' },
      skip: page.offset,
      take: page.limit,
    });
    return notes.map((n) => this.toNote(auth, n));
  }

  private toNote(auth: AuthUser | null, note: UserNote): NoteDto {
    return {
      id: note.id,
      body: note.body,
      author: { id: note.authorId, fullName: note.author?.fullName ?? 'Deleted user' },
      canDelete: auth?.id === note.authorId,
      createdAt: iso(note.createdAt)!,
    };
  }

  async listNotes(auth: AuthUser, userId: string, query: PaginationQueryDto): Promise<Paginated<NoteDto>> {
    await this.load(userId);
    const [rows, total] = await Promise.all([
      this.noteRows(auth, userId, { offset: (query.page - 1) * query.limit, limit: query.limit }, this.dataSource.manager),
      this.dataSource.getRepository(UserNote).count({ where: { userId } }),
    ]);
    return paginate(rows, total, query);
  }

  async addNote(auth: AuthUser, userId: string, dto: CreateNoteDto): Promise<NoteDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const user = await this.load(userId, em);
      const repository = em.getRepository(UserNote);
      const note = await repository.save(repository.create({ userId, authorId: auth.id, body: dto.body }));
      await this.audit.log(
        { action: 'user.note_added', objectType: 'user', objectId: userId, objectLabel: user.fullName, level: AuditLevel.Info, changes: { noteId: note.id } },
        em,
      );
      const saved = await repository.findOneOrFail({ where: { id: note.id }, relations: { author: true } });
      return this.toNote(auth, saved);
    });
  }

  async deleteNote(auth: AuthUser, userId: string, noteId: string): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const user = await this.load(userId, em);
      const note = await em.getRepository(UserNote).findOne({ where: { id: noteId, userId }, lock: { mode: 'pessimistic_write' } });
      if (!note) throw AppException.of('NOTE_NOT_FOUND');
      if (note.authorId !== auth.id) throw AppException.of('NOT_OWNER');
      await em.getRepository(UserNote).softDelete(note.id);
      await this.audit.log(
        { action: 'user.note_deleted', objectType: 'user', objectId: userId, objectLabel: user.fullName, level: AuditLevel.Info, changes: { noteId } },
        em,
      );
    });
  }
}

