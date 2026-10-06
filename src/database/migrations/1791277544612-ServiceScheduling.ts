import { MigrationInterface, QueryRunner } from 'typeorm';

export class ServiceScheduling1791277544612 implements MigrationInterface {
  name = 'ServiceScheduling1791277544612';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`service_hours\` (\`id\` varchar(36) NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`service_id\` varchar(36) NOT NULL, \`weekday\` tinyint UNSIGNED NOT NULL, \`start_time\` time NOT NULL, \`end_time\` time NOT NULL, INDEX \`IDX_660d1b407ce255ac7190daa6d3\` (\`service_id\`, \`weekday\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`services\` ADD \`concurrent_clients\` tinyint UNSIGNED NOT NULL DEFAULT '1'`,
    );
    await queryRunner.query(
      `ALTER TABLE \`services\` ADD \`available_from\` date NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`services\` ADD \`available_until\` date NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`service_hours\` ADD CONSTRAINT \`FK_42dbd04581978f8158a0d79e988\` FOREIGN KEY (\`service_id\`) REFERENCES \`services\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`service_hours\` DROP FOREIGN KEY \`FK_42dbd04581978f8158a0d79e988\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`services\` DROP COLUMN \`available_until\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`services\` DROP COLUMN \`available_from\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`services\` DROP COLUMN \`concurrent_clients\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_660d1b407ce255ac7190daa6d3\` ON \`service_hours\``,
    );
    await queryRunner.query(`DROP TABLE \`service_hours\``);
  }
}
