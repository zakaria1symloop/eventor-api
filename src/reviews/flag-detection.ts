import { maskContacts } from '../messaging/contact-masking.js';

/**
 * Flags stored in `reviews.detected_flags` (api-standards §6, status-rules §8):
 * contact details (phone, email, link, social handle) and insults. A flagged
 * review or reply is still published, with an automatic `open` report.
 */
export type ReviewFlag = 'phone' | 'email' | 'link' | 'handle' | 'insult';

export const REVIEW_FLAGS: readonly ReviewFlag[] = ['phone', 'email', 'link', 'handle', 'insult'];

/**
 * Basic insult list (FR / Darija in Latin letters / AR / EN). Matched on whole
 * words after lower-casing and removing accents; kept short on purpose, a
 * moderator decides.
 */
export const INSULT_WORDS: readonly string[] = [
  // French
  'arnaque', 'arnaqueur', 'arnaqueurs', 'escroc', 'escrocs', 'voleur', 'voleurs', 'voleuse', 'connard', 'connards', 'connasse', 'salaud', 'salope', 'merde', 'encule', 'batard', 'abruti', 'imbecile', 'idiot', 'nul', 'minable', 'pourri',
  // Darija (Latin)
  'hmar', '7mar', 'kelb', 'khanez', 'zamel', 'tahan', 'nsab',
  // Arabic
  'نصاب', 'نصابين', 'حمار', 'كلب', 'حقير', 'سارق', 'لص', 'غشاش', 'محتال', 'تافه', 'زبالة',
  // English
  'scam', 'scammer', 'scammers', 'fraud', 'thief', 'thieves', 'idiot', 'stupid', 'moron', 'bastard', 'asshole', 'shit', 'fuck', 'fucking', 'crap',
];

const INSULTS = new Set(INSULT_WORDS);

const normalise = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Arabic diacritics and tatweel
    .replace(/[ً-ْـ]/g, '');

export function containsInsult(text: string): boolean {
  return normalise(text)
    .split(/[^\p{L}\p{N}]+/u)
    .some((word) => word.length > 1 && INSULTS.has(word));
}

/** Flags found in a review comment or reply body, in a stable order; empty when clean. */
export function detectFlags(text: string | null | undefined): ReviewFlag[] {
  if (!text) return [];
  const found = new Set<ReviewFlag>();
  for (const kind of maskContacts(text).kinds) found.add(kind === 'url' ? 'link' : kind);
  if (containsInsult(text)) found.add('insult');
  return REVIEW_FLAGS.filter((flag) => found.has(flag));
}

/** Report reason for an automatic report: contact details first, then insults. */
export function autoReportReason(flags: readonly ReviewFlag[]): 'contact_outside' | 'inappropriate' | null {
  if (flags.some((f) => f !== 'insult')) return 'contact_outside';
  if (flags.includes('insult')) return 'inappropriate';
  return null;
}
