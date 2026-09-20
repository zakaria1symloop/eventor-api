import './test-env.js';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateEnv } from '../../src/config/env.js';
import { buildDataSourceOptions } from '../../src/database/database.options.js';

/** A DataSource on the test database (DB_DATABASE_TEST), with the app's entities and migrations. */
export function createTestDataSource(): DataSource {
  return new DataSource({ ...buildDataSourceOptions(validateEnv(process.env)), logging: ['error'] });
}
