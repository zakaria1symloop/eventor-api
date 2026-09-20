import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { ServiceStatus } from '../common/enums/catalog.enums.js';
import type { UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import type { Lang } from '../common/i18n/language.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { USER_EVENTS, type UserBlockedEvent, type UserDeletedEvent, type UserUnblockedEvent } from '../users/users.events.js';
import { VERIFICATION_EVENTS, type VerificationStatusChangedEvent } from '../verification/verification.events.js';
import { PACK_EVENTS, type PackNeedsAttentionEvent } from './packs.events.js';
import { packAttentionReasons, type AttentionReason, type PackItemState, type PackProviderState } from './packs.policy.js';

export interface PackHealthScope {
  packIds?: string[];
  serviceIds?: string[];
  providerIds?: string[];
}

export interface PackHealthResult {
  /** Packs examined. */
  checked: number;
  /** Packs whose flag became true. */
  nowNeedingAttention: string[];
  /** Packs whose flag became false. */
  resolved: string[];
}

interface PackStateRow {
  id: string;
  name_en: string;
  name_ar: string;
  needs_attention: number;
  provider_id: string;
  u_status: UserStatus;
  u_verification: VerificationStatus;
  u_deleted: Date | null;
  u_email: string;
  u_name: string;
  u_lang: Lang;
}

/**
 * Keeps `packs.needs_attention` in line with status-rules §4 (an item not
 * published or deleted, or the provider blocked / unverified). Called inside
 * the transaction of every service write, and on account and verification
 * events. A pack that starts needing attention emits `pack.needs_attention`.
 */
@Injectable()
export class PackHealthService {
  private readonly logger = new Logger(PackHealthService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: DomainEvents,
  ) {}

  /** Reasons for one pack (detail screen), from the current rows. */
  async reasonsFor(em: EntityManager, packId: string): Promise<AttentionReason[]> {
    const states = await this.states(em, [packId]);
    const state = states.get(packId);
    return state ? packAttentionReasons(state.items, state.provider) : [];
  }

  async recompute(em: EntityManager, afterCommit: AfterCommit | null, scope: PackHealthScope): Promise<PackHealthResult> {
    const packIds = await this.packIdsFor(em, scope);
    const result: PackHealthResult = { checked: packIds.length, nowNeedingAttention: [], resolved: [] };
    if (packIds.length === 0) return result;

    const states = await this.states(em, packIds);
    for (const [id, state] of states) {
      const reasons = packAttentionReasons(state.items, state.provider);
      const needs = reasons.length > 0;
      if (needs === state.row.needs_attention > 0) continue;
      await em.query('UPDATE packs SET needs_attention = ? WHERE id = ?', [needs ? 1 : 0, id]);
      if (!needs) {
        result.resolved.push(id);
        continue;
      }
      result.nowNeedingAttention.push(id);
      const payload: PackNeedsAttentionEvent = {
        packId: id,
        nameEn: state.row.name_en,
        nameAr: state.row.name_ar,
        reasons: reasons.map((r) => r.code),
        provider: { userId: state.row.provider_id, email: state.row.u_email, name: state.row.u_name, lang: state.row.u_lang },
      };
      if (afterCommit) this.events.emitAfterCommit(afterCommit, PACK_EVENTS.needsAttention, payload);
      else await this.events.emit(PACK_EVENTS.needsAttention, payload);
    }
    return result;
  }

  private async packIdsFor(em: EntityManager, scope: PackHealthScope): Promise<string[]> {
    const ids = new Set(scope.packIds ?? []);
    if (scope.serviceIds?.length) {
      const rows: { pack_id: string }[] = await em.query(
        'SELECT DISTINCT pi.pack_id FROM pack_items pi JOIN packs p ON p.id = pi.pack_id WHERE p.deleted_at IS NULL AND pi.service_id IN (?)',
        [scope.serviceIds],
      );
      rows.forEach((r) => ids.add(r.pack_id));
    }
    if (scope.providerIds?.length) {
      const rows: { id: string }[] = await em.query('SELECT id FROM packs WHERE deleted_at IS NULL AND provider_id IN (?)', [scope.providerIds]);
      rows.forEach((r) => ids.add(r.id));
    }
    return [...ids];
  }

  private async states(em: EntityManager, packIds: string[]): Promise<Map<string, { row: PackStateRow; items: PackItemState[]; provider: PackProviderState }>> {
    if (packIds.length === 0) return new Map();
    const [packs, items]: [PackStateRow[], { pack_id: string; service_id: string; status: ServiceStatus; deleted_at: Date | null; base_price: string }[]] = await Promise.all([
      em.query(
        `SELECT p.id, p.name_en, p.name_ar, p.needs_attention, p.provider_id, u.status AS u_status, u.verification_status AS u_verification,
                u.deleted_at AS u_deleted, u.email AS u_email, u.full_name AS u_name, u.language AS u_lang
         FROM packs p JOIN users u ON u.id = p.provider_id WHERE p.id IN (?) AND p.deleted_at IS NULL`,
        [packIds],
      ),
      em.query(
        `SELECT pi.pack_id, pi.service_id, s.status, s.deleted_at, s.base_price FROM pack_items pi JOIN services s ON s.id = pi.service_id
         WHERE pi.pack_id IN (?) ORDER BY pi.position`,
        [packIds],
      ),
    ]);
    const map = new Map<string, { row: PackStateRow; items: PackItemState[]; provider: PackProviderState }>();
    for (const row of packs) {
      map.set(row.id, {
        row,
        items: [],
        provider: { status: row.u_status, verificationStatus: row.u_verification, deleted: row.u_deleted !== null },
      });
    }
    for (const item of items) {
      map.get(item.pack_id)?.items.push({ serviceId: item.service_id, status: item.status, deleted: item.deleted_at !== null, basePrice: String(item.base_price) });
    }
    return map;
  }

  // ── account & verification events ───────────────────────────

  private async recomputeProvider(providerId: string): Promise<void> {
    try {
      await runInTransaction(this.dataSource, (em, afterCommit) => this.recompute(em, afterCommit, { providerIds: [providerId] }));
    } catch (error) {
      this.logger.error(`Pack health recompute failed for provider ${providerId}`, error instanceof Error ? error.stack : String(error));
    }
  }

  @OnEvent(USER_EVENTS.blocked)
  async onBlocked(event: UserBlockedEvent): Promise<void> {
    await this.recomputeProvider(event.userId);
  }

  @OnEvent(USER_EVENTS.unblocked)
  async onUnblocked(event: UserUnblockedEvent): Promise<void> {
    await this.recomputeProvider(event.userId);
  }

  @OnEvent(USER_EVENTS.deleted)
  async onDeleted(event: UserDeletedEvent): Promise<void> {
    await this.recomputeProvider(event.userId);
  }

  @OnEvent(VERIFICATION_EVENTS.statusChanged)
  async onVerificationChanged(event: VerificationStatusChangedEvent): Promise<void> {
    await this.recomputeProvider(event.userId);
  }
}
