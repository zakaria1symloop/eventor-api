/**
 * `pnpm perf:seed [--reset]`: builds the performance database (`PERF_DB_DATABASE`,
 * default `eventor_admin_perf`) with production-like volumes, for `pnpm perf:check`.
 *
 * 1. CREATE DATABASE (with the DB_* credentials, root locally) and run every migration.
 * 2. Run the demo seed into it (realistic reference rows: categories, admins, forms…).
 * 3. Amplify with set-based SQL: ~50k users (1 in 5 a provider with a profile),
 *    20k services, 50k bookings, 20k reviews, 2k disputes (+ conversations),
 *    100k audit-log entries. Rows are tagged `perf.user.N@perf.eventor.dz`, `PRF-NNNNNNN`,
 *    `PDS-NNNNNNN`, so a second run is a no-op unless `--reset` drops the database.
 * 4. Backfill `stats_daily` for 120 days.
 *
 * Refuses NODE_ENV=production and refuses to target DB_DATABASE / DB_DATABASE_TEST.
 * Runs through tsx (no Nest DI needed: raw SQL only).
 */
import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { NodeEnv, validateEnv } from '../config/env.js';
import { buildDataSourceOptions } from '../database/database.options.js';

try {
  process.loadEnvFile();
} catch {
  // Variables come from the environment.
}

const PERF_DB = process.env.PERF_DB_DATABASE || 'eventor_admin_perf';
const COUNTS = {
  users: 50_000,
  services: 20_000,
  bookings: 50_000,
  reviews: 20_000,
  disputes: 2_000,
  audit: 100_000,
};
const CHUNK = 10_000;

const FIRST = ['Amel', 'Sofia', 'Rania', 'Ines', 'Lina', 'Mehdi', 'Anis', 'Ryad', 'Hamza', 'Omar'];
const LAST = ['Benamar', 'Bouaziz', 'Kaci', 'Belhadj', 'Mokrani', 'Ziani', 'Hamdi', 'Guerfi', 'Laib', 'Toumi'];
const sqlList = (items: readonly (string | number)[]) =>
  items.map((v) => (typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`)).join(', ');

function log(message: string): void {
  console.log(`[perf:seed] ${message}`);
}

async function main(): Promise<void> {
  const base = validateEnv(process.env);
  if (base.NODE_ENV === NodeEnv.Production) throw new Error('perf:seed refuses to run with NODE_ENV=production');
  if (!/^[A-Za-z0-9_]+$/.test(PERF_DB)) throw new Error('PERF_DB_DATABASE must match [A-Za-z0-9_]+');
  if ([base.DB_DATABASE, process.env.DB_DATABASE_TEST].includes(PERF_DB)) {
    throw new Error(`perf:seed refuses to target ${PERF_DB}: use a dedicated database`);
  }

  const admin = await mysql.createConnection({
    host: base.DB_HOST,
    port: base.DB_PORT,
    user: base.DB_USERNAME,
    password: base.DB_PASSWORD,
  });
  if (process.argv.includes('--reset')) {
    log(`dropping ${PERF_DB}`);
    await admin.query(`DROP DATABASE IF EXISTS \`${PERF_DB}\``);
  }
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${PERF_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await admin.end();

  const env = { ...base, DB_DATABASE: PERF_DB };
  const db = new DataSource({ ...buildDataSourceOptions(env), logging: ['error'] });
  await db.initialize();
  try {
    const applied = await db.runMigrations({ transaction: 'each' });
    log(`migrations applied: ${applied.length}`);

    const [{ n: existing }] = await db.query(
      `SELECT COUNT(*) AS n FROM bookings WHERE reference LIKE 'PRF-%'`,
    );
    if (Number(existing) >= COUNTS.bookings) {
      log(`already seeded (${existing} perf bookings); use --reset to rebuild`);
      return;
    }
    if (Number(existing) > 0) {
      throw new Error('partially seeded database: run `pnpm perf:seed --reset`');
    }

    runChild('demo seed', ['src/database/seeds/demo-seed.ts'], PERF_DB);
    await amplify(db);
    runChild('stats backfill', ['src/stats/stats-backfill.cli.ts', '--days', '120'], PERF_DB);

    for (const table of ['users', 'provider_profiles', 'services', 'bookings', 'reviews', 'disputes', 'audit_logs']) {
      await db.query(`ANALYZE TABLE \`${table}\``);
      const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      log(`${table}: ${n} rows`);
    }
  } finally {
    await db.destroy();
  }
}

function runChild(label: string, args: string[], database: string): void {
  log(`${label}…`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', ...args], {
    cwd: resolve(import.meta.dirname, '../..'),
    env: { ...process.env, DB_DATABASE: database, LOG_REQUESTS: 'false' },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})`);
}

async function inChunks(total: number, run: (from: number, to: number) => Promise<unknown>): Promise<void> {
  for (let from = 1; from <= total; from += CHUNK) {
    await run(from, Math.min(total, from + CHUNK - 1));
  }
}

async function amplify(db: DataSource): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

  // Number table 1..max(counts).
  const max = Math.max(...Object.values(COUNTS));
  await q('DROP TABLE IF EXISTS perf_seq');
  await q('CREATE TABLE perf_seq (n INT UNSIGNED NOT NULL PRIMARY KEY) ENGINE=InnoDB');
  await q('INSERT INTO perf_seq (n) VALUES (1)');
  for (let size = 1; size < max; size *= 2) {
    await q('INSERT INTO perf_seq (n) SELECT n + ? FROM perf_seq WHERE n + ? <= ?', [size, size, max]);
  }

  const categories: { id: string }[] = await q('SELECT id FROM categories ORDER BY position, slug');
  const admins: { id: string }[] = await q(`SELECT id FROM users WHERE role = 'admin'`);
  if (categories.length === 0 || admins.length === 0) throw new Error('demo seed produced no categories or admins');
  const categoryPick = (expr: string) => `ELT(1 + ${expr} % ${categories.length}, ${sqlList(categories.map((c) => c.id))})`;
  const adminPick = (expr: string) => `ELT(1 + ${expr} % ${admins.length}, ${sqlList(admins.map((a) => a.id))})`;
  const ago = (days: string) => `(UTC_TIMESTAMP(6) - INTERVAL (${days}) DAY - INTERVAL (n * 37 % 86400) SECOND)`;

  log(`users (${COUNTS.users})…`);
  await inChunks(COUNTS.users, (from, to) =>
    q(
      `INSERT INTO users (id, created_at, updated_at, role, status, verification_status, full_name, email,
         email_verified_at, language, wilaya_code, last_active_at, blocked_at, blocked_reason)
       SELECT UUID(), ${ago('n % 730')}, ${ago('n % 30')},
         IF(n % 5 = 0, 'provider', 'client'),
         IF(n % 50 = 0, 'blocked', 'active'),
         IF(n % 5 = 0, ELT(1 + n % 4, 'pending', 'verified', 'verified', 'rejected'), 'not_required'),
         CONCAT(ELT(1 + n % 10, ${sqlList(FIRST)}), ' ', ELT(1 + (n DIV 10) % 10, ${sqlList(LAST)}), ' ', n),
         CONCAT('perf.user.', n, '@perf.eventor.dz'),
         ${ago('n % 730')},
         IF(n % 3 = 0, 'en', 'ar'),
         ELT(1 + n % 8, 16, 16, 31, 25, 9, 42, 19, 6),
         ${ago('n % 60')},
         IF(n % 50 = 0, ${ago('n % 20')}, NULL),
         IF(n % 50 = 0, 'spam', NULL)
       FROM perf_seq WHERE n BETWEEN ? AND ?`,
      [from, to],
    ),
  );

  // Index tables so later inserts can join "the k-th client / provider / service".
  await q('DROP TABLE IF EXISTS perf_clients, perf_providers, perf_services');
  await q(`CREATE TABLE perf_clients (idx INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(36) NOT NULL)`);
  await q(`INSERT INTO perf_clients (user_id) SELECT id FROM users WHERE role = 'client' AND email LIKE 'perf.user.%' ORDER BY email`);
  await q(`CREATE TABLE perf_providers (idx INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(36) NOT NULL, category_id VARCHAR(36) NOT NULL)`);
  await q(
    `INSERT INTO perf_providers (user_id, category_id)
     SELECT id, ${categoryPick('CRC32(id)')} FROM users WHERE role = 'provider' AND email LIKE 'perf.user.%' ORDER BY email`,
  );

  log('provider profiles…');
  await q(
    `INSERT INTO provider_profiles (id, user_id, business_name, category_id, bio_en, bio_ar, years_active, avg_rating, rating_count, completed_bookings_count)
     SELECT UUID(), user_id, CONCAT('Perf Studio ', idx), category_id, 'Performance fixture provider.', 'مزود للاختبار.',
       1 + idx % 20, 3 + (idx % 20) / 10, idx % 90, idx % 120
     FROM perf_providers`,
  );
  await q(
    `INSERT INTO provider_wilayas (provider_profile_id, wilaya_code)
     SELECT pp.id, u.wilaya_code FROM provider_profiles pp JOIN users u ON u.id = pp.user_id
     WHERE u.email LIKE 'perf.user.%'`,
  );

  const [{ n: providerCount }] = await q('SELECT COUNT(*) AS n FROM perf_providers');
  const [{ n: clientCount }] = await q('SELECT COUNT(*) AS n FROM perf_clients');

  log(`services (${COUNTS.services})…`);
  await inChunks(COUNTS.services, (from, to) =>
    q(
      `INSERT INTO services (id, created_at, updated_at, provider_id, category_id, title_en, title_ar, description_en, description_ar,
         base_price, price_type, max_guests, status, hidden_reason, hidden_at, avg_rating, rating_count, bookings_count)
       SELECT UUID(), ${ago('n % 600')}, ${ago('n % 40')}, p.user_id, p.category_id,
         CONCAT('Perf service ', n), CONCAT('خدمة ', n), 'Performance fixture service.', 'خدمة للاختبار.',
         5000 + n % 200 * 1000, ELT(1 + n % 5, 'per_event', 'per_hour', 'per_person', 'per_day', 'on_quote'),
         IF(n % 2 = 0, 100 + n % 700, NULL),
         ELT(1 + n % 10, 'published', 'published', 'published', 'published', 'published', 'published', 'published', 'draft', 'hidden', 'published'),
         IF(n % 10 = 8, 'inappropriate_content', NULL), IF(n % 10 = 8, ${ago('n % 30')}, NULL),
         3 + (n % 20) / 10, n % 60, n % 80
       FROM perf_seq s JOIN perf_providers p ON p.idx = 1 + s.n % ?
       WHERE s.n BETWEEN ? AND ?`,
      [providerCount, from, to],
    ),
  );
  await q(`CREATE TABLE perf_services (idx INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, service_id VARCHAR(36) NOT NULL, provider_id VARCHAR(36) NOT NULL)`);
  await q(`INSERT INTO perf_services (service_id, provider_id) SELECT id, provider_id FROM services WHERE title_en LIKE 'Perf service %' ORDER BY created_at, id`);
  const [{ n: serviceCount }] = await q('SELECT COUNT(*) AS n FROM perf_services');

  log(`bookings (${COUNTS.bookings})…`);
  await inChunks(COUNTS.bookings, (from, to) =>
    q(
      `INSERT INTO bookings (id, created_at, updated_at, reference, client_id, provider_id, service_id, status, dispute_status,
         event_type, event_date, start_time, wilaya_code, guests, subtotal, discount_total, total, fee_percent,
         responded_at, completed_at, cancelled_by, cancel_reason, decline_reason, source)
       SELECT UUID(), ${ago('n % 540')}, ${ago('n % 30')}, CONCAT('PRF-', LPAD(n, 7, '0')), c.user_id, sv.provider_id, sv.service_id,
         ELT(1 + n % 10, 'completed', 'completed', 'completed', 'completed', 'accepted', 'accepted', 'pending', 'declined', 'cancelled', 'completed'),
         IF(n % 25 = 0, IF(n % 50 = 0, 'resolved', 'open'), 'none'),
         ELT(1 + n % 8, 'wedding', 'engagement', 'henna', 'birthday', 'circumcision', 'graduation', 'corporate', 'other'),
         DATE(UTC_TIMESTAMP() - INTERVAL 400 DAY + INTERVAL (n % 540) DAY), '18:00:00',
         ELT(1 + n % 8, 16, 16, 31, 25, 9, 42, 19, 6), 50 + n % 500,
         20000 + n % 300 * 1000, IF(n % 7 = 0, 5000, 0), 20000 + n % 300 * 1000 - IF(n % 7 = 0, 5000, 0), 10.00,
         IF(n % 10 = 6, NULL, ${ago('n % 500')}),
         IF(n % 10 IN (0, 1, 2, 3, 9), ${ago('n % 400')}, NULL),
         IF(n % 10 = 8, 'client', NULL), IF(n % 10 = 8, 'change_of_plans', NULL), IF(n % 10 = 7, 'unavailable', NULL),
         ELT(1 + n % 4, 'android', 'ios', 'web', 'android')
       FROM perf_seq s
       JOIN perf_clients c ON c.idx = 1 + (s.n * 7) % ?
       JOIN perf_services sv ON sv.idx = 1 + s.n % ?
       WHERE s.n BETWEEN ? AND ?`,
      [clientCount, serviceCount, from, to],
    ),
  );

  log(`reviews (${COUNTS.reviews})…`);
  await q(
    `INSERT INTO reviews (id, created_at, updated_at, booking_id, author_id, service_id, provider_id, rating, comment, status, redacted_comment, moderated_at, had_dispute)
     SELECT UUID(), b.completed_at + INTERVAL 1 DAY, b.completed_at + INTERVAL 1 DAY, b.id, b.client_id, b.service_id, b.provider_id,
       1 + CRC32(b.id) % 5, CONCAT('Perf review for ', b.reference, '. Great service, on time.'),
       ELT(1 + CRC32(b.reference) % 20, 'hidden', 'redacted', 'published', 'published', 'published', 'published', 'published', 'published', 'published', 'published',
         'published', 'published', 'published', 'published', 'published', 'published', 'published', 'published', 'published', 'published'),
       NULL, NULL, b.dispute_status <> 'none'
     FROM bookings b
     WHERE b.reference LIKE 'PRF-%' AND b.status = 'completed'
     ORDER BY b.reference
     LIMIT ${COUNTS.reviews}`,
  );
  await q(`UPDATE reviews SET redacted_comment = 'Perf review [redacted].', moderated_at = updated_at WHERE status IN ('hidden', 'redacted') AND comment LIKE 'Perf review%'`);

  log(`disputes (${COUNTS.disputes})…`);
  await q('DROP TABLE IF EXISTS perf_disputes');
  await q(
    `CREATE TABLE perf_disputes (idx INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, booking_id VARCHAR(36) NOT NULL, client_id VARCHAR(36) NOT NULL,
       provider_id VARCHAR(36) NOT NULL, created_at DATETIME(6) NOT NULL, conversation_id VARCHAR(36) NOT NULL, dispute_id VARCHAR(36) NOT NULL)`,
  );
  await q(
    `INSERT INTO perf_disputes (booking_id, client_id, provider_id, created_at, conversation_id, dispute_id)
     SELECT id, client_id, provider_id, created_at + INTERVAL 2 DAY, UUID(), UUID() FROM bookings
     WHERE reference LIKE 'PRF-%' AND status IN ('completed', 'accepted') ORDER BY reference DESC LIMIT ${COUNTS.disputes}`,
  );
  await q(
    `INSERT INTO conversations (id, created_at, updated_at, kind, booking_id, dispute_id, status, last_message_at)
     SELECT conversation_id, created_at, created_at, 'dispute', booking_id, NULL, 'open', NULL FROM perf_disputes`,
  );
  await q(
    `INSERT INTO disputes (id, created_at, updated_at, reference, booking_id, opened_by_id, opened_by_role, against_user_id, type, description,
       status, assigned_admin_id, conversation_id, booking_outcome, decision_note, resolved_by_id, resolved_at)
     SELECT dispute_id, created_at, created_at, CONCAT('PDS-', LPAD(idx, 7, '0')), booking_id,
       IF(idx % 3 = 0, provider_id, client_id), IF(idx % 3 = 0, 'provider', 'client'), IF(idx % 3 = 0, client_id, provider_id),
       ELT(1 + idx % 9, 'provider_no_show', 'client_no_show', 'service_not_as_described', 'incomplete_or_late', 'price_disagreement',
         'cancellation_disagreement', 'damage_or_safety', 'behaviour', 'other'),
       'Performance fixture dispute.',
       ELT(1 + idx % 4, 'open', 'in_review', 'resolved', 'closed'),
       IF(idx % 4 = 0, NULL, ${adminPick('idx')}), conversation_id,
       IF(idx % 4 = 2, 'completed', NULL), IF(idx % 4 IN (2, 3), 'Decision.', NULL),
       IF(idx % 4 IN (2, 3), ${adminPick('idx')}, NULL), IF(idx % 4 IN (2, 3), created_at + INTERVAL 3 DAY, NULL)
     FROM perf_disputes`,
  );
  await q('UPDATE conversations c JOIN perf_disputes d ON d.conversation_id = c.id SET c.dispute_id = d.dispute_id');

  log(`audit logs (${COUNTS.audit})…`);
  await inChunks(COUNTS.audit, (from, to) =>
    q(
      `INSERT INTO audit_logs (id, created_at, actor_id, actor_role, action, object_type, object_id, object_label, level, changes, note, source, ip, request_id)
       SELECT UUID(), ${ago('n % 365')}, ${adminPick('n')}, 'admin',
         ELT(1 + n % 6, 'user.blocked', 'service.hidden', 'booking.cancelled', 'review.hidden', 'dispute.resolved', 'settings.updated'),
         ELT(1 + n % 6, 'user', 'service', 'booking', 'review', 'dispute', 'settings'),
         UUID(), CONCAT('Perf object ', n),
         ELT(1 + n % 4, 'info', 'normal', 'sensitive', 'security'),
         IF(n % 2 = 0, JSON_OBJECT('status', JSON_OBJECT('from', 'active', 'to', 'blocked')), NULL),
         NULL, 'dashboard', '10.0.0.1', CONCAT('req_perf', n)
       FROM perf_seq WHERE n BETWEEN ? AND ?`,
      [from, to],
    ),
  );

  await q('DROP TABLE IF EXISTS perf_seq, perf_clients, perf_providers, perf_services, perf_disputes');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
