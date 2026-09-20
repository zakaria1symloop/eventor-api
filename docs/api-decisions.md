# API decisions

> **Partly superseded on 15 Sep 2026.** Where this file disagrees with `tech-decisions.md`, `status-rules.md` or `db-schema.md`, those files win. Specifically:
> - **§5 (one conversation per user):** conversations now have participants and kinds direct / support / dispute.
> - **Languages:** EN + AR, not AR/FR.
> - **Stack:** Next.js + NestJS on a Hostinger VPS.
> - **§3 events and view tracking:** deferred to V2.
> - **§4 invoices:** still valid; payment is cash.
>
> Still valid: §1 pagination, §2 immutable role, §6 single admin role, and the "Rules that follow from the screens".

Contract-level decisions for the Eventor admin API, taken 10 September 2026 from the
Figma admin dashboard (`5GRFrMfyv979o63DSFXLjB`, page *admin Dashboard*) and the design
audit. Each one changes the shape of several endpoints, so they are recorded here rather
than left to whoever writes the first controller. Change one only by editing this file
and telling the dashboard and mobile teams.

## 1. Lists are offset-paginated and return totals

Every list endpoint accepts `?page=1&limit=20` (limit max 100) and optional
`?sort=<field>:asc|desc` against a per-endpoint whitelist. Filters are repeated query
parameters (`?role=client&role=provider`). Every list responds with one envelope:

```json
{ "data": [], "meta": { "page": 1, "limit": 20, "total": 2847, "totalPages": 143 } }
```

*Why:* the tables show "Showing 11–20 of 116" and numbered pages, which needs a total and
random access. Cursors cannot provide either. One shape for all seven lists.

## 2. The role is immutable

`PATCH /admin/users/:id` rejects a `role` field with 400. An account created with the
wrong role is removed and the person registers again.

*Why:* the mobile app promises "cannot be changed later", the backend already enforces it,
and switching would have to migrate provider documents or academic institution data
across incompatible shapes.

## 3. Statistics needs exactly two client events

The mobile app posts two events to `POST /events`:

| type | when | payload |
| --- | --- | --- |
| `service_view` | a service detail screen opens; deduplicated per user, service and day | `serviceId` |
| `search` | a search is run on the home screen | `query`, `categoryId?`, `wilaya?` |

Stored in one `events` table (`type`, `actorId?`, `subjectId?`, `metadata` JSON,
`createdAt`). A nightly job rolls them into `stats_daily`. Everything else on the
Statistics page derives from bookings and reviews: funnel = views → requests → accepted →
completed; demand heatmap, top wilayas and revenue by category from bookings; rating
breakdown from reviews. Widgets show "—" until data exists.

*Why:* this is the whole "analytics pipeline" — one table, one endpoint, one job.

## 4. Invoices are snapshots issued by Eventor on the provider's behalf

An invoice is created when a booking is **accepted**, numbered `INV-YYYY-NNNN`
(sequential per year), and never changes afterwards: parties, service, amount and the
platform fee (setting `platform_fee_percent`, default 10) are copied in at that moment.
The PDF is rendered server-side, stored under `STORAGE_ROOT`, and served at
`GET /admin/bookings/:id/invoice.pdf`. "Send to client" emails it. No payment status in
v1 — the document states that payment is collected by the provider on the day.

*Why:* payment is out of scope for v1, so the invoice is a record, not a bill; a snapshot
means a later price edit cannot rewrite history.

## 5. One conversation per user, with optional context

`conversations` are keyed by the user (admin ↔ `userId`). Messages carry an optional
`context` — `request:<id>` for an academic request, `verification` for provider
documents — shown as a chip in the thread. One Socket.IO room per conversation.

*Why:* "Message provider", "Message requester" and the request thread all open the same
table and the same drawer. A thread owned by a request cannot cover the provider case.

## 6. One admin role

There is a single `admin` role and no tiers. Any admin can do everything the dashboard
shows, including creating and suspending other admins (self-suspension and suspending
the last active admin stay blocked). The former "Super Admin" label has been removed
from the design.

*Why:* nothing in the product needs a second level yet; adding one later is additive.

## Rules that follow from the screens

- **Deleting a category** that still has services returns **409** with the count.
- **Removing a user** is a soft delete; personal data is anonymised after 30 days and
  their bookings and reviews remain, attributed to "Deleted user".
- **Global search** covers users (name, email, phone), services (name), bookings
  (reference, client name) and academic requests (reference, requester); it returns the
  top 5 per group, and Enter opens the matching list filtered.
- **Notifications** are persisted rows pushed over the existing socket as
  `notification:new`; `GET /admin/notifications/unread-count` feeds the bell.
- **Every admin action** (block, unblock, remove, approve, reject, validate, hide, cancel)
  writes an audit row with the acting admin. The Activity page reads from it.
- **Reject reasons** are an enum plus an optional note (`reason`, `note?`), with Arabic
  copy for each value, because the mobile app shows them to the person rejected.
- **Document states** are `approved | pending | rejected` everywhere; "Undo" on an
  approved document is a transition back to `pending`.
- **Bilingual names**: services, packs and categories store `name_en`, `name_ar` and,
  where shown, `description_en`, `description_ar`.

## Scope check against the commercial offer (SYMLOOP/OFF/EVT/2026-07)

The signed offer (July 2026, 370 000 DA HT, one month, two sprints a week) defines V1 as:
mobile apps, admin dashboard, 4 roles, search and filters, booking with an availability
calendar, real-time messaging and push, reviews and favourites, Ready Packs, budget
module, academic module, a bilingual **AR / FR** interface with RTL, store publishing and
documentation. **Out of V1:** electronic payment (SATIM / CIB / Edahabia), AI
recommendations, *advanced analytics dashboard*, external integrations.

Consequences for this API:

- **Languages.** The offer says Arabic and French; the design and code say Arabic and
  English. Every `name_en` here is really `name_<second language>` — settle which
  language the second one is before the mobile app ships strings.
- **Analytics (decision 3).** The event-driven widgets on the Statistics page (views,
  searches, funnel, heatmap) fall under "tableau de bord analytique avancé", which the
  offer places in V2. Keep the `events` table design; ship the derived widgets only
  (booking status, users by role, activity, revenue by category) in V1.
- **Commission (decision 4).** No payment is processed in V1, so the platform fee is a
  figure on the invoice, not money collected. The percentage lives in **Platform
  Settings** (`platform_fee_percent`), editable by an admin, snapshotted per invoice.
- **Platform Settings** is a required admin screen the design lacked: fee percentage,
  currency and VAT, enabled languages and default language, the wilaya list, booking
  rules (cancellation window), support contact, legal links, maintenance mode. One
  `settings` key/value table, `GET/PATCH /admin/settings`, every change audited.
- **Stack.** The offer names Flutter Web + Firebase (Firestore, Auth, Storage, FCM,
  Hosting) and lists "Base de données structurée (Cloud Firestore)" as a deliverable.
  The platform is being built on NestJS + MySQL + Next.js. That is a better fit for the
  admin tables and audit trail, but it is a deviation from a signed document — the
  deliverables list should be amended with the client before hand-off.
- **Budget module and favourites** are client-side features; the dashboard needs no
  screens for them beyond what user details already show.
