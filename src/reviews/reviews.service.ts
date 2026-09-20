import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { dateOnly } from '../bookings/bookings.service.js';
import { likeContains } from '../common/dto/transforms.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { ReportReason, ReportStatus, ReportTargetType, ReviewReplyStatus } from '../common/enums/moderation.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { preview } from '../messaging/contact-masking.js';
import {
  REVIEW_SORT_FIELDS,
  type DeleteReviewDto,
  type EditReviewDto,
  type ModerateReplyDto,
  type ModerateReviewDto,
  type ReplyDeletedDto,
  type ReviewDeletedDto,
  type ReviewDetailDto,
  type ReviewFiltersDto,
  type ReviewRowDto,
  type ReviewsQueryDto,
  type ReviewTabCountsDto,
} from './dto/reviews.dto.js';
import { Review } from './entities/review.entity.js';
import { ReviewReply } from './entities/review-reply.entity.js';
import { autoReportReason, detectFlags, type ReviewFlag } from './flag-detection.js';
import { REVIEW_EVENTS, type ReplyModeratedEvent, type ReportCreatedEvent, type ReportsClosedEvent, type ReviewModeratedEvent } from './reviews.events.js';
import { allowedReviewActions, moderationTarget, replyTarget } from './reviews.policy.js';
import { closeOpenReports, insertReview, insertReviewReply, recomputeRatings, type InsertedReview, type InsertReviewInput } from './reviews.writes.js';

export const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);
const parseJson = <T>(value: unknown): T | null => (typeof value === 'string' ? (JSON.parse(value) as T) : ((value as T) ?? null));

const FROM = `FROM reviews r
  JOIN users au ON au.id = r.author_id
  JOIN users pu ON pu.id = r.provider_id
  LEFT JOIN provider_profiles pp ON pp.user_id = r.provider_id
  LEFT JOIN services s ON s.id = r.service_id
  LEFT JOIN packs pk ON pk.id = r.pack_id
  JOIN bookings b ON b.id = r.booking_id
  LEFT JOIN review_replies rr ON rr.review_id = r.id AND rr.deleted_at IS NULL`;

/** FROM for counters: the joins above are at most one row per review and only `q` reads them. */
const COUNT_FROM = 'FROM reviews r';
const countFrom = (filters: ReviewFiltersDto) => (filters.q ? FROM : COUNT_FROM);

export const REVIEW_OPEN_REPORTS_SQL = (alias: string) =>
  `(SELECT COUNT(*) FROM reports rp WHERE rp.target_type = 'review' AND rp.target_id = ${alias}.id AND rp.status = 'open' AND rp.deleted_at IS NULL)`;

const SORT_COLUMNS: Record<(typeof REVIEW_SORT_FIELDS)[number], string> = {
  createdAt: 'r.created_at',
  rating: 'r.rating',
};

const SELECT = `SELECT r.id, r.rating, r.comment, r.redacted_comment, r.status, r.detected_flags, r.had_dispute, r.created_at, r.updated_at, r.edited_at,
  r.moderated_by_id, r.moderated_at, r.moderation_note, r.author_id, au.full_name AS author_name, r.provider_id, pu.full_name AS provider_name, pp.business_name,
  s.id AS service_id, s.title_en, s.title_ar, pk.id AS pack_id, pk.name_en, pk.name_ar, b.id AS booking_id, b.reference AS booking_reference,
  rr.id AS reply_id, rr.body AS reply_body, rr.status AS reply_status, ${REVIEW_OPEN_REPORTS_SQL('r')} AS reports_open`;

const ACTION_AUDIT: Record<'hide' | 'show' | 'redact', string> = { hide: 'review.hidden', show: 'review.shown', redact: 'review.redacted' };

/** REV-01…REV-03: review moderation, ratings recompute and provider replies. */
@Injectable()
export class ReviewsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  // ── list ────────────────────────────────────────────────────

  private where(filters: ReviewFiltersDto, options: { tab: boolean }): { sql: string; params: unknown[] } {
    const clauses = ['r.deleted_at IS NULL'];
    const params: unknown[] = [];
    const add = (sql: string, ...values: unknown[]) => {
      clauses.push(sql);
      params.push(...values);
    };
    const tab = filters.tab ?? 'all';
    if (options.tab && tab !== 'all') {
      if (tab === 'reported') add(`${REVIEW_OPEN_REPORTS_SQL('r')} > 0`);
      else add('r.status = ?', tab);
    }
    if (filters.rating?.length) add('r.rating IN (?)', filters.rating);
    if (filters.ratingMin !== undefined) add('r.rating >= ?', filters.ratingMin);
    if (filters.ratingMax !== undefined) add('r.rating <= ?', filters.ratingMax);
    if (filters.providerId) add('r.provider_id = ?', filters.providerId);
    if (filters.serviceId) add('r.service_id = ?', filters.serviceId);
    if (filters.packId) add('r.pack_id = ?', filters.packId);
    if (filters.authorId) add('r.author_id = ?', filters.authorId);
    if (filters.hadDispute !== undefined) add('r.had_dispute = ?', filters.hadDispute ? 1 : 0);
    if (filters.flagged !== undefined) add(filters.flagged ? '(r.detected_flags IS NOT NULL AND JSON_LENGTH(r.detected_flags) > 0)' : '(r.detected_flags IS NULL OR JSON_LENGTH(r.detected_flags) = 0)');
    if (filters.createdFrom) add('r.created_at >= ?', new Date(`${filters.createdFrom}T00:00:00Z`));
    if (filters.createdTo) add('r.created_at < ?', new Date(new Date(`${filters.createdTo}T00:00:00Z`).getTime() + 86_400_000));
    if (filters.q) {
      const like = likeContains(filters.q);
      add('(r.comment LIKE ? OR au.full_name LIKE ? OR pu.full_name LIKE ? OR pp.business_name LIKE ?)', like, like, like, like);
    }
    return { sql: clauses.join(' AND '), params };
  }

  private toRow(r: any): ReviewRowDto {
    return {
      id: r.id,
      rating: Number(r.rating),
      comment: preview(r.comment, 200) ?? '',
      redactedComment: r.redacted_comment,
      status: r.status,
      author: { id: r.author_id, fullName: r.author_name },
      provider: { id: r.provider_id, fullName: r.provider_name, businessName: r.business_name ?? null },
      service: r.service_id ? { id: r.service_id, titleEn: r.title_en, titleAr: r.title_ar } : null,
      pack: r.pack_id ? { id: r.pack_id, nameEn: r.name_en, nameAr: r.name_ar } : null,
      booking: { id: r.booking_id, reference: r.booking_reference },
      hadDispute: Number(r.had_dispute) === 1,
      detectedFlags: parseJson<ReviewFlag[]>(r.detected_flags) ?? [],
      reportsOpen: Number(r.reports_open),
      reply: r.reply_id ? { id: r.reply_id, body: r.reply_body, status: r.reply_status } : null,
      createdAt: iso(r.created_at)!,
      editedAt: iso(r.edited_at),
    };
  }

  async count(filters: ReviewFiltersDto): Promise<number> {
    const where = this.where(filters, { tab: true });
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n ${countFrom(filters)} WHERE ${where.sql}`, where.params);
    return Number(n);
  }

  async fetchRows(filters: ReviewFiltersDto, sort: string | undefined, page: { offset: number; limit: number }): Promise<ReviewRowDto[]> {
    const [field, direction] = Object.entries(toOrder(sort, REVIEW_SORT_FIELDS, ['createdAt', 'DESC']))[0]! as [(typeof REVIEW_SORT_FIELDS)[number], 'ASC' | 'DESC'];
    const where = this.where(filters, { tab: true });
    const rows: any[] = await this.dataSource.query(`${SELECT} ${FROM} WHERE ${where.sql} ORDER BY ${field === 'createdAt' ? `r.created_at ${direction}, r.id ${direction}` : `${SORT_COLUMNS[field]} ${direction}, r.created_at DESC, r.id DESC`} LIMIT ? OFFSET ?`, [
      ...where.params,
      page.limit,
      page.offset,
    ]);
    return rows.map((r) => this.toRow(r));
  }

  async tabCounts(filters: ReviewFiltersDto): Promise<ReviewTabCountsDto> {
    const where = this.where(filters, { tab: false });
    const [raw] = await this.dataSource.query(
      `SELECT COUNT(*) AS all_n, SUM(r.status = 'published') AS published, SUM(r.status = 'hidden') AS hidden, SUM(r.status = 'redacted') AS redacted,
              SUM(${REVIEW_OPEN_REPORTS_SQL('r')} > 0) AS reported
       ${countFrom(filters)} WHERE ${where.sql}`,
      where.params,
    );
    const n = (v: unknown) => Number(v ?? 0);
    return { all: n(raw.all_n), published: n(raw.published), reported: n(raw.reported), hidden: n(raw.hidden), redacted: n(raw.redacted) };
  }

  async list(query: ReviewsQueryDto): Promise<Paginated<ReviewRowDto, ReviewTabCountsDto>> {
    const [rows, counts] = await Promise.all([
      this.fetchRows(query, query.sort, { offset: (query.page - 1) * query.limit, limit: query.limit }),
      this.tabCounts(query),
    ]);
    // Counters follow every filter but the tab: the current tab's counter is the total.
    return paginateWithCounts(rows, counts[query.tab ?? 'all'], query, counts);
  }

  // ── detail ──────────────────────────────────────────────────

  async get(id: string, em: EntityManager = this.dataSource.manager): Promise<ReviewDetailDto> {
    const [r] = await em.query(
      `${SELECT}, b.status AS booking_status, b.dispute_status AS booking_dispute_status, b.event_date, b.total, mu.full_name AS moderated_by_name,
              rr.provider_id AS reply_provider_id, rpu.full_name AS reply_provider_name, rr.edited_at AS reply_edited_at, rr.created_at AS reply_created_at,
              rr.moderated_by_id AS reply_moderated_by_id, rmu.full_name AS reply_moderated_by_name
       ${FROM} LEFT JOIN users mu ON mu.id = r.moderated_by_id LEFT JOIN users rpu ON rpu.id = rr.provider_id LEFT JOIN users rmu ON rmu.id = rr.moderated_by_id
       WHERE r.id = ? AND r.deleted_at IS NULL`,
      [id],
    );
    if (!r) throw AppException.of('REVIEW_NOT_FOUND');
    const [reports, disputes] = await Promise.all([
      em.query(
        `SELECT rp.id, rp.target_type, rp.reason, rp.note, rp.status, rp.reporter_id, ru.full_name AS reporter_name, rp.resolved_by_id, rb.full_name AS resolved_by_name,
                rp.resolved_at, rp.resolution_note, rp.dispute_id, rp.created_at
         FROM reports rp LEFT JOIN users ru ON ru.id = rp.reporter_id LEFT JOIN users rb ON rb.id = rp.resolved_by_id
         WHERE rp.deleted_at IS NULL AND ((rp.target_type = 'review' AND rp.target_id = ?) OR (rp.target_type = 'review_reply' AND rp.target_id = ?))
         ORDER BY rp.created_at DESC, rp.id`,
        [id, r.reply_id ?? ''],
      ),
      em.query('SELECT id, reference, status FROM disputes WHERE booking_id = ? AND deleted_at IS NULL ORDER BY created_at DESC', [r.booking_id]),
    ]);
    const person = (userId: string | null, name: string | null) => (userId ? { id: userId, fullName: name ?? 'Deleted user' } : null);
    const row = this.toRow(r);
    const replyReportsOpen = reports.filter((x: any) => x.target_type === ReportTargetType.ReviewReply && x.status === ReportStatus.Open).length;
    return {
      ...row,
      comment: r.comment,
      booking: { id: r.booking_id, reference: r.booking_reference, status: r.booking_status, disputeStatus: r.booking_dispute_status, eventDate: dateOnly(r.event_date), total: String(r.total) },
      reply: r.reply_id
        ? {
            id: r.reply_id,
            body: r.reply_body,
            status: r.reply_status,
            provider: { id: r.reply_provider_id, fullName: r.reply_provider_name ?? 'Deleted user' },
            editedAt: iso(r.reply_edited_at),
            moderatedBy: person(r.reply_moderated_by_id, r.reply_moderated_by_name),
            reportsOpen: replyReportsOpen,
            createdAt: iso(r.reply_created_at)!,
          }
        : null,
      disputes: disputes.map((d: any) => ({ id: d.id, reference: d.reference, status: d.status })),
      reports: reports.map((x: any) => ({
        id: x.id,
        targetType: x.target_type,
        reason: x.reason,
        note: x.note,
        status: x.status,
        reporter: person(x.reporter_id, x.reporter_name),
        resolvedBy: person(x.resolved_by_id, x.resolved_by_name),
        resolvedAt: iso(x.resolved_at),
        resolutionNote: x.resolution_note,
        disputeId: x.dispute_id,
        createdAt: iso(x.created_at)!,
      })),
      moderatedBy: person(r.moderated_by_id, r.moderated_by_name),
      moderatedAt: iso(r.moderated_at),
      moderationNote: r.moderation_note,
      allowedActions: allowedReviewActions({ status: r.status, openReports: row.reportsOpen, hasBooking: true }),
      updatedAt: iso(r.updated_at)!,
    };
  }

  // ── writes shared with the mobile API and the seed ──────────

  /** Client review (future mobile API): flag scan + automatic report + ratings, then `report.created` after COMMIT when flagged. */
  async createInTransaction(em: EntityManager, afterCommit: AfterCommit, input: InsertReviewInput): Promise<InsertedReview> {
    const inserted = await insertReview(em, input);
    if (inserted.reportId) {
      this.events.emitAfterCommit<ReportCreatedEvent>(afterCommit, REVIEW_EVENTS.reportCreated, {
        reportId: inserted.reportId,
        targetType: ReportTargetType.Review,
        targetId: inserted.id,
        reason: autoReportReason(inserted.flags) as ReportReason,
        automatic: true,
      });
    }
    return inserted;
  }

  /** Provider reply (future mobile API), with the same flag scan. */
  async createReplyInTransaction(em: EntityManager, afterCommit: AfterCommit, input: { reviewId: string; body: string }): Promise<{ id: string; reportId: string | null }> {
    const inserted = await insertReviewReply(em, input);
    if (inserted.reportId) {
      this.events.emitAfterCommit<ReportCreatedEvent>(afterCommit, REVIEW_EVENTS.reportCreated, {
        reportId: inserted.reportId,
        targetType: ReportTargetType.ReviewReply,
        targetId: inserted.id,
        reason: autoReportReason(inserted.flags) as ReportReason,
        automatic: true,
      });
    }
    return inserted;
  }

  // ── moderation ──────────────────────────────────────────────

  private async lockReview(em: EntityManager, id: string): Promise<Review> {
    const review = await em.getRepository(Review).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!review) throw AppException.of('REVIEW_NOT_FOUND');
    return review;
  }

  private label(review: Review): string {
    return `★${review.rating} · ${preview(review.comment, 80) ?? ''}`;
  }

  async moderate(auth: AuthUser, id: string, dto: ModerateReviewDto): Promise<ReviewDetailDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const review = await this.lockReview(em, id);
      const now = new Date();
      if (dto.action === 'dismiss_reports') {
        const closed = await closeOpenReports(em, { type: ReportTargetType.Review, id }, { status: ReportStatus.Dismissed, adminId: auth.id, note: dto.note ?? null, at: now });
        if (!closed.length) throw AppException.of('REVIEW_NO_OPEN_REPORTS');
        await this.audit.log(
          { action: 'review.reports_dismissed', objectType: 'review', objectId: id, objectLabel: this.label(review), level: AuditLevel.Normal, changes: { reportIds: closed.map((c) => c.id) }, note: dto.note ?? null },
          em,
        );
        this.events.emitAfterCommit<ReportsClosedEvent>(afterCommit, REVIEW_EVENTS.reportsClosed, {
          reports: closed,
          status: ReportStatus.Dismissed,
          targetType: ReportTargetType.Review,
          targetId: id,
          disputeReference: null,
        });
        return;
      }
      const to = moderationTarget(review.status, dto.action);
      if (!to) throw AppException.of('REVIEW_INVALID_TRANSITION', { status: review.status, action: dto.action });
      const redactedComment = dto.action === 'redact' ? dto.redactedComment! : review.redactedComment;
      await em.getRepository(Review).update(id, { status: to, redactedComment, moderatedById: auth.id, moderatedAt: now, moderationNote: dto.note ?? null });
      const closed = await closeOpenReports(em, { type: ReportTargetType.Review, id }, { status: ReportStatus.Resolved, adminId: auth.id, note: dto.note ?? `Review ${to}.`, at: now });
      await recomputeRatings(em, { serviceId: review.serviceId, packId: review.packId, providerId: review.providerId });
      await this.audit.log(
        {
          action: ACTION_AUDIT[dto.action],
          objectType: 'review',
          objectId: id,
          objectLabel: this.label(review),
          level: dto.action === 'show' ? AuditLevel.Normal : AuditLevel.Sensitive,
          changes: {
            status: { from: review.status, to },
            ...(dto.action === 'redact' ? { redactedComment: { from: review.redactedComment, to: redactedComment } } : {}),
            reportsResolved: closed.length,
          },
          note: dto.note ?? null,
        },
        em,
      );
      this.events.emitAfterCommit<ReviewModeratedEvent>(afterCommit, REVIEW_EVENTS.moderated, {
        reviewId: id,
        authorId: review.authorId,
        action: dto.action,
        note: dto.note ?? null,
        notifyAuthor: dto.notifyAuthor !== false,
      });
      if (closed.length) {
        this.events.emitAfterCommit<ReportsClosedEvent>(afterCommit, REVIEW_EVENTS.reportsClosed, { reports: closed, status: ReportStatus.Resolved, targetType: ReportTargetType.Review, targetId: id, disputeReference: null });
      }
    });
    return this.get(id);
  }

  async edit(auth: AuthUser, id: string, dto: EditReviewDto): Promise<ReviewDetailDto> {
    await runInTransaction(this.dataSource, async (em) => {
      const review = await this.lockReview(em, id);
      const flags = detectFlags(dto.comment);
      await em.getRepository(Review).update(id, { comment: dto.comment, detectedFlags: flags.length ? flags : null, moderatedById: auth.id, moderatedAt: new Date() });
      await this.audit.log(
        {
          action: 'review.edited',
          objectType: 'review',
          objectId: id,
          objectLabel: this.label(review),
          level: AuditLevel.Sensitive,
          changes: { comment: { from: review.comment, to: dto.comment }, detectedFlags: { from: review.detectedFlags, to: flags } },
          note: dto.reason,
        },
        em,
      );
    });
    return this.get(id);
  }

  async remove(auth: AuthUser, id: string, dto: DeleteReviewDto): Promise<ReviewDeletedDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const review = await this.lockReview(em, id);
      const now = new Date();
      await em.query('UPDATE reviews SET deleted_at = ?, moderated_by_id = ?, moderated_at = ?, moderation_note = ? WHERE id = ?', [now, auth.id, now, dto.reason, id]);
      const closed = await closeOpenReports(em, { type: ReportTargetType.Review, id }, { status: ReportStatus.Resolved, adminId: auth.id, note: dto.reason, at: now });
      await recomputeRatings(em, { serviceId: review.serviceId, packId: review.packId, providerId: review.providerId });
      await this.audit.log(
        {
          action: 'review.deleted',
          objectType: 'review',
          objectId: id,
          objectLabel: this.label(review),
          level: AuditLevel.Sensitive,
          changes: { status: review.status, rating: review.rating, bookingId: review.bookingId, reportsResolved: closed.length },
          note: dto.reason,
        },
        em,
      );
      if (closed.length) {
        this.events.emitAfterCommit<ReportsClosedEvent>(afterCommit, REVIEW_EVENTS.reportsClosed, { reports: closed, status: ReportStatus.Resolved, targetType: ReportTargetType.Review, targetId: id, disputeReference: null });
      }
      return { id, deletedAt: now.toISOString(), reportsResolved: closed.length };
    });
  }

  // ── replies ─────────────────────────────────────────────────

  private async lockReply(em: EntityManager, id: string): Promise<ReviewReply> {
    const reply = await em.getRepository(ReviewReply).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!reply) throw AppException.of('REVIEW_REPLY_NOT_FOUND');
    const [review] = await em.query('SELECT id FROM reviews WHERE id = ? AND deleted_at IS NULL', [reply.reviewId]);
    if (!review) throw AppException.of('REVIEW_REPLY_NOT_FOUND');
    return reply;
  }

  async moderateReply(auth: AuthUser, id: string, action: 'hide' | 'show', dto: ModerateReplyDto): Promise<ReviewDetailDto> {
    const reviewId = await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const reply = await this.lockReply(em, id);
      const to = replyTarget(reply.status, action);
      if (!to) throw AppException.of('REVIEW_REPLY_INVALID_TRANSITION', { status: reply.status, action });
      await em.getRepository(ReviewReply).update(id, { status: to, moderatedById: auth.id });
      const closed =
        to === ReviewReplyStatus.Hidden
          ? await closeOpenReports(em, { type: ReportTargetType.ReviewReply, id }, { status: ReportStatus.Resolved, adminId: auth.id, note: dto.note ?? 'Reply hidden.' })
          : [];
      await this.audit.log(
        {
          action: action === 'hide' ? 'review_reply.hidden' : 'review_reply.shown',
          objectType: 'review_reply',
          objectId: id,
          objectLabel: preview(reply.body, 120),
          level: AuditLevel.Normal,
          changes: { reviewId: reply.reviewId, status: { from: reply.status, to }, reportsResolved: closed.length },
          note: dto.note ?? null,
        },
        em,
      );
      this.events.emitAfterCommit<ReplyModeratedEvent>(afterCommit, REVIEW_EVENTS.replyModerated, { replyId: id, reviewId: reply.reviewId, providerId: reply.providerId, action });
      if (closed.length) {
        this.events.emitAfterCommit<ReportsClosedEvent>(afterCommit, REVIEW_EVENTS.reportsClosed, { reports: closed, status: ReportStatus.Resolved, targetType: ReportTargetType.ReviewReply, targetId: id, disputeReference: null });
      }
      return reply.reviewId;
    });
    return this.get(reviewId);
  }

  async removeReply(auth: AuthUser, id: string): Promise<ReplyDeletedDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const reply = await this.lockReply(em, id);
      const now = new Date();
      await em.query('UPDATE review_replies SET deleted_at = ?, moderated_by_id = ? WHERE id = ?', [now, auth.id, id]);
      const closed = await closeOpenReports(em, { type: ReportTargetType.ReviewReply, id }, { status: ReportStatus.Resolved, adminId: auth.id, note: 'Reply deleted.', at: now });
      await this.audit.log(
        {
          action: 'review_reply.deleted',
          objectType: 'review_reply',
          objectId: id,
          objectLabel: preview(reply.body, 120),
          level: AuditLevel.Sensitive,
          changes: { reviewId: reply.reviewId, body: reply.body, status: reply.status, reportsResolved: closed.length },
        },
        em,
      );
      if (closed.length) {
        this.events.emitAfterCommit<ReportsClosedEvent>(afterCommit, REVIEW_EVENTS.reportsClosed, { reports: closed, status: ReportStatus.Resolved, targetType: ReportTargetType.ReviewReply, targetId: id, disputeReference: null });
      }
      return { id, reviewId: reply.reviewId, deletedAt: now.toISOString() };
    });
  }

  /** Export columns need the full comment, not the preview. */
  async exportRows(filters: ReviewFiltersDto, page: { offset: number; limit: number }): Promise<(ReviewRowDto & { fullComment: string })[]> {
    const where = this.where(filters, { tab: true });
    const rows: any[] = await this.dataSource.query(`${SELECT} ${FROM} WHERE ${where.sql} ORDER BY r.created_at DESC, r.id ASC LIMIT ? OFFSET ?`, [...where.params, page.limit, page.offset]);
    return rows.map((r) => ({ ...this.toRow(r), fullComment: r.comment }));
  }
}
