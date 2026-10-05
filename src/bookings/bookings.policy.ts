import { BookingDisputeStatus, BookingLineKind, BookingStatus } from '../common/enums/booking.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { PriceType } from '../common/enums/catalog.enums.js';

// ── status transitions (status-rules §5, admin actor) ────────────

export const BOOKING_TABS = ['all', 'pending', 'accepted', 'completed', 'declined', 'cancelled', 'disputed'] as const;
export type BookingTab = (typeof BOOKING_TABS)[number];

/** What an admin sends to `POST /admin/bookings/:id/status`. `reopen` moves completed → accepted. */
export const STATUS_ACTIONS = ['accepted', 'declined', 'cancelled', 'completed', 'reopen'] as const;
export type StatusAction = (typeof STATUS_ACTIONS)[number];

const MOVES: Record<BookingStatus, StatusAction[]> = {
  [BookingStatus.Pending]: ['accepted', 'declined', 'cancelled'],
  [BookingStatus.Accepted]: ['cancelled', 'completed'],
  [BookingStatus.Completed]: ['reopen'],
  [BookingStatus.Declined]: [],
  [BookingStatus.Cancelled]: [],
};

export function targetStatus(action: StatusAction): BookingStatus {
  return action === 'reopen' ? BookingStatus.Accepted : (action as BookingStatus);
}

export function canTransition(from: BookingStatus, action: StatusAction): boolean {
  return MOVES[from].includes(action);
}

export interface AllowedTransition {
  action: StatusAction;
  to: BookingStatus;
  reasonRequired: boolean;
  /** Completing before the event date is allowed for admins; the dialog warns. */
  warning: 'event_not_passed' | 'dispute_open' | null;
}

export function allowedTransitions(booking: { status: BookingStatus; eventDate: string; disputeStatus: BookingDisputeStatus }, today: string): AllowedTransition[] {
  return MOVES[booking.status].map((action) => ({
    action,
    to: targetStatus(action),
    reasonRequired: action !== 'accepted',
    warning:
      action === 'completed' && booking.eventDate >= today
        ? 'event_not_passed'
        : action === 'completed' && booking.disputeStatus === BookingDisputeStatus.Open
          ? 'dispute_open'
          : null,
  }));
}

/** Pending bookings and accepted ones before completion can be edited (price, details, reschedule). */
export function isEditable(status: BookingStatus): boolean {
  return status === BookingStatus.Pending || status === BookingStatus.Accepted;
}

// ── money (cents, no floating point on totals) ───────────────────

export const toCents = (value: string | number): number => Math.round(Number(value) * 100);
export const fromCents = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

export interface LineInput {
  kind: BookingLineKind;
  label: string;
  quantity: number;
  unitAmount: string;
  serviceId?: string | null;
}

export interface ComputedLine extends Required<Omit<LineInput, 'serviceId'>> {
  serviceId: string | null;
  amount: string;
  position: number;
}

export interface Totals {
  subtotal: string;
  discountTotal: string;
  total: string;
}

/**
 * Line amounts: quantity × unit. A `discount` line always reduces the total
 * (its amount is negative whatever the sign sent); an `adjustment` keeps its
 * sign; other kinds are positive.
 */
export function computeLines(lines: LineInput[]): ComputedLine[] {
  return lines.map((line, position) => {
    const unit = toCents(line.unitAmount);
    const raw = unit * line.quantity;
    const amount = line.kind === BookingLineKind.Discount ? -Math.abs(raw) : line.kind === BookingLineKind.Adjustment ? raw : Math.abs(raw);
    return {
      kind: line.kind,
      label: line.label,
      quantity: line.quantity,
      unitAmount: fromCents(line.kind === BookingLineKind.Discount ? Math.abs(unit) : unit),
      serviceId: line.serviceId ?? null,
      amount: fromCents(amount),
      position,
    };
  });
}

/** Subtotal = positive lines, discountTotal = |negative lines|, total = subtotal − discountTotal. */
export function computeTotals(lines: Pick<ComputedLine, 'amount'>[]): Totals {
  let positive = 0;
  let negative = 0;
  for (const line of lines) {
    const cents = toCents(line.amount);
    if (cents >= 0) positive += cents;
    else negative += -cents;
  }
  return { subtotal: fromCents(positive), discountTotal: fromCents(negative), total: fromCents(positive - negative) };
}

/** Eventor fee on the total (rounded to the centime, half up) and the provider's share. */
export function computeFee(total: string, feePercent: string | number): { feeAmount: string; providerAmount: string } {
  const totalCents = toCents(total);
  const fee = Math.round((totalCents * Number(feePercent)) / 100);
  return { feeAmount: fromCents(fee), providerAmount: fromCents(totalCents - fee) };
}

// ── event times ──────────────────────────────────────────────────

const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * The booked hours as minutes from midnight of the event date. An end earlier
 * than the start ends the next day (18:00 → 02:00 is 8 h, `end` = 1560).
 * Null when the booking has no start or no end (a whole-day booking).
 */
export function timeSpan(startTime: string | null | undefined, endTime: string | null | undefined): { start: number; end: number } | null {
  if (!startTime || !endTime) return null;
  const start = minutesOf(startTime);
  let end = minutesOf(endTime);
  if (end <= start) end += 24 * 60;
  return { start, end };
}

/**
 * Event time rules for quotes, bookings and reschedules: an end needs a start,
 * and an end equal to the start is refused. An end earlier than the start is
 * an overnight event (see `timeSpan`).
 */
export function assertEventTimes(startTime: string | null | undefined, endTime: string | null | undefined): void {
  if (endTime && !startTime) {
    throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'startTime', code: 'REQUIRED_WITH_END', message: 'startTime is required when endTime is sent' }]);
  }
  if (startTime && endTime && startTime === endTime) {
    throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'endTime', code: 'SAME_AS_START', message: 'endTime must differ from startTime' }]);
  }
}

/** Quantity of the main service line from its price type. `per_hour`: started hours, across midnight. */
export function serviceQuantity(priceType: PriceType, input: { guests?: number | null; startTime?: string | null; endTime?: string | null }): number {
  if (priceType === PriceType.PerPerson) return Math.max(1, input.guests ?? 1);
  const span = priceType === PriceType.PerHour ? timeSpan(input.startTime, input.endTime) : null;
  if (span) return Math.max(1, Math.ceil((span.end - span.start) / 60));
  return 1;
}

/** Pack lines: one per item at its base price, then a discount down to the pack price. */
export function packLines(pack: { price: string; nameEn: string }, items: { serviceId: string; titleEn: string; basePrice: string }[]): LineInput[] {
  const lines: LineInput[] = items.map((item) => ({ kind: BookingLineKind.PackService, label: item.titleEn, quantity: 1, unitAmount: item.basePrice, serviceId: item.serviceId }));
  const sum = items.reduce((total, item) => total + toCents(item.basePrice), 0);
  const saving = sum - toCents(pack.price);
  if (saving > 0) lines.push({ kind: BookingLineKind.Discount, label: `${pack.nameEn} pack price`, quantity: 1, unitAmount: fromCents(saving) });
  if (saving < 0) lines.push({ kind: BookingLineKind.Adjustment, label: `${pack.nameEn} pack price`, quantity: 1, unitAmount: fromCents(-saving) });
  return lines;
}

// ── timing rules ─────────────────────────────────────────────────

const HOUR = 3_600_000;

/** Adds days to a `YYYY-MM-DD` date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Pending for longer than the reply deadline. */
export function isNoReply(booking: { status: BookingStatus; createdAt: Date }, deadlineHours: number, now = new Date()): boolean {
  return booking.status === BookingStatus.Pending && now.getTime() - booking.createdAt.getTime() >= deadlineHours * HOUR;
}

/** Manual reminders are throttled to one per 12 h; returns seconds to wait (0 = allowed). */
export const REMINDER_INTERVAL_HOURS = 12;
export function reminderRetryAfter(lastSentAt: Date | null, now = new Date()): number {
  if (!lastSentAt) return 0;
  const wait = lastSentAt.getTime() + REMINDER_INTERVAL_HOURS * HOUR - now.getTime();
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}

// ── check-in ("All good / Report a problem") ─────────────────────

export type CheckInOutcome = 'refused_status' | 'refused_dispute' | 'refused_too_early' | 'recorded' | 'complete';

/**
 * status-rules §5: after the event either party taps "All good"; when **both**
 * have, the booking completes immediately instead of waiting for the dispute
 * window to run out. A booking that is not accepted, is disputed, or whose
 * event has not happened yet refuses the tap.
 */
export function checkInOutcome(input: {
  status: BookingStatus;
  disputeStatus: BookingDisputeStatus;
  /** `YYYY-MM-DD`, Africa/Algiers. */
  eventDate: string;
  today: string;
  otherCheckedIn: boolean;
}): CheckInOutcome {
  if (input.status !== BookingStatus.Accepted) return 'refused_status';
  if (input.disputeStatus === BookingDisputeStatus.Open) return 'refused_dispute';
  if (input.eventDate > input.today) return 'refused_too_early';
  return input.otherCheckedIn ? 'complete' : 'recorded';
}

/** The error a refused check-in answers with; `null` when the tap is allowed. */
export function checkInRefusal(outcome: CheckInOutcome): AppException | null {
  if (outcome === 'refused_status') return AppException.of('CHECK_IN_NOT_ALLOWED');
  if (outcome === 'refused_dispute') return AppException.of('CHECK_IN_DISPUTED');
  if (outcome === 'refused_too_early') return AppException.of('CHECK_IN_TOO_EARLY');
  return null;
}

/** Event end as a UTC instant: date + end time (or 23:59) in Africa/Algiers (UTC+1, no DST). */
export function eventEndUtc(eventDate: string, endTime: string | null): Date {
  const time = endTime ? endTime.slice(0, 5) : '23:59';
  return new Date(`${eventDate}T${time}:00+01:00`);
}

/** status-rules §5: accepted → completed at event end + dispute window, unless a dispute is open. */
export function isDueForAutoComplete(
  booking: { status: BookingStatus; disputeStatus: BookingDisputeStatus; eventDate: string; endTime: string | null },
  disputeWindowHours: number,
  now = new Date(),
): boolean {
  if (booking.status !== BookingStatus.Accepted || booking.disputeStatus === BookingDisputeStatus.Open) return false;
  return eventEndUtc(booking.eventDate, booking.endTime).getTime() + disputeWindowHours * HOUR <= now.getTime();
}
