import { PackStatus, ServiceStatus } from '../common/enums/catalog.enums.js';
import { UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { fromCents, toCents } from '../services/services.policy.js';

export const PACK_TABS = ['all', 'published', 'draft', 'unpublished', 'needs_attention'] as const;
export type PackTab = (typeof PACK_TABS)[number];

export const PACK_MIN_ITEMS = 2;
export const PACK_MAX_ITEMS = 6;

export interface PackItemState {
  serviceId: string;
  status: ServiceStatus;
  deleted: boolean;
  basePrice: string;
  /** Wilaya codes this service covers; used by the publish coverage rule when provided. */
  wilayaCodes?: number[];
}

export interface PackProviderState {
  status: UserStatus;
  verificationStatus: VerificationStatus;
  deleted: boolean;
}

/** Price summary shown on PCK-01/02: the pack price against the sum of its items' base prices. */
export function packPricing(price: string, items: { basePrice: string; deleted?: boolean }[]): { sumOfItems: string; savings: string; savingsPercent: number } {
  const sum = items.filter((i) => !i.deleted).reduce((total, item) => total + toCents(item.basePrice), 0);
  const savings = sum - toCents(price);
  return {
    sumOfItems: fromCents(sum),
    savings: fromCents(savings),
    savingsPercent: sum > 0 ? Math.round((savings / sum) * 1000) / 10 : 0,
  };
}

/** status-rules §4: the price must be strictly below the sum of the items. */
export function priceBelowSum(price: string, items: { basePrice: string; deleted?: boolean }[]): boolean {
  const sum = items.filter((i) => !i.deleted).reduce((total, item) => total + toCents(item.basePrice), 0);
  return toCents(price) > 0 && toCents(price) < sum;
}

export const ATTENTION_REASONS = ['item_not_published', 'item_deleted', 'provider_blocked', 'provider_not_verified', 'provider_deleted'] as const;
export type AttentionReasonCode = (typeof ATTENTION_REASONS)[number];

export interface AttentionReason {
  code: AttentionReasonCode;
  serviceId: string | null;
}

/**
 * status-rules §4 `needs_attention`: an item is not published or is deleted, or
 * the provider is blocked or unverified. Returns the reasons (empty = healthy).
 */
export function packAttentionReasons(items: PackItemState[], provider: PackProviderState): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  for (const item of items) {
    if (item.deleted) reasons.push({ code: 'item_deleted', serviceId: item.serviceId });
    else if (item.status !== ServiceStatus.Published) reasons.push({ code: 'item_not_published', serviceId: item.serviceId });
  }
  if (provider.deleted) reasons.push({ code: 'provider_deleted', serviceId: null });
  if (provider.status === UserStatus.Blocked) reasons.push({ code: 'provider_blocked', serviceId: null });
  if (provider.verificationStatus !== VerificationStatus.Verified) reasons.push({ code: 'provider_not_verified', serviceId: null });
  return reasons;
}

export const PACK_PUBLISH_REQUIREMENTS = ['nameEn', 'nameAr', 'items', 'unpublishedItems', 'providerBlocked', 'providerNotVerified', 'priceNotBelowSum', 'wilayaNotCovered'] as const;
export type PackPublishRequirement = (typeof PACK_PUBLISH_REQUIREMENTS)[number];

/** The pack's wilaya must belong to the intersection of the items' wilaya sets. */
export function packWilayaCovered(wilayaCode: number, items: PackItemState[]): boolean {
  const live = items.filter((i) => !i.deleted);
  if (live.length === 0) return false;
  return live.every((item) => (item.wilayaCodes ?? []).includes(wilayaCode));
}

/**
 * status-rules §4 publish guard: EN + AR name, 2+ items, every item a published
 * service (of the same provider, enforced on write), provider active and
 * verified, price below the sum of the items, and — when `wilayaCode` is given —
 * the pack's wilaya covered by every item (`wilayaNotCovered` otherwise, which
 * the publish route surfaces as 422 `PACK_WILAYA_NOT_COVERED`).
 */
export function packPublishMissing(input: {
  nameEn: string;
  nameAr: string;
  price: string;
  items: PackItemState[];
  provider: PackProviderState;
  /** Pack wilaya to check coverage for; omit to skip the coverage rule. */
  wilayaCode?: number;
}): PackPublishRequirement[] {
  const missing: PackPublishRequirement[] = [];
  const blank = (v: string | null | undefined) => !v || v.trim() === '';
  if (blank(input.nameEn)) missing.push('nameEn');
  if (blank(input.nameAr)) missing.push('nameAr');
  const live = input.items.filter((i) => !i.deleted);
  if (live.length < PACK_MIN_ITEMS) missing.push('items');
  if (input.items.some((i) => i.deleted || i.status !== ServiceStatus.Published)) missing.push('unpublishedItems');
  if (input.provider.deleted || input.provider.status === UserStatus.Blocked) missing.push('providerBlocked');
  if (input.provider.verificationStatus !== VerificationStatus.Verified) missing.push('providerNotVerified');
  if (!priceBelowSum(input.price, input.items)) missing.push('priceNotBelowSum');
  if (input.wilayaCode !== undefined && !packWilayaCovered(input.wilayaCode, input.items)) missing.push('wilayaNotCovered');
  return missing;
}

export type PackAction = 'publish' | 'unpublish';

export function canPackTransition(action: PackAction, from: PackStatus): boolean {
  return action === 'publish' ? from === PackStatus.Draft || from === PackStatus.Unpublished : from === PackStatus.Published;
}

/** SQL twin of pack visibility (aliases `p` pack, `u` provider). */
export const PACK_VISIBLE_SQL =
  "(p.status = 'published' AND p.needs_attention = 0 AND p.deleted_at IS NULL AND u.deleted_at IS NULL AND u.status = 'active' " +
  "AND u.verification_status = 'verified' AND EXISTS (SELECT 1 FROM wilayas pw WHERE pw.code = p.wilaya_code AND pw.is_open = 1))";

export function isPackVisible(input: { status: PackStatus; needsAttention: boolean; deleted: boolean; provider: PackProviderState; wilayaOpen: boolean }): boolean {
  return (
    input.status === PackStatus.Published &&
    !input.needsAttention &&
    !input.deleted &&
    !input.provider.deleted &&
    input.provider.status === UserStatus.Active &&
    input.provider.verificationStatus === VerificationStatus.Verified &&
    input.wilayaOpen
  );
}
