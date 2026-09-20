import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager, Repository } from 'typeorm';
import { AuditLog } from '../admin/entities/audit-log.entity.js';
import { AuditLevel, AuditSource } from '../common/enums/admin.enums.js';
import type { UserRole } from '../common/enums/user.enums.js';
import { getRequestContext } from '../common/request-context/request-context.js';

export interface AuditEntry {
  /** Defaults to the authenticated user of the current request; null for system jobs. */
  actorId?: string | null;
  actorRole?: UserRole | null;
  /** `user.block`, `booking.status_changed`, … */
  action: string;
  objectType: string;
  objectId?: string | null;
  objectLabel?: string | null;
  level?: AuditLevel;
  /** `{ field: { from, to } }`. Never include secrets. */
  changes?: Record<string, unknown> | null;
  note?: string | null;
  /** Defaults to `dashboard` inside a request, `system` outside one. */
  source?: AuditSource;
}

/**
 * Writes the activity log. Pass the transaction's EntityManager so the entry is
 * committed or rolled back with the change it describes. Request details (ip,
 * user agent, request id, actor) are read from the request context.
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog) private readonly repository: Repository<AuditLog>,
  ) {}

  async log(entry: AuditEntry, em?: EntityManager): Promise<AuditLog> {
    const context = getRequestContext();
    const repository = em ? em.getRepository(AuditLog) : this.repository;

    const row = repository.create({
      actorId: entry.actorId !== undefined ? entry.actorId : (context?.userId ?? null),
      actorRole:
        entry.actorRole !== undefined ? entry.actorRole : (context?.userRole ?? null),
      action: entry.action,
      objectType: entry.objectType,
      objectId: entry.objectId ?? null,
      objectLabel: entry.objectLabel?.slice(0, 190) ?? null,
      level: entry.level ?? AuditLevel.Normal,
      changes: entry.changes ?? null,
      note: entry.note ?? null,
      source: entry.source ?? (context ? AuditSource.Dashboard : AuditSource.System),
      ip: context?.ip ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
    });
    return repository.save(row);
  }
}
