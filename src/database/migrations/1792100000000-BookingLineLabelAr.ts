import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BUG-O2 (24 Nov 2026): booking lines keep an Arabic label next to the English
 * one, so the Arabic app, price line and invoice show the Arabic title. Existing
 * lines are filled from the current Arabic names when their English label still
 * matches: services and pack items, extras, and the "pack price" line.
 */
export class BookingLineLabelAr1792100000000 implements MigrationInterface {
  name = 'BookingLineLabelAr1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `booking_lines` ADD `label_ar` varchar(190) NULL');
    await queryRunner.query(
      `UPDATE booking_lines bl JOIN services s ON s.id = bl.service_id
       SET bl.label_ar = NULLIF(s.title_ar, '')
       WHERE bl.kind IN ('service', 'pack_service') AND bl.label = s.title_en AND bl.label_ar IS NULL`,
    );
    await queryRunner.query(
      `UPDATE booking_lines bl JOIN service_extras x ON x.service_id = bl.service_id AND x.name_en = bl.label
       SET bl.label_ar = NULLIF(x.name_ar, '')
       WHERE bl.kind = 'extra' AND bl.label_ar IS NULL`,
    );
    await queryRunner.query(
      `UPDATE booking_lines bl JOIN bookings b ON b.id = bl.booking_id JOIN packs p ON p.id = b.pack_id
       SET bl.label_ar = CONCAT('سعر الباقة ', p.name_ar)
       WHERE bl.kind IN ('discount', 'adjustment') AND bl.label = CONCAT(p.name_en, ' pack price') AND p.name_ar <> '' AND bl.label_ar IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `booking_lines` DROP COLUMN `label_ar`');
  }
}
