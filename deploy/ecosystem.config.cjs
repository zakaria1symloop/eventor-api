/**
 * PM2 configuration for the Eventor API (deployment path B: Node + PM2).
 *
 * This file is CommonJS (.cjs) on purpose: package.json has "type": "module",
 * so a plain ecosystem.config.js would be parsed as ESM and PM2 would fail to
 * require() it.
 *
 * Usage (from the repository root, backend/):
 *   pnpm build
 *   pm2 start deploy/ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup
 *   pm2 reload eventor-api      # after a new build
 *   pm2 logs eventor-api
 *
 * Log directory must exist and be writable by the deploy user:
 *   sudo mkdir -p /var/log/eventor && sudo chown deploy:deploy /var/log/eventor
 */

const path = require('node:path');

// deploy/ lives inside the repository, so the app root is one level up.
const APP_ROOT = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'eventor-api',
      // package.json -> "start:prod": "node dist/main"
      script: 'dist/main.js',
      cwd: APP_ROOT,
      interpreter: 'node',

      // ── Process model ──────────────────────────────────────────────────────
      // Default: a SINGLE process in fork mode.
      //
      // Why not cluster/`instances: 'max'`? The API serves Socket.IO (the
      // `/admin` namespace, src/messaging/messaging.gateway.ts). With more than
      // one process, engine.io's HTTP long-polling handshake lands on a random
      // worker and breaks, and room broadcasts (notifications, messages,
      // disputes) only reach clients attached to the emitting process.
      //
      // To scale out you need BOTH of:
      //   1. sticky sessions (nginx ip_hash / a sticky upstream, or PM2 with
      //      the `@socket.io/sticky` setup), and
      //   2. a Socket.IO Redis adapter (@socket.io/redis-adapter) wired into
      //      CorsIoAdapter so broadcasts cross processes.
      // Neither is in the codebase today. Until then, keep instances: 1.
      //
      // Once both are in place:
      //   instances: 'max',
      //   exec_mode: 'cluster',
      instances: 1,
      exec_mode: 'fork',

      // ── Restart policy ─────────────────────────────────────────────────────
      autorestart: true,
      watch: false,
      max_memory_restart: '768M',
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 3000,
      // The app calls enableShutdownHooks(); give it time to close the BullMQ
      // worker and the MySQL pool on SIGINT before PM2 sends SIGKILL.
      kill_timeout: 10000,
      listen_timeout: 15000,

      // ── Environment ────────────────────────────────────────────────────────
      // PM2 does not read .env files itself, and neither does main.ts (it never
      // calls process.loadEnvFile(), so the app sees only what the parent process
      // exported). Node 22 does, though: --env-file loads the file into
      // process.env before the app boots, which keeps the secrets in one
      // root-owned, chmod 600 file instead of the shell history or PM2's dump.
      // A missing variable then fails loudly at boot in validateEnv().
      //
      // Alternatives, if you would rather not use node_args:
      //   a) export first, then start:  set -a; . ./.env.production; set +a
      //   b) a systemd unit with EnvironmentFile=…/.env.production
      node_args: `--env-file=${path.join(APP_ROOT, '.env.production')}`,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },

      // ── Logs ───────────────────────────────────────────────────────────────
      out_file: '/var/log/eventor/api.out.log',
      error_file: '/var/log/eventor/api.err.log',
      merge_logs: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ── Optional dedicated queue worker ──────────────────────────────────────
    // HEADS UP: there is currently NO standalone worker entrypoint in the repo.
    // src/queue/queue.service.ts creates the BullMQ Queue and its Worker inside
    // the same Nest process, so a second `dist/main.js` process is a second full
    // API that also consumes jobs. It works with REDIS_URL set, but it also
    // binds PORT — give it a different one and do not proxy to it.
    //
    // Prefer adding a real worker bootstrap (NestFactory.createApplicationContext)
    // and pointing `script` at it before enabling this.
    //
    // {
    //   name: 'eventor-worker',
    //   script: 'dist/main.js',
    //   cwd: APP_ROOT,
    //   instances: 1,
    //   exec_mode: 'fork',
    //   autorestart: true,
    //   max_memory_restart: '768M',
    //   kill_timeout: 10000,
    //   env_production: {
    //     NODE_ENV: 'production',
    //     PORT: '3010',            // must differ from the API's PORT
    //     SWAGGER_ENABLED: 'false',
    //     LOG_REQUESTS: 'false',
    //     // REDIS_URL must be set, otherwise this process only runs its own
    //     // inline jobs and consumes nothing from the shared queue.
    //   },
    //   out_file: '/var/log/eventor/worker.out.log',
    //   error_file: '/var/log/eventor/worker.err.log',
    //   merge_logs: true,
    //   time: true,
    // },
  ],
};
