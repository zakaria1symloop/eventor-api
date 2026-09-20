import { plainToInstance, Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, validateSync } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { flattenValidationErrors, type FieldError } from '../common/errors/validation.js';
import { SETTINGS_DEFAULTS, type SettingKey, type SettingsMap } from './settings.defaults.js';

/** SET-01 sections, in screen order. */
export const SETTING_SECTIONS = [
  'commission',
  'bookings',
  'uploads',
  'languages',
  'notifications',
  'support',
  'maintenance',
] as const;
export type SettingSection = (typeof SETTING_SECTIONS)[number];

export const SETTING_TYPES = [
  'integer',
  'decimal',
  'boolean',
  'string',
  'email',
  'url',
  'phone',
  'version',
  'enum_list',
  'object',
] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** `invoice_issuer`: the company details printed on invoices. */
export class InvoiceIssuerDto {
  @ApiProperty({ example: 'Eventor SARL', maxLength: 150 })
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  name: string;

  @ApiProperty({ example: '12 rue Didouche Mourad, Alger', maxLength: 255 })
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  address: string;

  @ApiProperty({ example: '001216099999999', maxLength: 30, description: 'NIF (tax id); empty until provided.' })
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  nif: string;

  @ApiProperty({ example: '16/00-1234567B21', maxLength: 30, description: 'RC (commercial register); empty until provided.' })
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  rc: string;

  @ApiProperty({ example: 'billing@eventor.dz', maxLength: 190 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MaxLength(190)
  @Matches(/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'email must be an email or empty' })
  email: string;

  @ApiProperty({ example: '+213555123456', maxLength: 20 })
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  @Matches(/^$|^\+?[0-9 ]{6,20}$/, { message: 'phone must be a phone number or empty' })
  phone: string;
}

export interface SettingDefinition {
  key: SettingKey;
  section: SettingSection;
  type: SettingType;
  min: number | null;
  max: number | null;
  /** Max string length, or max list size. */
  maxLength: number | null;
  /** Allowed items for `enum_list`. */
  options: readonly string[] | null;
  /** Saving a change needs `confirm: true` (SET-01 confirm dialog with old → new). */
  sensitive: boolean;
  /** Empty strings allowed (details "to be provided"). */
  allowEmpty: boolean;
}

type Def = Omit<SettingDefinition, 'key' | 'min' | 'max' | 'maxLength' | 'options' | 'allowEmpty'> &
  Partial<Pick<SettingDefinition, 'min' | 'max' | 'maxLength' | 'options' | 'allowEmpty'>>;

const int = (section: SettingSection, min: number, max: number, sensitive = false): Def => ({ section, type: 'integer', min, max, sensitive });

const DEFINITIONS: Record<SettingKey, Def> = {
  // Commission & pricing
  platform_fee_percent: { section: 'commission', type: 'decimal', min: 0, max: 50, sensitive: true },
  pack_fee_percent: { section: 'commission', type: 'decimal', min: 0, max: 50, sensitive: true },
  currency: { section: 'commission', type: 'string', maxLength: 3, sensitive: false },
  invoice_issuer: { section: 'commission', type: 'object', sensitive: true },
  // Bookings
  booking_reply_deadline_hours: int('bookings', 1, 720),
  booking_auto_reminder: { section: 'bookings', type: 'boolean', sensitive: false },
  booking_min_notice_days: int('bookings', 0, 365),
  dispute_window_hours: int('bookings', 1, 720),
  review_open_after_hours: int('bookings', 0, 720),
  review_window_days: int('bookings', 1, 365),
  review_edit_hours: int('bookings', 0, 720),
  // Photos & uploads
  max_photos_per_service: int('uploads', 1, 50),
  max_photos_per_pack: int('uploads', 1, 50),
  max_photo_upload_mb: int('uploads', 1, 50),
  photo_max_dimension_px: int('uploads', 320, 8000),
  photo_quality: int('uploads', 10, 100),
  allowed_image_types: { section: 'uploads', type: 'enum_list', options: ['jpeg', 'png', 'webp', 'heic'], maxLength: 4, sensitive: false },
  max_document_upload_mb: int('uploads', 1, 50),
  max_dispute_evidence_files: int('uploads', 1, 50),
  // Languages
  languages_required: { section: 'languages', type: 'enum_list', options: ['en', 'ar'], maxLength: 2, sensitive: false },
  // Support & legal
  support_email: { section: 'support', type: 'email', maxLength: 190, allowEmpty: true, sensitive: false },
  support_phone: { section: 'support', type: 'phone', maxLength: 20, allowEmpty: true, sensitive: false },
  terms_url: { section: 'support', type: 'url', maxLength: 500, allowEmpty: true, sensitive: false },
  privacy_url: { section: 'support', type: 'url', maxLength: 500, allowEmpty: true, sensitive: false },
  // Maintenance
  maintenance_mode: { section: 'maintenance', type: 'boolean', sensitive: true },
  maintenance_message_en: { section: 'maintenance', type: 'string', maxLength: 500, allowEmpty: true, sensitive: false },
  maintenance_message_ar: { section: 'maintenance', type: 'string', maxLength: 500, allowEmpty: true, sensitive: false },
  min_app_version: { section: 'maintenance', type: 'version', maxLength: 20, sensitive: false },
};

/** Every setting with its section, type, limits and sensitivity (SET-01). */
export const SETTINGS_REGISTRY: Readonly<Record<SettingKey, SettingDefinition>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(SETTINGS_DEFAULTS) as SettingKey[]).map((key) => {
      const def = DEFINITIONS[key];
      return [
        key,
        {
          key,
          section: def.section,
          type: def.type,
          min: def.min ?? null,
          max: def.max ?? null,
          maxLength: def.maxLength ?? null,
          options: def.options ?? null,
          sensitive: def.sensitive,
          allowEmpty: def.allowEmpty ?? false,
        },
      ];
    }),
  ) as Record<SettingKey, SettingDefinition>,
);

export type ValidationResult = { ok: true; value: unknown } | { ok: false; errors: FieldError[] };

const fail = (field: string, code: string, message: string): ValidationResult => ({
  ok: false,
  errors: [{ field, code, message }],
});

/**
 * Validates and normalises one setting value against its definition. Returns the
 * value to store (trimmed strings, decimals rounded to 2 places, lists de-duplicated)
 * or field errors named `values.<key>`.
 */
export function validateSettingValue(key: string, value: unknown): ValidationResult {
  const field = `values.${key}`;
  if (!Object.hasOwn(SETTINGS_REGISTRY, key)) {
    return fail(field, 'SETTING_UNKNOWN', `Unknown setting "${key}"`);
  }
  const def = SETTINGS_REGISTRY[key as SettingKey];
  if (value === null || value === undefined) {
    return fail(field, 'REQUIRED', `${key} must not be null`);
  }

  const range = (n: number): ValidationResult | null => {
    if (def.min !== null && n < def.min) return fail(field, 'MIN', `${key} must not be less than ${def.min}`);
    if (def.max !== null && n > def.max) return fail(field, 'MAX', `${key} must not be greater than ${def.max}`);
    return null;
  };

  switch (def.type) {
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return fail(field, 'IS_INT', `${key} must be an integer`);
      return range(value) ?? { ok: true, value };
    }
    case 'decimal': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(field, 'IS_NUMBER', `${key} must be a number`);
      if (Math.round(value * 100) !== Number((value * 100).toFixed(6))) {
        return fail(field, 'MAX_DECIMAL_PLACES', `${key} must have at most 2 decimal places`);
      }
      return range(value) ?? { ok: true, value: Math.round(value * 100) / 100 };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : fail(field, 'IS_BOOLEAN', `${key} must be a boolean`);
    case 'string':
    case 'email':
    case 'url':
    case 'phone':
    case 'version': {
      if (typeof value !== 'string') return fail(field, 'IS_STRING', `${key} must be a string`);
      let text = value.trim();
      if (def.type === 'email') text = text.toLowerCase();
      if (text === '') {
        return def.allowEmpty ? { ok: true, value: '' } : fail(field, 'IS_NOT_EMPTY', `${key} must not be empty`);
      }
      if (def.maxLength !== null && text.length > def.maxLength) {
        return fail(field, 'MAX_LENGTH', `${key} must be shorter than or equal to ${def.maxLength} characters`);
      }
      if (key === 'currency' && !/^[A-Z]{3}$/.test(text)) return fail(field, 'IS_ISO4217', `${key} must be a 3-letter currency code`);
      if (def.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return fail(field, 'IS_EMAIL', `${key} must be an email`);
      if (def.type === 'phone' && !/^\+?[0-9 ]{6,20}$/.test(text)) return fail(field, 'IS_PHONE', `${key} must be a phone number`);
      if (def.type === 'version' && !/^\d+\.\d+\.\d+$/.test(text)) return fail(field, 'IS_SEMVER', `${key} must look like 1.2.3`);
      if (def.type === 'url') {
        let ok = false;
        try {
          ok = ['http:', 'https:'].includes(new URL(text).protocol);
        } catch {
          ok = false;
        }
        if (!ok) return fail(field, 'IS_URL', `${key} must be an http(s) URL`);
      }
      return { ok: true, value: text };
    }
    case 'enum_list': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return fail(field, 'IS_ARRAY', `${key} must be an array of strings`);
      }
      const items = [...new Set(value.map((item: string) => item.trim().toLowerCase()))];
      if (items.length === 0) return fail(field, 'ARRAY_NOT_EMPTY', `${key} must contain at least 1 element`);
      const unknown = items.filter((item) => !def.options!.includes(item));
      if (unknown.length > 0) {
        return fail(field, 'IS_IN', `${key} items must be one of: ${def.options!.join(', ')}`);
      }
      // Keep the canonical option order so equal sets compare equal.
      return { ok: true, value: def.options!.filter((option) => items.includes(option)) };
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return fail(field, 'IS_OBJECT', `${key} must be an object`);
      const allowed = Object.keys(SETTINGS_DEFAULTS.invoice_issuer);
      const extra = Object.keys(value).filter((k) => !allowed.includes(k));
      const instance = plainToInstance(InvoiceIssuerDto, value);
      const errors: FieldError[] = [
        ...extra.map((k) => ({ field: `${field}.${k}`, code: 'WHITELIST_VALIDATION', message: `property ${k} should not exist` })),
        ...flattenValidationErrors(validateSync(instance, { forbidUnknownValues: false }), field),
      ];
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, value: Object.fromEntries(allowed.map((k) => [k, (instance as unknown as Record<string, string>)[k] ?? ''])) };
    }
  }
}

/** Validates a whole `values` map; collects every field error. */
export function validateSettingValues(values: Record<string, unknown>): { values: Partial<SettingsMap>; errors: FieldError[] } {
  const out: Record<string, unknown> = {};
  const errors: FieldError[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const result = validateSettingValue(key, raw);
    if (result.ok) out[key] = result.value;
    else errors.push(...result.errors);
  }
  return { values: out as Partial<SettingsMap>, errors };
}

/** Deep equality for JSON setting values. */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
