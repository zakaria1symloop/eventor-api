import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { PriceType, ServiceStatus } from '../common/enums/catalog.enums.js';
import { ReviewStatus, ReviewReplyStatus } from '../common/enums/moderation.enums.js';
import { UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import type { Lang } from '../common/i18n/language.js';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import { runInTransaction } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import type { UploadedPhotoFile } from '../files/photo-gallery.js';
import { PacksService } from '../packs/packs.service.js';
import { insertReviewReply } from '../reviews/reviews.writes.js';
import { AvailabilityService } from '../services/availability.service.js';
import { ServicesService } from '../services/services.service.js';
import { SERVICE_VISIBLE_SQL } from '../services/services.policy.js';
import { algiersToday } from '../users/users.service.js';
import { AppBookingsService } from './app-bookings.service.js';
import { AppMeService } from './app-me.service.js';
import { assertProviderLive, providerHomeState, verificationSteps } from './app-provider.policy.js';
import { assertOwner, withinEditWindow } from './app-bookings.policy.js';
import { avatarUrl, photoUrls, reviewerName, toWilayaRef } from './app-refs.js';
import { pickText, pickTextOrNull } from './app.policy.js';
import type {
  AppCreatePackDto,
  AppCreateServiceDto,
  AppProviderHomeDto,
  AppProviderReviewDto,
  AppProviderServiceRowDto,
  AppUpdatePackDto,
  AppUpdateProviderProfileDto,
  AppUpdateServiceDto,
} from './dto/app-provider.dto.js';

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

/** How many rows screen 21 shows in each block before "See all". */
const HOME_REQUESTS = 5;
const HOME_UPCOMING = 5;
const HOME_SERVICES = 6;

/**
 * Everything under `/app/provider/**`. Services, packs and availability go
 * through the very services the dashboard uses (`ServicesService`,
 * `PacksService`, `AvailabilityService`), so the publish checklist, the photo
 * limits, the open-wilaya rule and the audit trail are identical; what this
 * class adds is **ownership** (a provider only ever touches their own rows) and
 * the verified-and-active guard of status-rules §2.
 */
@Injectable()
export class AppProviderService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly services: ServicesService,
    private readonly packs: PacksService,
    private readonly availability: AvailabilityService,
    private readonly appBookings: AppBookingsService,
    private readonly me: AppMeService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  // ── the account ───────────────────────────────────────────────

  private async account(userId: string): Promise<{ status: UserStatus; verificationStatus: VerificationStatus; fullName: string; avatarFileId: string | null }> {
    const [row] = await this.dataSource.query('SELECT status, verification_status, full_name, avatar_file_id FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
    if (!row) throw AppException.of('USER_NOT_FOUND');
    return { status: row.status, verificationStatus: row.verification_status, fullName: row.full_name, avatarFileId: row.avatar_file_id };
  }

  /** status-rules §2: publishing and accepting need a verified, active provider. */
  private async assertLive(userId: string): Promise<void> {
    assertProviderLive(await this.account(userId));
  }

  private async profileRow(em: EntityManager, userId: string) {
    const [row] = await em.query('SELECT * FROM provider_profiles WHERE user_id = ? AND deleted_at IS NULL', [userId]);
    if (!row) throw AppException.of('NOT_A_PROVIDER');
    return row;
  }

  // ── home (screens 21 / 21a) ───────────────────────────────────

  async home(auth: AuthUser, lang: Lang): Promise<AppProviderHomeDto> {
    const em = this.dataSource.manager;
    const account = await this.account(auth.id);
    const profile = await this.profileRow(em, auth.id);
    const state = providerHomeState(account);
    const today = algiersToday();

    const [[counts], documents] = await Promise.all([
      em.query(
        `SELECT
           (SELECT COUNT(*) FROM bookings b WHERE b.provider_id = ? AND b.status = 'pending' AND b.deleted_at IS NULL) AS requests,
           (SELECT COUNT(*) FROM bookings b WHERE b.provider_id = ? AND b.status = 'accepted' AND b.event_date >= ? AND b.deleted_at IS NULL) AS upcoming,
           (SELECT COUNT(*) FROM services s WHERE s.provider_id = ? AND s.deleted_at IS NULL) AS services,
           (SELECT COUNT(*) FROM messages m
              JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = ?
              JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
             WHERE m.kind <> 'system' AND m.status <> 'deleted' AND (m.sender_id IS NULL OR m.sender_id <> ?)
               AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)) AS unread_messages,
           (SELECT COUNT(*) FROM notifications n WHERE n.user_id = ? AND n.read_at IS NULL AND n.deleted_at IS NULL) AS unread_notifications`,
        [auth.id, auth.id, today, auth.id, auth.id, auth.id, auth.id],
      ),
      state === 'verified' ? Promise.resolve(null) : this.me.documents(auth, lang),
    ]);

    const [requests, upcoming, services] = await Promise.all([
      this.appBookings.list(auth, 'provider', 'requests', { page: 1, limit: HOME_REQUESTS }, lang),
      this.appBookings.list(auth, 'provider', 'upcoming', { page: 1, limit: HOME_UPCOMING }, lang),
      this.serviceRows(em, auth.id, lang, HOME_SERVICES),
    ]);

    return {
      state,
      businessName: profile.business_name,
      avatarUrl: avatarUrl(this.files, account.avatarFileId),
      verificationStatus: account.verificationStatus,
      verificationSteps: verificationSteps({ documentsSubmitted: documents ? documents.documents.filter((d) => d.status !== null).length : 3, status: account.verificationStatus }),
      documents,
      acceptingBookings: Number(profile.accepting_bookings) === 1,
      avgRating: String(profile.avg_rating ?? '0.00'),
      ratingCount: Number(profile.rating_count ?? 0),
      completedBookingsCount: Number(profile.completed_bookings_count ?? 0),
      counts: {
        requests: Number(counts.requests),
        upcoming: Number(counts.upcoming),
        services: Number(counts.services),
        unreadMessages: Number(counts.unread_messages),
        unreadNotifications: Number(counts.unread_notifications),
      },
      requests: requests.data,
      upcoming: upcoming.data,
      services,
    };
  }

  // ── services ──────────────────────────────────────────────────

  private async serviceRows(em: EntityManager, providerId: string, lang: Lang, limit?: number): Promise<AppProviderServiceRowDto[]> {
    const rows: any[] = await em.query(
      `SELECT s.id, s.title_en, s.title_ar, s.status, s.base_price, s.price_type, s.avg_rating, s.rating_count, s.bookings_count,
              ${SERVICE_VISIBLE_SQL} AS visible,
              (SELECT COUNT(*) FROM service_photos sp WHERE sp.service_id = s.id) AS photos
         FROM services s JOIN users u ON u.id = s.provider_id
        WHERE s.provider_id = ? AND s.deleted_at IS NULL
        ORDER BY FIELD(s.status, 'published', 'draft', 'hidden'), s.created_at DESC${limit ? ' LIMIT ?' : ''}`,
      limit ? [providerId, limit] : [providerId],
    );
    const ids = rows.map((r) => r.id);
    const [covers, wilayas] = await Promise.all([
      ids.length ? em.query('SELECT service_id, file_id FROM service_photos WHERE service_id IN (?) ORDER BY position', [ids]) : [],
      ids.length
        ? em.query('SELECT sw.service_id, w.code, w.name, w.name_ar FROM service_wilayas sw JOIN wilayas w ON w.code = sw.wilaya_code WHERE sw.service_id IN (?) ORDER BY w.code', [ids])
        : [],
    ]);
    const coverOf = new Map<string, string>();
    for (const c of covers as any[]) if (!coverOf.has(c.service_id)) coverOf.set(c.service_id, photoUrls(this.files, c.file_id).thumbUrl);
    return rows.map((r) => ({
      id: r.id,
      title: pickText(lang, r.title_en, r.title_ar),
      titleEn: r.title_en,
      titleAr: r.title_ar,
      status: r.status as ServiceStatus,
      visibleInApp: Number(r.visible) === 1,
      basePrice: String(r.base_price),
      priceType: r.price_type as PriceType,
      avgRating: String(r.avg_rating ?? '0.00'),
      ratingCount: Number(r.rating_count ?? 0),
      bookingsCount: Number(r.bookings_count ?? 0),
      photosCount: Number(r.photos ?? 0),
      coverUrl: coverOf.get(r.id) ?? null,
      wilayas: (wilayas as any[]).filter((w) => w.service_id === r.id).map((w) => toWilayaRef(lang, w)!),
    }));
  }

  listServices(auth: AuthUser, lang: Lang): Promise<AppProviderServiceRowDto[]> {
    return this.serviceRows(this.dataSource.manager, auth.id, lang);
  }

  /** 403 NOT_OWNER on somebody else's service, 404 when it does not exist. */
  private async ownService(id: string, auth: AuthUser): Promise<void> {
    const [row] = await this.dataSource.query('SELECT provider_id FROM services WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!row) throw AppException.of('SERVICE_NOT_FOUND');
    assertOwner(row.provider_id, auth.id);
  }

  /** One of my services, in the same shape the PATCH routes answer with. */
  async getService(auth: AuthUser, id: string) {
    await this.ownService(id, auth);
    return this.services.get(id);
  }

  createService(auth: AuthUser, dto: AppCreateServiceDto) {
    return this.services.create(auth, { ...dto, providerId: auth.id });
  }

  async updateService(auth: AuthUser, id: string, dto: AppUpdateServiceDto) {
    await this.ownService(id, auth);
    return this.services.update(auth, id, dto);
  }

  async transitionService(auth: AuthUser, id: string, action: 'publish' | 'unpublish') {
    await this.ownService(id, auth);
    if (action === 'publish') await this.assertLive(auth.id);
    return this.services.transition(auth, id, action);
  }

  async removeService(auth: AuthUser, id: string) {
    await this.ownService(id, auth);
    return this.services.remove(auth, id, false);
  }

  async addServicePhoto(auth: AuthUser, id: string, file: UploadedPhotoFile) {
    await this.ownService(id, auth);
    return this.services.addPhoto(auth, id, file);
  }

  async reorderServicePhotos(auth: AuthUser, id: string, ids: string[]) {
    await this.ownService(id, auth);
    return this.services.reorderPhotos(auth, id, ids);
  }

  async removeServicePhoto(auth: AuthUser, id: string, photoId: string) {
    await this.ownService(id, auth);
    return this.services.removePhoto(auth, id, photoId);
  }

  // ── packs ─────────────────────────────────────────────────────

  private async ownPack(id: string, auth: AuthUser): Promise<void> {
    const [row] = await this.dataSource.query('SELECT provider_id FROM packs WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!row) throw AppException.of('PACK_NOT_FOUND');
    assertOwner(row.provider_id, auth.id);
  }

  async listPacks(auth: AuthUser) {
    const page = await this.packs.list({ page: 1, limit: 100, providerId: auth.id } as never);
    return page.data;
  }

  /** One of my packs, in the same shape the PATCH routes answer with. */
  async getPack(auth: AuthUser, id: string) {
    await this.ownPack(id, auth);
    return this.packs.get(id);
  }

  createPack(auth: AuthUser, dto: AppCreatePackDto) {
    return this.packs.create(auth, { ...dto, providerId: auth.id });
  }

  async updatePack(auth: AuthUser, id: string, dto: AppUpdatePackDto) {
    await this.ownPack(id, auth);
    return this.packs.update(auth, id, dto);
  }

  async transitionPack(auth: AuthUser, id: string, action: 'publish' | 'unpublish') {
    await this.ownPack(id, auth);
    if (action === 'publish') await this.assertLive(auth.id);
    return this.packs.transition(auth, id, action);
  }

  async removePack(auth: AuthUser, id: string) {
    await this.ownPack(id, auth);
    return this.packs.remove(auth, id);
  }

  async addPackPhoto(auth: AuthUser, id: string, file: UploadedPhotoFile) {
    await this.ownPack(id, auth);
    return this.packs.addPhoto(auth, id, file);
  }

  async reorderPackPhotos(auth: AuthUser, id: string, ids: string[]) {
    await this.ownPack(id, auth);
    return this.packs.reorderPhotos(auth, id, ids);
  }

  async removePackPhoto(auth: AuthUser, id: string, photoId: string) {
    await this.ownPack(id, auth);
    return this.packs.removePhoto(auth, id, photoId);
  }

  // ── availability ──────────────────────────────────────────────

  month(auth: AuthUser, month: string) {
    return this.availability.month(auth.id, month);
  }

  createBlock(auth: AuthUser, dto: { date: string; startTime?: string; endTime?: string; serviceId?: string; note?: string }) {
    return this.availability.createBlock(auth, auth.id, dto);
  }

  async removeBlock(auth: AuthUser, id: string): Promise<void> {
    const [row] = await this.dataSource.query('SELECT provider_id FROM availability_blocks WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!row) throw AppException.of('AVAILABILITY_BLOCK_NOT_FOUND');
    assertOwner(row.provider_id, auth.id);
    await this.availability.removeBlock(auth, id);
  }

  // ── profile ───────────────────────────────────────────────────

  /**
   * The provider half of the Profile tab plus the "Available for bookings"
   * toggle on screen 21. Only the caller's own profile: there is no `:userId`.
   */
  async updateProfile(auth: AuthUser, dto: AppUpdateProviderProfileDto, lang: Lang) {
    await runInTransaction(this.dataSource, async (em) => {
      const profile = await this.profileRow(em, auth.id);
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      if (dto.categoryId !== undefined && dto.categoryId !== profile.category_id) {
        const [category] = await em.query('SELECT id, is_visible FROM categories WHERE id = ? AND deleted_at IS NULL', [dto.categoryId]);
        if (!category) throw AppException.of('CATEGORY_NOT_FOUND');
        if (!Number(category.is_visible)) throw AppException.of('CATEGORY_HIDDEN');
        changes.categoryId = { from: profile.category_id, to: dto.categoryId };
      }
      const columns: [keyof AppUpdateProviderProfileDto, string][] = [
        ['businessName', 'business_name'],
        ['categoryId', 'category_id'],
        ['bioEn', 'bio_en'],
        ['bioAr', 'bio_ar'],
        ['yearsActive', 'years_active'],
      ];
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [field, column] of columns) {
        const value = dto[field];
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        params.push(value);
        if (!changes[field]) changes[field] = { from: profile[column], to: value };
      }
      if (dto.languagesSpoken !== undefined) {
        sets.push('languages_spoken = ?');
        params.push(JSON.stringify(dto.languagesSpoken));
        changes.languagesSpoken = { from: profile.languages_spoken, to: dto.languagesSpoken };
      }
      if (dto.acceptingBookings !== undefined) {
        sets.push('accepting_bookings = ?');
        params.push(dto.acceptingBookings ? 1 : 0);
        changes.acceptingBookings = { from: Number(profile.accepting_bookings) === 1, to: dto.acceptingBookings };
      }
      if (sets.length) {
        await em.query(`UPDATE provider_profiles SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...params, new Date(), profile.id]);
      }
      if (dto.wilayaCodes !== undefined) {
        const current: any[] = await em.query('SELECT wilaya_code FROM provider_wilayas WHERE provider_profile_id = ?', [profile.id]);
        const had = new Set(current.map((r) => Number(r.wilaya_code)));
        const added = dto.wilayaCodes.filter((code) => !had.has(code));
        if (added.length) {
          const open: any[] = await em.query('SELECT code, is_open FROM wilayas WHERE code IN (?)', [added]);
          const missing = added.filter((code) => !open.some((w) => Number(w.code) === code));
          if (missing.length) throw AppException.of('WILAYA_NOT_FOUND', { codes: missing });
          const closed = open.filter((w) => !Number(w.is_open)).map((w) => Number(w.code));
          if (closed.length) throw AppException.of('WILAYA_CLOSED', { codes: closed });
        }
        await em.query('DELETE FROM provider_wilayas WHERE provider_profile_id = ?', [profile.id]);
        for (const code of dto.wilayaCodes) {
          await em.query('INSERT INTO provider_wilayas (provider_profile_id, wilaya_code, created_at) VALUES (?, ?, NOW(6))', [profile.id, code]);
        }
        changes.wilayaCodes = { from: [...had], to: dto.wilayaCodes };
      }
      if (Object.keys(changes).length) {
        await this.audit.log(
          { action: 'provider_profile.updated', objectType: 'user', objectId: auth.id, objectLabel: profile.business_name, level: AuditLevel.Normal, changes },
          em,
        );
      }
    });
    return this.me.profile(auth.id, lang);
  }

  // ── reviews received ──────────────────────────────────────────

  /** The provider's own reviews (Profile · Reviews), hidden ones excluded. */
  async reviews(auth: AuthUser, query: { page: number; limit: number }, lang: Lang): Promise<Paginated<AppProviderReviewDto>> {
    const em = this.dataSource.manager;
    const where = "r.provider_id = ? AND r.deleted_at IS NULL AND r.status <> 'hidden'";
    const [[count], rows] = await Promise.all([
      em.query(`SELECT COUNT(*) AS n FROM reviews r WHERE ${where}`, [auth.id]),
      em.query(
        `SELECT r.id, r.rating, r.comment, r.redacted_comment, r.status, r.had_dispute, r.created_at,
                au.full_name AS author_name, au.avatar_file_id AS author_avatar,
                s.id AS service_id, s.title_en, s.title_ar, b.reference,
                rr.id AS reply_id, rr.body AS reply_body, rr.status AS reply_status, rr.created_at AS replied_at
           FROM reviews r
           JOIN users au ON au.id = r.author_id
           JOIN bookings b ON b.id = r.booking_id
           LEFT JOIN services s ON s.id = r.service_id
           LEFT JOIN review_replies rr ON rr.review_id = r.id AND rr.deleted_at IS NULL
          WHERE ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
        [auth.id, query.limit, (query.page - 1) * query.limit],
      ),
    ]);
    const data = (rows as any[]).map(
      (r): AppProviderReviewDto => ({
        id: r.id,
        rating: Number(r.rating),
        comment: r.status === ReviewStatus.Redacted ? (r.redacted_comment ?? '') : r.comment,
        authorName: reviewerName(r.author_name),
        authorAvatarUrl: avatarUrl(this.files, r.author_avatar),
        serviceId: r.service_id ?? null,
        serviceTitle: r.service_id ? pickTextOrNull(lang, r.title_en, r.title_ar) : null,
        bookingReference: r.reference,
        hadDispute: Number(r.had_dispute) === 1,
        replyId: r.reply_id ?? null,
        reply: r.reply_id && r.reply_status === ReviewReplyStatus.Published ? r.reply_body : null,
        repliedAt: iso(r.replied_at),
        replyEditable: r.reply_id ? withinEditWindow(new Date(r.replied_at)) : false,
        createdAt: iso(r.created_at)!,
      }),
    );
    return paginate(data, Number(count.n), query);
  }

  /** One public reply per review (status-rules §8), with the same flag scan as a review. */
  async reply(auth: AuthUser, reviewId: string, body: string): Promise<{ id: string }> {
    return runInTransaction(this.dataSource, async (em) => {
      const [review] = await em.query('SELECT id, provider_id FROM reviews WHERE id = ? AND deleted_at IS NULL', [reviewId]);
      if (!review) throw AppException.of('REVIEW_NOT_FOUND');
      assertOwner(review.provider_id, auth.id);
      const [existing] = await em.query('SELECT id FROM review_replies WHERE review_id = ? AND deleted_at IS NULL', [reviewId]);
      if (existing) throw AppException.of('REVIEW_REPLY_EXISTS', { replyId: existing.id });
      const created = await insertReviewReply(em, { reviewId, body });
      await this.audit.log(
        { action: 'review.replied', objectType: 'review', objectId: reviewId, level: AuditLevel.Info, changes: { replyId: created.id, flags: created.flags, reportId: created.reportId } },
        em,
      );
      return { id: created.id };
    });
  }

  /** The reply can be edited or deleted for 48 h (status-rules §8). */
  private async ownReply(em: EntityManager, id: string, auth: AuthUser) {
    const [row] = await em.query('SELECT id, review_id, provider_id, body, created_at FROM review_replies WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!row) throw AppException.of('REVIEW_REPLY_NOT_FOUND');
    assertOwner(row.provider_id, auth.id);
    if (!withinEditWindow(new Date(row.created_at))) throw AppException.of('REVIEW_EDIT_WINDOW_CLOSED');
    return row;
  }

  async editReply(auth: AuthUser, id: string, body: string): Promise<{ id: string }> {
    return runInTransaction(this.dataSource, async (em) => {
      const row = await this.ownReply(em, id, auth);
      await em.query('UPDATE review_replies SET body = ?, updated_at = ? WHERE id = ?', [body, new Date(), id]);
      await this.audit.log(
        { action: 'review.reply_edited', objectType: 'review', objectId: row.review_id, level: AuditLevel.Info, changes: { replyId: id, body: { from: row.body, to: body } } },
        em,
      );
      return { id };
    });
  }

  async deleteReply(auth: AuthUser, id: string): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const row = await this.ownReply(em, id, auth);
      await em.query('UPDATE review_replies SET deleted_at = ? WHERE id = ?', [new Date(), id]);
      await this.audit.log({ action: 'review.reply_deleted', objectType: 'review', objectId: row.review_id, level: AuditLevel.Info, changes: { replyId: id } }, em);
    });
  }
}
