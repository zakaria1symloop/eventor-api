import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { MoreThan, type DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { lockoutRetryAfterSeconds, LOCKOUT_WINDOW_MS } from '../auth/admin-auth.service.js';
import { LoginAttempt } from '../auth/entities/login-attempt.entity.js';
import { VerificationCode } from '../auth/entities/verification-code.entity.js';
import { assertPasswordStrong } from '../auth/password.policy.js';
import { PasswordService } from '../auth/password.service.js';
import { parseKeyedToken, tokenMatchesHash } from '../auth/refresh-token.js';
import { SessionsService, type IssuedSession } from '../auth/sessions.service.js';
import { TokenService } from '../auth/token.service.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { SessionAudience, VerificationCodePurpose } from '../common/enums/auth.enums.js';
import { UserRole, UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { resolveLanguage, type Lang } from '../common/i18n/language.js';
import { getRequestContext } from '../common/request-context/request-context.js';
import { envConfig, type Env } from '../config/env.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { Category } from '../catalog/entities/category.entity.js';
import { ProviderProfile } from '../users/entities/provider-profile.entity.js';
import { ProviderWilaya } from '../users/entities/provider-wilaya.entity.js';
import { User } from '../users/entities/user.entity.js';
import { initialVerificationStatus } from '../users/users.policy.js';
import { APP_AUTH_EVENTS, type AppCodeSentEvent } from './app.events.js';
import {
  AppSignupRole,
  type AppCodeSentDto,
  type AppRegisterDto,
  type AppRegisterResultDto,
  type AppSessionDto,
} from './dto/app-auth.dto.js';
import { AppMeService } from './app-me.service.js';

/** tech-decisions → Auth: 6 digits, valid 15 min, 5 tries, resend after 60 s. */
export const APP_CODE_TTL_MINUTES = 15;
export const APP_CODE_RESEND_SECONDS = 60;
export const APP_CODE_MAX_ATTEMPTS = 5;

/**
 * Codes are stored hashed with a `code:` marker, so the same
 * `verification_codes` rows can also hold the long single-use `set-password`
 * tokens an admin's invitation creates (`<id>.<secret>`, no marker).
 */
const CODE_MARKER = 'code:';

export interface AppSignedIn {
  body: AppSessionDto;
}

/** Sign-up, email verification, sign-in and password recovery for the mobile app. */
@Injectable()
export class AppAuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(envConfig.KEY) private readonly env: Env,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly me: AppMeService,
  ) {}

  // ── codes ───────────────────────────────────────────────────

  private codeHash(purpose: VerificationCodePurpose, email: string, code: string): string {
    return CODE_MARKER + createHmac('sha256', this.env.FILES_SIGNING_SECRET).update(`${purpose}:${email}:${code}`).digest('hex');
  }

  /**
   * Emails a fresh 6-digit code, invalidating the previous one. Refuses within
   * `APP_CODE_RESEND_SECONDS` of the last one (429 CODE_RESEND_TOO_SOON), on top
   * of the per-IP auth throttle.
   */
  private async issueCode(
    em: EntityManager,
    afterCommit: AfterCommit,
    input: { user: User; purpose: VerificationCodePurpose; lang: Lang },
    now: Date,
  ): Promise<AppCodeSentDto> {
    const email = input.user.email;
    const [last] = await em.query(
      "SELECT created_at FROM verification_codes WHERE destination = ? AND purpose = ? AND code_hash LIKE 'code:%' ORDER BY created_at DESC LIMIT 1",
      [email, input.purpose],
    );
    if (last) {
      const wait = Math.ceil((new Date(last.created_at).getTime() + APP_CODE_RESEND_SECONDS * 1000 - now.getTime()) / 1000);
      if (wait > 0) throw AppException.of('CODE_RESEND_TOO_SOON', { retryAfterSeconds: wait });
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + APP_CODE_TTL_MINUTES * 60_000);
    await em.query(
      "UPDATE verification_codes SET consumed_at = ? WHERE destination = ? AND purpose = ? AND consumed_at IS NULL AND code_hash LIKE 'code:%'",
      [now, email, input.purpose],
    );
    const repository = em.getRepository(VerificationCode);
    await repository.save(
      repository.create({
        userId: input.user.id,
        purpose: input.purpose,
        destination: email,
        codeHash: this.codeHash(input.purpose, email, code),
        attempts: 0,
        expiresAt,
        consumedAt: null,
        createdAt: now,
      }),
    );
    this.events.emitAfterCommit<AppCodeSentEvent>(afterCommit, APP_AUTH_EVENTS.codeSent, {
      email,
      name: input.user.fullName,
      code,
      minutes: APP_CODE_TTL_MINUTES,
      lang: input.lang,
    });
    return { email, expiresAt: expiresAt.toISOString(), resendAfterSeconds: APP_CODE_RESEND_SECONDS };
  }

  /**
   * Checks the newest live code for this email. A wrong code counts an attempt
   * (committed even though the request fails, so 5 guesses burn the code).
   * Returns the row id, which the caller consumes inside its transaction.
   */
  private async checkCode(purpose: VerificationCodePurpose, email: string, code: string, now: Date): Promise<{ id: string; userId: string }> {
    const [row] = await this.dataSource.query(
      "SELECT id, user_id, code_hash, attempts, expires_at FROM verification_codes WHERE destination = ? AND purpose = ? AND consumed_at IS NULL AND code_hash LIKE 'code:%' ORDER BY created_at DESC LIMIT 1",
      [email, purpose],
    );
    if (!row || !row.user_id) throw AppException.of('CODE_INVALID');
    if (new Date(row.expires_at).getTime() <= now.getTime() || Number(row.attempts) >= APP_CODE_MAX_ATTEMPTS) {
      throw AppException.of('CODE_EXPIRED');
    }
    const expected = Buffer.from(String(row.code_hash).slice(CODE_MARKER.length), 'hex');
    const actual = Buffer.from(this.codeHash(purpose, email, code).slice(CODE_MARKER.length), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      await this.dataSource.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
      throw AppException.of('CODE_INVALID');
    }
    return { id: row.id, userId: row.user_id };
  }

  // ── session building ────────────────────────────────────────

  private async buildSession(em: EntityManager, user: User, issued: IssuedSession, lang: Lang): Promise<AppSessionDto> {
    const accessToken = await this.tokens.signAccessToken({
      id: user.id,
      role: user.role,
      audience: SessionAudience.App,
      sessionId: issued.session.id,
    });
    return {
      accessToken,
      expiresIn: this.env.JWT_ACCESS_TTL,
      refreshToken: issued.refreshToken,
      user: await this.me.profile(user.id, lang, em),
    };
  }

  private async signIn(em: EntityManager, user: User, lang: Lang, action: string): Promise<AppSessionDto> {
    const issued = await this.sessions.create(em, { userId: user.id, audience: SessionAudience.App, remember: true });
    await this.audit.log(
      {
        actorId: user.id,
        actorRole: user.role,
        action,
        objectType: 'session',
        objectId: issued.session.id,
        objectLabel: user.email,
        level: AuditLevel.Security,
        changes: { audience: SessionAudience.App },
      },
      em,
    );
    return this.buildSession(em, user, issued, lang);
  }

  // ── register & verify ───────────────────────────────────────

  /** The code email goes out in the language chosen on the register screen, not the request header. */
  async register(dto: AppRegisterDto): Promise<AppRegisterResultDto> {
    const isProvider = dto.role === AppSignupRole.Provider;
    if (isProvider && (!dto.businessName || !dto.categoryId)) {
      throw AppException.of('PROVIDER_FIELDS_REQUIRED', { fields: ['businessName', 'categoryId'] });
    }
    if (!isProvider && (dto.businessName || dto.categoryId || dto.wilayaCodes)) {
      throw AppException.of('PROVIDER_FIELDS_NOT_ALLOWED', { fields: ['businessName', 'categoryId', 'wilayaCodes'] });
    }
    assertPasswordStrong(dto.password);

    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const users = em.getRepository(User);
      if (await users.exists({ where: { email: dto.email }, withDeleted: true })) throw AppException.of('EMAIL_TAKEN');
      if (await users.exists({ where: { phone: dto.phone }, withDeleted: true })) throw AppException.of('PHONE_TAKEN');
      if (dto.wilayaCode !== undefined) await this.assertWilaya(em, dto.wilayaCode);
      for (const code of dto.wilayaCodes ?? []) await this.assertWilaya(em, code);
      if (isProvider) {
        const category = await em.getRepository(Category).findOneBy({ id: dto.categoryId! });
        if (!category) throw AppException.of('CATEGORY_NOT_FOUND');
      }

      const user = await users.save(
        users.create({
          role: dto.role as unknown as UserRole,
          status: UserStatus.Active,
          verificationStatus: initialVerificationStatus(dto.role as unknown as UserRole, false),
          fullName: dto.fullName,
          email: dto.email,
          emailVerifiedAt: this.env.AUTH_SKIP_EMAIL_VERIFICATION ? new Date() : null,
          phone: dto.phone,
          passwordHash: await this.passwords.hash(dto.password),
          language: dto.language,
          wilayaCode: dto.wilayaCode ?? null,
        }),
      );
      if (isProvider) {
        const profile = await em.getRepository(ProviderProfile).save(
          em.getRepository(ProviderProfile).create({
            userId: user.id,
            businessName: dto.businessName!,
            categoryId: dto.categoryId!,
            acceptingBookings: true,
          }),
        );
        const codes = [...new Set(dto.wilayaCodes ?? (dto.wilayaCode ? [dto.wilayaCode] : []))];
        for (const wilayaCode of codes) {
          await em.getRepository(ProviderWilaya).save(em.getRepository(ProviderWilaya).create({ providerProfileId: profile.id, wilayaCode }));
        }
      }

      const skip = this.env.AUTH_SKIP_EMAIL_VERIFICATION;
      const sent = skip
        ? null
        : await this.issueCode(em, afterCommit, { user, purpose: VerificationCodePurpose.EmailVerify, lang: dto.language }, new Date());
      await this.audit.log(
        {
          actorId: user.id,
          actorRole: user.role,
          action: 'app.registered',
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.fullName,
          level: AuditLevel.Normal,
          changes: { role: { from: null, to: user.role }, email: { from: null, to: user.email } },
          note: 'Self sign-up from the mobile app',
        },
        em,
      );
      return {
        userId: user.id,
        emailVerificationRequired: !skip,
        emailSentTo: sent?.email ?? null,
        expiresAt: sent?.expiresAt ?? null,
        resendAfterSeconds: sent?.resendAfterSeconds ?? null,
        verificationStatus: user.verificationStatus,
        session: skip ? await this.signIn(em, user, resolveLanguage(undefined, dto.language), 'app.registered_signed_in') : null,
      };
    });
  }

  private async assertWilaya(em: EntityManager, code: number): Promise<void> {
    const [row] = await em.query('SELECT code FROM wilayas WHERE code = ?', [code]);
    if (!row) throw AppException.of('WILAYA_NOT_FOUND', { code });
  }

  async verifyEmail(email: string, code: string, lang: Lang): Promise<AppSessionDto> {
    const checked = await this.checkCode(VerificationCodePurpose.EmailVerify, email, code, new Date());
    return runInTransaction(this.dataSource, async (em) => {
      const consumed = await em.query('UPDATE verification_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [new Date(), checked.id]);
      if (Number(consumed?.affectedRows ?? 0) !== 1) throw AppException.of('CODE_INVALID');
      const user = await em.getRepository(User).findOne({ where: { id: checked.userId }, lock: { mode: 'pessimistic_write' } });
      if (!user) throw AppException.of('CODE_INVALID');
      this.assertAppAccount(user);
      if (!user.emailVerifiedAt) {
        await em.getRepository(User).update(user.id, { emailVerifiedAt: new Date() });
        user.emailVerifiedAt = new Date();
      }
      return this.signIn(em, user, resolveLanguage(undefined, lang), 'app.email_verified');
    });
  }

  async resendVerification(email: string, lang: Lang): Promise<AppCodeSentDto> {
    const user = await this.dataSource.getRepository(User).findOneBy({ email });
    // Anti-enumeration: an unknown or already verified address gets the same shape.
    if (!user || user.role === UserRole.Admin || user.status === UserStatus.Blocked || user.emailVerifiedAt) {
      return {
        email,
        expiresAt: new Date(Date.now() + APP_CODE_TTL_MINUTES * 60_000).toISOString(),
        resendAfterSeconds: APP_CODE_RESEND_SECONDS,
      };
    }
    return runInTransaction(this.dataSource, async (em, afterCommit) =>
      this.issueCode(em, afterCommit, { user, purpose: VerificationCodePurpose.EmailVerify, lang: resolveLanguage(undefined, user.language) ?? lang }, new Date()),
    );
  }

  // ── login / refresh / logout ────────────────────────────────

  private assertAppAccount(user: User): void {
    if (user.role === UserRole.Admin) throw AppException.of('ROLE_NOT_ALLOWED_IN_APP');
    if (user.status === UserStatus.Blocked) {
      throw AppException.of('ACCOUNT_BLOCKED', {
        reason: user.blockedReason,
        message: user.blockedMessage,
        blockedUntil: user.blockedUntil ? user.blockedUntil.toISOString() : null,
        // Kept as an alias of `blockedUntil` for older app builds.
        until: user.blockedUntil ? user.blockedUntil.toISOString() : null,
      });
    }
  }

  async login(email: string, password: string, lang: Lang): Promise<AppSessionDto> {
    const attempts = this.dataSource.getRepository(LoginAttempt);
    const now = new Date();
    const since = new Date(now.getTime() - LOCKOUT_WINDOW_MS);
    const lastSuccess = await attempts.findOne({ where: { email, success: true, createdAt: MoreThan(since) }, order: { createdAt: 'DESC' } });
    const failures = await attempts.find({
      where: { email, success: false, createdAt: MoreThan(lastSuccess?.createdAt ?? since) },
      order: { createdAt: 'DESC' },
      take: 5,
    });
    const retryAfter = lockoutRetryAfterSeconds(failures, now);
    if (retryAfter !== null) throw AppException.of('ACCOUNT_LOCKED', { retryAfterSeconds: retryAfter });

    const ip = getRequestContext()?.ip ?? null;
    const user = await this.dataSource.getRepository(User).findOneBy({ email });
    const valid = await this.passwords.verify(user?.passwordHash, password);
    if (!user || !valid) {
      await attempts.save(attempts.create({ email, ip, success: false, createdAt: new Date() }));
      throw AppException.of('INVALID_CREDENTIALS');
    }
    this.assertAppAccount(user);
    if (!user.emailVerifiedAt && !this.env.AUTH_SKIP_EMAIL_VERIFICATION) {
      throw AppException.of('EMAIL_NOT_VERIFIED', { email: user.email });
    }

    return runInTransaction(this.dataSource, async (em) => {
      const repository = em.getRepository(LoginAttempt);
      await repository.save(repository.create({ email, ip, success: true, createdAt: new Date() }));
      return this.signIn(em, user, lang, 'app.login');
    });
  }

  async refresh(rawToken: unknown, lang: Lang): Promise<AppSessionDto> {
    const result = await this.sessions.refresh(rawToken, SessionAudience.App);
    if (result.outcome === 'reuse_detected') {
      await this.audit.log({
        actorId: null,
        actorRole: null,
        action: 'app.refresh_reuse_detected',
        objectType: 'user',
        objectId: result.userId,
        level: AuditLevel.Security,
        note: 'A rotated refresh token was replayed; the session was revoked.',
      });
      throw AppException.of('AUTH_REFRESH_INVALID');
    }
    if (result.outcome !== 'rotated') throw AppException.of('AUTH_REFRESH_INVALID');
    if (result.user.role === UserRole.Admin) {
      await this.sessions.revoke(result.session.id);
      throw AppException.of('AUTH_REFRESH_INVALID');
    }
    if (result.user.status === UserStatus.Blocked) {
      await this.sessions.revokeAllForUser(result.user.id);
      throw new AppException(401, 'ACCOUNT_BLOCKED', {
        reason: result.user.blockedReason,
        message: result.user.blockedMessage,
        blockedUntil: result.user.blockedUntil ? result.user.blockedUntil.toISOString() : null,
        // Kept as an alias of `blockedUntil` for older app builds.
        until: result.user.blockedUntil ? result.user.blockedUntil.toISOString() : null,
      });
    }
    return this.buildSession(this.dataSource.manager, result.user, result, lang);
  }

  /** Revokes the session of the presented refresh token, or of the bearer token. Always succeeds. */
  async logout(rawRefreshToken: unknown, bearer: string | undefined): Promise<void> {
    let sessionId: string | null = null;
    let userId: string | null = null;
    const fromToken = await this.sessions.findByRefreshToken(rawRefreshToken);
    if (fromToken) {
      sessionId = fromToken.id;
      userId = fromToken.userId;
    } else if (bearer?.toLowerCase().startsWith('bearer ')) {
      try {
        const payload = await this.tokens.verifyAccessToken(bearer.slice(7));
        sessionId = payload.sid ?? null;
        userId = payload.sub;
      } catch {
        // An expired or forged token revokes nothing.
      }
    }
    if (!sessionId) return;
    const id = sessionId;
    await runInTransaction(this.dataSource, async (em) => {
      if (await this.sessions.revoke(id, em)) {
        await this.audit.log(
          { actorId: userId, actorRole: null, action: 'app.logout', objectType: 'session', objectId: id, level: AuditLevel.Info },
          em,
        );
      }
    });
  }

  // ── password recovery ───────────────────────────────────────

  /** Always 202: the response never says whether the address has an account. */
  async forgotPassword(email: string, lang: Lang): Promise<void> {
    const user = await this.dataSource.getRepository(User).findOneBy({ email });
    if (!user || user.role === UserRole.Admin || user.status === UserStatus.Blocked || !user.passwordHash) return;
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      try {
        await this.issueCode(em, afterCommit, { user, purpose: VerificationCodePurpose.PasswordReset, lang: resolveLanguage(undefined, user.language) ?? lang }, new Date());
      } catch (error) {
        // A too-soon resend must not reveal the account either.
        if (!(error instanceof AppException) || error.code !== 'CODE_RESEND_TOO_SOON') throw error;
      }
    });
  }

  /**
   * Checks a reset code **without consuming it** (screen 10a checks the code
   * before asking for the new password). A wrong code still burns an attempt,
   * so the 5-try budget covers this route too; the same code then works once
   * on `POST /app/auth/reset`.
   */
  async verifyResetCode(email: string, code: string): Promise<void> {
    await this.checkCode(VerificationCodePurpose.PasswordReset, email, code, new Date());
  }

  async resetPassword(email: string, code: string, password: string): Promise<void> {
    const checked = await this.checkCode(VerificationCodePurpose.PasswordReset, email, code, new Date());
    assertPasswordStrong(password);
    await runInTransaction(this.dataSource, async (em) => {
      const consumed = await em.query('UPDATE verification_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [new Date(), checked.id]);
      if (Number(consumed?.affectedRows ?? 0) !== 1) throw AppException.of('CODE_INVALID');
      const user = await em.getRepository(User).findOne({ where: { id: checked.userId }, lock: { mode: 'pessimistic_write' } });
      if (!user) throw AppException.of('CODE_INVALID');
      this.assertAppAccount(user);
      await em.getRepository(User).update(user.id, {
        passwordHash: await this.passwords.hash(password),
        // Receiving the code proves the address works.
        ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
      });
      const revoked = await this.sessions.revokeAllForUser(user.id, em);
      await this.audit.log(
        {
          actorId: user.id,
          actorRole: user.role,
          action: 'app.password_reset',
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

  /** The link an admin-created account receives: `${APP_PUBLIC_URL}/set-password?token=…`. */
  async setPassword(rawToken: string, password: string, lang: Lang): Promise<AppSessionDto> {
    const parsed = parseKeyedToken(rawToken);
    if (!parsed) throw AppException.of('RESET_TOKEN_INVALID');
    assertPasswordStrong(password);

    return runInTransaction(this.dataSource, async (em) => {
      const code = await em.getRepository(VerificationCode).findOne({
        where: { id: parsed.id, purpose: VerificationCodePurpose.PasswordReset },
        lock: { mode: 'pessimistic_write' },
      });
      if (!code || code.consumedAt || !code.userId || code.codeHash.startsWith(CODE_MARKER) || !tokenMatchesHash(parsed.token, code.codeHash)) {
        throw AppException.of('RESET_TOKEN_INVALID');
      }
      if (code.expiresAt.getTime() <= Date.now()) throw AppException.of('RESET_TOKEN_EXPIRED');
      const user = await em.getRepository(User).findOne({ where: { id: code.userId }, lock: { mode: 'pessimistic_write' } });
      if (!user) throw AppException.of('RESET_TOKEN_INVALID');
      this.assertAppAccount(user);

      await em.getRepository(User).update(user.id, {
        passwordHash: await this.passwords.hash(password),
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      });
      await em.getRepository(VerificationCode).update(code.id, { consumedAt: new Date() });
      await this.sessions.revokeAllForUser(user.id, em);
      user.emailVerifiedAt = user.emailVerifiedAt ?? new Date();
      return this.signIn(em, user, lang, 'app.password_set');
    });
  }

  /** Used by `GET /app/me/documents` to tell clients apart from providers. */
  static isProvider(user: { role: UserRole; verificationStatus: VerificationStatus }): boolean {
    return user.role === UserRole.Provider;
  }
}
