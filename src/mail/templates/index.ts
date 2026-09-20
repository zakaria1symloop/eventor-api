import type { Lang } from '../../common/i18n/language.js';
import { escapeHtml, layout, type RenderedMail } from './layout.js';

/**
 * Email templates: plain TS functions, one per template, EN + AR. Data is
 * escaped here, so callers pass raw values. Add templates as modules need them.
 */
export const MAIL_TEMPLATES = {
  'verification-code': (lang: Lang, data: { name: string; code: string; minutes: number }) =>
    lang === 'ar'
      ? layout(
          lang,
          'رمز التحقق الخاص بك',
          [
            `مرحبًا ${escapeHtml(data.name)}،`,
            `رمز التحقق الخاص بك هو: <strong style="font-size:22px;letter-spacing:4px">${escapeHtml(data.code)}</strong>`,
            `ينتهي صلاحية الرمز خلال ${data.minutes} دقيقة.`,
          ],
          [`مرحبًا ${data.name}،`, `رمز التحقق الخاص بك هو: ${data.code}`, `ينتهي صلاحية الرمز خلال ${data.minutes} دقيقة.`],
        )
      : layout(
          lang,
          'Your verification code',
          [
            `Hello ${escapeHtml(data.name)},`,
            `Your verification code is: <strong style="font-size:22px;letter-spacing:4px">${escapeHtml(data.code)}</strong>`,
            `The code expires in ${data.minutes} minutes.`,
          ],
          [`Hello ${data.name},`, `Your verification code is: ${data.code}`, `The code expires in ${data.minutes} minutes.`],
        ),

  'password-reset': (lang: Lang, data: { name: string; url: string; minutes: number }) =>
    lang === 'ar'
      ? layout(
          lang,
          'إعادة تعيين كلمة المرور',
          [
            `مرحبًا ${escapeHtml(data.name)}،`,
            `لإعادة تعيين كلمة المرور، اضغط على الرابط: <a href="${escapeHtml(data.url)}">إعادة التعيين</a>`,
            `الرابط صالح لمدة ${data.minutes} دقيقة. إذا لم تطلب ذلك، تجاهل هذه الرسالة.`,
          ],
          [`مرحبًا ${data.name}،`, `رابط إعادة التعيين: ${data.url}`, `الرابط صالح لمدة ${data.minutes} دقيقة.`],
        )
      : layout(
          lang,
          'Reset your password',
          [
            `Hello ${escapeHtml(data.name)},`,
            `To reset your password, open this link: <a href="${escapeHtml(data.url)}">Reset password</a>`,
            `The link is valid for ${data.minutes} minutes. If you did not ask for this, ignore this email.`,
          ],
          [`Hello ${data.name},`, `Reset link: ${data.url}`, `The link is valid for ${data.minutes} minutes.`],
        ),

  'admin-invitation': (lang: Lang, data: { name: string; invitedBy: string; url: string }) =>
    lang === 'ar'
      ? layout(
          lang,
          'دعوة للانضمام إلى لوحة تحكم Eventor',
          [
            `مرحبًا ${escapeHtml(data.name)}،`,
            `دعاك ${escapeHtml(data.invitedBy)} لتصبح مسؤولًا في Eventor.`,
            `<a href="${escapeHtml(data.url)}">قبول الدعوة</a> (صالحة لمدة 72 ساعة)`,
          ],
          [`مرحبًا ${data.name}،`, `دعاك ${data.invitedBy} لتصبح مسؤولًا في Eventor.`, `قبول الدعوة: ${data.url}`],
        )
      : layout(
          lang,
          'You are invited to the Eventor dashboard',
          [
            `Hello ${escapeHtml(data.name)},`,
            `${escapeHtml(data.invitedBy)} invited you to become an Eventor admin.`,
            `<a href="${escapeHtml(data.url)}">Accept the invitation</a> (valid for 72 hours)`,
          ],
          [`Hello ${data.name},`, `${data.invitedBy} invited you to become an Eventor admin.`, `Accept: ${data.url}`],
        ),

  'export-ready': (lang: Lang, data: { name: string; resource: string; rowCount: number; url: string; days: number }) =>
    lang === 'ar'
      ? layout(
          lang,
          'ملف التصدير جاهز',
          [
            `مرحبًا ${escapeHtml(data.name)}،`,
            `ملف تصدير «${escapeHtml(data.resource)}» جاهز (${data.rowCount} سطر).`,
            `<a href="${escapeHtml(data.url)}">تنزيل الملف</a> (الرابط صالح لمدة ${data.days} أيام)`,
          ],
          [`مرحبًا ${data.name}،`, `ملف تصدير «${data.resource}» جاهز (${data.rowCount} سطر).`, `تنزيل: ${data.url}`],
        )
      : layout(
          lang,
          'Your export is ready',
          [
            `Hello ${escapeHtml(data.name)},`,
            `Your "${escapeHtml(data.resource)}" export is ready (${data.rowCount} rows).`,
            `<a href="${escapeHtml(data.url)}">Download the file</a> (link valid for ${data.days} days)`,
          ],
          [`Hello ${data.name},`, `Your "${data.resource}" export is ready (${data.rowCount} rows).`, `Download: ${data.url}`],
        ),

  'user-invitation': (lang: Lang, data: { name: string; url: string; days: number }) =>
    lang === 'ar'
      ? layout(
          lang,
          'مرحبًا بك في Eventor',
          [
            `مرحبًا ${escapeHtml(data.name)}،`,
            'أنشأ فريق Eventor حسابًا لك. اختر كلمة مرور لتسجيل الدخول:',
            `<a href="${escapeHtml(data.url)}">تعيين كلمة المرور</a> (الرابط صالح لمدة ${data.days} أيام)`,
          ],
          [`مرحبًا ${data.name}،`, 'أنشأ فريق Eventor حسابًا لك.', `تعيين كلمة المرور: ${data.url}`],
        )
      : layout(
          lang,
          'Welcome to Eventor',
          [
            `Hello ${escapeHtml(data.name)},`,
            'The Eventor team created an account for you. Choose a password to sign in:',
            `<a href="${escapeHtml(data.url)}">Set your password</a> (link valid for ${data.days} days)`,
          ],
          [`Hello ${data.name},`, 'The Eventor team created an account for you.', `Set your password: ${data.url}`],
        ),

  'account-blocked': (lang: Lang, data: { name: string; message: string | null; until: string | null }) =>
    lang === 'ar'
      ? layout(
          lang,
          'تم حظر حسابك',
          [
            `مرحبًا ${escapeHtml(data.name)}،`,
            data.until ? `تم حظر حسابك في Eventor حتى ${escapeHtml(data.until)}.` : 'تم حظر حسابك في Eventor.',
            ...(data.message ? [escapeHtml(data.message)] : []),
            'للاستفسار، تواصل مع الدعم.',
          ],
          [`مرحبًا ${data.name}،`, 'تم حظر حسابك في Eventor.', ...(data.message ? [data.message] : [])],
        )
      : layout(
          lang,
          'Your account has been blocked',
          [
            `Hello ${escapeHtml(data.name)},`,
            data.until ? `Your Eventor account is blocked until ${escapeHtml(data.until)}.` : 'Your Eventor account has been blocked.',
            ...(data.message ? [escapeHtml(data.message)] : []),
            'Contact support if you have questions.',
          ],
          [`Hello ${data.name},`, 'Your Eventor account has been blocked.', ...(data.message ? [data.message] : [])],
        ),

  'account-unblocked': (lang: Lang, data: { name: string }) =>
    lang === 'ar'
      ? layout(lang, 'تم رفع الحظر عن حسابك', [`مرحبًا ${escapeHtml(data.name)}،`, 'يمكنك استخدام حسابك في Eventor من جديد.'], [`مرحبًا ${data.name}،`, 'يمكنك استخدام حسابك في Eventor من جديد.'])
      : layout(lang, 'Your account is active again', [`Hello ${escapeHtml(data.name)},`, 'You can use your Eventor account again.'], [`Hello ${data.name},`, 'You can use your Eventor account again.']),

  'provider-verified': (lang: Lang, data: { name: string }) =>
    lang === 'ar'
      ? layout(
          lang,
          'تمت الموافقة على ملفك',
          [`مرحبًا ${escapeHtml(data.name)}،`, 'تم التحقق من وثائقك. أصبحت خدماتك المنشورة ظاهرة للعملاء على Eventor.'],
          [`مرحبًا ${data.name}،`, 'تم التحقق من وثائقك. أصبحت خدماتك المنشورة ظاهرة للعملاء.'],
        )
      : layout(
          lang,
          'Your profile is approved',
          [`Hello ${escapeHtml(data.name)},`, 'Your documents have been verified. Your published services are now visible to clients on Eventor.'],
          [`Hello ${data.name},`, 'Your documents have been verified. Your published services are now visible to clients.'],
        ),

  'document-rejected': (lang: Lang, data: { name: string; document: string; reason: string; message: string }) =>
    lang === 'ar'
      ? layout(
          lang,
          'يجب إعادة إرسال وثيقة',
          [
            `مرحبًا ${escapeHtml(data.name)}،`,
            `تم رفض وثيقتك «${escapeHtml(data.document)}» (${escapeHtml(data.reason)}).`,
            escapeHtml(data.message),
            'يرجى إرسال نسخة جديدة من التطبيق.',
          ],
          [`مرحبًا ${data.name}،`, `تم رفض وثيقتك «${data.document}» (${data.reason}).`, data.message],
        )
      : layout(
          lang,
          'A document needs to be sent again',
          [
            `Hello ${escapeHtml(data.name)},`,
            `Your document "${escapeHtml(data.document)}" was rejected (${escapeHtml(data.reason)}).`,
            escapeHtml(data.message),
            'Please upload a new copy from the app.',
          ],
          [`Hello ${data.name},`, `Your document "${data.document}" was rejected (${data.reason}).`, data.message],
        ),

  'service-hidden': (lang: Lang, data: { name: string; title: string; reason: string; message: string | null; allowResubmit: boolean }) =>
    lang === 'ar'
      ? layout(
          lang,
          'تم إخفاء إحدى خدماتك',
          [
            `مرحبًا ${escapeHtml(data.name)}،`,
            `تم إخفاء خدمتك «${escapeHtml(data.title)}» من التطبيق (${escapeHtml(data.reason)}).`,
            ...(data.message ? [escapeHtml(data.message)] : []),
            data.allowResubmit ? 'يمكنك تعديل الخدمة وطلب إعادة نشرها.' : 'لا يمكن إعادة نشر هذه الخدمة.',
          ],
          [`مرحبًا ${data.name}،`, `تم إخفاء خدمتك «${data.title}» (${data.reason}).`, ...(data.message ? [data.message] : [])],
        )
      : layout(
          lang,
          'One of your services was hidden',
          [
            `Hello ${escapeHtml(data.name)},`,
            `Your service "${escapeHtml(data.title)}" is hidden from the app (${escapeHtml(data.reason)}).`,
            ...(data.message ? [escapeHtml(data.message)] : []),
            data.allowResubmit ? 'You can edit the service and ask for it to be published again.' : 'This service cannot be published again.',
          ],
          [`Hello ${data.name},`, `Your service "${data.title}" is hidden from the app (${data.reason}).`, ...(data.message ? [data.message] : [])],
        ),

  'service-shown': (lang: Lang, data: { name: string; title: string }) =>
    lang === 'ar'
      ? layout(
          lang,
          'خدمتك ظاهرة من جديد',
          [`مرحبًا ${escapeHtml(data.name)}،`, `خدمتك «${escapeHtml(data.title)}» ظاهرة من جديد في التطبيق.`],
          [`مرحبًا ${data.name}،`, `خدمتك «${data.title}» ظاهرة من جديد في التطبيق.`],
        )
      : layout(
          lang,
          'Your service is visible again',
          [`Hello ${escapeHtml(data.name)},`, `Your service "${escapeHtml(data.title)}" is visible in the app again.`],
          [`Hello ${data.name},`, `Your service "${data.title}" is visible in the app again.`],
        ),

  'pack-needs-attention': (lang: Lang, data: { name: string; pack: string }) =>
    lang === 'ar'
      ? layout(
          lang,
          'باقتك تحتاج إلى مراجعة',
          [
            `مرحبًا ${escapeHtml(data.name)}،`,
            `باقتك «${escapeHtml(data.pack)}» لم تعد ظاهرة لأن إحدى خدماتها غير منشورة أو أن حسابك غير متاح.`,
            'راجع الباقة من التطبيق.',
          ],
          [`مرحبًا ${data.name}،`, `باقتك «${data.pack}» تحتاج إلى مراجعة.`],
        )
      : layout(
          lang,
          'Your Ready Pack needs attention',
          [
            `Hello ${escapeHtml(data.name)},`,
            `Your pack "${escapeHtml(data.pack)}" is no longer shown because one of its services is not published or your account is not available.`,
            'Please review the pack in the app.',
          ],
          [`Hello ${data.name},`, `Your pack "${data.pack}" needs attention.`],
        ),

  /** Booking lifecycle mails: the listener picks the translated subject and lines (module 8). */
  'booking-update': (lang: Lang, data: { name: string; subject: string; lines: string[] }) =>
    layout(
      lang,
      data.subject,
      [lang === 'ar' ? `مرحبًا ${escapeHtml(data.name)}،` : `Hello ${escapeHtml(data.name)},`, ...data.lines.map((line) => escapeHtml(line))],
      [lang === 'ar' ? `مرحبًا ${data.name}،` : `Hello ${data.name},`, ...data.lines],
    ),

  /** Disputes and academic requests: the listener writes subject and lines in the recipient's language; optional link button. */
  'case-update': (lang: Lang, data: { name: string; subject: string; lines: string[]; url?: string | null; urlLabel?: string | null }) =>
    layout(
      lang,
      data.subject,
      [
        lang === 'ar' ? `مرحبًا ${escapeHtml(data.name)}،` : `Hello ${escapeHtml(data.name)},`,
        ...data.lines.map((line) => escapeHtml(line)),
        ...(data.url ? [`<a href="${escapeHtml(data.url)}">${escapeHtml(data.urlLabel ?? (lang === 'ar' ? 'فتح' : 'Open'))}</a>`] : []),
      ],
      [lang === 'ar' ? `مرحبًا ${data.name}،` : `Hello ${data.name},`, ...data.lines, ...(data.url ? [data.url] : [])],
    ),

  invoice: (lang: Lang, data: { name: string; number: string; reference: string; total: string }) =>
    lang === 'ar'
      ? layout(
          lang,
          `فاتورتك ${data.number}`,
          [
            `مرحبًا ${escapeHtml(data.name)}،`,
            `تجد في المرفق الفاتورة ${escapeHtml(data.number)} الخاصة بحجزك ${escapeHtml(data.reference)} (المجموع ${escapeHtml(data.total)} دج).`,
            'الدفع نقدًا لمقدم الخدمة؛ هذه الفاتورة للاطلاع.',
          ],
          [`مرحبًا ${data.name}،`, `الفاتورة ${data.number} لحجزك ${data.reference} (المجموع ${data.total} دج).`],
        )
      : layout(
          lang,
          `Your invoice ${data.number}`,
          [
            `Hello ${escapeHtml(data.name)},`,
            `Attached is invoice ${escapeHtml(data.number)} for your booking ${escapeHtml(data.reference)} (total ${escapeHtml(data.total)} DZD).`,
            'Payment is made in cash to the provider; this invoice is for your records.',
          ],
          [`Hello ${data.name},`, `Invoice ${data.number} for your booking ${data.reference} (total ${data.total} DZD).`],
        ),

  'support-message': (lang: Lang, data: { name: string; body: string }) =>
    lang === 'ar'
      ? layout(
          lang,
          'رسالة من دعم Eventor',
          [`مرحبًا ${escapeHtml(data.name)}،`, escapeHtml(data.body), 'يمكنك الرد من تطبيق Eventor.'],
          [`مرحبًا ${data.name}،`, data.body, 'يمكنك الرد من تطبيق Eventor.'],
        )
      : layout(
          lang,
          'A message from Eventor support',
          [`Hello ${escapeHtml(data.name)},`, escapeHtml(data.body), 'You can reply from the Eventor app.'],
          [`Hello ${data.name},`, data.body, 'You can reply from the Eventor app.'],
        ),

  notification: (lang: Lang, data: { title: string; body: string; url?: string }) =>
    layout(
      lang,
      data.title,
      [
        escapeHtml(data.body),
        ...(data.url
          ? [`<a href="${escapeHtml(data.url)}">${lang === 'ar' ? 'فتح' : 'Open'}</a>`]
          : []),
      ],
      [data.body, ...(data.url ? [data.url] : [])],
    ),
} satisfies Record<string, (lang: Lang, data: never) => RenderedMail>;

export type MailTemplateName = keyof typeof MAIL_TEMPLATES;
export type MailTemplateData<T extends MailTemplateName> = Parameters<(typeof MAIL_TEMPLATES)[T]>[1];

export function renderMail<T extends MailTemplateName>(
  template: T,
  lang: Lang,
  data: MailTemplateData<T>,
): RenderedMail {
  return (MAIL_TEMPLATES[template] as (lang: Lang, data: MailTemplateData<T>) => RenderedMail)(
    lang,
    data,
  );
}
