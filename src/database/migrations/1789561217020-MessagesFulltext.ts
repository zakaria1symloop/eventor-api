import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Module 11: full-text search on message text (`GET /admin/conversations?q=`). */
export class MessagesFulltext1789561217020 implements MigrationInterface {
  name = 'MessagesFulltext1789561217020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE FULLTEXT INDEX `IDX_2159346a5481bb966ba72cb564` ON `messages` (`body`)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `IDX_2159346a5481bb966ba72cb564` ON `messages`');
  }
}
