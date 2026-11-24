import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Setting added on 23 Nov 2026 (BUG-F1): `booking_auto_expire`, off. While off
 * nothing changes; an admin turns it on in Settings · Bookings once the backlog
 * (`pnpm bookings:expire-preview:prod`) has been reviewed.
 */
export const SETTINGS_ADDED_20261123: Record<string, unknown> = {
  booking_auto_expire: false,
};

export class BookingAutoExpireSetting1791600000000 implements MigrationInterface {
  name = 'BookingAutoExpireSetting1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const keys = Object.keys(SETTINGS_ADDED_20261123);
    // INSERT IGNORE: never overwrite a value an admin already saved.
    await queryRunner.query(
      `INSERT IGNORE INTO \`settings\` (\`key\`, \`value\`) VALUES ${keys.map(() => '(?, CAST(? AS JSON))').join(', ')}`,
      keys.flatMap((key) => [key, JSON.stringify(SETTINGS_ADDED_20261123[key])]),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM `settings` WHERE `key` IN (?)', [Object.keys(SETTINGS_ADDED_20261123)]);
  }
}
