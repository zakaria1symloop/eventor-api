# API standards: definition of done for every endpoint

Every endpoint is built to this model. A module is finished only when every endpoint in it passes the checklist at the bottom. Endpoints are derived from the dashboard screens (`../../docs/admin-dashboard-screen-map.md`).

**Scope (15 Sep 2026):** **admin API only** (`/api/v1/admin/**` plus admin auth). No mobile endpoints are designed or built now. Services are written so a mobile controller can be added later without changing them.

## 1. Shape of a module

```
src/<module>/
  <module>.module.ts
  admin-<module>.controller.ts        # /api/v1/admin/<resource>   (admin only)
  <module>.service.ts                 # business rules, transactions, no HTTP
  dto/                                # request DTOs + response DTOs
  <module>.policy.ts                  # who can do what (role + ownership + status rules)
  <module>.events.ts                  # domain events emitted (→ notifications, audit, jobs)
  entities/
  tests/ <module>.service.spec.ts, <module>.e2e-spec.ts
```

Controllers are thin: they validate input, call the service and map the result to a response DTO. They never return entities directly.

## 2. Routes

- **Naming:** plural nouns in kebab-case, e.g. `/admin/academic-requests`, `/admin/users/:id`.
- **Methods:**
  - `GET` reads.
  - `POST` creates.
  - `PATCH` does a partial update.
  - `DELETE` does a soft delete.
- **State changes are action sub-resources**, never a bare `PATCH status`: `POST /admin/users/:id/block`, `POST /admin/bookings/:id/status`, `POST /admin/documents/:id/reject`. This way each one has its own DTO, policy, audit entry and notification.
- **Bulk operations:** `POST /admin/<resource>/bulk` with `{ action, ids[], ...payload }`. They run all-or-nothing and return per-id results.
- **IDs:** UUIDs. Human-readable references (`EVT-000123`) are also accepted as `:id`, where the screen shows them.

## 3. Requests & validation

- **DTOs:**
  - One class per action, validated with `class-validator`.
  - The global `ValidationPipe` uses `whitelist`, `forbidNonWhitelisted` and `transform`, so unknown fields return 400.
  - Transformations such as trim, lowercasing emails and E.164 phones happen in the DTO with `class-transformer`.
  - Enums are validated with `@IsEnum`, UUIDs with `@IsUUID('4')`, and lengths with the same limits as the DB columns.
  - Bilingual content requires `*_en` and `*_ar` when publishing and allows empty values in drafts (validation groups).
- **Lists:** `?page&limit&sort=field:dir&q=` plus filters (repeat a parameter for several values), as in api-decisions §1. Each endpoint's DTO whitelists its sort and filter fields.
- **Dates:**
  - Timestamps are ISO 8601 in UTC.
  - Event dates are `YYYY-MM-DD`, and times `HH:mm` in Africa/Algiers.
- **Money:** request and response values are strings with 2 decimals (`"45000.00"`), labelled in Swagger as DZD.
- **Uploads:** `multipart/form-data` checked by an upload pipe:
  - MIME type sniffed from the file content, not just the extension
  - size limit and photo count limit taken from `settings`
  - compression and variants produced asynchronously by a job

## 4. Responses

- **Single object:** `{ "data": { … } }`.
- **List:** `{ "data": [ … ], "meta": { page, limit, total, totalPages } }`.
- **Action:** `{ "data": <updated resource> }`, so the dashboard can update the row without refetching.
- **Nulls:** fields are always present; missing values are `null`, not omitted.
- **Response DTOs:** each object has its own response DTO, and Swagger documents exactly those DTOs. Never exposed: password hashes, tokens, internal file paths, `deleted_at`.
- **Privacy:** fields hidden by privacy rules (the budget, a client's phone number before a booking is accepted) are stripped by the response mapper for each role.

## 5. Errors

The global `AllExceptionsFilter` returns one shape everywhere:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "code": "CATEGORY_HAS_SERVICES",
  "message": "This category still has 10 services.",
  "details": { "servicesCount": 10 },
  "path": "/api/v1/admin/categories/…",
  "timestamp": "2026-09-15T10:00:00.000Z",
  "requestId": "req_9f2a71c0"
}
```

- **`code`:** a stable `UPPER_SNAKE` value that the clients switch on.
- **`message`:** translated using `Accept-Language` (en or ar).
- **Validation errors:** return 400 with code `VALIDATION_FAILED` and `details: [{ field, code, message }]`, so forms can show the error under each field.
- **Codes** are listed in `src/common/errors/error-codes.ts`, one per module with an EN and AR message, and appear in Swagger.

| Status | When |
|---|---|
| 400 | validation, malformed input |
| 401 | missing, expired or invalid token (`AUTH_TOKEN_EXPIRED`, …) |
| 403 | authenticated but not allowed (`FORBIDDEN_ROLE`, `NOT_OWNER`, `ACCOUNT_BLOCKED`) |
| 404 | not found or soft-deleted (`USER_NOT_FOUND`) |
| 409 | state conflict (`BOOKING_INVALID_TRANSITION`, `EMAIL_TAKEN`, `CATEGORY_HAS_SERVICES`, `LAST_ADMIN`) |
| 413 / 415 | upload too large / unsupported type |
| 422 | business rule failed on valid input (`PHOTO_LIMIT_REACHED`, `PROVIDER_NOT_VERIFIED`, `DATE_UNAVAILABLE`) |
| 429 | rate limited (`RATE_LIMITED`, with `Retry-After`) |
| 500 | unexpected; generic message, full error logged with `requestId` |

## 6. Security & cross-cutting

- **Auth:** routes are private by default; open routes are marked `@Public()`. `/admin/**` requires role `admin`. Mobile routes use `@Roles(...)` plus ownership checks in the policy.
- **Rate limits** (`@nestjs/throttler`):
  - global: 100 requests/min per user or IP
  - auth: 10/min per IP
  - uploads: 30/min
- **Status rules:** every state change goes through the module policy, which uses the status rules in `status-rules.md`. Invalid moves return 409.
- **Transactions:** a write that touches several tables runs in one transaction. Examples: block user (user, sessions, bookings, services, audit) and accept booking (booking, availability, invoice, audit).
- **Audit:** every admin write calls `AuditService.log({ action, object, changes, note, level })` inside the transaction, as required by the activity log screen.
- **Events:** once the transaction commits, the service emits domain events (`booking.accepted`, …). Listeners create notifications and queue jobs. Services never send emails or pushes directly.
- **Concurrency:**
  - Bookings and availability use a row lock (`SELECT … FOR UPDATE`).
  - Settings and editable forms send `updatedAt` (optimistic concurrency); a stale value returns 409 `STALE_UPDATE`.
- **Logging:** each request log line records requestId, userId, route, status and duration. Passwords, tokens and document contents are never logged.
- **Output encoding:** user text is stored raw and escaped when displayed. Review and message text is scanned for phone numbers and emails (`detected_flags`).

## 7. Swagger

Every endpoint has all of:
- **Grouping and summary:** `@ApiTags('<module>')` and `@ApiOperation({ summary, description })`. The description names the screen code(s) it serves, e.g. "Used by USR-07".
- **Auth marker:** `@ApiBearerAuth()`, or `@Public()` shown in the description.
- **Parameters:** `@ApiParam` and `@ApiQuery` for every parameter; list filters come from the query DTO.
- **Responses:**
  - the success response DTO (`ApiPaginatedResponse(Dto)` for lists)
  - **every** error status the endpoint can return, with its `code` values listed
- **Examples:** filled in on request and response DTOs, using the same fictional data as the Figma screens.
- **Export:** `pnpm spec:export` writes `openapi.json`. The Next.js dashboard generates its typed client from that file, so front and back can't drift. CI fails if the exported spec changes but isn't committed.

## 8. Tests: the model for each endpoint

Each endpoint has **e2e tests** (supertest against a real MySQL test database, recreated with migrations and seeded per suite) covering at least:

| # | Case | Expect |
|---|---|---|
| 1 | Happy path | status, response shape matches DTO, DB row changed |
| 2 | Validation: each required field missing, one wrong type, one unknown field | 400 `VALIDATION_FAILED` with field |
| 3 | No token | 401 |
| 4 | Wrong role (e.g. client token on `/admin`) | 403 |
| 5 | Not owner (mobile routes) | 403 `NOT_OWNER` |
| 6 | Not found / soft-deleted id | 404 |
| 7 | Each business rule / invalid transition | 409 or 422 with its `code` |
| 8 | Side effects: audit row written, notification queued, job queued | assert rows / queue mock |
| 9 | Lists: pagination meta, each filter, each sort, search | correct subset & order |
| 10 | Arabic: `Accept-Language: ar` returns the Arabic `message` | — |

**Unit tests** cover service and policy logic without HTTP: status transitions, fee calculations, limit checks and the rules for deriving a status from its source data.

Shared test helpers:
- factories for each entity (`makeUser({ role: 'provider' })`)
- `loginAs(role)`
- `expectError(res, 409, 'CODE')`

## 9. Performance

- **Filter indexes:** every list filter uses an index (see `db-schema.md`). A new filter needs an index or an explicit note explaining why it doesn't.
- **Page size:** lists never load relations one row at a time; they use joins or a batched `IN` query. Maximum `limit` is 100.
- **Counters:** counts shown on cards and tabs come from one grouped query per screen, not one query per tab.
- **Target:** p95 under 300 ms for list endpoints on 50k rows, checked with seeded data before a module is marked done.

## 10. Checklist per endpoint

- [ ] Route, method and name follow §2; screen code(s) noted
- [ ] Request DTO with validation and example; response DTO with example
- [ ] Policy: role, ownership and status rule
- [ ] Transaction where more than one table is written
- [ ] Audit log (admin writes) and domain event
- [ ] Error codes defined (EN and AR) and documented in Swagger
- [ ] Swagger complete (§7), `openapi.json` exported
- [ ] e2e cases 1–10 that apply, plus unit tests for the rules
- [ ] Indexes checked for filters and sorts
- [ ] ERP task updated with the endpoint list and Swagger link (backend: Symloop Admin; dashboard: Yacoub)
