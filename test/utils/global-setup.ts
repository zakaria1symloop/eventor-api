import { rm } from 'node:fs/promises';
import { TEST_STORAGE_ROOT } from './test-env.js';
import { createTestDataSource } from './test-data-source.js';

/**
 * Runs once per `pnpm test:e2e`: empties the test database, applies every
 * migration (schema + seed) and clears the test storage folder. Suites then
 * create their own rows with the factories (unique values, so suites can share
 * the database).
 */
export default async function setup(): Promise<void> {
  const dataSource = createTestDataSource();
  await dataSource.initialize();
  try {
    await dataSource.dropDatabase();
    await dataSource.runMigrations({ transaction: 'each' });
  } finally {
    await dataSource.destroy();
  }
  await rm(TEST_STORAGE_ROOT, { recursive: true, force: true });
}
