import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { ARGON2_OPTIONS } from '../../auth/password.service.js';

type WilayaRow = [code: number, name: string, nameAr: string, region: string];

/** The 58 wilayas (2021 administrative division): code, French name, Arabic name, region. */
export const SEED_WILAYAS: WilayaRow[] = [
  [1, 'Adrar', 'أدرار', 'south'],
  [2, 'Chlef', 'الشلف', 'north_west'],
  [3, 'Laghouat', 'الأغواط', 'highlands'],
  [4, 'Oum El Bouaghi', 'أم البواقي', 'highlands'],
  [5, 'Batna', 'باتنة', 'highlands'],
  [6, 'Béjaïa', 'بجاية', 'north_centre'],
  [7, 'Biskra', 'بسكرة', 'south'],
  [8, 'Béchar', 'بشار', 'south'],
  [9, 'Blida', 'البليدة', 'north_centre'],
  [10, 'Bouira', 'البويرة', 'north_centre'],
  [11, 'Tamanrasset', 'تمنراست', 'south'],
  [12, 'Tébessa', 'تبسة', 'highlands'],
  [13, 'Tlemcen', 'تلمسان', 'north_west'],
  [14, 'Tiaret', 'تيارت', 'highlands'],
  [15, 'Tizi Ouzou', 'تيزي وزو', 'north_centre'],
  [16, 'Alger', 'الجزائر', 'north_centre'],
  [17, 'Djelfa', 'الجلفة', 'highlands'],
  [18, 'Jijel', 'جيجل', 'north_east'],
  [19, 'Sétif', 'سطيف', 'highlands'],
  [20, 'Saïda', 'سعيدة', 'highlands'],
  [21, 'Skikda', 'سكيكدة', 'north_east'],
  [22, 'Sidi Bel Abbès', 'سيدي بلعباس', 'north_west'],
  [23, 'Annaba', 'عنابة', 'north_east'],
  [24, 'Guelma', 'قالمة', 'north_east'],
  [25, 'Constantine', 'قسنطينة', 'north_east'],
  [26, 'Médéa', 'المدية', 'north_centre'],
  [27, 'Mostaganem', 'مستغانم', 'north_west'],
  [28, "M'Sila", 'المسيلة', 'highlands'],
  [29, 'Mascara', 'معسكر', 'north_west'],
  [30, 'Ouargla', 'ورقلة', 'south'],
  [31, 'Oran', 'وهران', 'north_west'],
  [32, 'El Bayadh', 'البيض', 'highlands'],
  [33, 'Illizi', 'إليزي', 'south'],
  [34, 'Bordj Bou Arréridj', 'برج بوعريريج', 'highlands'],
  [35, 'Boumerdès', 'بومرداس', 'north_centre'],
  [36, 'El Tarf', 'الطارف', 'north_east'],
  [37, 'Tindouf', 'تندوف', 'south'],
  [38, 'Tissemsilt', 'تيسمسيلت', 'highlands'],
  [39, 'El Oued', 'الوادي', 'south'],
  [40, 'Khenchela', 'خنشلة', 'highlands'],
  [41, 'Souk Ahras', 'سوق أهراس', 'north_east'],
  [42, 'Tipaza', 'تيبازة', 'north_centre'],
  [43, 'Mila', 'ميلة', 'north_east'],
  [44, 'Aïn Defla', 'عين الدفلى', 'north_centre'],
  [45, 'Naâma', 'النعامة', 'highlands'],
  [46, 'Aïn Témouchent', 'عين تموشنت', 'north_west'],
  [47, 'Ghardaïa', 'غرداية', 'south'],
  [48, 'Relizane', 'غليزان', 'north_west'],
  [49, 'Timimoun', 'تيميمون', 'south'],
  [50, 'Bordj Badji Mokhtar', 'برج باجي مختار', 'south'],
  [51, 'Ouled Djellal', 'أولاد جلال', 'south'],
  [52, 'Béni Abbès', 'بني عباس', 'south'],
  [53, 'In Salah', 'عين صالح', 'south'],
  [54, 'In Guezzam', 'عين قزام', 'south'],
  [55, 'Touggourt', 'تقرت', 'south'],
  [56, 'Djanet', 'جانت', 'south'],
  [57, "El M'Ghair", 'المغير', 'south'],
  [58, 'El Meniaa', 'المنيعة', 'south'],
];

/**
 * Settings defaults at the time of schema v1 (docs/db-schema.md §11). A snapshot:
 * later default changes go in a new migration. The runtime fallbacks live in
 * src/settings/settings.defaults.ts (a unit test keeps both key sets equal).
 */
export const SEED_SETTINGS: Record<string, unknown> = {
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
};

function seedSequences(): string[] {
  return ['booking', 'academic_request', 'dispute', `invoice_${new Date().getUTCFullYear()}`];
}

/**
 * Reference data for schema v1: wilayas, settings, sequences and the first admin
 * (from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_NAME; skipped when
 * any is empty or the email already exists).
 */
export class SeedV11789552455600 implements MigrationInterface {
  name = 'SeedV11789552455600';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO \`wilayas\` (\`code\`, \`name\`, \`name_ar\`, \`region\`, \`is_open\`) VALUES ${SEED_WILAYAS.map(() => '(?, ?, ?, ?, 1)').join(', ')}`,
      SEED_WILAYAS.flat(),
    );

    const keys = Object.keys(SEED_SETTINGS);
    await queryRunner.query(
      `INSERT INTO \`settings\` (\`key\`, \`value\`) VALUES ${keys.map(() => '(?, CAST(? AS JSON))').join(', ')}`,
      keys.flatMap((key) => [key, JSON.stringify(SEED_SETTINGS[key])]),
    );

    const sequences = seedSequences();
    await queryRunner.query(
      `INSERT IGNORE INTO \`sequences\` (\`name\`, \`value\`) VALUES ${sequences.map(() => '(?, 0)').join(', ')}`,
      sequences,
    );

    const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD;
    const fullName = process.env.SEED_ADMIN_NAME?.trim();
    if (!email || !password || !fullName) {
      return;
    }
    const existing: unknown[] = await queryRunner.query(
      'SELECT `id` FROM `users` WHERE `email` = ?',
      [email],
    );
    if (existing.length > 0) {
      return;
    }
    const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
    await queryRunner.query(
      "INSERT INTO `users` (`id`, `role`, `status`, `verification_status`, `full_name`, `email`, `email_verified_at`, `password_hash`, `language`) VALUES (?, 'admin', 'active', 'not_required', ?, ?, UTC_TIMESTAMP(), ?, 'en')",
      [randomUUID(), fullName, email, passwordHash],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
    if (email) {
      await queryRunner.query(
        "DELETE FROM `users` WHERE `email` = ? AND `role` = 'admin'",
        [email],
      );
    }
    await queryRunner.query('DELETE FROM `sequences`');
    await queryRunner.query('DELETE FROM `settings`');
    await queryRunner.query('DELETE FROM `wilayas`');
  }
}
