import type { Lang } from '../common/i18n/language.js';

export const AUTH_EVENTS = {
  /** An admin asked for a reset link; the listener emails it. */
  passwordResetRequested: 'auth.password_reset_requested',
  /** An admin invitation was created or resent; the listener emails it. */
  adminInvited: 'auth.admin_invited',
} as const;

/** Tokens travel in the payload only to build the link; never log payloads. */
export interface PasswordResetRequestedEvent {
  userId: string;
  email: string;
  name: string;
  lang: Lang;
  token: string;
  minutes: number;
}

export interface AdminInvitedEvent {
  invitationId: string;
  email: string;
  name: string;
  invitedBy: string;
  lang: Lang;
  token: string;
}
