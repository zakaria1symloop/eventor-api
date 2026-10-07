import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Max events per day" becomes the provider's checkbox "Only one booking per day":
 * 1 = ticked, NULL = no daily limit. Services that allowed more than one a day
 * become "no daily limit" (the checkbox has no in-between).
 */
export class OneBookingPerDay1791360000000 implements MigrationInterface {
  name = 'OneBookingPerDay1791360000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE `services` CHANGE `max_events_per_day` `max_events_per_day` tinyint UNSIGNED NULL DEFAULT '1'");
    await queryRunner.query('UPDATE `services` SET `max_events_per_day` = NULL WHERE `max_events_per_day` > 1');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('UPDATE `services` SET `max_events_per_day` = 20 WHERE `max_events_per_day` IS NULL');
    await queryRunner.query("ALTER TABLE `services` CHANGE `max_events_per_day` `max_events_per_day` tinyint UNSIGNED NOT NULL DEFAULT '1'");
  }
}
