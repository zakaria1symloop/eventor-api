import { SETTINGS_DEFAULTS, SETTING_KEYS } from './settings.defaults.js';
import {
  sameSettingValue,
  SETTINGS_REGISTRY,
  SETTING_SECTIONS,
  validateSettingValue,
  validateSettingValues,
} from './settings.registry.js';

const codes = (key: string, value: unknown) => {
  const result = validateSettingValue(key, value);
  return result.ok ? [] : result.errors.map((e) => `${e.field}:${e.code}`);
};

describe('settings registry', () => {
  it('describes every setting key, each in a SET-01 section', () => {
    expect(Object.keys(SETTINGS_REGISTRY).sort()).toEqual([...SETTING_KEYS].sort());
    for (const def of Object.values(SETTINGS_REGISTRY)) {
      expect(SETTING_SECTIONS).toContain(def.section);
    }
  });

  it('marks exactly the sensitive keys', () => {
    const sensitive = Object.values(SETTINGS_REGISTRY).filter((d) => d.sensitive).map((d) => d.key).sort();
    expect(sensitive).toEqual(['invoice_issuer', 'maintenance_mode', 'pack_fee_percent', 'platform_fee_percent']);
  });

  it('accepts every default value unchanged', () => {
    for (const key of SETTING_KEYS) {
      const result = validateSettingValue(key, SETTINGS_DEFAULTS[key]);
      expect(result, key).toEqual({ ok: true, value: SETTINGS_DEFAULTS[key] });
    }
  });

  it('rejects unknown keys and nulls', () => {
    expect(codes('nope', 1)).toEqual(['values.nope:SETTING_UNKNOWN']);
    expect(codes('photo_quality', null)).toEqual(['values.photo_quality:REQUIRED']);
  });

  it('checks integer type and range', () => {
    expect(codes('photo_quality', '80')).toEqual(['values.photo_quality:IS_INT']);
    expect(codes('photo_quality', 80.5)).toEqual(['values.photo_quality:IS_INT']);
    expect(codes('photo_quality', 5)).toEqual(['values.photo_quality:MIN']);
    expect(codes('photo_quality', 101)).toEqual(['values.photo_quality:MAX']);
    expect(validateSettingValue('photo_quality', 100)).toEqual({ ok: true, value: 100 });
  });

  it('checks decimals: range and at most 2 places', () => {
    expect(validateSettingValue('platform_fee_percent', 12.5)).toEqual({ ok: true, value: 12.5 });
    expect(codes('platform_fee_percent', 12.555)).toEqual(['values.platform_fee_percent:MAX_DECIMAL_PLACES']);
    expect(codes('platform_fee_percent', -1)).toEqual(['values.platform_fee_percent:MIN']);
    expect(codes('platform_fee_percent', 51)).toEqual(['values.platform_fee_percent:MAX']);
  });

  it('checks booleans strictly', () => {
    expect(codes('maintenance_mode', 'true')).toEqual(['values.maintenance_mode:IS_BOOLEAN']);
  });

  it('normalises and checks strings, emails, urls, versions and currency', () => {
    expect(validateSettingValue('support_email', '  Help@Eventor.DZ ')).toEqual({ ok: true, value: 'help@eventor.dz' });
    expect(validateSettingValue('support_email', '')).toEqual({ ok: true, value: '' });
    expect(codes('support_email', 'nope')).toEqual(['values.support_email:IS_EMAIL']);
    expect(codes('terms_url', 'ftp://x.dz')).toEqual(['values.terms_url:IS_URL']);
    expect(codes('min_app_version', '1.0')).toEqual(['values.min_app_version:IS_SEMVER']);
    expect(codes('min_app_version', '')).toEqual(['values.min_app_version:IS_NOT_EMPTY']);
    expect(codes('currency', 'dzd')).toEqual(['values.currency:IS_ISO4217']);
    expect(codes('maintenance_message_en', 'x'.repeat(501))).toEqual(['values.maintenance_message_en:MAX_LENGTH']);
  });

  it('checks enum lists and keeps canonical order', () => {
    expect(validateSettingValue('languages_required', ['ar', 'en', 'ar'])).toEqual({ ok: true, value: ['en', 'ar'] });
    expect(codes('languages_required', [])).toEqual(['values.languages_required:ARRAY_NOT_EMPTY']);
    expect(codes('allowed_image_types', ['gif'])).toEqual(['values.allowed_image_types:IS_IN']);
    expect(codes('allowed_image_types', 'jpeg')).toEqual(['values.allowed_image_types:IS_ARRAY']);
  });

  it('validates invoice_issuer with its DTO', () => {
    const issuer = { name: ' Eventor SARL ', address: 'Alger', nif: '1', rc: '2', email: 'Billing@Eventor.dz', phone: '+213555123456' };
    expect(validateSettingValue('invoice_issuer', issuer)).toEqual({
      ok: true,
      value: { ...issuer, name: 'Eventor SARL', email: 'billing@eventor.dz' },
    });
    expect(codes('invoice_issuer', { ...issuer, email: 'bad', vat: 'x' })).toEqual(
      expect.arrayContaining(['values.invoice_issuer.vat:WHITELIST_VALIDATION', 'values.invoice_issuer.email:MATCHES']),
    );
    expect(codes('invoice_issuer', { name: 'x' })).toEqual(
      expect.arrayContaining(['values.invoice_issuer.address:IS_STRING']),
    );
    expect(codes('invoice_issuer', ['x'])).toEqual(['values.invoice_issuer:IS_OBJECT']);
  });

  it('collects errors across keys', () => {
    const { values, errors } = validateSettingValues({ photo_quality: 90, review_window_days: 0, nope: 1 });
    expect(values).toEqual({ photo_quality: 90 });
    expect(errors.map((e) => e.field)).toEqual(['values.review_window_days', 'values.nope']);
  });

  it('compares JSON values deeply, ignoring key order', () => {
    expect(sameSettingValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameSettingValue(['en'], ['en', 'ar'])).toBe(false);
  });
});
