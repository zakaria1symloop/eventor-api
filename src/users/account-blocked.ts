import { AppException } from '../common/errors/app.exception.js';
import type { Lang } from '../common/i18n/language.js';
import { legalPageUrl } from '../legal/legal.controller.js';
import type { User } from './entities/user.entity.js';

/**
 * BUG-F5 / BUG-J1: what a blocked account is told, wherever it hits the block
 * (sign-in, refresh, any authenticated call, the socket). The app shows its
 * blocked screen (21c provider, 23 client) from these details.
 */

/** Labels of the reason codes the dashboard offers; any other value is a label the admin typed and is shown as is. */
const REASON_LABELS: Record<string, Record<Lang, string>> = {
  fraud: { en: 'Fraud or scam', ar: 'احتيال' },
  scam: { en: 'Fraud or scam', ar: 'احتيال' },
  spam: { en: 'Spam', ar: 'رسائل مزعجة' },
  abuse: { en: 'Abusive behaviour', ar: 'سلوك مسيء' },
  harassment: { en: 'Harassment', ar: 'مضايقة' },
  fake_account: { en: 'Fake account', ar: 'حساب مزيف' },
  impersonation: { en: 'Impersonation', ar: 'انتحال شخصية' },
  inappropriate_content: { en: 'Inappropriate content', ar: 'محتوى غير لائق' },
  terms_violation: { en: 'Breach of the terms of use', ar: 'مخالفة شروط الاستخدام' },
  no_show: { en: 'Repeated no-shows', ar: 'تكرار عدم الحضور' },
  safety: { en: 'Safety concern', ar: 'مخاوف تتعلق بالسلامة' },
  other: { en: 'Other reason', ar: 'سبب آخر' },
};

export function blockReasonLabel(reason: string | null, lang: Lang): string | null {
  if (!reason) return null;
  return REASON_LABELS[reason.trim().toLowerCase()]?.[lang] ?? reason;
}

export interface AccountBlockedDetails {
  /** The code the admin chose (`fraud`, `spam`, `other`…). */
  reason: string | null;
  /** That reason in the caller's language (`Accept-Language`). */
  reasonLabel: string | null;
  /** The admin's message to the user, if any. */
  message: string | null;
  blockedAt: string | null;
  /** End of the block; null = until further notice. */
  blockedUntil: string | null;
  /** Alias of `blockedUntil` kept for older app builds. */
  until: string | null;
  /** The web page where the account can still be deleted. */
  deleteAccountUrl: string;
}

export function accountBlockedDetails(
  user: Pick<User, 'blockedReason' | 'blockedMessage' | 'blockedAt' | 'blockedUntil'>,
  lang: Lang,
  adminUrl: string,
): AccountBlockedDetails {
  const until = user.blockedUntil ? new Date(user.blockedUntil).toISOString() : null;
  return {
    reason: user.blockedReason,
    reasonLabel: blockReasonLabel(user.blockedReason, lang),
    message: user.blockedMessage,
    blockedAt: user.blockedAt ? new Date(user.blockedAt).toISOString() : null,
    blockedUntil: until,
    until,
    deleteAccountUrl: legalPageUrl(adminUrl, lang, 'delete-account'),
  };
}

/** 403 at sign-in, 401 on a session the block ended (the app treats both the same way). */
export function accountBlockedException(
  user: Pick<User, 'blockedReason' | 'blockedMessage' | 'blockedAt' | 'blockedUntil'>,
  lang: Lang,
  adminUrl: string,
  status: 401 | 403,
): AppException {
  return new AppException(status, 'ACCOUNT_BLOCKED', accountBlockedDetails(user, lang, adminUrl));
}
