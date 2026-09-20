import type { Repository } from 'typeorm';
import type { Setting } from '../admin/entities/setting.entity.js';
import { SEED_SETTINGS } from '../database/migrations/1789552455600-SeedV1.js';
import { AppException } from '../common/errors/app.exception.js';
import { SETTINGS_DEFAULTS, SETTING_KEYS } from './settings.defaults.js';
import { SettingsService } from './settings.service.js';

function serviceWith(rows: Partial<Setting>[]) {
  const find = vi.fn(async () => rows as Setting[]);
  return { service: new SettingsService({ find } as unknown as Repository<Setting>), find };
}

describe('SettingsService', () => {
  it('matches the db-schema §11 defaults', () => {
    expect(SETTINGS_DEFAULTS).toMatchObject({
      platform_fee_percent: 10,
      currency: 'DZD',
      booking_reply_deadline_hours: 48,
      dispute_window_hours: 72,
      review_window_days: 60,
      max_photo_upload_mb: 10,
      photo_max_dimension_px: 1920,
      photo_quality: 80,
      max_document_upload_mb: 5,
      languages_required: ['en', 'ar'],
      min_app_version: '1.0.0',
    });
  });

  it('seeds exactly the keys the service knows, with the same values', () => {
    expect(Object.keys(SEED_SETTINGS).sort()).toEqual([...SETTING_KEYS].sort());
    expect(SEED_SETTINGS).toEqual(SETTINGS_DEFAULTS);
  });

  it('falls back to defaults for missing rows and ignores unknown keys', async () => {
    const { service } = serviceWith([
      { key: 'platform_fee_percent', value: 12.5 },
      { key: 'legacy_key', value: 'x' },
    ]);
    await expect(service.get('platform_fee_percent')).resolves.toBe(12.5);
    await expect(service.get('pack_fee_percent')).resolves.toBe(10);
    await expect(service.getMany(['currency', 'maintenance_mode'])).resolves.toEqual({
      currency: 'DZD',
      maintenance_mode: false,
    });
    expect((await service.all()) as unknown as Record<string, unknown>).not.toHaveProperty('legacy_key');
  });

  it('caches values and reloads after invalidate()', async () => {
    const { service, find } = serviceWith([]);
    await Promise.all([service.get('currency'), service.get('photo_quality')]);
    await service.get('currency');
    expect(find).toHaveBeenCalledTimes(1);
    service.invalidate();
    await service.get('currency');
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('never lets callers mutate the shared defaults', async () => {
    const { service } = serviceWith([]);
    (await service.get('languages_required')).push('fr');
    expect(SETTINGS_DEFAULTS.languages_required).toEqual(['en', 'ar']);
  });

  it('rejects unknown keys', async () => {
    const { service } = serviceWith([]);
    await expect(service.get('nope' as never)).rejects.toBeInstanceOf(AppException);
  });
});
