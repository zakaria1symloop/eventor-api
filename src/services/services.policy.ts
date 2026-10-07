import { PriceType, ServiceStatus } from '../common/enums/catalog.enums.js';
import { UserStatus, VerificationStatus } from '../common/enums/user.enums.js';

export const SERVICE_TABS = ['all', 'published', 'draft', 'hidden', 'waiting_approval', 'reported'] as const;
export type ServiceTab = (typeof SERVICE_TABS)[number];

/** status-rules §3: at most this many featured (published) services. */
export const MAX_FEATURED_SERVICES = 12;

/** Why a service is not visible in the app (empty = visible). */
export const VISIBILITY_REASONS = ['deleted', 'not_published', 'provider_blocked', 'provider_not_verified', 'provider_deleted', 'no_open_wilaya', 'period_ended'] as const;
export type VisibilityReason = (typeof VISIBILITY_REASONS)[number];

export interface ServiceVisibilityInput {
  status: ServiceStatus;
  deleted: boolean;
  provider: { status: UserStatus; verificationStatus: VerificationStatus; deleted: boolean };
  /** Open wilayas among the service's wilayas. */
  openWilayas: number;
  /** `availableUntil` and the Algiers today: the service leaves the catalog after its last event date. */
  availableUntil?: string | null;
  today?: string;
}

/**
 * db-schema §4 "Visible in the app": published, not deleted, provider active and
 * verified, at least one open wilaya. A provider who is not accepting bookings
 * keeps visible services (booking disabled), so that flag is not part of the rule.
 */
export function serviceVisibilityReasons(input: ServiceVisibilityInput): VisibilityReason[] {
  const reasons: VisibilityReason[] = [];
  if (input.deleted) reasons.push('deleted');
  if (input.status !== ServiceStatus.Published) reasons.push('not_published');
  if (input.provider.deleted) reasons.push('provider_deleted');
  if (input.provider.status === UserStatus.Blocked) reasons.push('provider_blocked');
  if (input.provider.verificationStatus !== VerificationStatus.Verified) reasons.push('provider_not_verified');
  if (input.openWilayas < 1) reasons.push('no_open_wilaya');
  if (input.availableUntil && input.today && input.availableUntil < input.today) reasons.push('period_ended');
  return reasons;
}

export function isServiceVisible(input: ServiceVisibilityInput): boolean {
  return serviceVisibilityReasons(input).length === 0;
}

/** SQL twin of `isServiceVisible` for list rows (aliases `s` service, `u` provider). */
export const SERVICE_VISIBLE_SQL =
  "(s.status = 'published' AND s.deleted_at IS NULL AND u.deleted_at IS NULL AND u.status = 'active' AND u.verification_status = 'verified' " +
  'AND EXISTS (SELECT 1 FROM service_wilayas sw JOIN wilayas w ON w.code = sw.wilaya_code WHERE sw.service_id = s.id AND w.is_open = 1) ' +
  // Africa/Algiers is UTC+1 all year (no DST): its today, without depending on the server time zone.
  'AND (s.available_until IS NULL OR s.available_until >= DATE(UTC_TIMESTAMP() + INTERVAL 1 HOUR)))';

export const PUBLISH_REQUIREMENTS = ['titleEn', 'titleAr', 'descriptionEn', 'descriptionAr', 'price', 'photos', 'category', 'wilayas'] as const;
export type PublishRequirement = (typeof PUBLISH_REQUIREMENTS)[number];

export interface PublishCheckInput {
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  descriptionAr: string;
  basePrice: string;
  priceType: PriceType;
  photos: number;
  /** Category exists (not deleted) and is visible. */
  categoryUsable: boolean;
  wilayas: number;
}

const blank = (value: string | null | undefined) => !value || value.trim() === '';

/**
 * status-rules §3 publish guard: EN + AR title and description, a base price
 * (any amount for `on_quote`, otherwise above zero), at least one photo, a
 * usable category and at least one wilaya. Returns what is missing, in form order.
 */
export function servicePublishMissing(input: PublishCheckInput): PublishRequirement[] {
  const missing: PublishRequirement[] = [];
  if (blank(input.titleEn)) missing.push('titleEn');
  if (blank(input.titleAr)) missing.push('titleAr');
  if (blank(input.descriptionEn)) missing.push('descriptionEn');
  if (blank(input.descriptionAr)) missing.push('descriptionAr');
  if (input.priceType !== PriceType.OnQuote && !(toCents(input.basePrice) > 0)) missing.push('price');
  if (input.photos < 1) missing.push('photos');
  if (!input.categoryUsable) missing.push('category');
  if (input.wilayas < 1) missing.push('wilayas');
  return missing;
}

/** Transitions triggered by the admin action endpoints. */
export type ServiceAction = 'publish' | 'unpublish' | 'hide' | 'show';

const ALLOWED_FROM: Record<ServiceAction, ServiceStatus[]> = {
  publish: [ServiceStatus.Draft],
  unpublish: [ServiceStatus.Published],
  hide: [ServiceStatus.Published],
  show: [ServiceStatus.Hidden],
};

export function canTransition(action: ServiceAction, from: ServiceStatus): boolean {
  return ALLOWED_FROM[action].includes(from);
}

/** Featuring is for published services only, up to MAX_FEATURED_SERVICES. */
export function featureRefusal(status: ServiceStatus, featuredCount: number, alreadyFeatured: boolean): 'SERVICE_INVALID_TRANSITION' | 'FEATURED_LIMIT' | null {
  if (status !== ServiceStatus.Published) return 'SERVICE_INVALID_TRANSITION';
  if (!alreadyFeatured && featuredCount >= MAX_FEATURED_SERVICES) return 'FEATURED_LIMIT';
  return null;
}

// ── money (decimal strings, integer cents for arithmetic) ─────

export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const [whole = '0', fraction = ''] = String(value).trim().split('.');
  const negative = whole.startsWith('-');
  const cents = Math.abs(Number(whole)) * 100 + Number((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** The daily limit a save asks for: `onePerDay` wins (1 or no limit), then `maxEventsPerDay`, else `current`. */
export function dailyLimit(dto: { onePerDay?: boolean; maxEventsPerDay?: number | null }, current: number | null): number | null {
  if (dto.onePerDay !== undefined) return dto.onePerDay ? 1 : null;
  return dto.maxEventsPerDay !== undefined ? dto.maxEventsPerDay : current;
}
