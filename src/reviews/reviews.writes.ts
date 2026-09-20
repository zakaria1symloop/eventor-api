import type { EntityManager } from 'typeorm';
import { ReportReason, ReportStatus, ReportTargetType, ReviewReplyStatus, ReviewStatus } from '../common/enums/moderation.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { autoReportReason, detectFlags, type ReviewFlag } from './flag-detection.js';
import { RATED_STATUSES } from './reviews.policy.js';

/**
 * Database writes shared by the admin services, the demo seed and the future
 * mobile API (no Nest dependencies). Callers run them inside their transaction
 * and emit events after COMMIT.
 */

const RATED_SQL = RATED_STATUSES.map((s) => `'${s}'`).join(', ');

/** Cached `avg_rating` / `rating_count` of a service, a pack and a provider from their published + redacted reviews. */
export async function recomputeRatings(em: EntityManager, targets: { serviceId?: string | null; packId?: string | null; providerId?: string | null }): Promise<void> {
  if (targets.serviceId) {
    await em.query(
      `UPDATE services s SET
         avg_rating = COALESCE((SELECT ROUND(AVG(r.rating), 2) FROM reviews r WHERE r.service_id = s.id AND r.status IN (${RATED_SQL}) AND r.deleted_at IS NULL), 0),
         rating_count = (SELECT COUNT(*) FROM reviews r WHERE r.service_id = s.id AND r.status IN (${RATED_SQL}) AND r.deleted_at IS NULL)
       WHERE s.id = ?`,
      [targets.serviceId],
    );
  }
  if (targets.packId) {
    await em.query(
      `UPDATE packs p SET
         avg_rating = COALESCE((SELECT ROUND(AVG(r.rating), 2) FROM reviews r WHERE r.pack_id = p.id AND r.status IN (${RATED_SQL}) AND r.deleted_at IS NULL), 0),
         rating_count = (SELECT COUNT(*) FROM reviews r WHERE r.pack_id = p.id AND r.status IN (${RATED_SQL}) AND r.deleted_at IS NULL)
       WHERE p.id = ?`,
      [targets.packId],
    );
  }
  if (targets.providerId) {
    await em.query(
      `UPDATE provider_profiles pp SET
         avg_rating = COALESCE((SELECT ROUND(AVG(r.rating), 2) FROM reviews r WHERE r.provider_id = pp.user_id AND r.status IN (${RATED_SQL}) AND r.deleted_at IS NULL), 0),
         rating_count = (SELECT COUNT(*) FROM reviews r WHERE r.provider_id = pp.user_id AND r.status IN (${RATED_SQL}) AND r.deleted_at IS NULL)
       WHERE pp.user_id = ?`,
      [targets.providerId],
    );
  }
}

export interface InsertReportInput {
  /** Null: automatic report by the system (flag scan). */
  reporterId: string | null;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  note?: string | null;
  status?: ReportStatus;
  createdAt?: Date;
}

/**
 * One open report per reporter and target (status-rules §9): an existing open
 * report is returned instead of a new row. `created` tells whether a row was inserted.
 */
export async function insertReport(em: EntityManager, input: InsertReportInput): Promise<{ id: string; created: boolean }> {
  const [existing] = await em.query(
    `SELECT id FROM reports WHERE target_type = ? AND target_id = ? AND status = 'open' AND deleted_at IS NULL AND ${input.reporterId ? 'reporter_id = ?' : 'reporter_id IS NULL'} LIMIT 1`,
    input.reporterId ? [input.targetType, input.targetId, input.reporterId] : [input.targetType, input.targetId],
  );
  if (existing && (input.status ?? ReportStatus.Open) === ReportStatus.Open) return { id: existing.id, created: false };
  const id = crypto.randomUUID();
  const at = input.createdAt ?? new Date();
  await em.query('INSERT INTO reports (id, created_at, updated_at, reporter_id, target_type, target_id, reason, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    id,
    at,
    at,
    input.reporterId,
    input.targetType,
    input.targetId,
    input.reason,
    input.note ?? null,
    input.status ?? ReportStatus.Open,
  ]);
  return { id, created: true };
}

export interface InsertReviewInput {
  bookingId: string;
  rating: number;
  comment: string;
  status?: ReviewStatus;
  redactedComment?: string | null;
  createdAt?: Date;
}

export interface InsertedReview {
  id: string;
  flags: ReviewFlag[];
  /** The automatic report, when the comment was flagged. */
  reportId: string | null;
  booking: { id: string; reference: string; clientId: string; providerId: string; serviceId: string | null; packId: string | null };
}

/**
 * Review of a completed booking by its client (one per booking): flag scan,
 * automatic open report when flagged (the review stays published), ratings
 * recomputed, `had_dispute` from the booking. Window and author checks belong
 * to the caller (mobile API); the admin never creates reviews.
 */
export async function insertReview(em: EntityManager, input: InsertReviewInput): Promise<InsertedReview> {
  const [booking] = await em.query(
    "SELECT id, reference, client_id, provider_id, service_id, pack_id, status, dispute_status FROM bookings WHERE id = ? AND deleted_at IS NULL FOR UPDATE",
    [input.bookingId],
  );
  if (!booking) throw AppException.of('BOOKING_NOT_FOUND');
  const [taken] = await em.query('SELECT id FROM reviews WHERE booking_id = ?', [booking.id]);
  if (taken) throw new AppException(409, 'CONFLICT', { reason: 'review_exists', reviewId: taken.id });
  const [disputed] = await em.query('SELECT 1 AS x FROM disputes WHERE booking_id = ? AND deleted_at IS NULL LIMIT 1', [booking.id]);

  const rating = Math.min(5, Math.max(1, Math.round(input.rating)));
  const flags = detectFlags(input.comment);
  const id = crypto.randomUUID();
  const at = input.createdAt ?? new Date();
  await em.query(
    `INSERT INTO reviews (id, created_at, updated_at, booking_id, author_id, service_id, pack_id, provider_id, rating, comment, status, redacted_comment, detected_flags, had_dispute)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      at,
      at,
      booking.id,
      booking.client_id,
      booking.service_id,
      booking.pack_id,
      booking.provider_id,
      rating,
      input.comment,
      input.status ?? ReviewStatus.Published,
      input.redactedComment ?? null,
      flags.length ? JSON.stringify(flags) : null,
      disputed || booking.dispute_status !== 'none' ? 1 : 0,
    ],
  );
  let reportId: string | null = null;
  const reason = autoReportReason(flags);
  if (reason) {
    reportId = (await insertReport(em, { reporterId: null, targetType: ReportTargetType.Review, targetId: id, reason: reason as ReportReason, note: `Automatic: ${flags.join(', ')} detected.`, createdAt: at })).id;
  }
  await recomputeRatings(em, { serviceId: booking.service_id, packId: booking.pack_id, providerId: booking.provider_id });
  return {
    id,
    flags,
    reportId,
    booking: { id: booking.id, reference: booking.reference, clientId: booking.client_id, providerId: booking.provider_id, serviceId: booking.service_id, packId: booking.pack_id },
  };
}

/** The provider's public reply (one per review), with the same flag scan and automatic report (target `review_reply`). */
export async function insertReviewReply(
  em: EntityManager,
  input: { reviewId: string; body: string; status?: ReviewReplyStatus; createdAt?: Date },
): Promise<{ id: string; flags: ReviewFlag[]; reportId: string | null }> {
  const [review] = await em.query('SELECT id, provider_id FROM reviews WHERE id = ? AND deleted_at IS NULL', [input.reviewId]);
  if (!review) throw AppException.of('REVIEW_NOT_FOUND');
  const [taken] = await em.query('SELECT id FROM review_replies WHERE review_id = ?', [review.id]);
  if (taken) throw new AppException(409, 'CONFLICT', { reason: 'reply_exists', replyId: taken.id });
  const id = crypto.randomUUID();
  const at = input.createdAt ?? new Date();
  await em.query('INSERT INTO review_replies (id, created_at, updated_at, review_id, provider_id, body, status) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id,
    at,
    at,
    review.id,
    review.provider_id,
    input.body,
    input.status ?? ReviewReplyStatus.Published,
  ]);
  const flags = detectFlags(input.body);
  const reason = autoReportReason(flags);
  const reportId = reason
    ? (await insertReport(em, { reporterId: null, targetType: ReportTargetType.ReviewReply, targetId: id, reason: reason as ReportReason, note: `Automatic: ${flags.join(', ')} detected.`, createdAt: at })).id
    : null;
  return { id, flags, reportId };
}

/** Closes the open reports on a target (acting on it resolves them all, status-rules §9). Returns the affected ids. */
export async function closeOpenReports(
  em: EntityManager,
  target: { type: ReportTargetType; id: string },
  outcome: { status: ReportStatus.Resolved | ReportStatus.Dismissed; adminId: string; note: string | null; disputeId?: string | null; at?: Date },
): Promise<{ id: string; reporterId: string | null }[]> {
  const rows: { id: string; reporter_id: string | null }[] = await em.query(
    "SELECT id, reporter_id FROM reports WHERE target_type = ? AND target_id = ? AND status = 'open' AND deleted_at IS NULL FOR UPDATE",
    [target.type, target.id],
  );
  if (!rows.length) return [];
  const at = outcome.at ?? new Date();
  await em.query('UPDATE reports SET status = ?, resolved_by_id = ?, resolved_at = ?, resolution_note = ?, dispute_id = COALESCE(?, dispute_id), updated_at = ? WHERE id IN (?)', [
    outcome.status,
    outcome.adminId,
    at,
    outcome.note,
    outcome.disputeId ?? null,
    at,
    rows.map((r) => r.id),
  ]);
  return rows.map((r) => ({ id: r.id, reporterId: r.reporter_id }));
}
