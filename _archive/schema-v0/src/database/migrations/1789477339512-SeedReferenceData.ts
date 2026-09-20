import type { MigrationInterface, QueryRunner } from 'typeorm';

type WilayaRow = [code: number, name: string, nameAr: string, region: string];

/** The 58 wilayas (2021 administrative division), official codes. */
const WILAYAS: WilayaRow[] = [
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

/** Default platform settings (docs/db-schema.md §10). Values are JSON. */
const SETTINGS: Record<string, unknown> = {
  platform_fee_percent: 10,
  min_fee_amount: 0,
  pack_fee_percent: 10,
  currency: 'DZD',
  booking_reply_deadline_hours: 48,
  booking_auto_reminder: true,
  booking_min_notice_days: 1,
  booking_free_cancel_days: 3,
  review_open_after_hours: 24,
  languages_required: ['ar', 'en'],
  max_photos_per_service: 12,
  max_photos_per_pack: 6,
  max_photo_upload_mb: 10,
  photo_max_dimension_px: 1920,
  photo_quality: 80,
  allowed_image_types: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  max_document_upload_mb: 10,
  maintenance_mode: false,
  maintenance_message: '',
  min_app_version: '1.0.0',
  support_email: '',
  support_phone: '',
  terms_url: '',
  privacy_url: '',
};

const SEQUENCES = ['booking', 'academic_request', 'invoice_2026'];

export class SeedReferenceData1789477339512 implements MigrationInterface {
  name = 'SeedReferenceData1789477339512';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO \`wilayas\` (\`code\`, \`name\`, \`name_ar\`, \`region\`, \`is_open\`) VALUES ${WILAYAS.map(() => '(?, ?, ?, ?, 1)').join(', ')}`,
      WILAYAS.flat(),
    );

    const keys = Object.keys(SETTINGS);
    await queryRunner.query(
      `INSERT INTO \`settings\` (\`key\`, \`value\`) VALUES ${keys.map(() => '(?, CAST(? AS JSON))').join(', ')}`,
      keys.flatMap((key) => [key, JSON.stringify(SETTINGS[key])]),
    );

    await queryRunner.query(
      `INSERT INTO \`sequences\` (\`name\`, \`value\`) VALUES ${SEQUENCES.map(() => '(?, 0)').join(', ')}`,
      SEQUENCES,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM \`sequences\` WHERE \`name\` IN (${SEQUENCES.map(() => '?').join(', ')})`,
      SEQUENCES,
    );
    const keys = Object.keys(SETTINGS);
    await queryRunner.query(
      `DELETE FROM \`settings\` WHERE \`key\` IN (${keys.map(() => '?').join(', ')})`,
      keys,
    );
    await queryRunner.query('DELETE FROM `wilayas` WHERE `code` BETWEEN 1 AND 58');
  }
}
