import type { MigrationInterface, QueryRunner } from 'typeorm';

/** `verification_codes.purpose` gains `account_deletion`: the web deletion page can confirm with an emailed code. */
export class AccountDeletionCode1791500000002 implements MigrationInterface {
  name = 'AccountDeletionCode1791500000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE `verification_codes` CHANGE `purpose` `purpose` enum ('email_verify', 'password_reset', 'email_change', 'form_submission', 'account_deletion') NOT NULL",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `verification_codes` WHERE `purpose` = 'account_deletion'");
    await queryRunner.query(
      "ALTER TABLE `verification_codes` CHANGE `purpose` `purpose` enum ('email_verify', 'password_reset', 'email_change', 'form_submission') NOT NULL",
    );
  }
}
