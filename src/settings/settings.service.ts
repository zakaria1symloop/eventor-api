import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { Setting } from '../admin/entities/setting.entity.js';
import { AppException } from '../common/errors/app.exception.js';
import {
  isSettingKey,
  SETTINGS_DEFAULTS,
  type SettingKey,
  type SettingsMap,
} from './settings.defaults.js';

/** How long values are served from memory before the table is read again. */
export const SETTINGS_CACHE_TTL_MS = 30_000;

/**
 * Typed read access to `settings`. All rows are loaded in one query and cached
 * for SETTINGS_CACHE_TTL_MS; a missing row falls back to its default. The
 * settings module (module 2) calls `invalidate()` after a write.
 */
@Injectable()
export class SettingsService {
  private cache: { values: SettingsMap; loadedAt: number } | null = null;
  private loading: Promise<SettingsMap> | null = null;

  constructor(
    @InjectRepository(Setting) private readonly repository: Repository<Setting>,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<SettingsMap[K]> {
    this.assertKey(key);
    return (await this.all())[key];
  }

  async getMany<K extends SettingKey>(keys: readonly K[]): Promise<Pick<SettingsMap, K>> {
    keys.forEach((key) => this.assertKey(key));
    const values = await this.all();
    return Object.fromEntries(keys.map((key) => [key, values[key]])) as Pick<SettingsMap, K>;
  }

  async all(): Promise<SettingsMap> {
    if (this.cache && Date.now() - this.cache.loadedAt < SETTINGS_CACHE_TTL_MS) {
      return this.cache.values;
    }
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  invalidate(): void {
    this.cache = null;
  }

  private async load(): Promise<SettingsMap> {
    const rows = await this.repository.find();
    const values = structuredClone(SETTINGS_DEFAULTS) as SettingsMap;
    for (const row of rows) {
      if (isSettingKey(row.key) && row.value !== null && row.value !== undefined) {
        (values as unknown as Record<string, unknown>)[row.key] = row.value;
      }
    }
    this.cache = { values, loadedAt: Date.now() };
    return values;
  }

  private assertKey(key: string): void {
    if (!isSettingKey(key)) {
      throw new AppException(400, 'SETTING_UNKNOWN', { key });
    }
  }
}
