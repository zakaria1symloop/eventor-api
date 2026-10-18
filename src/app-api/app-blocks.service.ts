import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { UserRole } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import type { PaginationQueryDto } from '../common/pagination/pagination-query.dto.js';
import { FilesService } from '../files/files.service.js';
import { MESSAGING_EVENTS, type ConversationUpdatedEvent } from '../messaging/messaging.events.js';
import { avatarUrl } from './app-refs.js';
import type { AppBlockedUserDto } from './dto/app-me.dto.js';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<any>;
}

/** Who blocked whom between me and the others (one query, both directions). */
export async function blockSets(db: Queryable, me: string, others: string[]): Promise<{ byMe: Set<string>; me: Set<string> }> {
  if (others.length === 0) return { byMe: new Set(), me: new Set() };
  const rows: { blocker_id: string; blocked_id: string }[] = await db.query(
    'SELECT blocker_id, blocked_id FROM user_blocks WHERE (blocker_id = ? AND blocked_id IN (?)) OR (blocked_id = ? AND blocker_id IN (?))',
    [me, others, me, others],
  );
  return {
    byMe: new Set(rows.filter((r) => r.blocker_id === me).map((r) => r.blocked_id)),
    me: new Set(rows.filter((r) => r.blocked_id === me).map((r) => r.blocker_id)),
  };
}

/** 403 USER_BLOCKED when either side blocked the other: no chat, no new booking request. */
export async function assertNotBlocked(db: Queryable, me: string, others: string[]): Promise<void> {
  const { byMe, me: blockedMe } = await blockSets(db, me, others);
  if (byMe.size > 0 || blockedMe.size > 0) throw AppException.of('USER_BLOCKED', { blockedByMe: byMe.size > 0 });
}

/** `/app/me/blocks`: users I blocked (store guideline 1.2: report **and** block). */
@Injectable()
export class AppBlocksService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly files: FilesService,
    private readonly events: DomainEvents,
  ) {}

  /** Both sides get `conversation:updated` for their direct chat, so an open chat turns read-only (or back) at once. */
  private async announce(a: string, b: string, reason: 'blocked' | 'unblocked'): Promise<void> {
    const rows: { id: string }[] = await this.dataSource.query(
      `SELECT c.id FROM conversations c
         JOIN conversation_participants pa ON pa.conversation_id = c.id AND pa.user_id = ?
         JOIN conversation_participants pb ON pb.conversation_id = c.id AND pb.user_id = ?
        WHERE c.kind = 'direct' AND c.deleted_at IS NULL`,
      [a, b],
    );
    for (const { id } of rows) await this.events.emit<ConversationUpdatedEvent>(MESSAGING_EVENTS.conversationUpdated, { conversationId: id, reason });
  }

  private toDto(r: any): AppBlockedUserDto {
    return {
      id: r.user_id,
      name: r.business_name || r.full_name,
      avatarUrl: avatarUrl(this.files, r.avatar_file_id),
      role: r.role,
      blockedAt: new Date(r.created_at).toISOString(),
    };
  }

  private readonly selectSql = `SELECT b.blocked_id AS user_id, b.created_at, u.full_name, u.role, u.avatar_file_id, pp.business_name
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id
       LEFT JOIN provider_profiles pp ON pp.user_id = u.id AND pp.deleted_at IS NULL`;

  /** Idempotent: blocking twice answers the existing block. */
  async block(auth: AuthUser, userId: string): Promise<AppBlockedUserDto> {
    const [target] = await this.dataSource.query('SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
    if (!target) throw AppException.of('USER_NOT_FOUND');
    if (target.id === auth.id || target.role === UserRole.Admin) throw AppException.of('BLOCK_TARGET_INVALID', { userId });
    const inserted = await this.dataSource.query('INSERT IGNORE INTO user_blocks (id, created_at, blocker_id, blocked_id) VALUES (?, ?, ?, ?)', [
      crypto.randomUUID(),
      new Date(),
      auth.id,
      userId,
    ]);
    if (inserted.affectedRows) await this.announce(auth.id, userId, 'blocked');
    const [row] = await this.dataSource.query(`${this.selectSql} WHERE b.blocker_id = ? AND b.blocked_id = ?`, [auth.id, userId]);
    return this.toDto(row);
  }

  async unblock(auth: AuthUser, userId: string): Promise<void> {
    const result = await this.dataSource.query('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [auth.id, userId]);
    if (!result.affectedRows) throw AppException.of('BLOCK_NOT_FOUND');
    await this.announce(auth.id, userId, 'unblocked');
  }

  async list(auth: AuthUser, query: PaginationQueryDto): Promise<Paginated<AppBlockedUserDto>> {
    const [total] = await this.dataSource.query('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_id = ?', [auth.id]);
    const rows = await this.dataSource.query(`${this.selectSql} WHERE b.blocker_id = ? ORDER BY b.created_at DESC LIMIT ? OFFSET ?`, [
      auth.id,
      query.limit,
      (query.page - 1) * query.limit,
    ]);
    return paginate(rows.map((r: any) => this.toDto(r)), Number(total.n), query);
  }
}
