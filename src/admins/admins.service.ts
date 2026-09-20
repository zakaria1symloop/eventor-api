import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsNull, type DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { AUTH_EVENTS, type AdminInvitedEvent } from '../auth/auth.events.js';
import type { AuthUser } from '../auth/auth.types.js';
import { toAdminMe, type AdminMeDto } from '../auth/dto/admin-me.dto.js';
import { AdminInvitation } from '../auth/entities/admin-invitation.entity.js';
import { PasswordService } from '../auth/password.service.js';
import { assertPasswordStrong } from '../auth/password.policy.js';
import { hashToken, randomSecret } from '../auth/refresh-token.js';
import { SessionsService } from '../auth/sessions.service.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { SessionAudience } from '../common/enums/auth.enums.js';
import { UserRole, UserStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { User } from '../users/entities/user.entity.js';
import { assertCanRemoveAdmin, emailChangeNeedsPassword } from './admins.policy.js';
import {
  ADMIN_SORT_FIELDS,
  type AdminListItemDto,
  type AdminsQueryDto,
  type ChangePasswordDto,
  type CreateInvitationDto,
  type SessionDto,
  type UpdateMeDto,
} from './dto/admins.dto.js';

export const INVITATION_TTL_MS = 72 * 3_600_000;

/** My account (profile, password, sessions) and the admin team (list, invitations, removal). */
@Injectable()
export class AdminsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly files: FilesService,
  ) {}

  private async loadAdmin(id: string): Promise<User> {
    const user = await this.dataSource.getRepository(User).findOneBy({ id, role: UserRole.Admin });
    if (!user) throw AppException.of('ADMIN_NOT_FOUND');
    return user;
  }

  // ── me ──────────────────────────────────────────────────────

  async getMe(auth: AuthUser): Promise<AdminMeDto> {
    return toAdminMe(await this.loadAdmin(auth.id), this.files);
  }

  async updateMe(auth: AuthUser, dto: UpdateMeDto): Promise<AdminMeDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const users = em.getRepository(User);
      const user = await users.findOne({ where: { id: auth.id }, lock: { mode: 'pessimistic_write' } });
      if (!user) throw AppException.of('ADMIN_NOT_FOUND');

      const emailChanges = emailChangeNeedsPassword(user.email, dto.email);
      if (emailChanges) {
        if (!dto.currentPassword) {
          throw new AppException(400, 'VALIDATION_FAILED', [
            { field: 'currentPassword', code: 'REQUIRED', message: 'currentPassword is required to change the email' },
          ]);
        }
        if (!(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
          throw AppException.of('CURRENT_PASSWORD_INVALID');
        }
        if (await users.exists({ where: { email: dto.email }, withDeleted: true })) {
          throw AppException.of('EMAIL_TAKEN');
        }
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['fullName', 'email', 'language'] as const) {
        const next = dto[field];
        if (next !== undefined && next !== user[field]) {
          changes[field] = { from: user[field], to: next };
        }
      }
      if (Object.keys(changes).length === 0) return toAdminMe(user, this.files);

      if (dto.fullName !== undefined) user.fullName = dto.fullName;
      if (dto.language !== undefined) user.language = dto.language;
      if (emailChanges) {
        user.email = dto.email!;
        user.emailVerifiedAt = new Date();
      }
      await users.save(user);
      await this.audit.log(
        {
          action: emailChanges ? 'account.email_changed' : 'account.updated',
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.fullName,
          level: emailChanges ? AuditLevel.Security : AuditLevel.Normal,
          changes,
        },
        em,
      );
      return toAdminMe(user, this.files);
    });
  }

  async changePassword(auth: AuthUser, dto: ChangePasswordDto): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const user = await em.getRepository(User).findOne({ where: { id: auth.id }, lock: { mode: 'pessimistic_write' } });
      if (!user) throw AppException.of('ADMIN_NOT_FOUND');
      if (!(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
        throw AppException.of('CURRENT_PASSWORD_INVALID');
      }
      assertPasswordStrong(dto.newPassword);
      await em.getRepository(User).update(user.id, { passwordHash: await this.passwords.hash(dto.newPassword) });
      const revoked = await this.sessions.revokeAllForUser(user.id, em, { exceptSessionId: auth.sessionId });
      await this.audit.log(
        {
          action: 'account.password_changed',
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.fullName,
          level: AuditLevel.Security,
          changes: { otherSessionsRevoked: revoked },
        },
        em,
      );
    });
  }

  async listSessions(auth: AuthUser): Promise<SessionDto[]> {
    const sessions = await this.sessions.listActive(auth.id, SessionAudience.Dashboard);
    return sessions.map((s) => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      ip: s.ip,
      userAgent: s.userAgent,
      lastUsedAt: s.lastUsedAt ? s.lastUsedAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
      current: s.id === auth.sessionId,
    }));
  }

  async revokeSession(auth: AuthUser, sessionId: string): Promise<void> {
    const session = await this.sessions.findActiveOwned(auth.id, sessionId);
    if (!session) throw AppException.of('SESSION_NOT_FOUND');
    await runInTransaction(this.dataSource, async (em) => {
      await this.sessions.revoke(session.id, em);
      await this.audit.log(
        {
          action: 'account.session_revoked',
          objectType: 'session',
          objectId: session.id,
          objectLabel: session.deviceLabel,
          level: AuditLevel.Security,
        },
        em,
      );
    });
  }

  // ── team ────────────────────────────────────────────────────

  private invitationRow(invitation: AdminInvitation): AdminListItemDto {
    return {
      id: invitation.id,
      fullName: invitation.fullName,
      email: invitation.email,
      status: 'invited',
      lastActiveAt: null,
      invitationId: invitation.id,
      invitedAt: invitation.createdAt.toISOString(),
      expiresAt: invitation.expiresAt.toISOString(),
      isCurrentUser: false,
    };
  }

  /**
   * Admins and pending invitations in one list. The team is small (tens of
   * rows), so both sets are read with their indexes and merged in memory.
   */
  async listAdmins(auth: AuthUser, query: AdminsQueryDto): Promise<Paginated<AdminListItemDto>> {
    const order = toOrder(query.sort, ADMIN_SORT_FIELDS, ['createdAt', 'DESC']);
    const [field, direction] = Object.entries(order)[0] as [(typeof ADMIN_SORT_FIELDS)[number], 'ASC' | 'DESC'];

    const rows: (AdminListItemDto & { createdAt: string })[] = [];
    if (query.status !== 'invited') {
      const admins = await this.dataSource.getRepository(User).find({ where: { role: UserRole.Admin } });
      rows.push(
        ...admins.map((u) => ({
          id: u.id,
          fullName: u.fullName,
          email: u.email,
          status: 'active' as const,
          lastActiveAt: u.lastActiveAt ? u.lastActiveAt.toISOString() : null,
          invitationId: null,
          invitedAt: null,
          expiresAt: null,
          isCurrentUser: u.id === auth.id,
          createdAt: u.createdAt.toISOString(),
        })),
      );
    }
    if (query.status !== 'active') {
      const invitations = await this.dataSource
        .getRepository(AdminInvitation)
        .find({ where: { acceptedAt: IsNull(), revokedAt: IsNull() } });
      rows.push(...invitations.map((i) => ({ ...this.invitationRow(i), createdAt: i.createdAt.toISOString() })));
    }

    const q = query.q?.toLowerCase();
    const filtered = q ? rows.filter((r) => r.fullName.toLowerCase().includes(q) || r.email.includes(q)) : rows;
    const sign = direction === 'ASC' ? 1 : -1;
    filtered.sort((a, b) => {
      const av = a[field] ?? '';
      const bv = b[field] ?? '';
      if (av === bv) return a.id.localeCompare(b.id);
      if (!av) return 1;
      if (!bv) return -1;
      return av.localeCompare(bv) * sign;
    });

    const page = filtered
      .slice((query.page - 1) * query.limit, query.page * query.limit)
      .map(({ createdAt: _createdAt, ...row }) => row);
    return paginate(page, filtered.length, query);
  }

  private emitInvitation(afterCommit: AfterCommit, invitation: AdminInvitation, inviter: User, token: string): void {
    this.events.emitAfterCommit<AdminInvitedEvent>(afterCommit, AUTH_EVENTS.adminInvited, {
      invitationId: invitation.id,
      email: invitation.email,
      name: invitation.fullName,
      invitedBy: inviter.fullName,
      lang: inviter.language,
      token,
    });
  }

  async invite(auth: AuthUser, dto: CreateInvitationDto): Promise<AdminListItemDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const inviter = await em.getRepository(User).findOneByOrFail({ id: auth.id });
      if (await em.getRepository(User).exists({ where: { email: dto.email }, withDeleted: true })) {
        throw AppException.of('EMAIL_TAKEN');
      }
      const invitations = em.getRepository(AdminInvitation);
      const pending = await invitations.exists({
        where: { email: dto.email, acceptedAt: IsNull(), revokedAt: IsNull() },
      });
      if (pending) throw AppException.of('INVITATION_EXISTS');

      const token = randomSecret();
      const invitation = await invitations.save(
        invitations.create({
          email: dto.email,
          createdAt: new Date(),
          updatedAt: new Date(),
          fullName: dto.fullName,
          tokenHash: hashToken(token),
          invitedById: auth.id,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
          acceptedAt: null,
          revokedAt: null,
          userId: null,
        }),
      );
      await this.audit.log(
        {
          action: 'admin.invited',
          objectType: 'admin_invitation',
          objectId: invitation.id,
          objectLabel: invitation.email,
          level: AuditLevel.Security,
          changes: { fullName: { from: null, to: dto.fullName }, email: { from: null, to: dto.email } },
        },
        em,
      );
      this.emitInvitation(afterCommit, invitation, inviter, token);
      return this.invitationRow(invitation);
    });
  }

  private async lockPendingInvitation(em: import('typeorm').EntityManager, id: string): Promise<AdminInvitation> {
    const invitation = await em.getRepository(AdminInvitation).findOne({
      where: { id, acceptedAt: IsNull(), revokedAt: IsNull() },
      lock: { mode: 'pessimistic_write' },
    });
    if (!invitation) throw AppException.of('INVITATION_NOT_FOUND');
    return invitation;
  }

  async resendInvitation(auth: AuthUser, id: string): Promise<AdminListItemDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const invitation = await this.lockPendingInvitation(em, id);
      const inviter = await em.getRepository(User).findOneByOrFail({ id: auth.id });
      const token = randomSecret();
      invitation.tokenHash = hashToken(token);
      invitation.expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      await em.getRepository(AdminInvitation).save(invitation);
      await this.audit.log(
        {
          action: 'admin.invitation_resent',
          objectType: 'admin_invitation',
          objectId: invitation.id,
          objectLabel: invitation.email,
          level: AuditLevel.Normal,
        },
        em,
      );
      this.emitInvitation(afterCommit, invitation, inviter, token);
      return this.invitationRow(invitation);
    });
  }

  async revokeInvitation(_auth: AuthUser, id: string): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const invitation = await this.lockPendingInvitation(em, id);
      await em.getRepository(AdminInvitation).update(invitation.id, { revokedAt: new Date() });
      await this.audit.log(
        {
          action: 'admin.invitation_revoked',
          objectType: 'admin_invitation',
          objectId: invitation.id,
          objectLabel: invitation.email,
          level: AuditLevel.Security,
        },
        em,
      );
    });
  }

  async removeAdmin(auth: AuthUser, id: string): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const users = em.getRepository(User);
      // Lock every admin row so two removals cannot leave zero admins.
      const admins = await users.find({ where: { role: UserRole.Admin }, lock: { mode: 'pessimistic_write' } });
      const target = admins.find((a) => a.id === id);
      if (!target) throw AppException.of('ADMIN_NOT_FOUND');
      assertCanRemoveAdmin({
        actorId: auth.id,
        targetId: target.id,
        remainingActiveAdmins: admins.filter((a) => a.id !== target.id && a.status === UserStatus.Active).length,
      });
      await users.softDelete(target.id);
      const revoked = await this.sessions.revokeAllForUser(target.id, em);
      await this.audit.log(
        {
          action: 'admin.removed',
          objectType: 'user',
          objectId: target.id,
          objectLabel: target.fullName,
          level: AuditLevel.Security,
          changes: { sessionsRevoked: revoked },
        },
        em,
      );
    });
  }
}
