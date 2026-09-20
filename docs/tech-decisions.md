# Technical decisions

Decisions taken with the product owner on 15 September 2026. They override anything older in `api-decisions.md` (for example the "Flutter Web + Firebase" stack in the offer, and "one conversation per user").

**Status:** planning. No feature code is written until every document in `docs/` is agreed.

## Stack & hosting

| Area | Decision |
|---|---|
| Admin dashboard | **Next.js** (App Router, TypeScript), reusable components (see `../../docs/dashboard-components.md`) |
| Backend API | **NestJS 12** + TypeORM + MySQL 8, REST + Swagger (`/api/v1/docs`), Socket.IO for realtime |
| Mobile | Flutter (existing app). **Out of scope for now:** no mobile API or app work until the admin side is done (`docs/mobile-screen-map.md` kept as reference) |
| Hosting | **Hostinger VPS** (Ubuntu). Nginx reverse proxy + Let's Encrypt, PM2 or Docker Compose for Node processes, MySQL on the same VPS (daily dump to off-VPS backup) |
| File storage | **VPS disk**, under `STORAGE_ROOT` (outside the web root). Files are served through the API (signed, expiring URLs for private files such as documents and invoices; public cache headers for published photos) |
| Queue / jobs | **Redis on the VPS** + BullMQ (`@nestjs/bullmq`); cron via `@nestjs/schedule` enqueuing jobs |
| Push notifications | **Firebase Cloud Messaging** (FCM HTTP v1, service account), only for push; no other Firebase product |
| Email | **Google**: Google Workspace SMTP relay (or Gmail API) with an `@eventor.dz` sender; templates in EN + AR |
| Image processing | `sharp` in a queue job (compression rules in `db-schema.md` → Files) |
| PDF (invoices) | HTML template → PDF in a queue job |

## Languages

- **Languages:** **English and Arabic** in the app, the dashboard, emails and push notifications. French is not supported.
- **Arabic layout:** right-to-left, both in the dashboard and the mobile app.
- **Stored content:** columns stay `*_en` and `*_ar`, and both are required before publishing.
- **Language choice:**
  - The API reads `Accept-Language: en|ar`, falling back to the user's `language` and then `en`.
  - Error messages and emails are returned in that language.

## Auth (standard setup)

- **Tokens:**
  - **Access token:** JWT, 15 min, sent as `Authorization: Bearer`.
  - **Refresh token:** opaque, 30 days. It rotates on every refresh and is stored hashed in `sessions`. Reusing a revoked token revokes the whole session family.
- **Separate login audiences:**
  - `POST /auth/login` accepts client, provider and academic accounts, from the mobile app.
  - `POST /admin/auth/login` accepts admin accounts only, from the dashboard. The dashboard keeps its refresh token in an httpOnly, Secure, SameSite=Strict cookie.
- **Roles:** `client` and `provider` sign up in the app. `admin` is created by invitation only. There is no academic role; academic requests are a form (status-rules §7).
- **Phone:** the app accepts `0XXXXXXXXX`; the API normalises it to `+213XXXXXXXXX`. The phone is not verified (no SMS in V1).
- **Passwords:**
  - argon2id hashing.
  - Minimum 10 characters, including at least one letter and one digit.
  - Checked against a list of common passwords.
- **Email verification:** a 6-digit code emailed at sign-up, valid 15 min, max 5 tries. Resending is allowed after 60 s.
- **Forgot password:** emailed link or code, valid 1 h, single use. Resetting revokes all sessions.
- **Lockout:** 5 failed logins per email in 15 min locks the account for 15 min. There is also a per-IP rate limit.
- **Guards:** a global `JwtAuthGuard`, with `@Public()` for opening routes, `@Roles()` for role checks, and ownership checks inside services.
- **Blocked users:** login is refused and existing sessions are revoked at the moment of blocking.

## Notifications (standard setup)

Channels:
- **In-app:** a row in `notifications` plus a `notification:new` socket event.
- **Push:** FCM to the user's `device_tokens`.
- **Email:** for account-level events only.

Every event is sent in the recipient's language. Users can mute push per category in the app; security emails can't be muted.

The event → recipient → channel matrix is part of the status-rules document (one line per transition).

## Background jobs (standard setup)

| Job | Trigger |
|---|---|
| Image compression + variants | on upload |
| Invoice PDF render | booking accepted / price changed |
| Send push / email | on notification create |
| Booking reply reminder | hourly: pending > `booking_reply_deadline_hours` − 12 h |
| Booking no-reply flag | hourly: pending > deadline |
| Auto-complete bookings | daily: accepted and event date passed + 24 h |
| Open review request | after `review_open_after_hours` from completion |
| Anonymise deleted users | daily: soft-deleted > 30 days |
| Stats rollup (`stats_daily`) | nightly |
| Large exports | on request |
| Cleanup expired sessions / resets / invitations | daily |
| Recompute pack `needs_attention` | on service hidden or deleted, or provider blocked |

Each job is idempotent: it can be retried safely and logs its failures. Failed jobs stay visible in a Bull board, protected by admin auth.

## Domains

Not chosen yet. Everything reads them from env: `APP_PUBLIC_URL` (web forms `/f/:slug`), `ADMIN_URL`, `API_URL`, `CORS_ORIGINS`, `MAIL_FROM`. Nothing is hard-coded.

## Invoices

Issued by **Eventor** as record documents. Payment is cash, with no payment status and no cancellation fees. Company details (name, address, NIF, RC) come from the `invoice_issuer` setting and are still to be provided.

## Team

- **Backend and dashboard:** Symloop Admin (ERP user id 1).
- **Yacoub:** has stopped working on the project, so no tasks are assigned to him.

## Environments

- **local:** AMPPS MySQL, local Redis, a mail catcher.
- **staging:** Hostinger VPS, subdomain `staging.`.
- **production:** Hostinger VPS.

Secrets are kept in `.env` on the server and never committed.
