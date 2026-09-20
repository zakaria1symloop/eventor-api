/**
 * Contact details in chat messages (status-rules §10): phone numbers, emails,
 * links and WhatsApp / Telegram / Instagram handles are replaced in
 * `body_masked` until the pair has an accepted booking. Admins always see the
 * original text.
 */
export type ContactKind = 'phone' | 'email' | 'url' | 'handle';

export interface MaskResult {
  /** The masked text, or null when nothing was found (then `body` is shown as is). */
  masked: string | null;
  /** Kinds found, in first-seen order. */
  kinds: ContactKind[];
}

export const MASK_TOKENS: Record<ContactKind, string> = {
  phone: '[phone hidden]',
  email: '[email hidden]',
  url: '[link hidden]',
  handle: '[handle hidden]',
};

/** Latin and Arabic-Indic digits. */
const D = '[0-9\\u0660-\\u0669\\u06F0-\\u06F9]';
const SEP = '[\\s.\\-/]?';

const RULES: { kind: ContactKind; pattern: RegExp }[] = [
  { kind: 'email', pattern: /[\p{L}\p{N}._%+-]+\s?(?:@|\(at\)|\[at\])\s?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[A-Za-z]{2,}/giu },
  // wa.me/…, t.me/…, http(s)://…, www.…, bare domains with a common TLD
  {
    kind: 'url',
    pattern: /(?:https?:\/\/|www\.)[^\s]+|\b(?:wa\.me|t\.me|telegram\.me|instagram\.com|facebook\.com|fb\.me|snapchat\.com|tiktok\.com)\/[^\s]*|\b[a-z0-9-]{2,}\.(?:com|dz|net|org|fr|me|io|info|link|ly|app|site|shop)(?:\/[^\s]*)?(?![\p{L}\p{N}])/giu,
  },
  // +213 / 00213 international, then 0[5-7] mobiles (10 digits) and 0[2-4] landlines (9 digits), any spacing
  {
    kind: 'phone',
    pattern: new RegExp(
      `(?:\\+|00)\\s?213${SEP}(?:\\(0\\)${SEP})?[1-9](?:${SEP}${D}){7,8}(?!${D})` +
        `|(?<!${D})[0٠۰]${SEP}[5-7٥-٧۵-۷](?:${SEP}${D}){8}(?!${D})` +
        `|(?<!${D})[0٠۰]${SEP}[2-4٢-٤۲-۴](?:${SEP}${D}){7}(?!${D})`,
      'gu',
    ),
  },
  // @handle (emails were replaced first), or "whatsapp: name" / "telegram name" / "insta: name"
  { kind: 'handle', pattern: /(?<![\p{L}\p{N}_])@[A-Za-z0-9_.]{3,32}|\b(?:whatsapp|whatsap|watsap|telegram|telegramme|insta(?:gram)?|snap(?:chat)?)\s*[:=]?\s*@?[A-Za-z][A-Za-z0-9_.]{2,31}/giu },
];

/** Masks contact details; returns `masked: null` when the text has none. */
export function maskContacts(body: string | null | undefined): MaskResult {
  if (!body) return { masked: null, kinds: [] };
  let text = body;
  const kinds: ContactKind[] = [];
  for (const { kind, pattern } of RULES) {
    pattern.lastIndex = 0;
    const next = text.replace(pattern, (match) => {
      // A handle rule hit on words like "whatsapp [phone hidden]" is already masked.
      if (kind === 'handle' && /hidden\]?$/.test(match)) return match;
      if (!kinds.includes(kind)) kinds.push(kind);
      return MASK_TOKENS[kind];
    });
    text = next;
  }
  return kinds.length === 0 ? { masked: null, kinds } : { masked: text, kinds };
}

/** The text a participant sees: masked unless the pair has an accepted booking. */
export function visibleBody(message: { body: string | null; bodyMasked: string | null }, unmasked: boolean): string | null {
  return unmasked || message.bodyMasked === null ? message.body : message.bodyMasked;
}

/** First 120 characters of the masked text, on one line. */
export function preview(body: string | null, max = 120): string | null {
  if (body === null) return null;
  const line = body.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
