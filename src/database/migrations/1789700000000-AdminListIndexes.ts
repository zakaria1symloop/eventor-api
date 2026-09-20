import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 14: indexes found by `pnpm perf:check` on 50k bookings / 100k audit entries.
 * The admin lists sort by `created_at` (and bookings by `event_date`) with an id
 * tie-break in the same direction, which InnoDB serves from these indexes (the
 * primary key is part of every secondary index) instead of a filesort.
 */
export class AdminListIndexes1789700000000 implements MigrationInterface {
  name = 'AdminListIndexes1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX `IDX_2f9dc5b3a2c915e0a7595f58eb` ON `services` (`created_at`)');
    await queryRunner.query('CREATE INDEX `IDX_612ddbdc6c5a74e253cb258693` ON `bookings` (`event_date`)');
    await queryRunner.query('CREATE INDEX `IDX_3411322e212076d1ac1a71e6ed` ON `bookings` (`created_at`)');
    await queryRunner.query('CREATE INDEX `IDX_2cd10fda8276bb995288acfbfb` ON `audit_logs` (`created_at`)');
    await queryRunner.query('CREATE INDEX `IDX_d3b0d4755fa5510f2a4041ffc8` ON `reviews` (`created_at`)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `IDX_d3b0d4755fa5510f2a4041ffc8` ON `reviews`');
    await queryRunner.query('DROP INDEX `IDX_2cd10fda8276bb995288acfbfb` ON `audit_logs`');
    await queryRunner.query('DROP INDEX `IDX_3411322e212076d1ac1a71e6ed` ON `bookings`');
    await queryRunner.query('DROP INDEX `IDX_612ddbdc6c5a74e253cb258693` ON `bookings`');
    await queryRunner.query('DROP INDEX `IDX_2f9dc5b3a2c915e0a7595f58eb` ON `services`');
  }
}
