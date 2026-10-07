import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Clients at the same time" becomes the provider's checkbox "Allow several clients at
 * the same time": 1 = one client per time slot (unticked), NULL = no limit (ticked).
 * Services set above 1 become "allow several" (the checkbox has no in-between).
 */
export class AllowSimultaneous1791380000000 implements MigrationInterface {
  name = 'AllowSimultaneous1791380000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE `services` CHANGE `concurrent_clients` `concurrent_clients` tinyint UNSIGNED NULL DEFAULT '1'");
    await queryRunner.query('UPDATE `services` SET `concurrent_clients` = NULL WHERE `concurrent_clients` > 1');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('UPDATE `services` SET `concurrent_clients` = 50 WHERE `concurrent_clients` IS NULL');
    await queryRunner.query("ALTER TABLE `services` CHANGE `concurrent_clients` `concurrent_clients` tinyint UNSIGNED NOT NULL DEFAULT '1'");
  }
}
