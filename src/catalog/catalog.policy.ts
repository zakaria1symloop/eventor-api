import { AppException } from '../common/errors/app.exception.js';

/** Lowercase kebab-case, ASCII only (`Salles des fêtes` → `salles-des-fetes`). */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 80;

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'category';
}

/**
 * Slug a soft-deleted category keeps, freeing its real slug (the unique index
 * covers deleted rows). `~` never appears in a valid slug, so it cannot clash.
 */
export function deletedSlug(slug: string, id: string): string {
  const suffix = `~${id.slice(0, 8)}`;
  return `${slug.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
}

/** CAT-01 "Missing translation": a name or a one-sided description is missing in EN or AR. */
export function hasMissingTranslation(category: {
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
}): boolean {
  const filled = (value: string | null) => !!value && value.trim() !== '';
  return (
    !filled(category.nameEn) ||
    !filled(category.nameAr) ||
    filled(category.descriptionEn) !== filled(category.descriptionAr)
  );
}

/**
 * Reorders categories: the listed ids take the position slots they currently
 * occupy, in the new order. Works for the full list and for a filtered tab
 * (other categories keep their positions). Returns only the changed positions.
 */
export function reorderPositions(
  current: { id: string; position: number }[],
  ids: string[],
): { id: string; position: number }[] {
  const byId = new Map(current.map((c) => [c.id, c]));
  const unknownIds = ids.filter((id) => !byId.has(id));
  if (unknownIds.length > 0) {
    throw new AppException(404, 'CATEGORY_NOT_FOUND', { ids: unknownIds });
  }
  const slots = ids.map((id) => byId.get(id)!.position).sort((a, b) => a - b);
  // Duplicate positions (legacy data) are spread out so the order is stable.
  for (let i = 1; i < slots.length; i++) {
    if (slots[i]! <= slots[i - 1]!) slots[i] = slots[i - 1]! + 1;
  }
  return ids
    .map((id, index) => ({ id, position: slots[index]! }))
    .filter((next) => byId.get(next.id)!.position !== next.position);
}

/** Closing a wilaya hides what is offered there, so it needs an explicit confirm. */
export function assertWilayaCloseConfirmed(input: {
  wasOpen: boolean;
  isOpen: boolean | undefined;
  confirm: boolean | undefined;
  servicesCount: number;
  providersCount: number;
}): void {
  if (input.wasOpen && input.isOpen === false && input.confirm !== true) {
    throw AppException.of('WILAYA_CLOSE_CONFIRM_REQUIRED', {
      servicesCount: input.servicesCount,
      providersCount: input.providersCount,
    });
  }
}

/** Accent- and case-insensitive key, close to MySQL's utf8mb4_unicode_ci equality. */
export function communeKey(wilayaCode: number, name: string): string {
  return `${wilayaCode}|${name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()}`;
}
