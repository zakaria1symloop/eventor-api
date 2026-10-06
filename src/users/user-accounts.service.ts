import { randomInt } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { In, IsNull, LessThan, LessThanOrEqual, type DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { BookingsService } from '../bookings/bookings.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { VerificationCode } from '../auth/entities/verification-code.entity.js';
import { PasswordService } from '../auth/password.service.js';
import { createKeyedToken } from '../auth/refresh-token.js';
import { SessionsService } from '../auth/sessions.service.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { VerificationCodePurpose } from '../common/enums/auth.enums.js';
import { UserRole, UserStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import type { ErrorCode } from '../common/errors/error-codes.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { JOBS } from '../queue/jobs.js';
import { QueueService } from '../queue/queue.service.js';
import type {
  BlockImpactDto,
  BlockResultDto,
  BlockUserDto,
  BulkItemResultDto,
  BulkUsersDto,
  DeleteUserDto,
  PasswordResetDto,
  PasswordResetResultDto,
  UserDetailDto,
} from './dto/users.dto.js';
import { ProviderProfile } from './entities/provider-profile.entity.js';
import { User } from './entities/user.entity.js';
import {
  USER_EVENTS,
  type UserBlockedEvent,
  type UserDeletedEvent,
  type UserPasswordResetLinkEvent,
  type UserUnblockedEvent,
} from './users.events.js';
import {
  activeItemsBlockingDelete,
  ANONYMISE_AFTER_DAYS,
  anonymisedFields,
  bookingsToCancel,
  computeBlockImpact,
  generateTemporaryPassword,
  releasedContactFields,
  typedNameMatches,
  type BookingChoice,
} from './users.policy.js';
import { algiersToday, UsersService } from './users.service.js';

export const USER_RESET_LINK_TTL_MINUTES = 60;

interface BlockInput {
  reason: string;
  until: Date | null;
  message: string | null;
  bookings: BookingChoice;
}

interface ActionOutcome {
  impact: BlockImpactDto;
  cancelledBookings: number;
  sessionsRevoked: number;
}

/** USR-04, USR-07, USR-08, USR-09: account state changes and their jobs (auto-unblock, anonymisation). */
@Injectable()
export class UserAccountsService implements OnModuleInit {
  private readonly logger = new Logger(UserAccountsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly queue: QueueService,
    private readonly bookings: BookingsService,
  ) {}

  onModuleInit(): void {
    this.queue.registerHandler(JOBS.autoUnblockUsers, async () => {
      await this.autoUnblockExpired();
    });
    this.queue.registerHandler(JOBS.anonymiseDeletedUsers, async () => {
      await this.anonymiseDeleted();
    });
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'users.auto-unblock' })
  async scheduleAutoUnblock(): Promise<void> {
    await this.queue.add(JOBS.autoUnblockUsers, {}, { jobId: `auto-unblock-${new Date().toISOString().slice(0, 13)}` });
  }

  @Cron('0 30 2 * * *', { name: 'users.anonymise-deleted', timeZone: 'Africa/Algiers' })
  async scheduleAnonymisation(): Promise<void> {
    await this.queue.add(JOBS.anonymiseDeletedUsers, {}, { jobId: `anonymise-${new Date().toISOString().slice(0, 10)}` });
  }

  // ── impact ──────────────────────────────────────────────────

  private column(user: User): 'provider_id' | 'client_id' {
    return user.role === UserRole.Provider ? 'provider_id' : 'client_id';
  }

  async impactOf(user: User, em: EntityManager = this.dataSource.manager): Promise<BlockImpactDto> {
    const isProvider = user.role === UserRole.Provider;
    const [[services], [packs], bookings, [conversations]] = await Promise.all([
      isProvider
        ? em.query("SELECT COUNT(*) AS n FROM services WHERE provider_id = ? AND status = 'published' AND deleted_at IS NULL", [user.id])
        : [{ n: 0 }],
      isProvider ? em.query("SELECT COUNT(*) AS n FROM packs WHERE provider_id = ? AND status = 'published' AND deleted_at IS NULL", [user.id]) : [{ n: 0 }],
      em.query(
        `SELECT status, (event_date >= ?) AS upcoming, COUNT(*) AS n FROM bookings
         WHERE ${this.column(user)} = ? AND deleted_at IS NULL AND status IN ('pending', 'accepted') GROUP BY status, upcoming`,
        [algiersToday(), user.id],
      ),
      em.query(
        `SELECT COUNT(*) AS n FROM conversation_participants cp JOIN conversations c ON c.id = cp.conversation_id
         WHERE cp.user_id = ? AND c.status = 'open' AND c.deleted_at IS NULL`,
        [user.id],
      ),
    ]);
    return computeBlockImpact({
      role: user.role,
      publishedServices: Number(services.n),
      publishedPacks: Number(packs.n),
      bookings: bookings.map((b: any) => ({ status: b.status, upcoming: Number(b.upcoming) === 1, count: Number(b.n) })),
      openConversations: Number(conversations.n),
    });
  }

  async blockImpact(id: string): Promise<BlockImpactDto> {
    return this.impactOf(await this.users.load(id));
  }

  private async activeItems(user: User, em: EntityManager): Promise<{ upcomingBookings: number; openDisputes: number }> {
    const col = this.column(user);
    const [[upcoming], [disputes]] = await Promise.all([
      em.query(`SELECT COUNT(*) AS n FROM bookings WHERE ${col} = ? AND status = 'accepted' AND event_date >= ? AND deleted_at IS NULL`, [
        user.id,
        algiersToday(),
      ]),
      em.query(
        `SELECT COUNT(*) AS n FROM disputes d JOIN bookings b ON b.id = d.booking_id
         WHERE b.${col} = ? AND d.status IN ('open', 'in_review') AND d.deleted_at IS NULL`,
        [user.id],
      ),
    ]);
    return { upcomingBookings: Number(upcoming.n), openDisputes: Number(disputes.n) };
  }

  /** Cancels the user's pending bookings through BookingsService (status rows, released availability, audit, one event per booking). */
  private async cancelPendingBookings(em: EntityManager, afterCommit: AfterCommit, user: User, choice: BookingChoice, reason: string, actorId: string | null): Promise<number> {
    if (bookingsToCancel(choice, [user.id]).length === 0) return 0;
    return this.bookings.cancelPendingFor(em, afterCommit, { column: this.column(user), id: user.id, reason, actorId, causedByUserId: user.id });
  }

  // ── block / unblock ─────────────────────────────────────────

  private async blockInTransaction(em: EntityManager, afterCommit: AfterCommit, auth: AuthUser, user: User, input: BlockInput): Promise<ActionOutcome> {
    const impact = await this.impactOf(user, em);
    const now = new Date();
    await em.getRepository(User).update(user.id, {
      status: UserStatus.Blocked,
      blockedAt: now,
      blockedUntil: input.until,
      blockedReason: input.reason,
      blockedMessage: input.message,
      blockedById: auth.id,
    });
    const sessionsRevoked = await this.sessions.revokeAllForUser(user.id, em);
    const cancelledBookings = await this.cancelPendingBookings(em, afterCommit, user, input.bookings, 'account_blocked', auth.id);
    await em.query('UPDATE conversation_participants SET can_write = 0 WHERE user_id = ?', [user.id]);
    await this.audit.log(
      {
        action: 'user.blocked',
        objectType: 'user',
        objectId: user.id,
        objectLabel: user.fullName,
        level: AuditLevel.Sensitive,
        changes: {
          status: { from: UserStatus.Active, to: UserStatus.Blocked },
          reason: input.reason,
          until: input.until?.toISOString() ?? null,
          pendingBookings: input.bookings,
          impact,
          cancelledBookings,
          sessionsRevoked,
        },
        note: input.message,
      },
      em,
    );
    this.events.emitAfterCommit<UserBlockedEvent>(afterCommit, USER_EVENTS.blocked, {
      userId: user.id,
      email: user.email,
      name: user.fullName,
      lang: user.language,
      reason: input.reason,
      message: input.message,
      until: input.until?.toISOString() ?? null,
    });
    return { impact, cancelledBookings, sessionsRevoked };
  }

  private async unblockInTransaction(em: EntityManager, afterCommit: AfterCommit, user: User, automatic: boolean): Promise<void> {
    await em.getRepository(User).update(user.id, {
      status: UserStatus.Active,
      blockedAt: null,
      blockedUntil: null,
      blockedReason: null,
      blockedMessage: null,
      blockedById: null,
    });
    await em.query(
      `UPDATE conversation_participants cp JOIN conversations c ON c.id = cp.conversation_id
       SET cp.can_write = 1 WHERE cp.user_id = ? AND c.status = 'open'`,
      [user.id],
    );
    await this.audit.log(
      {
        ...(automatic ? { actorId: null, actorRole: null } : {}),
        action: 'user.unblocked',
        objectType: 'user',
        objectId: user.id,
        objectLabel: user.fullName,
        level: AuditLevel.Sensitive,
        changes: {
          status: { from: UserStatus.Blocked, to: UserStatus.Active },
          blockedReason: user.blockedReason,
          blockedUntil: user.blockedUntil?.toISOString() ?? null,
        },
        note: automatic ? 'Block period ended' : null,
      },
      em,
    );
    this.events.emitAfterCommit<UserUnblockedEvent>(afterCommit, USER_EVENTS.unblocked, {
      userId: user.id,
      email: user.email,
      name: user.fullName,
      lang: user.language,
      automatic,
    });
  }

  private blockInput(dto: { reason?: string; until?: string | null; message?: string | null; bookings?: BookingChoice }): BlockInput {
    const until = dto.until ? new Date(dto.until) : null;
    if (until && until.getTime() <= Date.now()) {
      throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'until', code: 'MIN_DATE', message: 'until must be in the future' }]);
    }
    return { reason: dto.reason!, until, message: dto.message ?? null, bookings: dto.bookings! };
  }

  async block(auth: AuthUser, id: string, dto: BlockUserDto): Promise<BlockResultDto> {
    const input = this.blockInput(dto);
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const user = await this.users.load(id, em, true);
      if (user.status === UserStatus.Blocked) throw AppException.of('USER_ALREADY_BLOCKED');
      const outcome = await this.blockInTransaction(em, afterCommit, auth, user, input);
      return { user: await this.users.row(id, em), ...outcome };
    });
  }

  async unblock(auth: AuthUser, id: string): Promise<UserDetailDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const user = await this.users.load(id, em, true);
      if (user.status !== UserStatus.Blocked) throw AppException.of('USER_NOT_BLOCKED');
      await this.unblockInTransaction(em, afterCommit, user, false);
    });
    return this.users.get(id, auth);
  }

  /** Job: unblocks accounts whose `blocked_until` has passed. Idempotent. */
  async autoUnblockExpired(now = new Date()): Promise<number> {
    const due = await this.dataSource.getRepository(User).find({
      where: { status: UserStatus.Blocked, blockedUntil: LessThanOrEqual(now) },
      select: { id: true },
    });
    let done = 0;
    for (const { id } of due) {
      await runInTransaction(this.dataSource, async (em, afterCommit) => {
        const user = await em.getRepository(User).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!user || user.status !== UserStatus.Blocked || !user.blockedUntil || user.blockedUntil > now) return;
        await this.unblockInTransaction(em, afterCommit, user, true);
        done += 1;
      });
    }
    if (done > 0) this.logger.log(`Auto-unblocked ${done} account(s)`);
    return done;
  }

  // ── delete ──────────────────────────────────────────────────

  private async deleteInTransaction(em: EntityManager, afterCommit: AfterCommit, auth: AuthUser, user: User): Promise<ActionOutcome> {
    const impact = await this.impactOf(user, em);
    const cancelledBookings = await this.cancelPendingBookings(em, afterCommit, user, 'cancel', 'account_deleted', auth.id);
    const sessionsRevoked = await this.sessions.revokeAllForUser(user.id, em);
    await em.query('UPDATE conversation_participants SET can_write = 0 WHERE user_id = ?', [user.id]);
    await em.getRepository(User).update(user.id, releasedContactFields(user.id));
    await em.getRepository(User).softDelete(user.id);
    const anonymiseAfter = new Date(Date.now() + ANONYMISE_AFTER_DAYS * 86_400_000);
    await this.audit.log(
      {
        action: 'user.deleted',
        objectType: 'user',
        objectId: user.id,
        objectLabel: user.fullName,
        level: AuditLevel.Sensitive,
        changes: { mode: 'anonymise', anonymiseAfter: anonymiseAfter.toISOString(), cancelledBookings, sessionsRevoked },
      },
      em,
    );
    this.events.emitAfterCommit<UserDeletedEvent>(afterCommit, USER_EVENTS.deleted, { userId: user.id });
    return { impact, cancelledBookings, sessionsRevoked };
  }

  /**
   * `DELETE /app/me`: the account closes itself. The same guards as the admin
   * route below — upcoming bookings or an open dispute refuse it — except that
   * the confirmation is the account's own password, checked by the caller,
   * rather than typing the name back.
   */
  async removeSelf(auth: AuthUser, user: User): Promise<void> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const locked = await this.users.load(user.id, em, true);
      const blocking = activeItemsBlockingDelete(await this.activeItems(locked, em));
      if (blocking) throw AppException.of('ACCOUNT_HAS_ACTIVE_ITEMS', blocking);
      await this.deleteInTransaction(em, afterCommit, auth, locked);
    });
  }

  async remove(auth: AuthUser, id: string, dto: DeleteUserDto): Promise<void> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const user = await this.users.load(id, em, true);
      if (!typedNameMatches(dto.typedName, user.fullName)) throw AppException.of('TYPED_NAME_MISMATCH');
      const blocking = activeItemsBlockingDelete(await this.activeItems(user, em));
      if (blocking) throw AppException.of('ACCOUNT_HAS_ACTIVE_ITEMS', blocking);
      await this.deleteInTransaction(em, afterCommit, auth, user);
    });
  }

  /** Job: replaces personal data of accounts deleted more than 30 days ago. Idempotent. */
  async anonymiseDeleted(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - ANONYMISE_AFTER_DAYS * 86_400_000);
    const due = await this.dataSource.getRepository(User).find({
      where: { deletedAt: LessThan(cutoff), anonymisedAt: IsNull(), role: In([UserRole.Client, UserRole.Provider]) },
      withDeleted: true,
      select: { id: true, fullName: true },
    });
    for (const { id, fullName } of due) {
      await runInTransaction(this.dataSource, async (em) => {
        await em.getRepository(User).update(id, { ...anonymisedFields(id), anonymisedAt: now });
        await em
          .getRepository(ProviderProfile)
          .update({ userId: id }, { businessName: 'Deleted provider', bioEn: null, bioAr: null, languagesSpoken: null });
        await em.query('DELETE FROM verification_codes WHERE user_id = ?', [id]);
        await this.audit.log(
          {
            actorId: null,
            actorRole: null,
            action: 'user.anonymised',
            objectType: 'user',
            objectId: id,
            objectLabel: `Deleted user (was ${fullName.slice(0, 1)}…)`,
            level: AuditLevel.Sensitive,
          },
          em,
        );
      });
    }
    if (due.length > 0) this.logger.log(`Anonymised ${due.length} deleted account(s)`);
    return due.length;
  }

  // ── password & sessions ─────────────────────────────────────

  async passwordReset(auth: AuthUser, id: string, dto: PasswordResetDto): Promise<PasswordResetResultDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const user = await this.users.load(id, em, true);
      let temporaryPassword: string | null = null;
      if (dto.mode === 'temporary') {
        temporaryPassword = generateTemporaryPassword((max) => randomInt(max));
        await em.getRepository(User).update(user.id, { passwordHash: await this.passwords.hash(temporaryPassword) });
      } else {
        const codes = em.getRepository(VerificationCode);
        const code = await codes.save(
          codes.create({
            userId: user.id,
            purpose: VerificationCodePurpose.PasswordReset,
            createdAt: new Date(),
            destination: user.email,
            codeHash: 'pending',
            expiresAt: new Date(Date.now() + USER_RESET_LINK_TTL_MINUTES * 60_000),
            consumedAt: null,
          }),
        );
        const { token, hash } = createKeyedToken(code.id);
        await codes.update(code.id, { codeHash: hash });
        this.events.emitAfterCommit<UserPasswordResetLinkEvent>(afterCommit, USER_EVENTS.passwordResetLinkSent, {
          userId: user.id,
          email: user.email,
          name: user.fullName,
          lang: user.language,
          token,
          minutes: USER_RESET_LINK_TTL_MINUTES,
        });
      }
      const sessionsRevoked = dto.signOutEverywhere ? await this.sessions.revokeAllForUser(user.id, em) : 0;
      await this.audit.log(
        {
          action: dto.mode === 'temporary' ? 'user.temporary_password_set' : 'user.password_reset_link_sent',
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.fullName,
          level: AuditLevel.Security,
          changes: { mode: dto.mode, signOutEverywhere: dto.signOutEverywhere ?? false, sessionsRevoked },
        },
        em,
      );
      return { mode: dto.mode, temporaryPassword, sessionsRevoked };
    });
  }

  async revokeSessions(auth: AuthUser, id: string): Promise<{ sessionsRevoked: number }> {
    return runInTransaction(this.dataSource, async (em) => {
      const user = await this.users.load(id, em, true);
      const sessionsRevoked = await this.sessions.revokeAllForUser(user.id, em);
      await this.audit.log(
        {
          action: 'user.sessions_revoked',
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.fullName,
          level: AuditLevel.Security,
          changes: { sessionsRevoked },
        },
        em,
      );
      return { sessionsRevoked };
    });
  }

  // ── bulk ────────────────────────────────────────────────────

  /** All-or-nothing: every id is checked first; one refusal changes nothing (409 BULK_ACTION_REFUSED with the refusals). */
  async bulk(auth: AuthUser, dto: BulkUsersDto): Promise<BulkItemResultDto[]> {
    const input = dto.action === 'block' ? this.blockInput(dto) : null;
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const found = await em.getRepository(User).find({
        where: { id: In(dto.ids), role: In([UserRole.Client, UserRole.Provider]) },
        lock: { mode: 'pessimistic_write' },
      });
      const byId = new Map(found.map((u) => [u.id, u]));
      const refused: { id: string; code: ErrorCode; details?: unknown }[] = [];
      for (const id of dto.ids) {
        const user = byId.get(id);
        if (!user) refused.push({ id, code: 'USER_NOT_FOUND' });
        else if (dto.action === 'block' && user.status === UserStatus.Blocked) refused.push({ id, code: 'USER_ALREADY_BLOCKED' });
        else if (dto.action === 'unblock' && user.status !== UserStatus.Blocked) refused.push({ id, code: 'USER_NOT_BLOCKED' });
        else if (dto.action === 'delete') {
          const blocking = activeItemsBlockingDelete(await this.activeItems(user, em));
          if (blocking) refused.push({ id, code: 'ACCOUNT_HAS_ACTIVE_ITEMS', details: blocking });
        }
      }
      if (refused.length > 0) {
        throw AppException.of('BULK_ACTION_REFUSED', { refusedCount: refused.length, refused });
      }

      const results: BulkItemResultDto[] = [];
      for (const id of dto.ids) {
        const user = byId.get(id)!;
        if (dto.action === 'block') {
          const outcome = await this.blockInTransaction(em, afterCommit, auth, user, input!);
          results.push({ id, result: 'ok', cancelledBookings: outcome.cancelledBookings, sessionsRevoked: outcome.sessionsRevoked });
        } else if (dto.action === 'unblock') {
          await this.unblockInTransaction(em, afterCommit, user, false);
          results.push({ id, result: 'ok', cancelledBookings: 0, sessionsRevoked: 0 });
        } else {
          const outcome = await this.deleteInTransaction(em, afterCommit, auth, user);
          results.push({ id, result: 'ok', cancelledBookings: outcome.cancelledBookings, sessionsRevoked: outcome.sessionsRevoked });
        }
      }
      return results;
    });
  }
}

