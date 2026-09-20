import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Module 11: microsecond `last_read_at`, so unread counts compare exactly with `messages.created_at` (datetime(6)). */
export class ParticipantsReadPrecision1789561926399 implements MigrationInterface {
  name = 'ParticipantsReadPrecision1789561926399';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `conversation_participants` CHANGE `last_read_at` `last_read_at` datetime(6) NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `conversation_participants` CHANGE `last_read_at` `last_read_at` datetime(0) NULL');
  }
}
