# Eventor Admin API

NestJS 12 · TypeORM 1.1 · MySQL 8 · ESM (nodenext): the backend for the Eventor admin
dashboard (module 0 "Foundation" of `../docs/build-plan.md`).

Read before adding an endpoint:

- [`docs/api-standards.md`](docs/api-standards.md): definition of done per endpoint
- [`docs/db-schema.md`](docs/db-schema.md): schema v1 (authoritative)
- [`docs/status-rules.md`](docs/status-rules.md): every status transition
- [`docs/tech-decisions.md`](docs/tech-decisions.md): stack, auth, jobs

## Requirements

- Node.js 22.12 or newer
- pnpm 12 (`corepack enable`, or prefix commands with `npx pnpm@12.4.1`; plain `npm` is
  broken on the dev machine and would create a second lockfile)
- MySQL 8
- Redis: **optional** (see [Queues](#queues-and-cron))

## Getting started

```bash
pnpm install
cp .env.example .env        # set DB_*, SEED_ADMIN_*
pnpm migration:run          # schema v1 + seed (wilayas, settings, sequences, first admin)
pnpm start:dev
```

| | |
| --- | --- |
| API | http://localhost:3000/api/v1 |
| Swagger UI | http://localhost:3000/api/v1/docs |
| OpenAPI JSON | http://localhost:3000/api/v1/docs/openapi.json |
| Liveness | `GET /api/v1/health/live` |
| Readiness (database + queue driver) | `GET /api/v1/health/ready` |

The dashboard runs on http://localhost:3001 and is allowed by `CORS_ORIGINS` (with credentials).

### Local database (AMPPS)

MySQL comes from AMPPS (`C:\Program Files\Ampps\mysql`, start `bin\mysqld.exe` if it is not
running). Dev uses `root`; create both databases once:

```sql
CREATE DATABASE eventor_admin      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE eventor_admin_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

## Environment

All variables are validated at boot (`src/config/env.ts`); a bad value stops the process
with a list of problems. In production `JWT_ACCESS_SECRET` and `FILES_SIGNING_SECRET` must be
random values of at least 32 characters.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV`, `PORT` | development, 3000 | |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | 127.0.0.1, 3306 | MySQL |
| `DB_DATABASE_TEST` | eventor_admin_test | database the e2e tests rebuild |
| `CORS_ORIGINS` | `*` | comma-separated allowlist (credentials on) |
| `SWAGGER_ENABLED`, `LOG_REQUESTS` | true, true | |
| `THROTTLE_LIMIT`, `THROTTLE_TTL_MS` | 100, 60000 | global rate limit per user or IP |
| `AUTH_THROTTLE_LIMIT` | 10 | per minute on `/admin/auth/*` and the public form code / submit routes |
| `UPLOAD_THROTTLE_LIMIT` | 30 | per minute on every multipart upload route |
| `MAIL_THROTTLE_LIMIT` | 20 | per minute on the admin routes that email a third party (invitations, re-sends) |
| `BODY_LIMIT` | 1mb | max JSON / urlencoded body (413 above it); multipart is capped per route |
| `API_URL`, `ADMIN_URL`, `APP_PUBLIC_URL` | localhost | public URLs (signed file links use `API_URL`) |
| `JWT_ACCESS_SECRET`, `JWT_ACCESS_TTL` | dev secret, 900 s | access tokens (HS256) |
| `STORAGE_ROOT` | ./storage | uploaded files (`private/`, `public/`), outside the web root |
| `FILES_SIGNING_SECRET`, `FILES_URL_TTL` | dev secret, 900 s | signed file URLs |
| `REDIS_URL` | empty | BullMQ when set; in-process jobs when empty |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | empty | Google SMTP relay; empty host logs mails |
| `FCM_PROJECT_ID`, `FCM_CREDENTIALS_PATH` | empty | push (stub for now) |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | empty | first admin, created by `SeedV1` (skipped if any is empty) |

## Scripts

| Script | Does |
| --- | --- |
| `pnpm start:dev` | Run in watch mode |
| `pnpm build` / `pnpm start:prod` | Compile to `dist/` / run it |
| `pnpm test` | Unit tests (`src/**/*.spec.ts`, no database) |
| `pnpm test:e2e` | e2e tests (`test/*.e2e-spec.ts`) against `DB_DATABASE_TEST` |
| `pnpm lint` / `pnpm format` | oxlint / Prettier |
| `pnpm migration:run` / `:revert` / `:show` / `:generate <path>` | TypeORM migrations |
| `pnpm spec:export` | Build and write `openapi.json` at the backend root (no DB needed) |
| `pnpm stats:backfill --days 120` | Recompute `stats_daily` for the last N Africa/Algiers days up to yesterday (the nightly job at 01:00 Algiers re-rolls the last 2 days) |
| `pnpm perf:seed [--reset]` | Build `eventor_admin_perf` (`PERF_DB_DATABASE`) with production-like volumes: 50k users, 20k services, 50k bookings, 20k reviews, 2k disputes, 100k audit entries. Refuses `NODE_ENV=production` and refuses to target `DB_DATABASE` / `DB_DATABASE_TEST`; a second run is a no-op |
| `pnpm perf:check` | p50 / p95 / max over `PERF_REQUESTS` (30) requests on each admin list endpoint, against the perf database. Exits 1 when a p95 exceeds `PERF_P95_MS` (300). `PERF_BASE_URL` + `PERF_TOKEN` measure an already-running server instead |
| `pnpm seed:demo` | Idempotent demo data in `DB_DATABASE` (categories, communes, 40 clients, 25 providers, documents in every verification state, notes, audit entries, services, packs, ~180 bookings with invoices, reschedules and price changes, ~150 conversations with masked contact details and reported messages, 8 disputes (DSP-000024…031) in every status with evidence and dispute chats, request forms with versions and ~25 academic requests, ~70 reviews (FR/EN/AR, flagged ones with automatic reports, some hidden / redacted) with ~40% provider replies, reports on reviews, replies, messages, services, a pack and users in every status (one converted to DSP-000025), admin notifications, `stats_daily` backfilled for 120 days, admin `omar.belaid@eventor.dz` / `SEED_DEMO_ADMIN_PASSWORD`, default `Eventor-demo-2026`); refuses `NODE_ENV=production` |

## Schema

Schema v1 has **55 tables** (plus `migrations`), exactly as `docs/db-schema.md`.

- Entities live next to their module: `src/<module>/entities/`, registered in
  `src/database/entities.ts`; enums in `src/common/enums`.
- `AbstractEntity` (UUID `varchar(36)`, `created_at`, `updated_at`, `deleted_at`) and
  `AppendOnlyEntity` (`id`, `created_at`); join tables use composite keys.
- snake_case columns via `SnakeNamingStrategy`; every `@Column` has an explicit `type`
  (the CLI runs through tsx without decorator metadata); relations are `Relation<T>`.
- Money and decimals are `string` in entities (mysql2 returns them as strings).
- Foreign keys are `RESTRICT`, `CASCADE` only for pure children.
- Migrations: `SchemaV1` (all tables) and `SeedV1` (58 wilayas, settings defaults, sequences
  `booking`, `academic_request`, `dispute`, `invoice_<year>`, first admin with argon2id), then
  `MessagesFulltext` (FULLTEXT on `messages.body`) and `ParticipantsReadPrecision`
  (`conversation_participants.last_read_at` datetime(6)) for module 11, and
  `ReportsSystemReporter` (`reports.reporter_id` nullable: null = automatic report from the
  review / reply flag scan) for module 12.
- The pre-v1 generated entities and migrations are kept for reference in
  `_archive/schema-v0/` (excluded from build, lint and tests).

```bash
pnpm migration:generate src/database/migrations/DescribeTheChange
```

Add each generated class to `src/database/migrations/index.ts` (explicit lists: globs resolve
differently under ESM from `src` and `dist`). A clean schema reports "No changes" on
`migration:generate`. On a server: `pnpm build && pnpm migration:run:prod`.

## Foundation building blocks

| Need | Use |
| --- | --- |
| Throw an error | `throw new AppException(409, 'CODE', details)` or `AppException.of('CODE')`; add codes with EN + AR text to `src/common/errors/error-codes.ts` |
| Error body | `{ statusCode, error, code, message, details, path, timestamp, requestId }`; `message` follows `Accept-Language` (`en`/`ar`); validation errors are `400 VALIDATION_FAILED` with `details: [{ field, code, message }]` |
| Transaction + events | `runInTransaction(dataSource, async (em, afterCommit) => …)`; `domainEvents.emitAfterCommit(afterCommit, 'booking.accepted', payload)` |
| Audit log | `auditService.log({ action, objectType, objectId, objectLabel, level, changes, note }, em)`; actor, IP, user agent and request id come from the request context |
| Settings | `settingsService.get('platform_fee_percent')` / `getMany([...])`, typed, cached 30 s, defaults for missing rows |
| References | `sequencesService.next('booking', em)` → `EVT-000123` (`SELECT … FOR UPDATE`); `ACR-`, `DSP-`, `INV-YYYY-NNNN` |
| Files | `filesService.store({ buffer, originalName, purpose, ownerId }, { em, afterCommit })`; `filesService.signedUrl(id, { variant })`; served by `GET /api/v1/files/:id?variant&exp&sig` |
| Jobs | `queueService.registerHandler(JOBS.x, handler)` in `onModuleInit`; `queueService.add(JOBS.x, data)` |
| Mail | `mailService.enqueue({ to, template, lang, data })`; templates in `src/mail/templates` |
| Push | `pushService.send(targets, message)` (logging stub, `PushProvider` interface for FCM) |
| Auth | global `JwtAuthGuard` (routes private by default), `@Public()`, `@Roles(UserRole.Admin)`, `@CurrentUser()` |
| Swagger | `@ApiErrorResponses('CODE', …)`, `@ApiAuthErrors()`, `@ApiPaginatedResponse(Dto, { counts: TabCountsDto })` |
| Exports (STA-05) | `exportRegistry.register({ resource, screens, filters: FiltersDto, columns, count, fetch })` in `onModuleInit`; `POST /admin/exports` does the rest (sync below 5,000 rows, else queued + emailed) |
| Helpers | `src/common/dto/transforms.ts`: `trim`, `trimToNull`, `toArray` (multi-value query params), `uuidParam('X_NOT_FOUND')`, `intParam(…)`, `likeContains(q)` |

Every request gets an `x-request-id` (an incoming well-formed one is reused) and one log line:
request id, user id, method, route pattern, status and duration. Bodies, query strings and
headers are never logged.

### Files and photos

- Photos (`avatar`, `service_photo`, `pack_photo`) are public; they are checked against
  `allowed_image_types` and `max_photo_upload_mb`, then a queue job rotates them upright,
  strips EXIF, converts to WebP capped at `photo_max_dimension_px` with `photo_quality`, and
  writes `thumb` (320 px) and `medium` (800 px) variants. The original is deleted.
- Documents, evidence, attachments, messages, invoices and exports are private, stored as
  uploaded (PDF, JPEG, PNG, WebP, HEIC, max `max_document_upload_mb`) and only served through
  a signed URL (HMAC-SHA256 over id, variant and expiry).
- MIME types are sniffed from the content (`file-type`), never taken from the extension.
- The prebuilt `sharp` binaries cannot decode HEIC photos; such uploads end as
  `processing_status = failed` (a `file.processing_failed` event is emitted).

### Database time zone

MySQL evaluates `CURRENT_TIMESTAMP(6)` defaults and `ON UPDATE` in the session time zone. The
pool (`mysqlUtcDriver` in `src/database/database.options.ts`) runs `SET time_zone = '+00:00'` on
every new connection, so DB-defaulted and JS-written timestamps are both UTC whatever the
server's zone (AMPPS runs at UTC+1). Rows written before this fix are one hour ahead.

### Modules 2 and 3

- **Settings** (`src/settings`): `settings.registry.ts` holds each key's section, type, limits and
  sensitivity; `PATCH /admin/settings` validates through it, asks for `confirm` on sensitive keys,
  checks `expectedUpdatedAt` and invalidates the cache after commit.
- **Activity log** (`src/activity-log`), **exports** (`src/exports`, xlsx via exceljs, loaded lazily),
  **saved views** (`src/saved-views`).
- **Catalogue** (`src/catalog`): categories, wilayas, communes + CSV import
  (`communes-csv.ts`). Uploads are limited by `UPLOAD_THROTTLE_LIMIT` (default 30/min).
- **Communes are not seeded**: no verified FR + AR list of the 1,541 communes was available.
  Import them with `POST /admin/communes/import` (template: `GET /admin/communes/import/template`).

### Modules 8 and 11

- **Bookings** (`src/bookings`): `bookings.policy.ts` holds the status matrix (status-rules §5), money in
  cents (lines, totals, fee) and the timing rules; `BookingsService.applyTransition` is the single place
  a status changes (status row, availability, invoice, counters, chat, audit, `booking.<status>` event).
  Account block / delete and service / pack deletion cancel pending bookings through
  `BookingsService.cancelPendingFor`. Availability: the provider row is locked (`SELECT … FOR UPDATE`),
  then held / booked rows are counted against `max_events_per_day` (packs: the smallest among their items)
  and manual blocks are checked.
- **Invoices**: numbered `INV-YYYY-NNNN`, versioned on price changes (the old version is soft-deleted),
  issuer copied from `invoice_issuer`. PDFs are drawn with `pdfkit` (English layout) by the
  `invoices.render-pdf` job, or on first download. Arabic names and titles use the bundled
  `assets/fonts/NotoNaskhArabic-*.ttf` (SIL OFL); a single string mixing Arabic and Latin words is not
  bidi-reordered.
- **Jobs** (hourly, idempotent): provider reply reminders at deadline − 12 h (`booking_auto_reminder`),
  auto-completion at event end + `dispute_window_hours` unless a dispute is open, review requests after
  `review_open_after_hours`. The "no reply" flag is derived from `created_at`, never stored.
- **Messages** (`src/messaging`): `contact-masking.ts` fills `messages.body_masked` on every insert
  (Algerian phones in any spacing, Arabic-Indic digits, emails, links, WhatsApp / Telegram / Instagram
  handles). Participants see the original once the pair has an accepted or completed booking
  (computed, `contactUnmasked`); admins always get both. Socket.IO namespace `/admin` on the API port:
  connect with `auth: { token: '<admin access token>' }`; events `message:new`, `message:updated`,
  `conversation:updated`; `conversation:join { conversationId }` subscribes to one thread.

### Module 9: disputes

- **Disputes** (`src/disputes`): `disputes.policy.ts` holds the window rule (event start → event end +
  `dispute_window_hours`, or 7 days after a cancellation; admins can override with `ignoreWindow` + note),
  the resolution outcome → booking actions mapping and the allowed actions. Opening sets booking
  `dispute_status=open` (the auto-complete and review-request jobs skip it), creates the `dispute`
  conversation (client + provider + support) and attaches the booking chat as a `chat_snapshot` evidence.
- **Resolve** applies the outcome through `BookingsService.applyTransition` (completed; cancelled by admin with
  reason `dispute`, a completed booking is reopened first; unchanged) and sets `dispute_status=resolved`: that
  stored flag is how a later review gets `had_dispute`. **Close** puts `dispute_status` back to `none`
  (or `resolved` if an earlier dispute on the booking was resolved), so auto-completion resumes.
- **Job** (hourly): the dispute chat is closed 7 days after the dispute is resolved or closed.
### Module 10: academic requests & forms

- **Forms** (`src/academic`): `form-schema.ts` validates builder schemas (draft = structure, publish = required
  mappings `title`, `event_date`, `wilaya`, `requester_name`, `requester_phone` + EN/AR labels); publishing writes an
  immutable `form_versions` row and each request keeps its version. `form-answers.ts` is the server-side answer
  validator (showIf, required, formats, limits, files) shared by submissions and edit links.
- **Public** `/forms/:slug` (no auth, throttled): email code (`verification_codes` purpose `form_submission`),
  uploads with a 1 h signed upload token, submission (`ACR-…`), edit link token stored in `requested_changes`.
- **Requests**: proposals, booking a proposal creates / links the client account and books through
  `BookingsService.createInTransaction`; hourly job in_progress → completed.

- **Notifications**: `NotificationsService` (`src/notifications`) writes `notifications` rows and sends a push
  (stub); dispute emails use the `case-update` template; socket event `dispute:new` on `/admin`.

## Queues and cron

`QueueModule` hides the driver:

- **`REDIS_URL` set** (staging, production): BullMQ queue `eventor` on Redis with a worker in
  the API process (concurrency 4, exponential backoff, failed jobs kept).
- **`REDIS_URL` empty** (dev machine without Redis, tests): the **inline driver**.
  `queueService.add()` runs the handler immediately in-process and awaits it, retrying up to
  `attempts`; failures are logged and never thrown to the caller. There is no persistence or
  delay, so a crash loses in-flight jobs; that is fine locally, not in production.

`/api/v1/health/ready` reports which driver is active. Cron uses `@nestjs/schedule`
(`@Cron` methods should only enqueue jobs). Handlers must be idempotent.

## Security

What the API does by default, and where to change it.

- **Authentication.** Every route is guarded: `JwtAuthGuard` and `RolesGuard` are global
  (`APP_GUARD` in `AuthModule`), so a route is only reachable without a token when it is
  explicitly marked `@Public()`. The full list is six controllers — admin auth, public
  catalog, public forms, file download, health, and nothing else; `pnpm spec:export` makes
  any addition visible in the diff. Access tokens are HS256, 15 min, and carry the session
  id: revoking the session (`sessions.revoked_at`) kills the token immediately. Refresh
  tokens live in an httpOnly, `SameSite=Strict`, `Secure`-in-production cookie scoped to
  `/api/v1/admin/auth`, are hashed at rest, and rotate on every use — replaying a rotated
  token revokes the whole session.
- **Passwords.** argon2id with the parameters pinned in `ARGON2_OPTIONS`
  (`src/auth/password.service.ts`): 64 MiB, 3 passes, 4 lanes, well above the OWASP
  minimum, and pinned so a dependency bump cannot silently weaken them. `verify()` hashes a
  dummy password for unknown accounts so the response time does not reveal whether an email
  exists. 5 failed attempts within 15 min lock an account for 15 min.
- **Rate limits.** Global `THROTTLE_LIMIT` (100/min per user or IP, `UserOrIpThrottlerGuard`),
  with tighter per-group overrides defined once in `src/common/http/throttles.ts`:
  `AUTH_THROTTLE` (10/min) on `/admin/auth/*` and the public form code / submit routes,
  `UPLOAD_THROTTLE` (30/min) on every multipart route, `MAIL_THROTTLE` (20/min) on the admin
  routes that email a third party. Import the constants rather than redefining them.
- **Anti-enumeration.** `POST /admin/auth/forgot` always answers 202 whether or not the
  email belongs to an admin, and the public form email-code route returns the same shape for
  any address, with a 60 s per-email resend brake on top of the IP limit.
- **Input.** The global `ValidationPipe` runs with `whitelist` **and**
  `forbidNonWhitelisted`, so an unknown body field is a 400 rather than a silent
  mass-assignment. `BODY_LIMIT` (1 MB) caps JSON and urlencoded bodies; multipart routes add
  `uploadLimits(maxMb)` (file size, one file, 20 small fields), so a multipart body cannot
  smuggle megabytes of fields past the JSON cap.
- **Uploads.** The declared `Content-Type` is ignored: `checkUpload()` sniffs the real type
  from the bytes (`file-type`) and rejects anything outside the allowlist, then enforces the
  `max_photo_upload_mb` / `max_document_upload_mb` platform settings. Downloads always send
  `X-Content-Type-Options: nosniff`, and non-image, non-PDF files are sent as attachments.
- **File URLs.** Private files need an unexpired HMAC signature (`FILES_SIGNING_SECRET`,
  `FILES_URL_TTL`, 15 min), compared with `timingSafeEqual`; they are served `no-store` and
  framed only by the dashboard origin. Public photos are cacheable and need no signature.
- **SQL.** Raw SQL is used for the heavy list queries, but every value is a bound `?`
  parameter. The only interpolated fragments are constants or whitelisted identifiers:
  `toOrder(sort, ALLOWED_FIELDS, fallback)` (`src/common/pagination/sort.ts`) rejects any
  sort field an endpoint did not declare with 400 `SORT_FIELD_NOT_ALLOWED`. Keep it that
  way — never interpolate a request value into SQL.
- **Headers and CORS.** `helmet()` with `crossOriginResourcePolicy: cross-origin` (the
  dashboard loads files from another origin), `x-powered-by` off, and CORS strictly from
  `CORS_ORIGINS` — the same allowlist is applied to Socket.IO by `CorsIoAdapter`, which also
  caps WebSocket frames at 100 KB. In production `validateEnv` refuses `CORS_ORIGINS=*`,
  refuses dev or under-32-character secrets, and refuses reusing one secret for both jobs.
- **Logs and errors.** One line per request: request id, user id, method, matched route
  pattern, status, duration — never bodies, headers or query strings, so passwords, tokens
  and signed-URL signatures stay out of the logs. `AllExceptionsFilter` is the only error
  shape: a 5xx returns the generic catalogue message and the request id, with the stack
  logged server-side only.
- Behind nginx the app trusts exactly one proxy hop (`trust proxy 1`), so rate limits and
  audit entries see the real client IP.

## Performance

`pnpm perf:seed` then `pnpm perf:check` measure the admin lists on production-like volumes
(50k bookings, 50k users, 20k services, 20k reviews, 100k audit entries) — 30 sequential
requests per endpoint after two warm-ups, target **p95 < 300 ms**.

p95 in milliseconds, on a dev laptop with MySQL 8 on the same machine (a VPS with
warm buffers should be no worse). **Before** = the same database with the five
`AdminListIndexes` indexes dropped; **after** = with the migration applied.

| Endpoint | p95 before | p95 after |
| --- | ---: | ---: |
| `GET /admin/users` | 55.0 | 58.1 |
| `GET /admin/users?q=…` | 257.4 | 238.6 |
| `GET /admin/users?tab=providers&sort=createdAt:desc` | 54.3 | 53.7 |
| `GET /admin/services` | 145.5 | 125.1 |
| `GET /admin/services?tab=published` | 135.0 | 140.5 |
| `GET /admin/bookings` | 293.0 | **51.7** |
| `GET /admin/bookings?tab=pending` | 56.6 | 53.8 |
| `GET /admin/bookings?noReply=true` | 35.4 | 18.6 |
| `GET /admin/bookings?q=…` | 272.5 | 208.9 |
| `GET /admin/reviews` | 113.0 | 67.1 |
| `GET /admin/reviews?tab=reported` | 95.9 | 115.2 |
| `GET /admin/disputes` | 35.8 | 34.8 |
| `GET /admin/disputes?tab=all` | 35.8 | 33.6 |
| `GET /admin/activity-log` | 234.9 | **21.2** |
| `GET /admin/activity-log?q=…` | 268.6 | 125.0 |
| `GET /admin/search?q=…` | 134.0 | 124.4 |
| `GET /admin/search?q=PRF-…` | 82.2 | 86.3 |
| `GET /admin/search?q=EVT-…` | 43.7 | 45.7 |
| `GET /admin/overview` | 5.2 | 4.4 |
| `GET /admin/overview?range=this_month` | 5.0 | 4.3 |
| `GET /admin/nav-counts` | 4.2 | 4.7 |

The indexes that made the difference (`AdminListIndexes1789700000000`) are five
plain `created_at` / `event_date` indexes on `bookings`, `services`, `reviews`
and `audit_logs`. Every admin list sorts by a timestamp with an id tie-break in
the same direction, which InnoDB serves from the index (the primary key is part
of every secondary index) instead of sorting 50k–100k rows per request: the
bookings list drops from 293 ms to 52 ms and the activity log from 235 ms to
21 ms. The remaining differences are measurement noise — the other endpoints
already filter on a selective column before sorting.

The overview and nav-counts numbers are cached KPI reads; their first,
cold-cache call is ~200 ms and is reported separately by `perf:check`.

## Deployment

Deployment artefacts live in [`deploy/`](deploy/): a multi-stage `Dockerfile`,
`docker-compose.yml` (api + MySQL 8 in UTC + Redis 7), `nginx/eventor.conf`,
`ecosystem.config.cjs` for PM2, `.env.production.example`, and `backup.sh` / `restore.sh`.
[`deploy/README.md`](deploy/README.md) is the step-by-step Hostinger VPS guide: server prep,
firewall, TLS with certbot, first deploy, migrations, seeding the first admin, updating,
rollback, backups and log locations. Nothing is deployed yet — the domains, SMTP
credentials and invoice issuer details are still with the client.

## Tests

- `test/utils/`: `createApp({ controllers })` boots the real `AppModule` on the test
  database; `loginAs(app, 'admin')` creates a user and mints a JWT; `expectError(res, 409,
  'CODE')`; factories `makeUser`, `makeProvider`, `makeCategory`, `makeService`, `makePack`,
  `makeBooking`, `makeInvoice`, `makeForm`, `makeAcademicRequest`, `makeDispute`,
  `makeReview`, `makeReport`, `makeConversation`, `makeMessage`, `makeNotification`,
  `makeFile`, `makeUserDocument`, `makeSession`, `makeCommune`, `makeAuditLog`.
- `pnpm test:e2e` rebuilds `DB_DATABASE_TEST` with all migrations once per run (global
  setup), uses a temp `STORAGE_ROOT`, the inline queue and the console mailer. Suites run
  sequentially and create unique rows, so they can share the database.

## Layout

```
src/
  main.ts, app.module.ts, app.setup.ts     bootstrap, modules, HTTP setup (shared with e2e)
  config/          env.ts (validated env), swagger.ts
  common/          enums, errors (AppException, codes, validation), filters, i18n,
                   events (DomainEvents), request-context (request id + logging),
                   pagination, swagger decorators
  database/        options, data-source (CLI), base entities, naming, transaction helper,
                   entities.ts, migrations/
  auth/            token service, guards, decorators (+ entities: sessions, codes, …)
  audit/ settings/ sequences/ queue/ mail/ push/ files/ health/
  users/ catalog/ verification/ services/ packs/ bookings/ academic/ disputes/
  reviews/ messaging/ notifications/ admin/ stats/       entities per module
  tools/export-openapi.ts
test/              *.e2e-spec.ts, utils/
_archive/schema-v0 pre-v1 entities and migrations (reference only)
```
