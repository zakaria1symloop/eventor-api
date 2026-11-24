/**
 * `pnpm bookings:stale-reschedules` (or `:prod` on the server, from `dist/`):
 * lists the pending reschedule proposals left on bookings that already ended
 * (BUG-E7). **Read-only by default.** With `--apply` it closes them (status
 * `cancelled`, audit row per booking) in one transaction — run that only after
 * the list was reviewed and approved.
 *
 * Options: `--json` prints JSON instead of a table; `--apply` writes.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.js';
import { buildDataSourceOptions } from '../database/database.options.js';
import { closeStaleReschedules, findStaleReschedules } from './stale-reschedules.js';

try {
  process.loadEnvFile();
} catch {
  // Variables come from the environment.
}

/** The flags, kept apart so a typo can never turn a preview into a write. */
export function parseFlags(argv: string[]): { json: boolean; apply: boolean } {
  const unknown = argv.filter((a) => a !== '--json' && a !== '--apply');
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.join(' ')} (allowed: --json, --apply)`);
  return { json: argv.includes('--json'), apply: argv.includes('--apply') };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const dataSource = new DataSource({ ...buildDataSourceOptions(validateEnv(process.env)), logging: ['error'] });
  await dataSource.initialize();
  try {
    const stale = await findStaleReschedules(dataSource);
    if (flags.json) console.log(JSON.stringify({ count: stale.length, proposals: stale }, null, 2));
    else {
      console.log(`bookings:stale-reschedules: ${stale.length} pending proposal(s) on ended bookings${flags.apply ? '' : ' (read-only)'}`);
      if (stale.length) console.table(stale.map((s) => ({ reference: s.reference, booking: s.bookingStatus, proposal: s.rescheduleId, from: s.oldDate, to: `${s.newDate}${s.newStartTime ? ` ${s.newStartTime}–${s.newEndTime}` : ''}`, proposedAt: s.proposedAt })));
    }
    if (flags.apply) {
      const closed = await closeStaleReschedules(dataSource);
      console.log(`--apply: ${closed} proposal(s) closed as cancelled.`);
    }
  } finally {
    await dataSource.destroy();
  }
}

// Not when imported by a test.
if (process.argv[1]?.includes('stale-reschedules.cli')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
