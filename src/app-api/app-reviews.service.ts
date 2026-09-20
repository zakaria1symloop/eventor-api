import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { BookingDisputeStatus, BookingStatus } from '../common/enums/booking.enums.js';
import { DisputeStatus, ReviewStatus } from '../common/enums/moderation.enums.js';
import { PartyRole } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import type { Lang } from '../common/i18n/language.js';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import { runInTransaction } from '../database/transaction.js';
import { DisputesService } from '../disputes/disputes.service.js';
import { isActive } from '../disputes/disputes.policy.js';
import { FilesService } from '../files/files.service.js';
import { REVIEW_EVENTS, type ReportCreatedEvent, type ReviewCreatedEvent } from '../reviews/reviews.events.js';
import { ReportTargetType } from '../common/enums/moderation.enums.js';
import { insertReview, recomputeRatings } from '../reviews/reviews.writes.js';
import { autoReportReason } from '../reviews/flag-detection.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { SettingsService } from '../settings/settings.service.js';
import { assertOwner, reviewWindow, withinEditWindow } from './app-bookings.policy.js';
import { pickTextOrNull } from './app.policy.js';
import type {
  AppCreateReviewDto,
  AppDisputeDetailDto,
  AppDisputeRowDto,
  AppEditReviewDto,
  AppMyReviewDto,
  AppOpenDisputeDto,
} from './dto/app-reviews.dto.js';

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);
const dateOnly = (value: Date | string): string =>
  value instanceof Date ? new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : String(value).slice(0, 10);

/**
 * Reviews the client writes and disputes either party opens, from the app.
 *
 * The review row, its flag scan and the automatic report are `reviews.writes`,
 * the shared writes the admin services and the demo seed use; the dispute
 * machine is `DisputesService`. What lives here is the app's half of
 * status-rules §8 and §6: who may write, the 24 h / 60-day window, the 48-hour
 * edit window and the ownership checks.
 */
@Injectable()
export class AppReviewsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly disputes: DisputesService,
    private readonly settings: SettingsService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  // ── reviews ───────────────────────────────────────────────────

  /**
   * status-rules §8: the **client** of a **completed** booking, one review per
   * booking, from 24 h after the completion until 60 days after it, and never
   * while a dispute is open.
   */
  async create(auth: AuthUser, bookingId: string, dto: AppCreateReviewDto, lang: Lang): Promise<AppMyReviewDto> {
    const reviewId = await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const [booking] = await em.query('SELECT id, reference, client_id, provider_id, status, dispute_status, completed_at FROM bookings WHERE id = ? AND deleted_at IS NULL', [bookingId]);
      if (!booking) throw AppException.of('BOOKING_NOT_FOUND');
      assertOwner(booking.client_id, auth.id);
      if (booking.status !== BookingStatus.Completed) throw AppException.of('REVIEW_NOT_ALLOWED', { status: booking.status });
      if (booking.dispute_status === BookingDisputeStatus.Open) throw AppException.of('REVIEW_NOT_ALLOWED', { reason: 'dispute_open' });
      const [existing] = await em.query('SELECT id FROM reviews WHERE booking_id = ? AND deleted_at IS NULL', [bookingId]);
      if (existing) throw AppException.of('REVIEW_EXISTS', { reviewId: existing.id });

      const hours = Number(await this.settings.get('review_open_after_hours'));
      const window = reviewWindow(booking.completed_at ? new Date(booking.completed_at) : null, hours);
      if (!window.open) throw AppException.of('REVIEW_WINDOW_CLOSED', { opensAt: window.opensAt, closesAt: window.closesAt });

      const created = await insertReview(em, { bookingId, rating: dto.rating, comment: dto.comment });
      await this.audit.log(
        {
          action: 'review.created',
          objectType: 'review',
          objectId: created.id,
          objectLabel: booking.reference,
          level: AuditLevel.Normal,
          changes: { bookingId, rating: dto.rating, flags: created.flags, reportId: created.reportId },
        },
        em,
      );
      if (created.reportId) {
        this.events.emitAfterCommit<ReportCreatedEvent>(afterCommit, REVIEW_EVENTS.reportCreated, {
          reportId: created.reportId,
          targetType: ReportTargetType.Review,
          targetId: created.id,
          reason: autoReportReason(created.flags)! as ReportCreatedEvent['reason'],
          automatic: true,
        });
      }
      this.events.emitAfterCommit<ReviewCreatedEvent>(afterCommit, REVIEW_EVENTS.created, {
        reviewId: created.id,
        bookingId,
        bookingReference: booking.reference,
        authorId: auth.id,
        providerId: booking.provider_id,
        rating: dto.rating,
        flags: created.flags,
        reportId: created.reportId,
      });
      return created.id;
    });
    return this.one(auth, reviewId, lang);
  }

  /** The author edits their own review for 48 h (status-rules §8). */
  async edit(auth: AuthUser, id: string, dto: AppEditReviewDto, lang: Lang): Promise<AppMyReviewDto> {
    if (dto.rating === undefined && dto.comment === undefined) {
      throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'rating', code: 'EMPTY', message: 'Send a rating, a comment, or both' }]);
    }
    await runInTransaction(this.dataSource, async (em) => {
      const [review] = await em.query('SELECT * FROM reviews WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
      if (!review) throw AppException.of('REVIEW_NOT_FOUND');
      assertOwner(review.author_id, auth.id);
      if (!withinEditWindow(new Date(review.created_at))) throw AppException.of('REVIEW_EDIT_WINDOW_CLOSED');
      const rating = dto.rating ?? Number(review.rating);
      const comment = dto.comment ?? review.comment;
      await em.query('UPDATE reviews SET rating = ?, comment = ?, updated_at = ? WHERE id = ?', [rating, comment, new Date(), id]);
      await recomputeRatings(em, { serviceId: review.service_id, packId: review.pack_id, providerId: review.provider_id });
      await this.audit.log(
        {
          action: 'review.edited_by_author',
          objectType: 'review',
          objectId: id,
          level: AuditLevel.Normal,
          changes: { rating: { from: Number(review.rating), to: rating }, comment: { from: review.comment, to: comment } },
        },
        em,
      );
    });
    return this.one(auth, id, lang);
  }

  private async one(auth: AuthUser, id: string, lang: Lang): Promise<AppMyReviewDto> {
    const page = await this.mine(auth, { page: 1, limit: 1 }, lang, id);
    const row = page.data[0];
    if (!row) throw AppException.of('REVIEW_NOT_FOUND');
    return row;
  }

  /** The client's own reviews (Profile · My reviews), whatever an admin did to them. */
  async mine(auth: AuthUser, query: { page: number; limit: number }, lang: Lang, onlyId?: string): Promise<Paginated<AppMyReviewDto>> {
    const em = this.dataSource.manager;
    const where = `r.author_id = ? AND r.deleted_at IS NULL${onlyId ? ' AND r.id = ?' : ''}`;
    const params = onlyId ? [auth.id, onlyId] : [auth.id];
    const [[count], rows] = await Promise.all([
      em.query(`SELECT COUNT(*) AS n FROM reviews r WHERE ${where}`, params),
      em.query(
        `SELECT r.id, r.rating, r.comment, r.redacted_comment, r.status, r.created_at, r.booking_id,
                b.reference, s.id AS service_id, s.title_en, s.title_ar,
                COALESCE(pp.business_name, pu.full_name) AS provider_name,
                rr.body AS reply_body, rr.status AS reply_status
           FROM reviews r
           JOIN bookings b ON b.id = r.booking_id
           JOIN users pu ON pu.id = r.provider_id
           LEFT JOIN provider_profiles pp ON pp.user_id = r.provider_id AND pp.deleted_at IS NULL
           LEFT JOIN services s ON s.id = r.service_id
           LEFT JOIN review_replies rr ON rr.review_id = r.id AND rr.deleted_at IS NULL
          WHERE ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
        [...params, query.limit, (query.page - 1) * query.limit],
      ),
    ]);
    const data = (rows as any[]).map(
      (r): AppMyReviewDto => ({
        id: r.id,
        bookingId: r.booking_id,
        bookingReference: r.reference,
        rating: Number(r.rating),
        comment: r.status === ReviewStatus.Redacted ? (r.redacted_comment ?? '') : r.comment,
        serviceId: r.service_id ?? null,
        serviceTitle: r.service_id ? pickTextOrNull(lang, r.title_en, r.title_ar) : null,
        providerName: r.provider_name,
        status: r.status,
        reply: r.reply_status === 'published' ? r.reply_body : null,
        editable: withinEditWindow(new Date(r.created_at)),
        createdAt: iso(r.created_at)!,
      }),
    );
    return paginate(data, Number(count.n), query);
  }

  // ── disputes ──────────────────────────────────────────────────

  /**
   * "Report a problem" on a booking (status-rules §6): from the event start
   * until 72 h after the event end, or within 7 days of a contested
   * cancellation. Opening one pauses auto-completion and reviews.
   */
  async openDispute(auth: AuthUser, bookingId: string, dto: AppOpenDisputeDto, lang: Lang): Promise<AppDisputeDetailDto> {
    const [booking] = await this.dataSource.query('SELECT id, client_id, provider_id FROM bookings WHERE id = ? AND deleted_at IS NULL', [bookingId]);
    if (!booking) throw AppException.of('BOOKING_NOT_FOUND');
    const role = booking.client_id === auth.id ? PartyRole.Client : booking.provider_id === auth.id ? PartyRole.Provider : null;
    if (!role) throw AppException.of('NOT_OWNER');
    const detail = await this.disputes.open(auth, {
      bookingId,
      openedByRole: role,
      type: dto.type,
      description: dto.description,
      evidenceFileIds: dto.evidenceFileIds,
      // A party never opens outside the window: that is an admin-only override.
      ignoreWindow: false,
    });
    return this.disputeDetail(auth, detail.id, lang);
  }

  /** The caller must be one of the two parties of the dispute's booking. */
  private async ownDispute(em: EntityManager, id: string, auth: AuthUser) {
    const [row] = await em.query(
      `SELECT d.*, b.reference AS booking_reference, b.event_date, b.client_id, b.provider_id,
              COALESCE(s.title_en, pk.name_en) AS title_en, COALESCE(s.title_ar, pk.name_ar) AS title_ar
         FROM disputes d JOIN bookings b ON b.id = d.booking_id
         LEFT JOIN services s ON s.id = b.service_id
         LEFT JOIN packs pk ON pk.id = b.pack_id
        WHERE d.id = ? AND d.deleted_at IS NULL`,
      [id],
    );
    if (!row) throw AppException.of('DISPUTE_NOT_FOUND');
    if (row.client_id !== auth.id && row.provider_id !== auth.id) throw AppException.of('NOT_OWNER');
    return row;
  }

  async listDisputes(auth: AuthUser, query: { page: number; limit: number }, lang: Lang): Promise<Paginated<AppDisputeRowDto>> {
    const em = this.dataSource.manager;
    const where = 'd.deleted_at IS NULL AND (b.client_id = ? OR b.provider_id = ?)';
    const [[count], rows] = await Promise.all([
      em.query(`SELECT COUNT(*) AS n FROM disputes d JOIN bookings b ON b.id = d.booking_id WHERE ${where}`, [auth.id, auth.id]),
      em.query(
        `SELECT d.*, b.reference AS booking_reference, b.event_date,
                COALESCE(s.title_en, pk.name_en) AS title_en, COALESCE(s.title_ar, pk.name_ar) AS title_ar,
                (SELECT COUNT(*) FROM dispute_evidence de WHERE de.dispute_id = d.id) AS evidence_count
           FROM disputes d JOIN bookings b ON b.id = d.booking_id
           LEFT JOIN services s ON s.id = b.service_id
           LEFT JOIN packs pk ON pk.id = b.pack_id
          WHERE ${where} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
        [auth.id, auth.id, query.limit, (query.page - 1) * query.limit],
      ),
    ]);
    return paginate(
      (rows as any[]).map((r) => this.toDisputeRow(r, auth, lang)),
      Number(count.n),
      query,
    );
  }

  private toDisputeRow(r: any, auth: AuthUser, lang: Lang): AppDisputeRowDto {
    return {
      id: r.id,
      reference: r.reference,
      status: r.status as DisputeStatus,
      type: r.type,
      bookingId: r.booking_id,
      bookingReference: r.booking_reference,
      eventDate: dateOnly(r.event_date),
      title: pickTextOrNull(lang, r.title_en, r.title_ar) ?? '',
      openedByRole: r.opened_by_role,
      openedByMe: r.opened_by_id === auth.id,
      conversationId: r.conversation_id ?? null,
      evidenceCount: Number(r.evidence_count ?? 0),
      decisionNote: r.decision_note ?? null,
      createdAt: iso(r.created_at)!,
    };
  }

  async disputeDetail(auth: AuthUser, id: string, lang: Lang): Promise<AppDisputeDetailDto> {
    const em = this.dataSource.manager;
    const row = await this.ownDispute(em, id, auth);
    const [evidence, max, [counted]] = await Promise.all([
      em.query('SELECT id, kind, file_id, note, uploaded_by_id, created_at FROM dispute_evidence WHERE dispute_id = ? ORDER BY created_at', [id]),
      this.settings.get('max_dispute_evidence_files'),
      em.query('SELECT COUNT(*) AS n FROM dispute_evidence WHERE dispute_id = ?', [id]),
    ]);
    return {
      ...this.toDisputeRow({ ...row, evidence_count: Number(counted.n) }, auth, lang),
      description: row.description,
      evidence: (evidence as any[]).map((e) => ({
        id: e.id,
        kind: e.kind,
        url: e.file_id ? this.files.signedUrl(e.file_id) : null,
        note: e.note ?? null,
        mine: e.uploaded_by_id === auth.id,
        createdAt: iso(e.created_at)!,
      })),
      evidenceMax: Number(max),
      active: isActive(row.status as DisputeStatus),
      resolvedAt: iso(row.resolved_at),
    };
  }

  /** A message in the dispute chat, from a party (the chat holds both parties and Eventor). */
  async sendDisputeMessage(auth: AuthUser, id: string, body: string) {
    await this.ownDispute(this.dataSource.manager, id, auth);
    return this.disputes.sendMessage(auth, id, body);
  }

  /** A party attaches one more evidence file, up to `max_dispute_evidence_files` each. */
  async addEvidence(auth: AuthUser, id: string, note: string | null, upload: { buffer: Buffer; originalName: string } | undefined, lang: Lang): Promise<AppDisputeDetailDto> {
    await this.ownDispute(this.dataSource.manager, id, auth);
    await this.disputes.addEvidence(auth, id, { partyUserId: auth.id, note: note ?? undefined }, upload);
    return this.disputeDetail(auth, id, lang);
  }

  /** status-rules §6: the opener can withdraw their dispute while it is still open or in review. */
  async withdraw(auth: AuthUser, id: string, note: string, lang: Lang): Promise<AppDisputeDetailDto> {
    const row = await this.ownDispute(this.dataSource.manager, id, auth);
    if (row.opened_by_id !== auth.id || !isActive(row.status as DisputeStatus)) {
      throw AppException.of('DISPUTE_NOT_WITHDRAWABLE', { status: row.status });
    }
    await this.disputes.close(auth, id, { note });
    return this.disputeDetail(auth, id, lang);
  }
}
