import type { Lang } from '../common/i18n/language.js';

export const APP_AUTH_EVENTS = {
  /** A 6-digit code was issued for an app account; the listener emails it. */
  codeSent: 'app.code_sent',
} as const;

/** Codes travel in the payload only to build the email; never log payloads. */
export interface AppCodeSentEvent {
  email: string;
  name: string;
  code: string;
  minutes: number;
  lang: Lang;
}
