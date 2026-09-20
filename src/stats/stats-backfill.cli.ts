/**
 * `pnpm stats:backfill [--days 120]`: recomputes `stats_daily` for the last N
 * Africa/Algiers days up to yesterday (today is always computed live).
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { addDays } from '../bookings/bookings.policy.js';
import { validateEnv } from '../config/env.js';
import { buildDataSourceOptions } from '../database/database.options.js';
import { algiersDay } from './stats.policy.js';
import { rollupStats } from './stats.rollup.js';

try {
  process.loadEnvFile();
} catch {
  // Variables come from the environment.
}

export function parseDays(argv: string[], fallback = 120): number {
  const index = argv.findIndex((a) => a === '--days' || a.startsWith('--days='));
  if (index === -1) return fallback;
  const raw = argv[index]!.includes('=') ? argv[index]!.split('=')[1] : argv[index + 1];
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('--days must be an integer between 1 and 3650');
  return days;
}

async function main(): Promise<void> {
  const days = parseDays(process.argv.slice(2));
  const dataSource = new DataSource({ ...buildDataSourceOptions(validateEnv(process.env)), logging: ['error'] });
  await dataSource.initialize();
  try {
    const today = algiersDay(new Date());
    const from = addDays(today, -days);
    const to = addDays(today, -1);
    const rows = await rollupStats(dataSource, from, to);
    console.log(`stats:backfill ${from}..${to}: ${rows} rows written`);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
