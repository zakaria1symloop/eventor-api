/**
 * `pnpm perf:check`: p50 / p95 / max latency of the main admin list endpoints
 * against the perf database built by `pnpm perf:seed`.
 *
 * Boots the compiled AppModule in this process on a free port with
 * DB_DATABASE=PERF_DB_DATABASE (default `eventor_admin_perf`), mints an admin
 * token for a fresh session, warms each endpoint up, then sends PERF_REQUESTS
 * (default 30) sequential requests per endpoint. Exits 1 when a p95 is above
 * PERF_P95_MS (default 300). Runs from `dist/` because Nest DI needs the
 * decorator metadata that tsx does not emit.
 *
 * `PERF_BASE_URL` + `PERF_TOKEN` measure a running server instead.
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

try {
  process.loadEnvFile();
} catch {
  // Variables come from the environment.
}

const PERF_DB = process.env.PERF_DB_DATABASE || 'eventor_admin_perf';
const REQUESTS = Number(process.env.PERF_REQUESTS || 30);
const TARGET_MS = Number(process.env.PERF_P95_MS || 300);

const ENDPOINTS: [label: string, path: string][] = [
  ['users', '/admin/users'],
  ['users q', '/admin/users?q=Benamar'],
  ['users providers', '/admin/users?tab=providers&sort=createdAt:desc'],
  ['services', '/admin/services'],
  ['services published', '/admin/services?tab=published'],
  ['bookings', '/admin/bookings'],
  ['bookings pending', '/admin/bookings?tab=pending'],
  ['bookings noReply', '/admin/bookings?noReply=true'],
  ['bookings q', '/admin/bookings?q=Benamar'],
  ['reviews', '/admin/reviews'],
  ['reviews reported', '/admin/reviews?tab=reported'],
  ['disputes', '/admin/disputes'],
  ['disputes all', '/admin/disputes?tab=all'],
  ['activity-log', '/admin/activity-log'],
  ['activity-log q', '/admin/activity-log?q=Perf%20object%2012'],
  ['search', '/admin/search?q=Mokrani'],
  ['search text ref', '/admin/search?q=PRF-0004242'],
  ['search EVT ref', '/admin/search?q=EVT-000042'],
  ['overview 30d', '/admin/overview'],
  ['overview month', '/admin/overview?range=this_month'],
  ['nav-counts', '/admin/nav-counts'],
];

interface Target {
  baseUrl: string;
  token: string;
  close(): Promise<void>;
}

async function bootInProcess(): Promise<Target> {
  process.env.DB_DATABASE = PERF_DB;
  process.env.LOG_REQUESTS = 'false';
  process.env.REDIS_URL = '';
  process.env.SMTP_HOST = '';
  process.env.THROTTLE_LIMIT = '1000000';

  const [{ NestFactory }, { AppModule }, { API_PREFIX, configureApp }, { envConfig }, { DataSource }, { TokenService }, { SessionAudience }, { UserRole }] =
    await Promise.all([
      import('@nestjs/core'),
      import('../app.module.js'),
      import('../app.setup.js'),
      import('../config/env.js'),
      import('typeorm'),
      import('../auth/token.service.js'),
      import('../common/enums/auth.enums.js'),
      import('../common/enums/user.enums.js'),
    ]);

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  configureApp(app, app.get(envConfig.KEY));
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;

  const db = app.get(DataSource);
  const [admin] = await db.query(
    `SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  );
  if (!admin) throw new Error(`no admin in ${PERF_DB}: run pnpm perf:seed first`);
  const sessionId = crypto.randomUUID();
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, audience, expires_at, device_label) VALUES (?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL 1 HOUR, 'perf:check')`,
    [sessionId, admin.id, randomBytes(32).toString('hex'), SessionAudience.Dashboard],
  );
  const token = await app.get(TokenService).signAccessToken({
    id: admin.id,
    role: UserRole.Admin,
    audience: SessionAudience.Dashboard,
    sessionId,
  });

  return {
    baseUrl: `http://127.0.0.1:${port}${API_PREFIX}`,
    token,
    close: async () => {
      await db.query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [sessionId]);
      await app.close();
    },
  };
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

async function main(): Promise<void> {
  const target: Target =
    process.env.PERF_BASE_URL && process.env.PERF_TOKEN
      ? { baseUrl: process.env.PERF_BASE_URL, token: process.env.PERF_TOKEN, close: async () => {} }
      : await bootInProcess();

  const rows: { label: string; first: number; p50: number; p95: number; max: number; ok: boolean }[] = [];
  try {
    for (const [label, path] of ENDPOINTS) {
      const call = async () => {
        const started = performance.now();
        const res = await fetch(`${target.baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${target.token}`, 'Accept-Language': 'en' },
        });
        await res.arrayBuffer();
        if (res.status !== 200) throw new Error(`${path} answered ${res.status}`);
        return performance.now() - started;
      };
      // The first call is reported apart: it includes cold caches (the overview caches its KPIs).
      const first = await call();
      await call();
      const samples: number[] = [];
      for (let i = 0; i < REQUESTS; i++) samples.push(await call());
      samples.sort((a, b) => a - b);
      const p95 = percentile(samples, 95);
      rows.push({ label, first, p50: percentile(samples, 50), p95, max: samples.at(-1)!, ok: p95 < TARGET_MS });
    }
  } finally {
    await target.close();
  }

  const fmt = (ms: number) => ms.toFixed(1).padStart(8);
  console.log(`\nperf:check  db=${PERF_DB}  requests=${REQUESTS}  target p95 < ${TARGET_MS} ms\n`);
  console.log(`${'endpoint'.padEnd(22)}${'first'.padStart(8)}${'p50'.padStart(8)}${'p95'.padStart(8)}${'max'.padStart(8)}`);
  for (const r of rows) {
    console.log(`${r.label.padEnd(22)}${fmt(r.first)}${fmt(r.p50)}${fmt(r.p95)}${fmt(r.max)}  ${r.ok ? 'ok' : 'SLOW'}`);
  }
  const slow = rows.filter((r) => !r.ok);
  if (slow.length > 0) {
    console.log(`\n${slow.length} endpoint(s) above target`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
