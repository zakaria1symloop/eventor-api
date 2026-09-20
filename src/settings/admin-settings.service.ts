import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { In, type DataSource, type EntityManager } from 'typeorm';
import { Setting } from '../admin/entities/setting.entity.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import type { FieldError } from '../common/errors/validation.js';
import { runInTransaction } from '../database/transaction.js';
import { User } from '../users/entities/user.entity.js';
import type { SettingDiffDto, SettingsDto, UpdateSettingsDto } from './dto/admin-settings.dto.js';
import { SETTINGS_DEFAULTS, type SettingKey } from './settings.defaults.js';
import { sameSettingValue, SETTINGS_REGISTRY, SETTING_SECTIONS, validateSettingValues } from './settings.registry.js';
import { SettingsService } from './settings.service.js';

/** SET-01: read all settings with metadata, save a batch of changes. */
@Injectable()
export class AdminSettingsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async getAll(em: EntityManager = this.dataSource.manager): Promise<SettingsDto> {
    const rows = await em.getRepository(Setting).find();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const userIds = [...new Set(rows.map((r) => r.updatedById).filter((id): id is string => !!id))];
    const users = userIds.length
      ? await em.getRepository(User).find({ where: { id: In(userIds) }, withDeleted: true, select: { id: true, fullName: true } })
      : [];
    const names = new Map(users.map((u) => [u.id, u.fullName]));

    return {
      sections: SETTING_SECTIONS.map((section) => ({
        key: section,
        settings: Object.values(SETTINGS_REGISTRY)
          .filter((def) => def.section === section)
          .map((def) => {
            const row = byKey.get(def.key);
            const hasValue = row && row.value !== null && row.value !== undefined;
            return {
              key: def.key,
              value: hasValue ? row.value : structuredClone(SETTINGS_DEFAULTS[def.key]),
              defaultValue: structuredClone(SETTINGS_DEFAULTS[def.key]),
              type: def.type,
              min: def.min,
              max: def.max,
              maxLength: def.maxLength,
              options: def.options ? [...def.options] : null,
              sensitive: def.sensitive,
              updatedAt: row ? row.updatedAt.toISOString() : null,
              updatedBy: row?.updatedById ? { id: row.updatedById, fullName: names.get(row.updatedById) ?? '' } : null,
            };
          }),
      })),
    };
  }

  async update(auth: AuthUser, dto: UpdateSettingsDto): Promise<SettingsDto> {
    const { values, errors } = validateSettingValues(dto.values);
    const expected = dto.expectedUpdatedAt ?? {};
    for (const [key, stamp] of Object.entries(expected)) {
      if (stamp !== null && (typeof stamp !== 'string' || Number.isNaN(Date.parse(stamp)))) {
        errors.push({ field: `expectedUpdatedAt.${key}`, code: 'IS_ISO8601', message: `expectedUpdatedAt.${key} must be an ISO 8601 date or null` });
      }
    }
    if (Object.keys(dto.values).length === 0) {
      errors.push({ field: 'values', code: 'IS_NOT_EMPTY', message: 'values must contain at least one setting' });
    }
    if (errors.length > 0) throw new AppException(400, 'VALIDATION_FAILED', errors satisfies FieldError[]);

    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const keys = Object.keys(values) as SettingKey[];
      const repository = em.getRepository(Setting);
      const rows = await repository.find({ where: { key: In(keys) }, lock: { mode: 'pessimistic_write' } });
      const byKey = new Map(rows.map((row) => [row.key, row]));

      const stale = Object.entries(expected)
        .filter(([key]) => keys.includes(key as SettingKey))
        .filter(([key, stamp]) => {
          const current = byKey.get(key)?.updatedAt ?? null;
          if (stamp === null) return current !== null;
          return current === null || current.getTime() !== new Date(stamp).getTime();
        })
        .map(([key]) => key);
      if (stale.length > 0) {
        throw new AppException(409, 'STALE_UPDATE', { keys: stale });
      }

      const diff: SettingDiffDto[] = [];
      for (const key of keys) {
        const row = byKey.get(key);
        const old = row && row.value !== null && row.value !== undefined ? row.value : SETTINGS_DEFAULTS[key];
        if (!sameSettingValue(old, values[key])) diff.push({ key, old, new: values[key] });
      }
      if (diff.length === 0) return this.getAll(em);

      const sensitive = diff.filter((d) => SETTINGS_REGISTRY[d.key as SettingKey].sensitive);
      if (sensitive.length > 0 && dto.confirm !== true) {
        throw new AppException(409, 'SETTINGS_CONFIRM_REQUIRED', { diff, sensitiveKeys: sensitive.map((d) => d.key) });
      }

      const now = new Date();
      for (const change of diff) {
        await em
          .createQueryBuilder()
          .insert()
          .into(Setting)
          .values({ key: change.key, value: () => 'CAST(:json AS JSON)', updatedById: auth.id, updatedAt: now })
          .orUpdate(['value', 'updated_by_id', 'updated_at'], ['key'])
          .setParameter('json', JSON.stringify(change.new))
          .execute();
      }

      await this.audit.log(
        {
          action: 'settings.updated',
          objectType: 'settings',
          objectId: null,
          objectLabel: diff.map((d) => d.key).join(', '),
          level: AuditLevel.Sensitive,
          changes: Object.fromEntries(diff.map((d) => [d.key, { from: d.old, to: d.new }])),
          note: dto.note ?? null,
        },
        em,
      );
      afterCommit(() => this.settings.invalidate());
      return this.getAll(em);
    });
  }
}
