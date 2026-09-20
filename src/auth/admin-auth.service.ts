import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { MoreThan, type DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { SessionAudience, VerificationCodePurpose } from '../common/enums/auth.enums.js';
import { Language, UserRole, UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { resolveLanguage } from '../common/i18n/language.js';
import { getRequestContext } from '../common/request-context/request-context.js';
import { envConfig, type Env } from '../config/env.js';
import { runInTransaction } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { User } from '../users/entities/user.entity.js';
import { AUTH_EVENTS, type PasswordResetRequestedEvent } from './auth.events.js';
import { toAdminMe } from './dto/admin-me.dto.js';
import type { AuthSessionDto, InvitationPreviewDto } from './dto/admin-auth.dto.js';
import { AdminInvitation } from './entities/admin-invitation.entity.js';
import { LoginAttempt } from './entities/login-attempt.entity.js';
import { VerificationCode } from './entities/verification-code.entity.js';
import { PasswordService } from './password.service.js';
import { assertPasswordStrong } from './password.policy.js';
import { createKeyedToken, hashToken, parseKeyedToken, tokenMatchesHash } from './refresh-token.js';
import { SessionsService, type IssuedSession } from './sessions.service.js';
import { TokenService } from './token.service.js';

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60_000;
export const RESET_TOKEN_TTL_MS = 60 * 60_000;

export interface SignedIn {
  body: AuthSessionDto;
  refreshToken: string;
  remember: boolean;
}

/** Lock state from recent failures (newest first), pure for unit tests. */
export function lockoutRetryAfterSeconds(
  failuresNewestFirst: { createdAt: Date }[],
  now = new Date(),
): number | null {
  if (failuresNewestFirst.length < LOCKOUT_MAX_FAILURES) return null;
  const until = failuresNewestFirst[0]!.createdAt.getTime() + LOCKOUT_WINDOW_MS;
  const seconds = Math.ceil((until - now.getTime()) / 1000);
  return seconds > 0 ? seconds : null;
}

/** Dashboard sign-in, refresh, logout, password reset and invitation acceptance. */
@Injectable()
export class AdminAuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(envConfig.KEY) private readonly env: Env,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly files: FilesService,
  ) {}

  async buildSession(user: User, issued: IssuedSession): Promise<SignedIn> {
    const accessToken = await this.tokens.signAccessToken({
      id: user.id,
      role: user.role,
      audience: SessionAudience.Dashboard,
      sessionId: issued.session.id,
    });
    return {
      body: { accessToken, expiresIn: this.env.JWT_ACCESS_TTL, user: toAdminMe(user, this.files) },
      refreshToken: issued.refreshToken,
      remember: issued.remember,
    };
  }

  async login(email: string, password: string, remember: boolean): Promise<SignedIn> {
    const attempts = this.dataSource.getRepository(LoginAttempt);
    const now = new Date();
    const since = new Date(now.getTime() - LOCKOUT_WINDOW_MS);

    const lastSuccess = await attempts.findOne({
      where: { email, success: true, createdAt: MoreThan(since) },
      order: { createdAt: 'DESC' },
    });
    const failures = await attempts.find({
      where: { email, success: false, createdAt: MoreThan(lastSuccess?.createdAt ?? since) },
      order: { createdAt: 'DESC' },
      take: LOCKOUT_MAX_FAILURES,
    });
    const retryAfter = lockoutRetryAfterSeconds(failures, now);
    if (retryAfter !== null) {
      throw AppException.of('ACCOUNT_LOCKED', { retryAfterSeconds: retryAfter });
    }

    const ip = getRequestContext()?.ip ?? null;
    const user = await this.dataSource.getRepository(User).findOneBy({ email });
    const valid = await this.passwords.verify(user?.passwordHash, password);
    if (!user || !valid) {
      await attempts.save(attempts.create({ email, ip, success: false, createdAt: new Date() }));
      if (failures.length + 1 >= LOCKOUT_MAX_FAILURES && user) {
        await this.audit.log({
          actorId: null,
          actorRole: null,
          action: 'auth.account_locked',
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.email,
          level: AuditLevel.Security,
          note: `${LOCKOUT_MAX_FAILURES} failed sign-in attempts`,
        });
      }
      throw AppException.of('INVALID_CREDENTIALS');
    }
    if (user.role !== UserRole.Admin) {
      throw AppException.of('FORBIDDEN_ROLE');
    }
    if (user.status === UserStatus.Blocked) {
      throw AppException.of('ACCOUNT_BLOCKED');
    }

    return runInTransaction(this.dataSource, async (em) => {
      await em.getRepository(LoginAttempt).save(em.getRepository(LoginAttempt).create({ email, ip, success: true, createdAt: new Date() }));
      const issued = await this.sessions.create(em, { userId: user.id, audience: SessionAudience.Dashboard, remember });
      await this.audit.log(
        {
          actorId: user.id,
          actorRole: user.role,
          action: 'auth.login',
          objectType: 'session',
          objectId: issued.session.id,
          objectLabel: user.email,
          level: AuditLevel.Security,
        },
        em,
      );
      return this.buildSession(user, issued);
    });
  }

  async refresh(rawToken: unknown): Promise<SignedIn> {
    const result = await this.sessions.refresh(rawToken, SessionAudience.Dashboard);
    if (result.outcome === 'reuse_detected') {
      await this.audit.log({
        actorId: null,
        actorRole: null,
        action: 'auth.refresh_reuse_detected',
        objectType: 'user',
        objectId: result.userId,
        level: AuditLevel.Security,
        note: 'A rotated refresh token was replayed; the session was revoked.',
      });
      throw AppException.of('AUTH_REFRESH_INVALID');
    }
    if (result.outcome !== 'rotated') {
      throw AppException.of('AUTH_REFRESH_INVALID');
    }
    if (result.user.role !== UserRole.Admin) {
      await this.sessions.revoke(result.session.id);
      throw AppException.of('AUTH_REFRESH_INVALID');
    }
    if (result.user.status === UserStatus.Blocked) {
      await this.sessions.revokeAllForUser(result.user.id);
      throw new AppException(401, 'ACCOUNT_BLOCKED');
    }
    return this.buildSession(result.user, result);
  }

  /** Revokes the session of the refresh cookie, or of the bearer token's `sid`. */
  async logout(rawRefreshToken: unknown, bearer: string | undefined): Promise<void> {
    let sessionId: string | null = null;
    let userId: string | null = null;
    const fromCookie = await this.sessions.findByRefreshToken(rawRefreshToken);
    if (fromCookie) {
      sessionId = fromCookie.id;
      userId = fromCookie.userId;
    } else if (bearer?.toLowerCase().startsWith('bearer ')) {
      try {
        const payload = await this.tokens.verifyAccessToken(bearer.slice(7));
        sessionId = payload.sid ?? null;
        userId = payload.sub;
      } catch {
        // An expired or forged token simply revokes nothing.
      }
    }
    if (!sessionId) return;
    await runInTransaction(this.dataSource, async (em) => {
      if (await this.sessions.revoke(sessionId, em)) {
        await this.audit.log(
          { actorId: userId, actorRole: UserRole.Admin, action: 'auth.logout', objectType: 'session', objectId: sessionId, level: AuditLevel.Info },
          em,
        );
      }
    });
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.dataSource.getRepository(User).findOneBy({ email, role: UserRole.Admin });
    if (!user || user.status === UserStatus.Blocked) return;

    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const repository = em.getRepository(VerificationCode);
      const row = repository.create({
        userId: user.id,
        purpose: VerificationCodePurpose.PasswordReset,
        createdAt: new Date(),
        destination: user.email,
        codeHash: 'pending',
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        consumedAt: null,
      });
      await repository.save(row);
      const { token, hash } = createKeyedToken(row.id);
      await repository.update(row.id, { codeHash: hash });
      await this.audit.log(
        { actorId: user.id, actorRole: user.role, action: 'auth.password_reset_requested', objectType: 'user', objectId: user.id, objectLabel: user.email, level: AuditLevel.Security },
        em,
      );
      this.events.emitAfterCommit<PasswordResetRequestedEvent>(afterCommit, AUTH_EVENTS.passwordResetRequested, {
        userId: user.id,
        email: user.email,
        name: user.fullName,
        lang: resolveLanguage(undefined, user.language),
        token,
        minutes: RESET_TOKEN_TTL_MS / 60_000,
      });
    });
  }

  async resetPassword(rawToken: string, password: string): Promise<void> {
    const parsed = parseKeyedToken(rawToken);
    if (!parsed) throw AppException.of('RESET_TOKEN_INVALID');

    await runInTransaction(this.dataSource, async (em) => {
      const code = await em.getRepository(VerificationCode).findOne({
        where: { id: parsed.id, purpose: VerificationCodePurpose.PasswordReset },
        lock: { mode: 'pessimistic_write' },
      });
      if (!code || code.consumedAt || !code.userId || !tokenMatchesHash(parsed.token, code.codeHash)) {
        throw AppException.of('RESET_TOKEN_INVALID');
      }
      if (code.expiresAt.getTime() <= Date.now()) {
        throw AppException.of('RESET_TOKEN_EXPIRED');
      }
      const user = await em.getRepository(User).findOneBy({ id: code.userId, role: UserRole.Admin });
      if (!user) throw AppException.of('RESET_TOKEN_INVALID');
      assertPasswordStrong(password);

      await em.getRepository(User).update(user.id, { passwordHash: await this.passwords.hash(password) });
      await em.getRepository(VerificationCode).update(code.id, { consumedAt: new Date() });
      const revoked = await this.sessions.revokeAllForUser(user.id, em);
      await this.audit.log(
        {
          actorId: user.id,
          actorRole: user.role,
          action: 'auth.password_reset',
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.email,
          level: AuditLevel.Security,
          changes: { sessionsRevoked: revoked },
        },
        em,
      );
    });
  }

  private async findInvitation(em: EntityManager, rawToken: string, lock = false): Promise<AdminInvitation> {
    const invitation =
      rawToken && rawToken.length <= 200
        ? await em.getRepository(AdminInvitation).findOne({
            where: { tokenHash: hashToken(rawToken) },
            ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
          })
        : null;
    if (!invitation || invitation.acceptedAt || invitation.revokedAt) {
      throw AppException.of('INVITATION_INVALID');
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw AppException.of('INVITATION_EXPIRED');
    }
    return invitation;
  }

  async previewInvitation(rawToken: string): Promise<InvitationPreviewDto> {
    const invitation = await this.findInvitation(this.dataSource.manager, rawToken);
    return { fullName: invitation.fullName, email: invitation.email, expiresAt: invitation.expiresAt.toISOString() };
  }

  async acceptInvitation(rawToken: string, password: string): Promise<SignedIn> {
    return runInTransaction(this.dataSource, async (em) => {
      const invitation = await this.findInvitation(em, rawToken, true);
      assertPasswordStrong(password);
      const taken = await em.getRepository(User).exists({ where: { email: invitation.email }, withDeleted: true });
      if (taken) throw AppException.of('EMAIL_TAKEN');

      const users = em.getRepository(User);
      const inviter = await users.findOne({ where: { id: invitation.invitedById }, withDeleted: true });
      const user = await users.save(
        users.create({
          role: UserRole.Admin,
          status: UserStatus.Active,
          verificationStatus: VerificationStatus.NotRequired,
          fullName: invitation.fullName,
          email: invitation.email,
          emailVerifiedAt: new Date(),
          passwordHash: await this.passwords.hash(password),
          language: inviter?.language ?? Language.En,
        }),
      );
      await em.getRepository(AdminInvitation).update(invitation.id, { acceptedAt: new Date(), userId: user.id });
      const issued = await this.sessions.create(em, { userId: user.id, audience: SessionAudience.Dashboard, remember: false });
      await this.audit.log(
        {
          actorId: user.id,
          actorRole: UserRole.Admin,
          action: 'admin.invitation_accepted',
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.email,
          level: AuditLevel.Security,
          changes: { invitationId: invitation.id },
        },
        em,
      );
      return this.buildSession(user, issued);
    });
  }
}

