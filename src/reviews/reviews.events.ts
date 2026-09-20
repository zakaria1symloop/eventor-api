import type { ReportReason, ReportStatus, ReportTargetType } from '../common/enums/moderation.enums.js';
import type { ModerationAction } from './reviews.policy.js';

export const REVIEW_EVENTS = {
  /** hide / show / redact by an admin: 🔔 author (when `notifyAuthor`). */
  moderated: 'review.moderated',
  /** A reply was hidden or shown again: 🔔 the provider. */
  replyModerated: 'review_reply.moderated',
  /** A report was created (by a user or automatically): 🔔 all admins + socket `notification:new`. */
  reportCreated: 'report.created',
  /** Reports resolved or dismissed: 🔔 each reporter with the outcome. */
  reportsClosed: 'report.closed',
} as const;

export interface ReviewModeratedEvent {
  reviewId: string;
  authorId: string;
  action: Exclude<ModerationAction, 'dismiss_reports'>;
  note: string | null;
  notifyAuthor: boolean;
}

export interface ReplyModeratedEvent {
  replyId: string;
  reviewId: string;
  providerId: string;
  action: 'hide' | 'show';
}

export interface ReportCreatedEvent {
  reportId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  automatic: boolean;
}

export interface ReportsClosedEvent {
  reports: { id: string; reporterId: string | null }[];
  status: ReportStatus.Resolved | ReportStatus.Dismissed;
  targetType: ReportTargetType;
  targetId: string;
  disputeReference: string | null;
}
