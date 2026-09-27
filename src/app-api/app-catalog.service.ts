import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { likeContains } from '../common/dto/transforms.js';
import { BookingStatus } from '../common/enums/booking.enums.js';
import { FileVariantKind } from '../common/enums/file.enums.js';
import { PriceType } from '../common/enums/catalog.enums.js';
import { VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import type { Lang } from '../common/i18n/language.js';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import { FilesService } from '../files/files.service.js';
import { PACK_VISIBLE_SQL } from '../packs/packs.policy.js';
import { packPricing } from '../packs/packs.policy.js';
import { SERVICE_VISIBLE_SQL } from '../services/services.policy.js';
import { SettingsService } from '../settings/settings.service.js';
import { algiersToday, dateOnly } from '../users/users.service.js';
import { AppBudgetService } from './app-budget.service.js';
import { AppFavouritesService } from './app-favourites.service.js';
import { hhmm, photoUrls, priceTypeLabel, reviewerName, toCategoryRef, toWilayaRef } from './app-refs.js';
import {
  dayState,
  EMBEDDED_REVIEWS,
  HOME_PACKS,
  HOME_SERVICES,
  HOME_UPCOMING_BOOKINGS,
  parseMonth,
  pickText,
  pickTextOrNull,
  ratingBreakdown,
  replyTimeLabel,
} from './app.policy.js';
import type {
  AppAvailabilityDto,
  AppCategoryDto,
  AppCommuneDto,
  AppWilayaListDto,
  AppHomeDto,
  AppPackCardDto,
  AppPackDetailDto,
  AppPacksQueryDto,
  AppProviderDetailDto,
  AppProviderSummaryDto,
  AppReviewDto,
  AppReviewsQueryDto,
  AppServiceCardDto,
  AppServiceDetailDto,
  AppServicesQueryDto,
} from './dto/app-catalog.dto.js';
import type { AppWilayaRefDto } from './dto/app-me.dto.js';

/** Columns every service card needs, from the `services s` / `users u` / `provider_profiles pp` joins. */
const SERVICE_CARD_COLUMNS = `s.id, s.title_en, s.title_ar, s.base_price, s.price_type, s.avg_rating, s.rating_count, s.bookings_count,
  s.category_id, c.slug AS cat_slug, c.name_en AS cat_name_en, c.name_ar AS cat_name_ar, c.icon AS cat_icon,
  u.id AS provider_id, u.avatar_file_id AS provider_avatar, u.verification_status AS provider_verification, u.full_name AS provider_full_name,
  pp.business_name, pp.avg_rating AS pp_rating, pp.rating_count AS pp_rating_count, pp.completed_bookings_count,
  pp.years_active, pp.avg_reply_minutes, pp.accepting_bookings,
  pp.category_id AS pp_category_id, pc.slug AS pp_cat_slug, pc.name_en AS pp_cat_name_en, pc.name_ar AS pp_cat_name_ar, pc.icon AS pp_cat_icon,
  (SELECT sp.file_id FROM service_photos sp WHERE sp.service_id = s.id ORDER BY sp.position, sp.created_at LIMIT 1) AS cover_file_id`;

const SERVICE_CARD_JOINS = `FROM services s
  JOIN users u ON u.id = s.provider_id
  LEFT JOIN provider_profiles pp ON pp.user_id = u.id AND pp.deleted_at IS NULL
  LEFT JOIN categories c ON c.id = s.category_id AND c.deleted_at IS NULL
  LEFT JOIN categories pc ON pc.id = pp.category_id AND pc.deleted_at IS NULL`;

/**
 * Everything a client browses: home, categories, search, service and provider
 * detail, availability, reviews and packs.
 *
 * Every list is filtered by `SERVICE_VISIBLE_SQL` / `PACK_VISIBLE_SQL` — the
 * same rule `services.policy.ts` states and the admin "visible in app" column
 * shows — so a draft, a hidden service or an unverified provider can never
 * appear, and a detail route answers 404 rather than leaking that it exists.
 */
@Injectable()
export class AppCatalogService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly files: FilesService,
    private readonly settings: SettingsService,
    private readonly favourites: AppFavouritesService,
    private readonly budgets: AppBudgetService,
  ) {}

  // ── reference lists ─────────────────────────────────────────

  async categories(lang: Lang): Promise<AppCategoryDto[]> {
    const rows = await this.dataSource.query(
      `SELECT c.id, c.slug, c.name_en, c.name_ar, c.icon, c.position,
              (SELECT COUNT(*) FROM services s JOIN users u ON u.id = s.provider_id
                WHERE s.category_id = c.id AND ${SERVICE_VISIBLE_SQL}) AS services_count
       FROM categories c WHERE c.is_visible = 1 AND c.deleted_at IS NULL ORDER BY c.position ASC, c.created_at ASC`,
    );
    return rows.map((row: any) => ({
      ...toCategoryRef(lang, row)!,
      position: Number(row.position),
      servicesCount: Number(row.services_count),
    }));
  }

  /** Open wilayas with their visible-service counts, busiest first (there is no `position`). */
  async wilayas(lang: Lang): Promise<AppWilayaListDto[]> {
    const rows = await this.dataSource.query(
      `SELECT wl.code, wl.name, wl.name_ar,
              (SELECT COUNT(DISTINCT sw.service_id) FROM service_wilayas sw
                 JOIN services s ON s.id = sw.service_id
                 JOIN users u ON u.id = s.provider_id
                WHERE sw.wilaya_code = wl.code AND ${SERVICE_VISIBLE_SQL}) AS services_count
       FROM wilayas wl WHERE wl.is_open = 1
       ORDER BY services_count DESC, wl.code ASC`,
    );
    return rows.map((row: any) => ({ ...toWilayaRef(lang, row)!, servicesCount: Number(row.services_count) }));
  }

  /** Communes of one open-or-closed wilaya, for the booking address picker (screen map §C). */
  async communes(code: number, q: string | undefined, lang: Lang): Promise<AppCommuneDto[]> {
    const [wilaya] = await this.dataSource.query('SELECT code FROM wilayas WHERE code = ?', [code]);
    if (!wilaya) throw AppException.of('WILAYA_NOT_FOUND', { code });
    const clauses = ['c.wilaya_code = ?', 'c.deleted_at IS NULL'];
    const params: unknown[] = [code];
    if (q) {
      clauses.push('(c.name LIKE ? OR c.name_ar LIKE ? OR c.postal_code LIKE ?)');
      const like = likeContains(q);
      params.push(like, like, like);
    }
    const rows = await this.dataSource.query(
      `SELECT c.id, c.wilaya_code, c.name, c.name_ar, c.postal_code FROM communes c WHERE ${clauses.join(' AND ')} ORDER BY c.name ASC, c.id ASC`,
      params,
    );
    return rows.map((row: any): AppCommuneDto => ({
      id: row.id,
      wilayaCode: Number(row.wilaya_code),
      name: pickText(lang, row.name, row.name_ar),
      nameEn: row.name,
      nameAr: row.name_ar,
      postalCode: row.postal_code ?? null,
    }));
  }

  // ── mapping ─────────────────────────────────────────────────

  private providerSummary(lang: Lang, row: any): AppProviderSummaryDto {
    return {
      id: row.provider_id,
      businessName: row.business_name ?? row.provider_full_name ?? '',
      category: toCategoryRef(lang, row.pp_category_id ? { id: row.pp_category_id, slug: row.pp_cat_slug, name_en: row.pp_cat_name_en, name_ar: row.pp_cat_name_ar, icon: row.pp_cat_icon } : null),
      avatarUrl: row.provider_avatar ? this.files.signedUrl(row.provider_avatar, { variant: FileVariantKind.Thumb }) : null,
      verified: row.provider_verification === VerificationStatus.Verified,
      avgRating: String(row.pp_rating ?? '0.00'),
      ratingCount: Number(row.pp_rating_count ?? 0),
      completedBookingsCount: Number(row.completed_bookings_count ?? 0),
      yearsActive: row.years_active === null || row.years_active === undefined ? null : Number(row.years_active),
      avgReplyMinutes: row.avg_reply_minutes === null || row.avg_reply_minutes === undefined ? null : Number(row.avg_reply_minutes),
      replyTime: replyTimeLabel(row.avg_reply_minutes === null || row.avg_reply_minutes === undefined ? null : Number(row.avg_reply_minutes)),
      acceptingBookings: Number(row.accepting_bookings ?? 1) === 1,
    };
  }

  /** Open wilayas of several services in one query (never one per row). */
  private async serviceWilayas(em: EntityManager, serviceIds: string[], lang: Lang): Promise<Map<string, AppWilayaRefDto[]>> {
    const map = new Map<string, AppWilayaRefDto[]>();
    if (serviceIds.length === 0) return map;
    const rows = await em.query(
      `SELECT sw.service_id, w.code, w.name, w.name_ar FROM service_wilayas sw
       JOIN wilayas w ON w.code = sw.wilaya_code AND w.is_open = 1
       WHERE sw.service_id IN (?) ORDER BY w.code`,
      [serviceIds],
    );
    for (const row of rows) {
      map.set(row.service_id, [...(map.get(row.service_id) ?? []), toWilayaRef(lang, row)!]);
    }
    return map;
  }

  private serviceCard(lang: Lang, row: any, wilayas: AppWilayaRefDto[], favouriteId: string | null): AppServiceCardDto {
    return {
      id: row.id,
      title: pickText(lang, row.title_en, row.title_ar),
      titleEn: row.title_en,
      titleAr: row.title_ar,
      category: toCategoryRef(lang, row.category_id ? { id: row.category_id, slug: row.cat_slug, name_en: row.cat_name_en, name_ar: row.cat_name_ar, icon: row.cat_icon } : null),
      basePrice: String(row.base_price),
      priceType: row.price_type,
      priceTypeLabel: priceTypeLabel(lang, row.price_type as PriceType),
      avgRating: String(row.avg_rating),
      ratingCount: Number(row.rating_count),
      bookingsCount: Number(row.bookings_count),
      coverUrl: row.cover_file_id ? this.files.signedUrl(row.cover_file_id, { variant: FileVariantKind.Medium }) : null,
      wilayas,
      provider: this.providerSummary(lang, row),
      isFavourite: favouriteId !== null,
      favouriteId,
    };
  }

  private async toServiceCards(em: EntityManager, rows: any[], lang: Lang, viewerId: string | null): Promise<AppServiceCardDto[]> {
    const ids = rows.map((row) => row.id);
    const [wilayas, favourites] = await Promise.all([
      this.serviceWilayas(em, ids, lang),
      this.favourites.marked(viewerId, ids),
    ]);
    return rows.map((row) => this.serviceCard(lang, row, wilayas.get(row.id) ?? [], favourites.get(row.id) ?? null));
  }

  // ── search (screen 11a filters, Search tab) ─────────────────

  async services(query: AppServicesQueryDto, lang: Lang, viewer: AuthUser | null): Promise<Paginated<AppServiceCardDto>> {
    const where = [SERVICE_VISIBLE_SQL];
    const params: unknown[] = [];

    if (query.q) {
      where.push('(s.title_en LIKE ? OR s.title_ar LIKE ? OR u.full_name LIKE ? OR pp.business_name LIKE ?)');
      const like = likeContains(query.q);
      params.push(like, like, like, like);
    }
    if (query.categoryId?.length) {
      where.push('s.category_id IN (?)');
      params.push(query.categoryId);
    }
    if (query.wilaya?.length) {
      where.push('EXISTS (SELECT 1 FROM service_wilayas sw JOIN wilayas w ON w.code = sw.wilaya_code AND w.is_open = 1 WHERE sw.service_id = s.id AND sw.wilaya_code IN (?))');
      params.push(query.wilaya);
    }
    if (query.priceMin !== undefined) {
      where.push('s.base_price >= ?');
      params.push(query.priceMin);
    }
    if (query.priceMax !== undefined) {
      where.push('s.base_price <= ?');
      params.push(query.priceMax);
    }
    if (query.rating !== undefined) {
      where.push('s.avg_rating >= ?');
      params.push(query.rating);
    }
    if (query.eventType) {
      where.push('EXISTS (SELECT 1 FROM pack_items pi JOIN packs pk ON pk.id = pi.pack_id WHERE pi.service_id = s.id AND pk.event_type = ?)');
      params.push(query.eventType);
    }
    if (query.eventDate) {
      // Free that day: no manual whole-day block and capacity left after held / booked events.
      where.push(`NOT EXISTS (SELECT 1 FROM availability_blocks ab WHERE ab.provider_id = s.provider_id AND ab.date = ?
          AND ab.deleted_at IS NULL AND ab.kind = 'blocked' AND ab.start_time IS NULL AND (ab.service_id IS NULL OR ab.service_id = s.id))`);
      params.push(query.eventDate);
      where.push(`(SELECT COUNT(*) FROM bookings bk WHERE bk.provider_id = s.provider_id AND bk.event_date = ?
          AND bk.deleted_at IS NULL AND bk.status IN ('pending', 'accepted')) < s.max_events_per_day`);
      params.push(query.eventDate);
    }
    if (query.favourite) {
      if (!viewer) throw AppException.of('AUTH_TOKEN_MISSING');
      where.push('EXISTS (SELECT 1 FROM favourites fv WHERE fv.service_id = s.id AND fv.user_id = ? AND fv.deleted_at IS NULL)');
      params.push(viewer.id);
    }

    const sql = where.join(' AND ');
    const order = this.serviceOrder(query.order, Boolean(query.q));
    const [rows, [total]] = await Promise.all([
      this.dataSource.query(
        `SELECT ${SERVICE_CARD_COLUMNS} ${SERVICE_CARD_JOINS} WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
        [...params, query.limit, (query.page - 1) * query.limit],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS n ${SERVICE_CARD_JOINS} WHERE ${sql}`, params),
    ]);

    const data = await this.toServiceCards(this.dataSource.manager, rows, lang, viewer?.id ?? null);
    return paginate(data, Number(total.n), query);
  }

  /**
   * Whitelisted ORDER BY fragments — a request value is never interpolated into
   * SQL (README → Security, "SQL"). Every branch ends with `s.id` so paging is
   * stable when the sort key ties.
   */
  private serviceOrder(order: AppServicesQueryDto['order'], searching: boolean): string {
    switch (order) {
      case 'price_asc':
        return 's.base_price ASC, s.id ASC';
      case 'price_desc':
        return 's.base_price DESC, s.id DESC';
      case 'rating':
        return 's.avg_rating DESC, s.rating_count DESC, s.id DESC';
      case 'popular':
        return 's.bookings_count DESC, s.avg_rating DESC, s.id DESC';
      case 'newest':
        return 's.created_at DESC, s.id DESC';
      default:
        // "Relevance": featured first, then the best rated with the most bookings.
        // With a search term the LIKE filter has already done the matching.
        return searching
          ? 's.is_featured DESC, s.avg_rating DESC, s.bookings_count DESC, s.id DESC'
          : 's.is_featured DESC, s.featured_position ASC, s.avg_rating DESC, s.bookings_count DESC, s.id DESC';
    }
  }

  // ── service detail (screen 12) ──────────────────────────────

  async service(id: string, lang: Lang, viewer: AuthUser | null): Promise<AppServiceDetailDto> {
    const em = this.dataSource.manager;
    const [row] = await em.query(
      `SELECT ${SERVICE_CARD_COLUMNS}, s.description_en, s.description_ar, s.cancellation_policy_en, s.cancellation_policy_ar,
              s.facts, s.max_guests, s.max_events_per_day, s.updated_at
       ${SERVICE_CARD_JOINS} WHERE s.id = ? AND ${SERVICE_VISIBLE_SQL}`,
      [id],
    );
    if (!row) throw AppException.of('SERVICE_NOT_FOUND');

    const [wilayas, favourites, extras, photos, buckets, reviews, providerPacks] = await Promise.all([
      this.serviceWilayas(em, [id], lang),
      this.favourites.marked(viewer?.id ?? null, [id]),
      em.query('SELECT id, name_en, name_ar, price FROM service_extras WHERE service_id = ? AND deleted_at IS NULL ORDER BY position, created_at', [id]),
      em.query(
        `SELECT sp.file_id, f.width, f.height FROM service_photos sp JOIN files f ON f.id = sp.file_id
         WHERE sp.service_id = ? AND f.deleted_at IS NULL ORDER BY sp.position, sp.created_at`,
        [id],
      ),
      em.query("SELECT rating, COUNT(*) AS n FROM reviews WHERE service_id = ? AND status IN ('published', 'redacted') AND deleted_at IS NULL GROUP BY rating", [id]),
      this.reviewRows(em, 'r.service_id = ?', [id], EMBEDDED_REVIEWS, 0, lang),
      this.packRows(em, 'p.provider_id = ?', [row.provider_id], 4, 0, 'p.bookings_count DESC, p.id DESC', lang, viewer?.id ?? null),
    ]);

    const card = this.serviceCard(lang, row, wilayas.get(id) ?? [], favourites.get(id) ?? null);
    const facts = Array.isArray(row.facts) ? row.facts : typeof row.facts === 'string' ? JSON.parse(row.facts) : [];

    return {
      ...card,
      description: pickText(lang, row.description_en, row.description_ar),
      descriptionEn: row.description_en,
      descriptionAr: row.description_ar,
      cancellationPolicy: pickTextOrNull(lang, row.cancellation_policy_en, row.cancellation_policy_ar),
      cancellationPolicyEn: row.cancellation_policy_en,
      cancellationPolicyAr: row.cancellation_policy_ar,
      facts: (facts ?? []).map((fact: any) => ({
        label: pickText(lang, fact.label_en, fact.label_ar),
        value: pickText(lang, fact.value_en, fact.value_ar),
        labelEn: fact.label_en ?? '',
        valueEn: fact.value_en ?? '',
        labelAr: fact.label_ar ?? '',
        valueAr: fact.value_ar ?? '',
      })),
      extras: extras.map((extra: any) => ({
        id: extra.id,
        name: pickText(lang, extra.name_en, extra.name_ar),
        nameEn: extra.name_en,
        nameAr: extra.name_ar,
        price: String(extra.price),
      })),
      photos: photos.map((photo: any) => ({
        id: photo.file_id,
        ...photoUrls(this.files, photo.file_id),
        width: photo.width === null ? null : Number(photo.width),
        height: photo.height === null ? null : Number(photo.height),
      })),
      maxGuests: row.max_guests === null ? null : Number(row.max_guests),
      maxEventsPerDay: Number(row.max_events_per_day),
      ratingBreakdown: ratingBreakdown(buckets.map((b: any) => ({ rating: Number(b.rating), n: Number(b.n) }))),
      recentReviews: reviews,
      providerPacks,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  // ── reviews ─────────────────────────────────────────────────

  /**
   * Published reviews only, with the redacted text when an admin rewrote it and
   * the provider's published reply. Hidden reviews and hidden replies never
   * reach the app.
   */
  private async reviewRows(em: EntityManager, where: string, params: unknown[], limit: number, offset: number, _lang: Lang): Promise<AppReviewDto[]> {
    const rows = await em.query(
      `SELECT r.id, r.rating, r.comment, r.redacted_comment, r.status, r.created_at,
              au.full_name AS author_name, au.avatar_file_id AS author_avatar,
              rr.body AS reply_body, rr.created_at AS reply_at
       FROM reviews r
       JOIN users au ON au.id = r.author_id
       LEFT JOIN review_replies rr ON rr.review_id = r.id AND rr.status = 'published' AND rr.deleted_at IS NULL
       WHERE ${where} AND r.status IN ('published', 'redacted') AND r.deleted_at IS NULL
       ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map((row: any) => ({
      id: row.id,
      authorName: reviewerName(row.author_name),
      authorAvatarUrl: row.author_avatar ? this.files.signedUrl(row.author_avatar, { variant: FileVariantKind.Thumb }) : null,
      rating: Number(row.rating),
      comment: row.status === 'redacted' ? (row.redacted_comment ?? '') : row.comment,
      redacted: row.status === 'redacted',
      reply: row.reply_body ?? null,
      repliedAt: row.reply_at ? new Date(row.reply_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async serviceReviews(id: string, query: AppReviewsQueryDto, lang: Lang): Promise<Paginated<AppReviewDto>> {
    const em = this.dataSource.manager;
    const [exists] = await em.query(`SELECT s.id ${SERVICE_CARD_JOINS} WHERE s.id = ? AND ${SERVICE_VISIBLE_SQL}`, [id]);
    if (!exists) throw AppException.of('SERVICE_NOT_FOUND');
    return this.paginatedReviews(em, 'r.service_id = ?', [id], query, lang);
  }

  private async paginatedReviews(em: EntityManager, where: string, params: unknown[], query: AppReviewsQueryDto, lang: Lang): Promise<Paginated<AppReviewDto>> {
    let clause = where;
    const all = [...params];
    if (query.rating !== undefined) {
      clause += ' AND r.rating = ?';
      all.push(query.rating);
    }
    const [data, [total]] = await Promise.all([
      this.reviewRows(em, clause, all, query.limit, (query.page - 1) * query.limit, lang),
      em.query(`SELECT COUNT(*) AS n FROM reviews r WHERE ${clause} AND r.status IN ('published', 'redacted') AND r.deleted_at IS NULL`, all),
    ]);
    return paginate(data, Number(total.n), query);
  }

  // ── provider profile (screen 13) ────────────────────────────

  async provider(id: string, lang: Lang, viewer: AuthUser | null): Promise<AppProviderDetailDto> {
    const em = this.dataSource.manager;
    const [row] = await em.query(
      `SELECT u.id AS provider_id, u.full_name AS provider_full_name, u.avatar_file_id AS provider_avatar,
              u.verification_status AS provider_verification, u.created_at AS member_since,
              pp.id AS profile_id, pp.business_name, pp.bio_en, pp.bio_ar, pp.languages_spoken, pp.years_active,
              pp.accepting_bookings, pp.avg_rating AS pp_rating, pp.rating_count AS pp_rating_count,
              pp.completed_bookings_count, pp.avg_reply_minutes,
              pp.category_id AS pp_category_id, pc.slug AS pp_cat_slug, pc.name_en AS pp_cat_name_en, pc.name_ar AS pp_cat_name_ar, pc.icon AS pp_cat_icon
       FROM users u
       JOIN provider_profiles pp ON pp.user_id = u.id AND pp.deleted_at IS NULL
       LEFT JOIN categories pc ON pc.id = pp.category_id AND pc.deleted_at IS NULL
       WHERE u.id = ? AND u.role = 'provider' AND u.status = 'active' AND u.verification_status = 'verified' AND u.deleted_at IS NULL`,
      [id],
    );
    if (!row) throw AppException.of('PROVIDER_NOT_FOUND');

    const [wilayas, serviceRows, [servicesCount], buckets, reviews, packs] = await Promise.all([
      em.query(
        'SELECT w.code, w.name, w.name_ar FROM provider_wilayas pw JOIN wilayas w ON w.code = pw.wilaya_code AND w.is_open = 1 WHERE pw.provider_profile_id = ? ORDER BY w.code',
        [row.profile_id],
      ),
      em.query(
        `SELECT ${SERVICE_CARD_COLUMNS} ${SERVICE_CARD_JOINS} WHERE s.provider_id = ? AND ${SERVICE_VISIBLE_SQL}
         ORDER BY s.avg_rating DESC, s.bookings_count DESC, s.id DESC LIMIT 10`,
        [id],
      ),
      em.query(`SELECT COUNT(*) AS n ${SERVICE_CARD_JOINS} WHERE s.provider_id = ? AND ${SERVICE_VISIBLE_SQL}`, [id]),
      em.query("SELECT rating, COUNT(*) AS n FROM reviews WHERE provider_id = ? AND status IN ('published', 'redacted') AND deleted_at IS NULL GROUP BY rating", [id]),
      this.reviewRows(em, 'r.provider_id = ?', [id], EMBEDDED_REVIEWS, 0, lang),
      this.packRows(em, 'p.provider_id = ?', [id], 6, 0, 'p.bookings_count DESC, p.id DESC', lang, viewer?.id ?? null),
    ]);

    const summary = this.providerSummary(lang, row);
    const replyMinutes = summary.avgReplyMinutes;
    return {
      ...summary,
      bio: pickTextOrNull(lang, row.bio_en, row.bio_ar),
      bioEn: row.bio_en,
      bioAr: row.bio_ar,
      languagesSpoken: typeof row.languages_spoken === 'string' ? JSON.parse(row.languages_spoken) : (row.languages_spoken ?? null),
      wilayas: wilayas.map((w: any) => toWilayaRef(lang, w)!),
      checks: [
        {
          code: 'identity',
          title: lang === 'ar' ? 'الهوية موثّقة' : 'Identity verified',
          detail: lang === 'ar' ? 'تم التحقق من بطاقة التعريف الوطنية من طرف Eventor' : 'National ID checked by Eventor',
          passed: true,
        },
        {
          code: 'registration',
          title: lang === 'ar' ? 'نشاط مسجّل' : 'Registered activity',
          detail: lang === 'ar' ? 'تم التحقق من السجل التجاري أو بطاقة الحرفي' : "Commercial register or artisan card verified",
          passed: true,
        },
        {
          code: 'reply_time',
          title: replyMinutes ? (lang === 'ar' ? `يردّ خلال ${summary.replyTime} تقريبًا` : `Replies in about ${summary.replyTime}`) : lang === 'ar' ? 'وقت الرد' : 'Reply time',
          detail: lang === 'ar' ? 'محسوب على آخر 30 يومًا' : 'Measured over the last 30 days',
          passed: replyMinutes !== null,
        },
      ],
      servicesCount: Number(servicesCount.n),
      services: await this.toServiceCards(em, serviceRows, lang, viewer?.id ?? null),
      packs,
      ratingBreakdown: ratingBreakdown(buckets.map((b: any) => ({ rating: Number(b.rating), n: Number(b.n) }))),
      recentReviews: reviews,
      memberSince: new Date(row.member_since).toISOString(),
    };
  }

  async providerReviews(id: string, query: AppReviewsQueryDto, lang: Lang): Promise<Paginated<AppReviewDto>> {
    const em = this.dataSource.manager;
    const [exists] = await em.query("SELECT id FROM users WHERE id = ? AND role = 'provider' AND deleted_at IS NULL", [id]);
    if (!exists) throw AppException.of('PROVIDER_NOT_FOUND');
    return this.paginatedReviews(em, 'r.provider_id = ?', [id], query, lang);
  }

  // ── packs (screens 19 / 20) ─────────────────────────────────

  private async packRows(
    em: EntityManager,
    where: string,
    params: unknown[],
    limit: number,
    offset: number,
    order: string,
    lang: Lang,
    viewerId: string | null,
  ): Promise<AppPackCardDto[]> {
    const rows = await em.query(
      `SELECT p.id, p.name_en, p.name_ar, p.description_en, p.description_ar, p.event_type, p.price, p.max_guests,
              p.avg_rating, p.rating_count, p.bookings_count, p.wilaya_code, w.name AS wilaya_name, w.name_ar AS wilaya_name_ar,
              u.id AS provider_id, u.full_name AS provider_full_name, u.avatar_file_id AS provider_avatar, u.verification_status AS provider_verification,
              pp.business_name, pp.avg_rating AS pp_rating, pp.rating_count AS pp_rating_count, pp.completed_bookings_count,
              pp.years_active, pp.avg_reply_minutes, pp.accepting_bookings,
              pp.category_id AS pp_category_id, pc.slug AS pp_cat_slug, pc.name_en AS pp_cat_name_en, pc.name_ar AS pp_cat_name_ar, pc.icon AS pp_cat_icon,
              (SELECT ph.file_id FROM pack_photos ph WHERE ph.pack_id = p.id ORDER BY ph.position, ph.created_at LIMIT 1) AS cover_file_id
       FROM packs p
       JOIN users u ON u.id = p.provider_id
       LEFT JOIN provider_profiles pp ON pp.user_id = u.id AND pp.deleted_at IS NULL
       LEFT JOIN categories pc ON pc.id = pp.category_id AND pc.deleted_at IS NULL
       JOIN wilayas w ON w.code = p.wilaya_code
       WHERE ${where} AND ${PACK_VISIBLE_SQL} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    if (rows.length === 0) return [];

    const packIds = rows.map((row: any) => row.id);
    const [items, favourites] = await Promise.all([
      em.query(
        `SELECT pi.pack_id, pi.position, s.id AS service_id, s.base_price, s.deleted_at,
                c.id AS cat_id, c.name_en AS cat_name_en, c.name_ar AS cat_name_ar
         FROM pack_items pi JOIN services s ON s.id = pi.service_id
         LEFT JOIN categories c ON c.id = s.category_id AND c.deleted_at IS NULL
         WHERE pi.pack_id IN (?) ORDER BY pi.position, pi.created_at`,
        [packIds],
      ),
      this.favourites.marked(viewerId, [], packIds),
    ]);

    return rows.map((row: any) => {
      const own = items.filter((item: any) => item.pack_id === row.id);
      const pricing = packPricing(String(row.price), own.map((item: any) => ({ basePrice: String(item.base_price), deleted: item.deleted_at !== null })));
      return {
        id: row.id,
        name: pickText(lang, row.name_en, row.name_ar),
        nameEn: row.name_en,
        nameAr: row.name_ar,
        eventType: row.event_type,
        wilaya: toWilayaRef(lang, { code: row.wilaya_code, name: row.wilaya_name, name_ar: row.wilaya_name_ar })!,
        price: String(row.price),
        sumOfItems: pricing.sumOfItems,
        savings: pricing.savings,
        savingsPercent: pricing.savingsPercent,
        itemsCount: own.length,
        categoryNames: own.map((item: any) => pickText(lang, item.cat_name_en, item.cat_name_ar)).filter(Boolean),
        coverUrl: row.cover_file_id ? this.files.signedUrl(row.cover_file_id, { variant: FileVariantKind.Medium }) : null,
        avgRating: Number(row.avg_rating),
        ratingCount: Number(row.rating_count),
        bookingsCount: Number(row.bookings_count),
        provider: this.providerSummary(lang, row),
        isFavourite: favourites.has(row.id),
        favouriteId: favourites.get(row.id) ?? null,
      };
    });
  }

  async packs(query: AppPacksQueryDto, lang: Lang, viewer: AuthUser | null): Promise<Paginated<AppPackCardDto>> {
    const where: string[] = ['1 = 1'];
    const params: unknown[] = [];
    if (query.eventType) {
      where.push('p.event_type = ?');
      params.push(query.eventType);
    }
    if (query.wilaya?.length) {
      where.push('p.wilaya_code IN (?)');
      params.push(query.wilaya);
    }
    if (query.priceMax !== undefined) {
      where.push('p.price <= ?');
      params.push(query.priceMax);
    }
    if (query.providerId) {
      where.push('p.provider_id = ?');
      params.push(query.providerId);
    }
    const sql = where.join(' AND ');
    const order = this.packOrder(query.order);

    const em = this.dataSource.manager;
    const [data, [total]] = await Promise.all([
      this.packRows(em, sql, params, query.limit, (query.page - 1) * query.limit, order, lang, viewer?.id ?? null),
      em.query(
        `SELECT COUNT(*) AS n FROM packs p JOIN users u ON u.id = p.provider_id WHERE ${sql} AND ${PACK_VISIBLE_SQL}`,
        params,
      ),
    ]);
    return paginate(data, Number(total.n), query);
  }

  /** Whitelisted fragments, as `serviceOrder`. */
  private packOrder(order: AppPacksQueryDto['order']): string {
    switch (order) {
      case 'price_asc':
        return 'p.price ASC, p.id ASC';
      case 'price_desc':
        return 'p.price DESC, p.id DESC';
      case 'rating':
        return 'p.avg_rating DESC, p.rating_count DESC, p.id DESC';
      case 'popular':
        return 'p.bookings_count DESC, p.id DESC';
      default:
        // "Save X DA" is the headline of screen 19, so the biggest saving leads.
        return '(SELECT COALESCE(SUM(ps.base_price), 0) FROM pack_items ppi JOIN services ps ON ps.id = ppi.service_id AND ps.deleted_at IS NULL WHERE ppi.pack_id = p.id) - p.price DESC, p.id DESC';
    }
  }

  async pack(id: string, lang: Lang, viewer: AuthUser | null): Promise<AppPackDetailDto> {
    const em = this.dataSource.manager;
    const [card] = await this.packRows(em, 'p.id = ?', [id], 1, 0, 'p.id', lang, viewer?.id ?? null);
    if (!card) throw AppException.of('PACK_NOT_FOUND');

    const [row] = await em.query('SELECT description_en, description_ar, max_guests FROM packs WHERE id = ?', [id]);
    const [items, photos, reviews] = await Promise.all([
      em.query(
        `SELECT pi.position, s.id AS service_id, s.title_en, s.title_ar, s.base_price, s.price_type,
                c.id AS cat_id, c.slug AS cat_slug, c.name_en AS cat_name_en, c.name_ar AS cat_name_ar, c.icon AS cat_icon,
                (SELECT sp.file_id FROM service_photos sp WHERE sp.service_id = s.id ORDER BY sp.position, sp.created_at LIMIT 1) AS cover_file_id
         FROM pack_items pi JOIN services s ON s.id = pi.service_id
         LEFT JOIN categories c ON c.id = s.category_id AND c.deleted_at IS NULL
         WHERE pi.pack_id = ? ORDER BY pi.position, pi.created_at`,
        [id],
      ),
      em.query(
        `SELECT ph.file_id, f.width, f.height FROM pack_photos ph JOIN files f ON f.id = ph.file_id
         WHERE ph.pack_id = ? AND f.deleted_at IS NULL ORDER BY ph.position, ph.created_at`,
        [id],
      ),
      this.reviewRows(em, 'r.pack_id = ?', [id], EMBEDDED_REVIEWS, 0, lang),
    ]);

    // "Where they work" for a pack: the wilayas every one of its services covers.
    const serviceIds = items.map((item: any) => item.service_id);
    const wilayaMap = await this.serviceWilayas(em, serviceIds, lang);
    const shared = serviceIds.length === 0
      ? []
      : (wilayaMap.get(serviceIds[0]) ?? []).filter((wilaya) =>
          serviceIds.every((serviceId: string) => (wilayaMap.get(serviceId) ?? []).some((w) => w.code === wilaya.code)),
        );

    return {
      ...card,
      description: pickTextOrNull(lang, row?.description_en, row?.description_ar),
      descriptionEn: row?.description_en ?? null,
      descriptionAr: row?.description_ar ?? null,
      maxGuests: row?.max_guests === null || row?.max_guests === undefined ? null : Number(row.max_guests),
      photos: photos.map((photo: any) => ({
        id: photo.file_id,
        ...photoUrls(this.files, photo.file_id),
        width: photo.width === null ? null : Number(photo.width),
        height: photo.height === null ? null : Number(photo.height),
      })),
      items: items.map((item: any) => ({
        serviceId: item.service_id,
        title: pickText(lang, item.title_en, item.title_ar),
        titleEn: item.title_en,
        titleAr: item.title_ar,
        category: toCategoryRef(lang, item.cat_id ? { id: item.cat_id, slug: item.cat_slug, name_en: item.cat_name_en, name_ar: item.cat_name_ar, icon: item.cat_icon } : null),
        price: String(item.base_price),
        priceType: item.price_type,
        coverUrl: item.cover_file_id ? this.files.signedUrl(item.cover_file_id, { variant: FileVariantKind.Thumb }) : null,
        position: Number(item.position),
      })),
      wilayas: shared,
      recentReviews: reviews,
    };
  }

  // ── availability (screens 12 / 20) ──────────────────────────

  /**
   * A month of `available | busy | blocked` for one provider (a service) or for
   * several at once (a pack: a day is only free when *every* item's provider
   * is). Three queries, never one per day.
   */
  private async availability(
    em: EntityManager,
    input: { providerIds: string[]; serviceIds: string[]; month: string; capacity: number },
  ): Promise<AppAvailabilityDto> {
    const { first, last, days } = parseMonth(input.month);
    const minNoticeDays = await this.settings.get('booking_min_notice_days');
    const today = algiersToday();
    const firstBookable = new Date(new Date(`${today}T00:00:00.000Z`).getTime() + minNoticeDays * 86_400_000).toISOString().slice(0, 10);

    const [blocks, bookings] = await Promise.all([
      em.query(
        `SELECT ab.date, ab.provider_id FROM availability_blocks ab
         WHERE ab.provider_id IN (?) AND ab.date BETWEEN ? AND ? AND ab.deleted_at IS NULL
           AND ab.kind = 'blocked' AND ab.start_time IS NULL
           AND (ab.service_id IS NULL OR ab.service_id IN (?))`,
        [input.providerIds, first, last, input.serviceIds.length > 0 ? input.serviceIds : ['']],
      ),
      em.query(
        `SELECT b.event_date AS date, b.provider_id, COUNT(*) AS n FROM bookings b
         WHERE b.provider_id IN (?) AND b.event_date BETWEEN ? AND ? AND b.deleted_at IS NULL
           AND b.status IN ('pending', 'accepted')
         GROUP BY b.event_date, b.provider_id`,
        [input.providerIds, first, last],
      ),
    ]);

    // `date` columns come back from mysql2 as JS Dates, so they go through
    // `dateOnly` rather than a string slice — `String(new Date())` is "Wed Sep 30 …".
    const blocked = new Set(blocks.map((row: any) => `${row.provider_id}|${dateOnly(row.date)}`));
    const taken = new Map<string, number>();
    for (const row of bookings) taken.set(`${row.provider_id}|${dateOnly(row.date)}`, Number(row.n));

    const result: AppAvailabilityDto['days'] = [];
    for (let day = 1; day <= days; day++) {
      const date = `${input.month}-${String(day).padStart(2, '0')}`;
      // The strictest provider decides: a pack needs all of them free.
      const states = input.providerIds.map((providerId) =>
        dayState({
          past: date < firstBookable,
          manualBlock: blocked.has(`${providerId}|${date}`),
          taken: taken.get(`${providerId}|${date}`) ?? 0,
          capacity: input.capacity,
        }),
      );
      const state = states.includes('blocked') ? 'blocked' : states.includes('busy') ? 'busy' : 'available';
      result.push({ date, state });
    }

    return { month: input.month, maxEventsPerDay: input.capacity, minNoticeDays, firstBookableDate: firstBookable, days: result };
  }

  async serviceAvailability(id: string, month: string): Promise<AppAvailabilityDto> {
    const em = this.dataSource.manager;
    const [row] = await em.query(
      `SELECT s.id, s.provider_id, s.max_events_per_day ${SERVICE_CARD_JOINS} WHERE s.id = ? AND ${SERVICE_VISIBLE_SQL}`,
      [id],
    );
    if (!row) throw AppException.of('SERVICE_NOT_FOUND');
    return this.availability(em, {
      providerIds: [row.provider_id],
      serviceIds: [row.id],
      month,
      capacity: Number(row.max_events_per_day),
    });
  }

  async packAvailability(id: string, month: string): Promise<AppAvailabilityDto> {
    const em = this.dataSource.manager;
    const [pack] = await em.query(
      `SELECT p.id, p.provider_id FROM packs p JOIN users u ON u.id = p.provider_id WHERE p.id = ? AND ${PACK_VISIBLE_SQL}`,
      [id],
    );
    if (!pack) throw AppException.of('PACK_NOT_FOUND');
    const items = await em.query(
      'SELECT s.id, s.provider_id, s.max_events_per_day FROM pack_items pi JOIN services s ON s.id = pi.service_id WHERE pi.pack_id = ?',
      [id],
    );
    // status-rules §4: a pack's daily capacity is the smallest among its items.
    const capacity = items.length > 0 ? Math.min(...items.map((item: any) => Number(item.max_events_per_day))) : 1;
    return this.availability(em, {
      providerIds: [...new Set<string>(items.map((item: any) => item.provider_id as string))].concat(items.length === 0 ? [pack.provider_id] : []),
      serviceIds: items.map((item: any) => item.id),
      month,
      capacity,
    });
  }

  // ── home (screen 11) ────────────────────────────────────────

  async home(auth: AuthUser, lang: Lang): Promise<AppHomeDto> {
    const em = this.dataSource.manager;
    const [user] = await em.query(
      `SELECT u.id, u.full_name, u.avatar_file_id, u.wilaya_code, w.name AS wilaya_name, w.name_ar AS wilaya_name_ar
       FROM users u LEFT JOIN wilayas w ON w.code = u.wilaya_code WHERE u.id = ?`,
      [auth.id],
    );
    if (!user) throw AppException.of('USER_NOT_FOUND');

    const wilaya = user.wilaya_code ? [user.wilaya_code] : [];
    const [categories, upcoming, budget, packs, nearby, [unreadNotifications], [unreadConversations]] = await Promise.all([
      this.categories(lang),
      em.query(
        `SELECT b.id, b.reference, b.event_date, b.start_time, b.status,
                s.title_en, s.title_ar, pk.name_en AS pack_name_en, pk.name_ar AS pack_name_ar,
                c.id AS cat_id, c.slug AS cat_slug, c.name_en AS cat_name_en, c.name_ar AS cat_name_ar, c.icon AS cat_icon,
                COALESCE(pp.business_name, pu.full_name) AS provider_name, pu.avatar_file_id AS provider_avatar,
                (SELECT sp.file_id FROM service_photos sp WHERE sp.service_id = s.id ORDER BY sp.position, sp.created_at LIMIT 1) AS cover_file_id
         FROM bookings b
         JOIN users pu ON pu.id = b.provider_id
         LEFT JOIN provider_profiles pp ON pp.user_id = pu.id AND pp.deleted_at IS NULL
         LEFT JOIN services s ON s.id = b.service_id
         LEFT JOIN packs pk ON pk.id = b.pack_id
         LEFT JOIN categories c ON c.id = s.category_id AND c.deleted_at IS NULL
         WHERE b.client_id = ? AND b.deleted_at IS NULL AND b.status IN (?, ?) AND b.event_date >= ?
         ORDER BY b.event_date ASC, b.start_time ASC LIMIT ?`,
        [auth.id, BookingStatus.Pending, BookingStatus.Accepted, algiersToday(), HOME_UPCOMING_BOOKINGS],
      ),
      this.budgets.summary(auth),
      this.packRows(
        em,
        wilaya.length > 0 ? 'p.wilaya_code = ?' : '1 = 1',
        wilaya,
        HOME_PACKS,
        0,
        this.packOrder('savings'),
        lang,
        auth.id,
      ),
      this.services(
        { page: 1, limit: HOME_SERVICES, ...(wilaya.length > 0 ? { wilaya } : {}), order: 'rating' } as AppServicesQueryDto,
        lang,
        auth,
      ),
      em.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL', [auth.id]),
      em.query(
        `SELECT COUNT(*) AS n FROM conversation_participants cp JOIN conversations c ON c.id = cp.conversation_id AND c.deleted_at IS NULL
         WHERE cp.user_id = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = cp.conversation_id AND m.kind <> 'system'
           AND m.status <> 'deleted' AND (m.sender_id IS NULL OR m.sender_id <> cp.user_id)
           AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at))`,
        [auth.id],
      ),
    ]);

    return {
      fullName: user.full_name,
      avatarUrl: user.avatar_file_id ? this.files.signedUrl(user.avatar_file_id, { variant: FileVariantKind.Thumb }) : null,
      wilaya: toWilayaRef(lang, user.wilaya_code ? { code: user.wilaya_code, name: user.wilaya_name, name_ar: user.wilaya_name_ar } : null),
      unreadNotifications: Number(unreadNotifications.n),
      unreadConversations: Number(unreadConversations.n),
      categories,
      upcomingBookings: upcoming.map((row: any) => ({
        id: row.id,
        reference: row.reference,
        providerName: row.provider_name ?? '',
        providerAvatarUrl: row.provider_avatar ? this.files.signedUrl(row.provider_avatar, { variant: FileVariantKind.Thumb }) : null,
        title: pickTextOrNull(lang, row.title_en ?? row.pack_name_en, row.title_ar ?? row.pack_name_ar),
        category: toCategoryRef(lang, row.cat_id ? { id: row.cat_id, slug: row.cat_slug, name_en: row.cat_name_en, name_ar: row.cat_name_ar, icon: row.cat_icon } : null),
        eventDate: dateOnly(row.event_date),
        startTime: hhmm(row.start_time),
        status: row.status,
        coverUrl: row.cover_file_id ? this.files.signedUrl(row.cover_file_id, { variant: FileVariantKind.Thumb }) : null,
      })),
      budget,
      packs,
      nearbyServices: nearby.data,
    };
  }
}
