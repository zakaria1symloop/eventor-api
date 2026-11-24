import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BUG-G2 (24 Nov 2026): booking system messages carry a structured part — the
 * event (`booking_accepted`, `reschedule_proposed`…) and its data (booking id,
 * reference, dates, titles, who acted) — so the app can open the booking and
 * render the text in the reader's language. Older messages keep them null and
 * show their stored English body as before.
 */
export class SystemMessageEvents1791900000000 implements MigrationInterface {
  name = 'SystemMessageEvents1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `messages` ADD `system_event` varchar(40) NULL, ADD `system_data` json NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `messages` DROP COLUMN `system_data`, DROP COLUMN `system_event`');
  }
}
