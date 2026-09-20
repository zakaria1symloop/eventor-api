import type { Lang } from '../common/i18n/language.js';

export const USER_EVENTS = {
  /** An admin created the account; the listener emails a set-password link. */
  invited: 'user.invited',
  /** An admin sent a password reset link. */
  passwordResetLinkSent: 'user.password_reset_link_sent',
  blocked: 'user.blocked',
  unblocked: 'user.unblocked',
  deleted: 'user.deleted',
} as const;

interface Recipient {
  userId: string;
  email: string;
  name: string;
  lang: Lang;
}

/** Tokens travel in the payload only to build the link; never log payloads. */
export interface UserInvitedEvent extends Recipient {
  token: string;
  days: number;
}

export interface UserPasswordResetLinkEvent extends Recipient {
  token: string;
  minutes: number;
}

export interface UserBlockedEvent extends Recipient {
  reason: string;
  message: string | null;
  until: string | null;
}

export interface UserUnblockedEvent extends Recipient {
  automatic: boolean;
}

export interface UserDeletedEvent {
  userId: string;
}

