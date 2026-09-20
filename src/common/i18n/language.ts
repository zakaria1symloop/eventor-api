export const SUPPORTED_LANGUAGES = ['en', 'ar'] as const;
export type Lang = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Lang = 'en';

/**
 * Picks `en` or `ar` from an `Accept-Language` header, honouring q-values
 * (`ar-DZ,ar;q=0.9,en;q=0.8` → `ar`). Falls back to `fallback` (the user's
 * language when known), then `en`.
 */
export function resolveLanguage(
  header: string | string[] | undefined,
  fallback?: string | null,
): Lang {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value) {
    const ranked = value
      .split(',')
      .map((part, index) => {
        const [tag = '', ...params] = part.trim().split(';');
        const q = params
          .map((p) => p.trim())
          .find((p) => p.startsWith('q='));
        return {
          lang: tag.trim().toLowerCase().split('-')[0] ?? '',
          q: q ? Number(q.slice(2)) : 1,
          index,
        };
      })
      .filter((entry) => entry.lang && !Number.isNaN(entry.q) && entry.q > 0)
      .sort((a, b) => b.q - a.q || a.index - b.index);

    const match = ranked.find((entry) => isLang(entry.lang));
    if (match) {
      return match.lang as Lang;
    }
  }
  return isLang(fallback) ? fallback : DEFAULT_LANGUAGE;
}

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Replaces `{name}` placeholders with values from `params`. */
export function interpolate(template: string, params?: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return template;
  }
  const values = params as Record<string, unknown>;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    values[key] === undefined || values[key] === null ? whole : String(values[key]),
  );
}
