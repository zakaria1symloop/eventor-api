import { Module, type OnModuleInit } from '@nestjs/common';
import type { AuditLog } from '../admin/entities/audit-log.entity.js';
import { ExportRegistry } from '../exports/export-registry.js';
import { ActivityLogService } from './activity-log.service.js';
import { AdminActivityLogController } from './admin-activity-log.controller.js';
import { ActivityLogFiltersDto } from './dto/activity-log.dto.js';

/** Module 2: LOG-01 / LOG-02 (writes go through the global AuditService). */
@Module({
  controllers: [AdminActivityLogController],
  providers: [ActivityLogService],
})
export class ActivityLogModule implements OnModuleInit {
  constructor(
    private readonly log: ActivityLogService,
    private readonly exports: ExportRegistry,
  ) {}

  onModuleInit(): void {
    this.exports.register<ActivityLogFiltersDto, AuditLog>({
      resource: 'activity-log',
      screens: 'LOG-01',
      filters: ActivityLogFiltersDto,
      columns: [
        { key: 'createdAt', header: 'Date (UTC)', value: (r) => r.createdAt },
        { key: 'actor', header: 'Actor', value: (r) => r.actor?.fullName ?? 'System' },
        { key: 'actorEmail', header: 'Actor email', value: (r) => r.actor?.email ?? null },
        { key: 'actorRole', header: 'Actor role', value: (r) => r.actorRole },
        { key: 'action', header: 'Action', value: (r) => r.action },
        { key: 'objectType', header: 'Object type', value: (r) => r.objectType },
        { key: 'objectId', header: 'Object id', value: (r) => r.objectId },
        { key: 'objectLabel', header: 'Object', value: (r) => r.objectLabel },
        { key: 'level', header: 'Level', value: (r) => r.level },
        { key: 'source', header: 'Source', value: (r) => r.source },
        { key: 'ip', header: 'IP', value: (r) => r.ip },
        { key: 'requestId', header: 'Request id', value: (r) => r.requestId },
        { key: 'changes', header: 'Changes (JSON)', value: (r) => (r.changes ? JSON.stringify(r.changes) : null) },
        { key: 'note', header: 'Note', value: (r) => r.note },
      ],
      defaultColumns: ['createdAt', 'actor', 'action', 'objectType', 'objectLabel', 'level', 'source', 'ip'],
      count: (filters) => this.log.filtered(filters).getCount(),
      fetch: async (filters, page) =>
        this.log.withActors(
          await this.log
            .filtered(filters)
            .orderBy('log.createdAt', 'DESC')
            .addOrderBy('log.id', 'DESC')
            .offset(page.offset)
            .limit(page.limit)
            .getMany(),
        ),
    });
  }
}
