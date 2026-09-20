import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.js';
import { buildDataSourceOptions } from './database.options.js';

/**
 * Standalone DataSource for the TypeORM CLI (`pnpm migration:*`). The app gets
 * its connection from DatabaseModule; both build the same options.
 */
try {
  process.loadEnvFile();
} catch {
  // No .env file: use the variables already set in the environment.
}

export default new DataSource(buildDataSourceOptions(validateEnv(process.env)));
