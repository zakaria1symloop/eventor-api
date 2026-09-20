import type { ServiceRecipient } from '../services/services.events.js';
import type { AttentionReasonCode } from './packs.policy.js';

export const PACK_EVENTS = {
  /** A pack started needing attention (false → true); the provider is told. */
  needsAttention: 'pack.needs_attention',
  published: 'pack.published',
  unpublished: 'pack.unpublished',
  deleted: 'pack.deleted',
} as const;

export interface PackNeedsAttentionEvent {
  packId: string;
  nameEn: string;
  nameAr: string;
  reasons: AttentionReasonCode[];
  provider: ServiceRecipient;
}

export interface PackEvent {
  packId: string;
  providerId: string;
}
