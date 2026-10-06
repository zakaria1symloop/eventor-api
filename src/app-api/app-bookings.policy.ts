import { BookingDisputeStatus, BookingStatus } from '../common/enums/booking.enums.js';
import { AppException } from '../common/errors/app.exception.js';

/**
 * The pure rules behind `/app/bookings/**` and `/app/provider/bookings/**`:
 * which tab a booking belongs to, which buttons the app may draw, the
 * "All good / Report a problem" check-in and the review windows.
 *
 * Nothing here touches the database, so the e2e suites and
 * `app-bookings.policy.spec.ts` exercise exactly the same functions the
 * controllers do (api-standards §8 "unit tests cover service and policy logic").
 */

// ── tabs ────────────────────────────────────────────────────────

/** Tabs of the client Bookings tab (mobile screen map §C "Bookings"). */
export const CLIENT_BOOKING_TABS = ['upcoming', 'pending', 'past', 'cancelled'] as const;
export type ClientBookingTab = (typeof CLIENT_BOOKING_TABS)[number];

/** Tabs of the provider Requests tab (screen 21 and screen map §E); `cancelled` holds cancelled and declined, as for clients. */
export const PROVIDER_BOOKING_TABS = ['requests', 'upcoming', 'past', 'cancelled'] as const;
export type ProviderBookingTab = (typeof PROVIDER_BOOKING_TABS)[number];

export type AppBookingTab = ClientBookingTab | ProviderBookingTab;

/**
 * SQL for one tab, with `b` the bookings alias. The statuses come from
 * status-rules §5 rather than a stored column, so a booking is never in two
 * tabs at once: `upcoming` is accepted with the event still ahead, `past` is
 * everything that already happened.
 *
 * `params` receives the Algiers "today" the caller computed once per request.
 */
export function bookingTabSql(tab: AppBookingTab): { sql: string; params: (today: string) => string[] } {
  switch (tab) {
    case 'pending':
    case 'requests':
      return { sql: "b.status = 'pending'", params: () => [] };
    case 'upcoming':
      return { sql: "b.status = 'accepted' AND COALESCE(b.end_date, b.event_date) >= ?", params: (today) => [today] };
    case 'past':
      return { sql: "(b.status = 'completed' OR (b.status = 'accepted' AND COALESCE(b.end_date, b.event_date) < ?))", params: (today) => [today] };
    case 'cancelled':
      return { sql: "b.status IN ('cancelled', 'declined')", params: () => [] };
  }
}

// ── the buttons on a booking ────────────────────────────────────

export const APP_BOOKING_ACTIONS = [
  'cancel',
  'accept',
  'decline',
  'complete',
  'reschedule',
  'respond_reschedule',
  'check_in',
  'review',
  'dispute',
  'message',
  'invoice',
] as const;
export type AppBookingAction = (typeof APP_BOOKING_ACTIONS)[number];

export interface AppBookingState {
  status: BookingStatus;
  disputeStatus: BookingDisputeStatus;
  /** `YYYY-MM-DD`, Africa/Algiers. */
  eventDate: string;
  /** Africa/Algiers today, passed in so the list and the detail agree. */
  today: string;
  /** A reschedule proposal is waiting for **this** caller to answer. */
  pendingRescheduleForMe: boolean;
  /** This caller already tapped "All good". */
  checkedIn: boolean;
  hasReview: boolean;
  /** `disputeWindow(...).open` for this booking (disputes.policy). */
  disputeWindowOpen: boolean;
  /** `reviewWindow(...).open` for this booking. */
  reviewWindowOpen: boolean;
}

/**
 * What the app may offer on a booking, per party (status-rules §5, §6, §8). The
 * write endpoints enforce the same rules, so a greyed-out button and a 409
 * never disagree.
 */
export function appBookingActions(party: 'client' | 'provider', state: AppBookingState): AppBookingAction[] {
  const actions: AppBookingAction[] = ['message'];
  if (state.status === BookingStatus.Pending) {
    actions.push('cancel', 'reschedule');
    if (party === 'provider') actions.push('accept', 'decline');
  }
  if (state.status === BookingStatus.Accepted) {
    actions.push('cancel', 'reschedule', 'invoice');
    const eventPassed = state.eventDate <= state.today;
    if (party === 'provider' && eventPassed) actions.push('complete');
    if (eventPassed && !state.checkedIn && state.disputeStatus !== BookingDisputeStatus.Open) actions.push('check_in');
  }
  if (state.status === BookingStatus.Completed) {
    actions.push('invoice');
    if (party === 'client' && !state.hasReview && state.reviewWindowOpen && state.disputeStatus !== BookingDisputeStatus.Open) {
      actions.push('review');
    }
  }
  if (state.pendingRescheduleForMe) actions.push('respond_reschedule');
  if (state.disputeWindowOpen && state.disputeStatus !== BookingDisputeStatus.Open) actions.push('dispute');
  return [...new Set(actions)];
}

/**
 * Every `type` a booking timeline entry can carry: `created`, the status the
 * booking moved to, or one of the extra milestones the detail view renders.
 */
export const APP_BOOKING_TIMELINE_TYPES = [
  'created',
  'pending',
  'accepted',
  'declined',
  'cancelled',
  'completed',
  'rescheduled',
  'checked_in',
  'dispute_opened',
] as const;
export type AppBookingTimelineType = (typeof APP_BOOKING_TIMELINE_TYPES)[number];

// ── check-in ────────────────────────────────────────────────────

/**
 * The rule itself lives in `bookings.policy.ts`, next to the transitions it
 * feeds (`BookingsService.checkIn` applies it), and is re-exported here so the
 * app layer has one policy import.
 */
export { checkInOutcome, checkInRefusal, type CheckInOutcome } from '../bookings/bookings.policy.js';

// ── review windows ──────────────────────────────────────────────

const HOUR = 3_600_000;

/** status-rules §8: a review can be left for 60 days after the completion. */
export const REVIEW_WINDOW_DAYS = 60;

/** status-rules §8: the author edits a review, and a provider their reply, for 48 h. */
export const EDIT_WINDOW_HOURS = 48;

export interface ReviewWindow {
  open: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

/**
 * From `review_open_after_hours` (24 h) after completion until 60 days after
 * it. A booking that is not completed has no window at all.
 */
export function reviewWindow(completedAt: Date | null, openAfterHours: number, now = new Date()): ReviewWindow {
  if (!completedAt) return { open: false, opensAt: null, closesAt: null };
  const opensAt = new Date(completedAt.getTime() + openAfterHours * HOUR);
  const closesAt = new Date(completedAt.getTime() + REVIEW_WINDOW_DAYS * 24 * HOUR);
  return {
    open: now.getTime() >= opensAt.getTime() && now.getTime() <= closesAt.getTime(),
    opensAt: opensAt.toISOString(),
    closesAt: closesAt.toISOString(),
  };
}

/** True while the 48-hour edit window of a review or a provider reply is open. */
export function withinEditWindow(createdAt: Date, now = new Date()): boolean {
  return now.getTime() - createdAt.getTime() <= EDIT_WINDOW_HOURS * HOUR;
}

/** 403 NOT_OWNER unless the caller owns the row (api-standards §8, case 5). */
export function assertOwner(ownerId: string | null | undefined, callerId: string): void {
  if (ownerId !== callerId) throw AppException.of('NOT_OWNER');
}
