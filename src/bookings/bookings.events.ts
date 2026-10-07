import type { BookingStatus } from '../common/enums/booking.enums.js';

export const BOOKING_EVENTS = {
  created: 'booking.created',
  accepted: 'booking.accepted',
  declined: 'booking.declined',
  cancelled: 'booking.cancelled',
  completed: 'booking.completed',
  reopened: 'booking.reopened',
  rescheduled: 'booking.rescheduled',
  rescheduleProposed: 'booking.reschedule_proposed',
  /** The other party turned a proposed date down; the booking keeps its date. */
  rescheduleRejected: 'booking.reschedule_rejected',
  priceChanged: 'booking.price_changed',
  /** Manual (BKG-03) or automatic (reply deadline − 12 h) reminder to the provider. */
  reminderSent: 'booking.reminder_sent',
  reviewRequested: 'booking.review_requested',
  invoiceIssued: 'invoice.issued',
  invoiceSent: 'invoice.sent',
} as const;

/** Common payload: who to notify is decided by the listener from ids and flags. */
export interface BookingEvent {
  bookingId: string;
  reference: string;
  clientId: string;
  providerId: string;
  /** False when the admin unticked "Notify" (BKG-04): no emails. */
  notify: boolean;
}

export interface BookingStatusChangedEvent extends BookingEvent {
  from: BookingStatus;
  to: BookingStatus;
  reason: string | null;
  note: string | null;
  actorId: string | null;
}

export interface BookingCancelledEvent extends BookingEvent {
  cancelledBy: 'client' | 'provider' | 'admin';
  reason: string;
  /** Party whose account action caused it (block, delete): that party is not notified. */
  causedByUserId: string | null;
}

export interface BookingRescheduledEvent extends BookingEvent {
  oldDate: string;
  newDate: string;
  applied: boolean;
  /** Who proposed, accepted or rejected the date: not notified about their own action. */
  actorId: string | null;
}

export interface BookingPriceChangedEvent extends BookingEvent {
  oldTotal: string;
  newTotal: string;
}

export interface BookingReminderEvent extends BookingEvent {
  automatic: boolean;
}

export interface InvoiceSentEvent {
  bookingId: string;
  invoiceId: string;
  number: string;
  reference: string;
  total: string;
  /** Absolute path of the stored PDF (attached to the email). */
  pdfPath: string;
  client: { email: string; name: string; lang: 'en' | 'ar' } | null;
  actorId: string;
}

export interface InvoiceEvent extends BookingEvent {
  invoiceId: string;
  number: string;
  version: number;
}
