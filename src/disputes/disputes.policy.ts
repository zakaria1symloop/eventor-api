import { BookingStatus } from '../common/enums/booking.enums.js';
import { DisputeBookingOutcome, DisputeStatus } from '../common/enums/moderation.enums.js';
import { eventEndUtc } from '../bookings/bookings.policy.js';
import type { StatusAction } from '../bookings/bookings.policy.js';

// ── tabs & transitions (status-rules §6) ─────────────────────────

export const DISPUTE_TABS = ['open', 'in_review', 'resolved', 'closed', 'all'] as const;
export type DisputeTab = (typeof DISPUTE_TABS)[number];

export const DISPUTE_ACTIONS = ['assign', 'message', 'request_evidence', 'add_evidence', 'resolve', 'close'] as const;
export type DisputeAction = (typeof DISPUTE_ACTIONS)[number];

/** Days after which the dispute conversation of a resolved / closed dispute is closed by the job. */
export const DISPUTE_CONVERSATION_CLOSE_DAYS = 7;
/** A cancelled booking can be disputed for this many days after the cancellation. */
export const CANCELLATION_DISPUTE_DAYS = 7;

const OPEN_STATUSES: readonly DisputeStatus[] = [DisputeStatus.Open, DisputeStatus.InReview];

export function isActive(status: DisputeStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/** Actions an admin can take on a dispute (DSP-02 buttons). Messages stay possible while the dispute chat is open. */
export function allowedActions(status: DisputeStatus, conversationOpen: boolean): DisputeAction[] {
  const actions: DisputeAction[] = [];
  if (isActive(status)) actions.push('assign');
  if (conversationOpen) actions.push('message');
  if (isActive(status)) actions.push('request_evidence', 'add_evidence', 'resolve', 'close');
  return actions;
}

// ── opening ──────────────────────────────────────────────────────

export const DISPUTABLE_BOOKING_STATUSES: readonly BookingStatus[] = [BookingStatus.Accepted, BookingStatus.Completed, BookingStatus.Cancelled];

export function isDisputable(status: BookingStatus): boolean {
  return DISPUTABLE_BOOKING_STATUSES.includes(status);
}

export interface DisputeWindow {
  open: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
}

/**
 * When a client or provider may open a dispute (status-rules §6): from the event
 * start (date + start time, or the start of the day, Africa/Algiers) until the
 * event end + `dispute_window_hours`; a cancelled booking within 7 days of the
 * cancellation.
 */
export function disputeWindow(
  booking: { status: BookingStatus; eventDate: string; startTime: string | null; endTime: string | null; cancelledAt: Date | null },
  windowHours: number,
  now = new Date(),
): DisputeWindow {
  if (!isDisputable(booking.status)) return { open: false, opensAt: null, closesAt: null };
  if (booking.status === BookingStatus.Cancelled) {
    const opensAt = booking.cancelledAt ?? null;
    const closesAt = opensAt ? new Date(opensAt.getTime() + CANCELLATION_DISPUTE_DAYS * 86_400_000) : null;
    return { open: !!closesAt && now.getTime() <= closesAt.getTime(), opensAt, closesAt };
  }
  const start = booking.startTime ? booking.startTime.slice(0, 5) : '00:00';
  const opensAt = new Date(`${booking.eventDate}T${start}:00+01:00`);
  const closesAt = new Date(eventEndUtc(booking.eventDate, booking.endTime).getTime() + windowHours * 3_600_000);
  return { open: now.getTime() >= opensAt.getTime() && now.getTime() <= closesAt.getTime(), opensAt, closesAt };
}

// ── resolving ────────────────────────────────────────────────────

/**
 * Booking status actions that apply a resolution outcome through the booking
 * status machine. `null` = invalid (reported as BOOKING_INVALID_TRANSITION).
 * completed: accepted → completed (even before the window end); cancelled:
 * accepted → cancelled, completed → reopen → cancelled; unchanged: nothing.
 */
export function outcomeActions(outcome: DisputeBookingOutcome, bookingStatus: BookingStatus): StatusAction[] | null {
  if (outcome === DisputeBookingOutcome.Unchanged) return [];
  if (outcome === DisputeBookingOutcome.Completed) {
    if (bookingStatus === BookingStatus.Completed) return [];
    if (bookingStatus === BookingStatus.Accepted) return ['completed'];
    return null;
  }
  if (bookingStatus === BookingStatus.Cancelled) return [];
  if (bookingStatus === BookingStatus.Accepted) return ['cancelled'];
  if (bookingStatus === BookingStatus.Completed) return ['reopen', 'cancelled'];
  return null;
}
