import type { Lang } from '../common/i18n/language.js';

export const ACADEMIC_EVENTS = {
  /** A requester sent the public form (ACR-07). */
  submitted: 'academic_request.submitted',
  /** The requester edited their answers through the emailed link. */
  resubmitted: 'academic_request.resubmitted',
  changesRequested: 'academic_request.changes_requested',
  approved: 'academic_request.approved',
  rejected: 'academic_request.rejected',
  cancelled: 'academic_request.cancelled',
  /** First (or another) booking created from a proposal. */
  booked: 'academic_request.booked',
  /** A verification code for the public form was issued. */
  formCodeSent: 'form.code_sent',
} as const;

export interface RequestEventBase {
  requestId: string;
  reference: string;
  title: string;
  formSlug: string;
  requester: { name: string; email: string; userId: string | null };
  /** Language for requester emails (Accept-Language at submission, or the linked account's language). */
  lang: Lang;
}

export interface RequestSubmittedEvent extends RequestEventBase {
  confirmation: string;
  submittedAt: string;
}

export interface RequestResubmittedEvent extends RequestEventBase {
  changedFields: string[];
}

export interface RequestChangesRequestedEvent extends RequestEventBase {
  fields: string[];
  message: string;
  /** Edit link token; never log payloads. */
  token: string;
  expiresAt: string;
}

export interface RequestDecisionEvent extends RequestEventBase {
  message: string | null;
  reason: string | null;
  /** Approve: the proposed service titles. */
  proposals: string[];
  /** Cancel: providers of cancelled bookings. */
  providerIds: string[];
}

export interface RequestBookedEvent extends RequestEventBase {
  bookingId: string;
  bookingReference: string;
  providerId: string;
  clientCreated: boolean;
}

export interface FormCodeSentEvent {
  email: string;
  code: string;
  minutes: number;
  lang: Lang;
}
