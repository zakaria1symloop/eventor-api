import type { DisputeBookingOutcome, DisputeType } from '../common/enums/moderation.enums.js';

export const DISPUTE_EVENTS = {
  /** Opened (by an admin on behalf of a party): other party 🔔📱✉️, admins 🔔 + socket `dispute:new`. */
  opened: 'dispute.opened',
  assigned: 'dispute.assigned',
  /** An admin wrote in the dispute chat (plain message or evidence request): parties 🔔📱. */
  messageSent: 'dispute.message_sent',
  evidenceAdded: 'dispute.evidence_added',
  /** Both parties 🔔📱✉️ with the decision note. */
  resolved: 'dispute.resolved',
  /** Both parties 🔔. */
  closed: 'dispute.closed',
} as const;

export interface DisputeEvent {
  disputeId: string;
  reference: string;
  bookingId: string;
  bookingReference: string;
  clientId: string;
  providerId: string;
  openedById: string;
  againstUserId: string;
  actorId: string | null;
}

export interface DisputeOpenedEvent extends DisputeEvent {
  type: DisputeType;
}

export interface DisputeMessageEvent extends DisputeEvent {
  messageId: string;
  /** Set for "Ask for evidence": only that party is notified. */
  evidenceRequestedFrom: string | null;
}

export interface DisputeResolvedEvent extends DisputeEvent {
  bookingOutcome: DisputeBookingOutcome;
  decisionNote: string;
}

export interface DisputeClosedEvent extends DisputeEvent {
  note: string;
}
