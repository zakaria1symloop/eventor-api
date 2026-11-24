import type { Lang } from '../../common/i18n/language.js';

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/** The footer of every mail when the sender is a no-reply address. */
export const NO_REPLY_FOOTER: Record<Lang, string> = {
  en: 'The Eventor team. This is an automatic message, please do not reply.',
  ar: 'فريق Eventor. هذه رسالة تلقائية، يرجى عدم الرد عليها.',
};

/** #20 follow-up: the footer when replies reach Eventor support (the sender is a real inbox). */
export const REPLY_FOOTER: Record<Lang, string> = {
  en: 'The Eventor team. You can reply to this email to reach Eventor support.',
  ar: 'فريق Eventor. يمكنك الرد على هذه الرسالة للتواصل مع دعم Eventor.',
};

/** A sender whose address starts with "no-reply" / "noreply" is not read; any other one is. */
export function acceptsReplies(mailFrom: string): boolean {
  const match = /<([^>]+)>/.exec(mailFrom);
  const address = (match ? match[1]! : mailFrom).trim().toLowerCase();
  return !/^no-?reply@/.test(address);
}

/** Swaps the "do not reply" footer for the "reply to reach support" one, in the HTML and the text part. */
export function withReplyFooter(mail: RenderedMail, lang: Lang): RenderedMail {
  return {
    subject: mail.subject,
    html: mail.html.replace(escapeHtml(NO_REPLY_FOOTER[lang]), escapeHtml(REPLY_FOOTER[lang])),
    text: mail.text.replace(NO_REPLY_FOOTER[lang], REPLY_FOOTER[lang]),
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wraps body paragraphs in the shared email layout (RTL for Arabic). Pass
 * already-escaped HTML fragments; plain text is built from `textLines`.
 */
export function layout(
  lang: Lang,
  subject: string,
  htmlParagraphs: string[],
  textLines: string[],
): RenderedMail {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const footer = NO_REPLY_FOOTER[lang];

  const html = `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f5f5f7;font-family:Arial,Helvetica,sans-serif;color:#1d1d1f">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;text-align:${dir === 'rtl' ? 'right' : 'left'}">
    <h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(subject)}</h1>
    ${htmlParagraphs.map((p) => `<p style="margin:0 0 12px;line-height:1.6">${p}</p>`).join('\n    ')}
    <p style="margin:24px 0 0;color:#86868b;font-size:12px">${escapeHtml(footer)}</p>
  </div>
</body>
</html>`;

  return { subject, html, text: [...textLines, '', footer].join('\n') };
}
