import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BUG-F6 / BUG-M1 (24 Nov 2026): who made a manual availability block. Admin
 * blocks are shown to the provider as "Blocked by Eventor", without the admin's
 * note, and the provider cannot remove them.
 *
 * Existing rows default to `provider`; the ones an admin created are found in
 * the audit log (`availability.blocked` written by an admin actor). Holds and
 * bookings (`kind` held / booked) keep `provider`: the field only matters for
 * `kind = 'blocked'`.
 */
export class AvailabilityBlockSource1791800000000 implements MigrationInterface {
  name = 'AvailabilityBlockSource1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE `availability_blocks` ADD `source` enum ('provider', 'admin') NOT NULL DEFAULT 'provider'");
    await queryRunner.query(
      `UPDATE availability_blocks ab
       JOIN audit_logs al ON al.object_type = 'availability_block' AND al.object_id = ab.id AND al.action = 'availability.blocked'
       SET ab.source = 'admin'
       WHERE al.actor_role = 'admin' AND ab.kind = 'blocked'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `availability_blocks` DROP COLUMN `source`');
  }
}
