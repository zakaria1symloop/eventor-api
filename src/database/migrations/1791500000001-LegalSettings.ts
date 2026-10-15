import type { MigrationInterface, QueryRunner } from 'typeorm';
import { PRIVACY_AR, PRIVACY_EN, TERMS_AR, TERMS_EN } from '../../legal/legal-drafts.js';

/** Settings added on 15 Oct 2026: the legal page texts (drafts) and the store links. */
export const SETTINGS_ADDED_20261015: Record<string, unknown> = {
  legal_terms_en: TERMS_EN,
  legal_terms_ar: TERMS_AR,
  legal_privacy_en: PRIVACY_EN,
  legal_privacy_ar: PRIVACY_AR,
  store_url_android: '',
  store_url_ios: '',
};

export class LegalSettings1791500000001 implements MigrationInterface {
  name = 'LegalSettings1791500000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const keys = Object.keys(SETTINGS_ADDED_20261015);
    // INSERT IGNORE: an admin may already have saved one of them.
    await queryRunner.query(
      `INSERT IGNORE INTO \`settings\` (\`key\`, \`value\`) VALUES ${keys.map(() => '(?, CAST(? AS JSON))').join(', ')}`,
      keys.flatMap((key) => [key, JSON.stringify(SETTINGS_ADDED_20261015[key])]),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM `settings` WHERE `key` IN (?)', [Object.keys(SETTINGS_ADDED_20261015)]);
  }
}
