import { BookingDisputeStatus, BookingLineKind, BookingStatus } from '../common/enums/booking.enums.js';
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

/** Quantity of the main service line from its price type. */
export function serviceQuantity(priceType: PriceType, input: { guests?: number | null; startTime?: string | null; endTime?: string | null }): number {
  if (priceType === PriceType.PerPerson) return Math.max(1, input.guests ?? 1);
  if (priceType === PriceType.PerHour && input.startTime && input.endTime) {
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    let span = minutes(input.endTime) - minutes(input.startTime);
    if (span <= 0) span += 24 * 60;
    return Math.max(1, Math.ceil(span / 60));
  }
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
