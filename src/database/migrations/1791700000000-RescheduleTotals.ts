import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BUG-E3 (24 Nov 2026): a reschedule that changes the hours of a per-hour
 * service changes its price, so each proposal records the booking total before
 * and after it. Null on rows written before this migration (unknown).
 */
export class RescheduleTotals1791700000000 implements MigrationInterface {
  name = 'RescheduleTotals1791700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `booking_reschedules` ADD `old_total` decimal(12,2) NULL, ADD `new_total` decimal(12,2) NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `booking_reschedules` DROP COLUMN `new_total`, DROP COLUMN `old_total`');
  }
}
