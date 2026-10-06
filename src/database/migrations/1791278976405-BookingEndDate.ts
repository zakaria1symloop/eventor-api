import { MigrationInterface, QueryRunner } from 'typeorm';

export class BookingEndDate1791278976405 implements MigrationInterface {
  name = 'BookingEndDate1791278976405';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`bookings\` ADD \`end_date\` date NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`bookings\` DROP COLUMN \`end_date\``,
    );
  }
}
