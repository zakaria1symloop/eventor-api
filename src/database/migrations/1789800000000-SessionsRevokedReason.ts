import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `sessions.revoked_reason`: why a session ended, so the guard can tell the
 * dashboard "signed in on another computer" (one dashboard session per admin)
 * apart from a plain sign-out. Null for sessions revoked before this column.
 */
export class SessionsRevokedReason1789800000000 implements MigrationInterface {
  name = 'SessionsRevokedReason1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `sessions` ADD `revoked_reason` varchar(30) NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `sessions` DROP COLUMN `revoked_reason`');
  }
}
