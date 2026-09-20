export interface InvoiceIssuer {
  name: string;
  address: string;
  nif: string;
  rc: string;
  email: string;
  phone: string;
}

/** Every platform setting with its type (docs/db-schema.md §11). */
export interface SettingsMap {
  platform_fee_percent: number;
  pack_fee_percent: number;
  currency: string;
  invoice_issuer: InvoiceIssuer;
  booking_reply_deadline_hours: number;
  booking_auto_reminder: boolean;
  booking_min_notice_days: number;
  dispute_window_hours: number;
  review_open_after_hours: number;
  review_window_days: number;
  review_edit_hours: number;
  languages_required: string[];
  max_photos_per_service: number;
  max_photos_per_pack: number;
  max_photo_upload_mb: number;
  photo_max_dimension_px: number;
  photo_quality: number;
  /** Short type names: jpeg, png, webp, heic. */
  allowed_image_types: string[];
  max_document_upload_mb: number;
  max_dispute_evidence_files: number;
  maintenance_mode: boolean;
  maintenance_message_en: string;
  maintenance_message_ar: string;
  min_app_version: string;
  support_email: string;
  support_phone: string;
  terms_url: string;
  privacy_url: string;
}

export type SettingKey = keyof SettingsMap;

/** Used when a row is missing (and as the seed values). */
export const SETTINGS_DEFAULTS: Readonly<SettingsMap> = Object.freeze({
  platform_fee_percent: 10,
  pack_fee_percent: 10,
  currency: 'DZD',
  invoice_issuer: { name: 'Eventor', address: '', nif: '', rc: '', email: '', phone: '' },
  booking_reply_deadline_hours: 48,
  booking_auto_reminder: true,
  booking_min_notice_days: 1,
  dispute_window_hours: 72,
  review_open_after_hours: 24,
  review_window_days: 60,
  review_edit_hours: 48,
  languages_required: ['en', 'ar'],
  max_photos_per_service: 12,
  max_photos_per_pack: 6,
  max_photo_upload_mb: 10,
  photo_max_dimension_px: 1920,
  photo_quality: 80,
  allowed_image_types: ['jpeg', 'png', 'webp', 'heic'],
  max_document_upload_mb: 5,
  max_dispute_evidence_files: 10,
  maintenance_mode: false,
  maintenance_message_en: '',
  maintenance_message_ar: '',
  min_app_version: '1.0.0',
  support_email: '',
  support_phone: '',
  terms_url: '',
  privacy_url: '',
});

export const SETTING_KEYS = Object.keys(SETTINGS_DEFAULTS) as SettingKey[];

export function isSettingKey(value: string): value is SettingKey {
  return Object.hasOwn(SETTINGS_DEFAULTS, value);
}
