import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BUG-H4 / BUG-M3 (24 Nov 2026): `bookings.cancelled_by` gains `system` for
 * cancellations no person made. Existing values are kept as they are.
 */
export class CancelledBySystem1792000000000 implements MigrationInterface {
  name = 'CancelledBySystem1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE `bookings` MODIFY `cancelled_by` enum ('client', 'provider', 'admin', 'system') NULL");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("UPDATE `bookings` SET `cancelled_by` = 'admin' WHERE `cancelled_by` = 'system'");
    await queryRunner.query("ALTER TABLE `bookings` MODIFY `cancelled_by` enum ('client', 'provider', 'admin') NULL");
  }
}
