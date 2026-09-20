import { ReportStatus, ReportTargetType, ReviewReplyStatus, ReviewStatus } from '../common/enums/moderation.enums.js';

// ── reviews (status-rules §8) ───────────────────────────────────

export const REVIEW_TABS = ['all', 'published', 'reported', 'hidden', 'redacted'] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];

export const MODERATION_ACTIONS = ['hide', 'show', 'redact', 'dismiss_reports'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export const REVIEW_ACTIONS = [...MODERATION_ACTIONS, 'edit', 'delete', 'convert_report'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/** Statuses a review can be in for each status-changing action. */
const FROM: Record<Exclude<ModerationAction, 'dismiss_reports'>, readonly ReviewStatus[]> = {
  hide: [ReviewStatus.Published, ReviewStatus.Redacted],
  show: [ReviewStatus.Hidden, ReviewStatus.Redacted],
  // redacted → redacted replaces the redacted text.
  redact: [ReviewStatus.Published, ReviewStatus.Hidden, ReviewStatus.Redacted],
};

export const TARGET_STATUS: Record<Exclude<ModerationAction, 'dismiss_reports'>, ReviewStatus> = {
  hide: ReviewStatus.Hidden,
  show: ReviewStatus.Published,
  redact: ReviewStatus.Redacted,
};

/** The status after the action, or null when the move is not allowed (409 REVIEW_INVALID_TRANSITION). `dismiss_reports` keeps the status. */
export function moderationTarget(status: ReviewStatus, action: ModerationAction): ReviewStatus | null {
  if (action === 'dismiss_reports') return status;
  return FROM[action].includes(status) ? TARGET_STATUS[action] : null;
}

/** Published and redacted reviews are public and count in ratings; hidden ones do not. */
export const RATED_STATUSES: readonly ReviewStatus[] = [ReviewStatus.Published, ReviewStatus.Redacted];

export function countsInRating(status: ReviewStatus): boolean {
  return RATED_STATUSES.includes(status);
}

/** REV-02 buttons. */
export function allowedReviewActions(review: { status: ReviewStatus; openReports: number; hasBooking: boolean }): ReviewAction[] {
  const actions: ReviewAction[] = [];
  for (const action of ['hide', 'show', 'redact'] as const) if (moderationTarget(review.status, action)) actions.push(action);
  if (review.openReports > 0) actions.push('dismiss_reports');
  actions.push('edit', 'delete');
  if (review.openReports > 0 && review.hasBooking) actions.push('convert_report');
  return actions;
}

// ── replies ─────────────────────────────────────────────────────

export function replyTarget(status: ReviewReplyStatus, action: 'hide' | 'show'): ReviewReplyStatus | null {
  if (action === 'hide') return status === ReviewReplyStatus.Published ? ReviewReplyStatus.Hidden : null;
  return status === ReviewReplyStatus.Hidden ? ReviewReplyStatus.Published : null;
}

// ── reports (status-rules §9) ──────────────────────────────────

export const REPORT_TABS = ['open', 'resolved', 'dismissed', 'all'] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

export function assertReportOpen(status: ReportStatus): boolean {
  return status === ReportStatus.Open;
}

/** Only these targets can lead to a booking (review → booking, message → its conversation's booking). */
export const CONVERTIBLE_TARGETS: readonly ReportTargetType[] = [ReportTargetType.Review, ReportTargetType.Message];

/** Action labels recorded when an admin resolves a report after acting elsewhere (hide, block, close chat…). */
export const REPORT_RESOLVE_ACTIONS = ['content_hidden', 'content_redacted', 'content_deleted', 'chat_closed', 'user_warned', 'user_blocked', 'service_hidden', 'other'] as const;
export type ReportResolveAction = (typeof REPORT_RESOLVE_ACTIONS)[number];
