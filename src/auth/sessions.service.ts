import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsNull, MoreThan, Not, type DataSource, type EntityManager } from 'typeorm';
import { SessionAudience } from '../common/enums/auth.enums.js';
import { getRequestContext } from '../common/request-context/request-context.js';
import { User } from '../users/entities/user.entity.js';
import { Session } from './entities/session.entity.js';
import { REMEMBER_TTL_MS, SESSION_TTL_MS } from './refresh-cookie.js';
import {
  createRefreshToken,
  decideRotation,
  deviceLabel,
  parseRefreshToken,
  type RotationDecision,
} from './refresh-token.js';

export interface IssuedSession {
  session: Session;
  refreshToken: string;
  remember: boolean;
}

export type RefreshOutcome =
  | ({ outcome: 'rotated'; user: User } & IssuedSession)
  | { outcome: Exclude<RotationDecision, 'rotate'>; userId: string | null };

/** Sessions (one row per sign-in) and refresh token rotation. */
@Injectable()
export class SessionsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async create(
    em: EntityManager,
    input: { userId: string; audience: SessionAudience; remember: boolean },
  ): Promise<IssuedSession> {
    const context = getRequestContext();
    const repository = em.getRepository(Session);
    const id = randomUUID();
    const { token, hash } = createRefreshToken(id, input.remember);
    const session = repository.create({
      id,
      createdAt: new Date(),
      userId: input.userId,
      audience: input.audience,
      tokenHash: hash,
      deviceLabel: deviceLabel(context?.userAgent),
      ip: context?.ip ?? null,
      userAgent: context?.userAgent ?? null,
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + (input.remember ? REMEMBER_TTL_MS : SESSION_TTL_MS)),
      revokedAt: null,
    });
    await repository.save(session);
    return { session, refreshToken: token, remember: input.remember };
  }

  /** Rotates a refresh token; replaying an old one revokes its session. */
  async refresh(rawToken: unknown, audience: SessionAudience): Promise<RefreshOutcome> {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) return { outcome: 'invalid', userId: null };

    return this.dataSource.transaction(async (em) => {
      const session = await em.getRepository(Session).findOne({
        where: { id: parsed.sessionId, audience },
        lock: { mode: 'pessimistic_write' },
      });
      const decision = decideRotation(session, parsed.token);
      if (!session || decision === 'invalid') {
        return { outcome: 'invalid' as const, userId: session?.userId ?? null };
      }
      if (decision === 'reuse_detected') {
        await em.getRepository(Session).update(session.id, { revokedAt: new Date() });
        return { outcome: 'reuse_detected' as const, userId: session.userId };
      }

      const user = await em.getRepository(User).findOneBy({ id: session.userId });
      if (!user) {
        await em.getRepository(Session).update(session.id, { revokedAt: new Date() });
        return { outcome: 'invalid' as const, userId: null };
      }
      const { token, hash } = createRefreshToken(session.id, parsed.remember);
      const context = getRequestContext();
      const changes: Partial<Session> = {
        tokenHash: hash,
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + (parsed.remember ? REMEMBER_TTL_MS : SESSION_TTL_MS)),
        ip: context?.ip ?? session.ip,
      };
      await em.getRepository(Session).update(session.id, changes);
      Object.assign(session, changes);
      return { outcome: 'rotated' as const, user, session, refreshToken: token, remember: parsed.remember };
    });
  }

  /** The session a refresh cookie points at, if the cookie is genuine. */
  async findByRefreshToken(rawToken: unknown): Promise<Session | null> {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) return null;
    const session = await this.dataSource.getRepository(Session).findOneBy({ id: parsed.sessionId });
    return session && decideRotation(session, parsed.token) === 'rotate' ? session : null;
  }

  async revoke(sessionId: string, em: EntityManager = this.dataSource.manager): Promise<boolean> {
    const result = await em
      .getRepository(Session)
      .update({ id: sessionId, revokedAt: IsNull() }, { revokedAt: new Date() });
    return (result.affected ?? 0) > 0;
  }

  async revokeAllForUser(
    userId: string,
    em: EntityManager = this.dataSource.manager,
    options: { exceptSessionId?: string | null } = {},
  ): Promise<number> {
    const result = await em.getRepository(Session).update(
      {
        userId,
        revokedAt: IsNull(),
        ...(options.exceptSessionId ? { id: Not(options.exceptSessionId) } : {}),
      },
      { revokedAt: new Date() },
    );
    return result.affected ?? 0;
  }

  listActive(userId: string, audience: SessionAudience): Promise<Session[]> {
    return this.dataSource.getRepository(Session).find({
      where: { userId, audience, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      order: { lastUsedAt: 'DESC', createdAt: 'DESC' },
    });
  }

  findActiveOwned(userId: string, sessionId: string): Promise<Session | null> {
    return this.dataSource.getRepository(Session).findOneBy({
      id: sessionId,
      userId,
      revokedAt: IsNull(),
      expiresAt: MoreThan(new Date()),
    });
  }
}
