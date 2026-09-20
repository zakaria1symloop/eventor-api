import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { Setting } from '../src/admin/entities/setting.entity.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { SETTINGS_DEFAULTS } from '../src/settings/settings.defaults.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { createApp, expectError, loginAs, type LoggedIn, type TestApp } from './utils/index.js';

const URL = '/api/v1/admin/settings';

describe('Admin settings (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin);
  });

  afterAll(async () => {
    // Other suites share the database: put the values this suite touches back.
    const keys = ['platform_fee_percent', 'review_edit_hours', 'booking_min_notice_days', 'support_email', 'languages_required'] as const;
    for (const key of keys) {
      await t.dataSource.query('UPDATE settings SET value = CAST(? AS JSON), updated_by_id = NULL WHERE `key` = ?', [
        JSON.stringify(SETTINGS_DEFAULTS[key]),
        key,
      ]);
    }
    await t?.close();
  });

  const setting = (body: any, key: string) =>
    body.data.sections.flatMap((s: any) => s.settings).find((s: any) => s.key === key);

  describe('GET /admin/settings', () => {
    it('returns every section in order with typed values and metadata', async () => {
      const res = await request(t.http).get(URL).set(admin.headers).expect(200);
      expect(res.body.data.sections.map((s: any) => s.key)).toEqual([
        'commission',
        'bookings',
        'uploads',
        'languages',
        'notifications',
        'support',
        'maintenance',
      ]);
      const fee = setting(res.body, 'platform_fee_percent');
      expect(Object.keys(fee).sort()).toEqual(
        ['defaultValue', 'key', 'max', 'maxLength', 'min', 'options', 'sensitive', 'type', 'updatedAt', 'updatedBy', 'value'].sort(),
      );
      expect(fee).toMatchObject({ type: 'decimal', min: 0, max: 50, sensitive: true, defaultValue: 10 });
      expect(typeof fee.value).toBe('number');
      expect(fee.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(setting(res.body, 'allowed_image_types')).toMatchObject({ type: 'enum_list', options: ['jpeg', 'png', 'webp', 'heic'] });
      expect(setting(res.body, 'invoice_issuer').value).toEqual(expect.objectContaining({ name: expect.any(String), nif: expect.any(String) }));
      const total = res.body.data.sections.reduce((n: number, s: any) => n + s.settings.length, 0);
      expect(total).toBe(Object.keys(SETTINGS_DEFAULTS).length);
    });

    it('401 without a token, 403 for a provider', async () => {
      expectError(await request(t.http).get(URL), 401, 'AUTH_TOKEN_MISSING');
      const provider = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).get(URL).set(provider.headers), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('PATCH /admin/settings', () => {
    it('saves non-sensitive values, records who and when, audits and refreshes the cache', async () => {
      const settings = t.get(SettingsService);
      await settings.get('review_edit_hours'); // warm the cache
      const res = await request(t.http)
        .patch(URL)
        .set(admin.headers)
        .send({ values: { review_edit_hours: 36, support_email: ' Help@Eventor.DZ ' }, note: 'Support inbox' })
        .expect(200);

      expect(setting(res.body, 'review_edit_hours')).toMatchObject({ value: 36, updatedBy: { id: admin.user.id, fullName: admin.user.fullName } });
      expect(setting(res.body, 'support_email').value).toBe('help@eventor.dz');
      const updatedAt = new Date(setting(res.body, 'review_edit_hours').updatedAt).getTime();
      expect(Math.abs(updatedAt - Date.now())).toBeLessThan(10_000);

      const row = await t.dataSource.getRepository(Setting).findOneByOrFail({ key: 'review_edit_hours' });
      expect(row).toMatchObject({ value: 36, updatedById: admin.user.id });
      await expect(settings.get('review_edit_hours')).resolves.toBe(36);

      const audit = await t.dataSource.getRepository(AuditLog).findOneOrFail({
        where: { action: 'settings.updated', actorId: admin.user.id },
        order: { createdAt: 'DESC' },
      });
      expect(audit).toMatchObject({
        level: 'sensitive',
        objectType: 'settings',
        note: 'Support inbox',
        changes: { review_edit_hours: { from: 48, to: 36 }, support_email: { from: '', to: 'help@eventor.dz' } },
      });
    });

    it('ignores unchanged values (no audit entry)', async () => {
      const before = await t.dataSource.getRepository(AuditLog).countBy({ action: 'settings.updated' });
      await request(t.http).patch(URL).set(admin.headers).send({ values: { currency: 'DZD' } }).expect(200);
      expect(await t.dataSource.getRepository(AuditLog).countBy({ action: 'settings.updated' })).toBe(before);
    });

    it('409 SETTINGS_CONFIRM_REQUIRED with the diff for a sensitive key, then saves with confirm', async () => {
      const res = await request(t.http)
        .patch(URL)
        .set(admin.headers)
        .send({ values: { platform_fee_percent: 12.5, booking_min_notice_days: 2 } });
      expectError(res, 409, 'SETTINGS_CONFIRM_REQUIRED');
      expect(res.body.details).toEqual({
        diff: [
          { key: 'platform_fee_percent', old: 10, new: 12.5 },
          { key: 'booking_min_notice_days', old: 1, new: 2 },
        ],
        sensitiveKeys: ['platform_fee_percent'],
      });
      await expect(t.get(SettingsService).get('booking_min_notice_days')).resolves.toBe(1);

      const saved = await request(t.http)
        .patch(URL)
        .set(admin.headers)
        .send({ values: { platform_fee_percent: 12.5, booking_min_notice_days: 2 }, confirm: true })
        .expect(200);
      expect(setting(saved.body, 'platform_fee_percent').value).toBe(12.5);
      expect(setting(saved.body, 'booking_min_notice_days').value).toBe(2);
    });

    it('409 STALE_UPDATE when expectedUpdatedAt does not match', async () => {
      const current = await request(t.http).get(URL).set(admin.headers).expect(200);
      const loaded = setting(current.body, 'languages_required').updatedAt;

      await request(t.http)
        .patch(URL)
        .set(admin.headers)
        .send({ values: { languages_required: ['ar', 'en'] }, expectedUpdatedAt: { languages_required: loaded } })
        .expect(200);

      const stale = await request(t.http)
        .patch(URL)
        .set(admin.headers)
        .send({ values: { review_edit_hours: 40 }, expectedUpdatedAt: { review_edit_hours: '2020-01-01T00:00:00.000Z' } });
      expectError(stale, 409, 'STALE_UPDATE');
      expect(stale.body.details).toEqual({ keys: ['review_edit_hours'] });
    });

    it('400 VALIDATION_FAILED per key: type, range, unknown key, bad nested object, missing values', async () => {
      const res = await request(t.http)
        .patch(URL)
        .set(admin.headers)
        .send({
          values: {
            photo_quality: '80',
            review_window_days: 0,
            nope: 1,
            invoice_issuer: { name: 'Eventor', address: '', nif: '', rc: '', email: 'bad', phone: '' },
          },
        });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(res.body.details.map((d: any) => `${d.field}:${d.code}`)).toEqual(
        expect.arrayContaining([
          'values.photo_quality:IS_INT',
          'values.review_window_days:MIN',
          'values.nope:SETTING_UNKNOWN',
          'values.invoice_issuer.email:MATCHES',
        ]),
      );

      expectError(await request(t.http).patch(URL).set(admin.headers).send({}), 400, 'VALIDATION_FAILED');
      const extra = await request(t.http).patch(URL).set(admin.headers).send({ values: { photo_quality: 80 }, force: true });
      expectError(extra, 400, 'VALIDATION_FAILED');
      expect(extra.body.details[0]).toMatchObject({ field: 'force', code: 'WHITELIST_VALIDATION' });
      const empty = await request(t.http).patch(URL).set(admin.headers).send({ values: {} });
      expect(empty.body.details[0]).toMatchObject({ field: 'values', code: 'IS_NOT_EMPTY' });
    });

    it('401 without a token, 403 for a client', async () => {
      expectError(await request(t.http).patch(URL).send({ values: { photo_quality: 70 } }), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).patch(URL).set(client.headers).send({ values: { photo_quality: 70 } }), 403, 'FORBIDDEN_ROLE');
    });

    it('answers in Arabic', async () => {
      const res = await request(t.http)
        .patch(URL)
        .set(admin.headers)
        .set('Accept-Language', 'ar')
        .send({ values: { maintenance_mode: true } });
      expectError(res, 409, 'SETTINGS_CONFIRM_REQUIRED');
      expect(res.body.message).toBe('بعض هذه الإعدادات حساسة. راجع التغييرات ثم أكّد.');
    });
  });
});
