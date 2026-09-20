import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, In, type DataSource, type SelectQueryBuilder } from 'typeorm';
import { AuditLog } from '../admin/entities/audit-log.entity.js';
import { likeContains } from '../common/dto/transforms.js';
import { AppException } from '../common/errors/app.exception.js';
import { User } from '../users/entities/user.entity.js';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import {
  ACTIVITY_LOG_SORT_FIELDS,
  type ActivityLogDetailDto,
  type ActivityLogFiltersDto,
  type ActivityLogItemDto,
  type ActivityLogQueryDto,
} from './dto/activity-log.dto.js';

/** LOG-01 / LOG-02: read-only access to `audit_logs`. */
@Injectable()
export class ActivityLogService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Filtered query (actors are attached afterwards with `withActors`).
   * Index use: actorId → (actor_id, created_at); objectType/objectId →
   * (object_type, object_id, created_at); level → (level, created_at); the
   * default order uses created_at. `action`, `source` and `q` narrow those
   * scans and have no index of their own (the log is append-only and read by
   * date range; add one if a screen filters by them alone at scale).
   */
  filtered(filters: ActivityLogFiltersDto): SelectQueryBuilder<AuditLog> {
    const qb = this.dataSource
      .getRepository(AuditLog)
      .createQueryBuilder('log');

    if (filters.actorId) qb.andWhere('log.actorId = :actorId', { actorId: filters.actorId });
    if (filters.action?.length) qb.andWhere('log.action IN (:...actions)', { actions: filters.action });
    if (filters.objectType) qb.andWhere('log.objectType = :objectType', { objectType: filters.objectType });
    if (filters.objectId) qb.andWhere('log.objectId = :objectId', { objectId: filters.objectId });
    if (filters.level?.length) qb.andWhere('log.level IN (:...levels)', { levels: filters.level });
    if (filters.source?.length) qb.andWhere('log.source IN (:...sources)', { sources: filters.source });
    if (filters.from) qb.andWhere('log.createdAt >= :from', { from: new Date(filters.from) });
    if (filters.to) qb.andWhere('log.createdAt <= :to', { to: new Date(filters.to) });
    if (filters.q) {
      const like = likeContains(filters.q);
      qb.andWhere(
        new Brackets((w) =>
          w
            .where('log.action LIKE :like', { like })
            .orWhere('log.objectLabel LIKE :like')
            .orWhere('log.note LIKE :like')
            .orWhere('log.requestId LIKE :like'),
        ),
      );
    }
    return qb;
  }

  async list(query: ActivityLogQueryDto): Promise<Paginated<ActivityLogItemDto>> {
    const order = toOrder(query.sort, ACTIVITY_LOG_SORT_FIELDS, ['createdAt', 'DESC']);
    const direction = order.createdAt ?? 'DESC';
    const [rows, total] = await this.filtered(query)
      .orderBy('log.createdAt', direction)
      .addOrderBy('log.id', direction)
      .offset((query.page - 1) * query.limit)
      .limit(query.limit)
      .getManyAndCount();
    return paginate((await this.withActors(rows)).map(toItem), total, query);
  }

  /** Loads the actors of a page in one query, removed accounts included (a join would hide them). */
  async withActors(rows: AuditLog[]): Promise<AuditLog[]> {
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => !!id))];
    const actors = actorIds.length
      ? await this.dataSource.getRepository(User).find({
          where: { id: In(actorIds) },
          withDeleted: true,
          select: { id: true, fullName: true, email: true, role: true, deletedAt: true },
        })
      : [];
    const byId = new Map(actors.map((a) => [a.id, a]));
    for (const row of rows) row.actor = row.actorId ? (byId.get(row.actorId) ?? null) : null;
    return rows;
  }

  async get(id: string): Promise<ActivityLogDetailDto> {
    const row = await this.dataSource
      .getRepository(AuditLog)
      .createQueryBuilder('log')
      .where('log.id = :id', { id })
      .getOne();
    if (!row) throw AppException.of('AUDIT_LOG_NOT_FOUND');
    await this.withActors([row]);
    return {
      ...toItem(row),
      changes: row.changes,
      note: row.note,
      userAgent: row.userAgent,
      requestId: row.requestId,
      object: { type: row.objectType, id: row.objectId, label: row.objectLabel },
    };
  }
}

export function toItem(row: AuditLog): ActivityLogItemDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    objectType: row.objectType,
    objectId: row.objectId,
    objectLabel: row.objectLabel,
    level: row.level,
    source: row.source,
    actor: row.actor
      ? {
          id: row.actor.id,
          fullName: row.actor.fullName,
          email: row.actor.email,
          role: row.actor.role,
          isDeleted: row.actor.deletedAt !== null,
        }
      : null,
    actorRole: row.actorRole,
    ip: row.ip,
    hasChanges: row.changes !== null && Object.keys(row.changes).length > 0,
    hasNote: !!row.note,
  };
}
