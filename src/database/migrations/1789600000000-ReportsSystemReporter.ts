import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 12: `reports.reporter_id` becomes nullable. A null reporter is the
 * system (automatic report created by the flag scan on a review or reply).
 */
export class ReportsSystemReporter1789600000000 implements MigrationInterface {
  name = 'ReportsSystemReporter1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `reports` DROP FOREIGN KEY `FK_9459b9bf907a3807ef7143d2ead`');
    await queryRunner.query('ALTER TABLE `reports` CHANGE `reporter_id` `reporter_id` varchar(36) NULL');
    await queryRunner.query(
      'ALTER TABLE `reports` ADD CONSTRAINT `FK_9459b9bf907a3807ef7143d2ead` FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `reports` DROP FOREIGN KEY `FK_9459b9bf907a3807ef7143d2ead`');
    await queryRunner.query('DELETE FROM `reports` WHERE `reporter_id` IS NULL');
    await queryRunner.query('ALTER TABLE `reports` CHANGE `reporter_id` `reporter_id` varchar(36) NOT NULL');
    await queryRunner.query(
      'ALTER TABLE `reports` ADD CONSTRAINT `FK_9459b9bf907a3807ef7143d2ead` FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
  }
}
