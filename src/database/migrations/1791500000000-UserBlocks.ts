import type { MigrationInterface, QueryRunner } from 'typeorm';

/** `user_blocks`: a client or provider blocks another one (chat and new bookings stop both ways). */
export class UserBlocks1791500000000 implements MigrationInterface {
  name = 'UserBlocks1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `user_blocks` (`id` varchar(36) NOT NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `blocker_id` varchar(36) NOT NULL, `blocked_id` varchar(36) NOT NULL, ' +
        'UNIQUE INDEX `IDX_user_blocks_pair` (`blocker_id`, `blocked_id`), INDEX `IDX_user_blocks_blocked` (`blocked_id`), PRIMARY KEY (`id`)) ENGINE=InnoDB',
    );
    await queryRunner.query(
      'ALTER TABLE `user_blocks` ADD CONSTRAINT `FK_user_blocks_blocker` FOREIGN KEY (`blocker_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE `user_blocks` ADD CONSTRAINT `FK_user_blocks_blocked` FOREIGN KEY (`blocked_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `user_blocks` DROP FOREIGN KEY `FK_user_blocks_blocked`');
    await queryRunner.query('ALTER TABLE `user_blocks` DROP FOREIGN KEY `FK_user_blocks_blocker`');
    await queryRunner.query('DROP TABLE `user_blocks`');
  }
}
