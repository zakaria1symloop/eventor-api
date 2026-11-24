/**
 * `pnpm bookings:expire-preview` (or `:prod` on the server, from `dist/`): lists
 * the pending booking requests that `booking_auto_expire` would decline as
 * `expired` right now (BUG-F1). **Read-only**: it writes nothing, so it can be
 * run on the live database before an admin turns the setting on.
 *
 * Options: `--json` prints JSON instead of a table; `--deadline-hours N`
 * overrides `booking_reply_deadline_hours` (default: the saved setting).
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.js';
import { buildDataSourceOptions } from '../database/database.options.js';
import { SETTINGS_DEFAULTS } from '../settings/settings.defaults.js';
import { findExpiredRequests } from './booking-expiry.js';

try {
  process.loadEnvFile();
} catch {
  // Variables come from the environment.
}

export function parseDeadline(argv: string[]): number | null {
  const index = argv.findIndex((a) => a === '--deadline-hours' || a.startsWith('--deadline-hours='));
  if (index === -1) return null;
  const raw = argv[index]!.includes('=') ? argv[index]!.split('=')[1] : argv[index + 1];
  const hours = Number(raw);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error('--deadline-hours must be an integer between 1 and 720');
  return hours;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dataSource = new DataSource({ ...buildDataSourceOptions(validateEnv(process.env)), logging: ['error'] });
  await dataSource.initialize();
  try {
    const [saved] = await dataSource.query("SELECT value FROM settings WHERE `key` = 'booking_reply_deadline_hours'");
    const settingHours = saved?.value === undefined || saved?.value === null ? SETTINGS_DEFAULTS.booking_reply_deadline_hours : Number(saved.value);
    const hours = parseDeadline(argv) ?? settingHours;
    const now = new Date();
    const rows = await findExpiredRequests(dataSource, hours, now, 100_000);
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ now: now.toISOString(), replyDeadlineHours: hours, count: rows.length, bookings: rows }, null, 2));
      return;
    }
    console.log(`bookings:expire-preview at ${now.toISOString()} (reply deadline ${hours} h): ${rows.length} pending request(s) would expire`);
    console.table(
      rows.map((r) => ({
        reference: r.reference,
        event: `${r.eventDate}${r.startTime ? ` ${r.startTime}` : ''}`,
        requested: r.createdAt.toISOString().slice(0, 16).replace('T', ' '),
        cause: r.cause,
        provider: r.providerName,
        client: r.clientName,
      })),
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
