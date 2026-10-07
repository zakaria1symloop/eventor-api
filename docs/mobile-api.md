# Mobile API: the contract

The Eventor mobile app talks to `/api/v1/app/**`. This is everything you need
to call it; the exact shapes are in `openapi.json` (generate your client from
it — do not hand-write models).

| | |
| --- | --- |
| Base URL | `{API_URL}/api/v1` (local: `http://localhost:3000/api/v1`) |
| Swagger UI | `{API_URL}/api/v1/docs` |
| OpenAPI JSON | `{API_URL}/api/v1/docs/openapi.json`, committed as `backend/openapi.json` |
| Tags | `app-auth`, `app-me`, `app-catalog`, `app-bookings`, `app-provider`, `app-messages`, `app-reviews`, `app-config` |
| Socket.IO | `{API_URL}/app` (§11) |

**Part 1 is auth + client browsing; part 2 is everything else** — bookings,
messaging, reviews, reports, disputes and the whole provider side. Both are
built. The screen map (`../../docs/mobile-screen-map.md`) is the other half of
this document: it says which screen each endpoint serves.

## 1. Authentication

### The flow

```
Splash ──► GET /app/config                    force-update / maintenance check
       └─► POST /app/auth/refresh {refreshToken}   restore the session, or:

Register (08/08a) ──► POST /app/auth/register ──► 201 {userId, emailSentTo, expiresAt}
                                                   (no tokens yet)
Verify code (10)  ──► POST /app/auth/verify-email {email, code}
                                              ──► 200 {accessToken, refreshToken, user}
Provider only (08a) ─► POST /app/me/documents  × 3   (needs the token above)

Login (07)        ──► POST /app/auth/login    ──► 200 {accessToken, refreshToken, user}
Forgot (09)       ──► POST /app/auth/forgot   ──► 202 (always)
Check code (10a)  ──► POST /app/auth/reset/verify {email, code} ──► 204 (code NOT consumed)
Reset (10a)       ──► POST /app/auth/reset {email, code, password} ──► 204, sign in again
```

- **Access token**: JWT, **15 min**, `Authorization: Bearer <token>`, audience
  `app`. `expiresIn` on every auth response is its lifetime in seconds.
- **Refresh token**: opaque, **30 days**, returned **in the response body** —
  mobile has no cookie jar, unlike the dashboard. Keep it in the **iOS keychain
  / Android keystore**, never in plain preferences or in a log.
- **Rotation**: every `POST /app/auth/refresh` returns a *new* refresh token and
  invalidates the one you sent. Store the new one before using it. Replaying an
  already-rotated token is read as a theft signal and **revokes the whole
  session** — you get `AUTH_REFRESH_INVALID` and must send the user to Login.
  Serialise refreshes: two parallel refreshes with the same token will log the
  user out.
- **Sign out**: `POST /app/auth/logout` with the refresh token (or just the
  bearer). Always 204. Call `DELETE /app/me/device-tokens/{token}` **first**, or
  the next user of that phone gets these pushes.
- **Audience separation**: a token minted here is refused by `/admin/**`, and a
  dashboard token on `/app/**` gets **403 `FORBIDDEN_AUDIENCE`**. There is no
  admin access to the app API and no app access to the dashboard API.

### The cases the UI must handle on login

| Code | Status | What to do |
| --- | --- | --- |
| `INVALID_CREDENTIALS` | 401 | "Wrong email or password" — never say which. |
| `EMAIL_NOT_VERIFIED` | 403 | `details.email`. Go to screen 10 and call `verify-email/resend`. |
| `ACCOUNT_BLOCKED` | 403 | `details: { reason, message, blockedUntil }`. Show `message` (the admin's own words); `blockedUntil` is an ISO date-time, null for an indefinite block. The same details come back on every authenticated call a blocked account makes. |
| `ACCOUNT_LOCKED` | 429 | `details.retryAfterSeconds` — count down, do not retry silently. |
| `ROLE_NOT_ALLOWED_IN_APP` | 403 | An admin account; only client and provider sign in here. |

### Email codes

6 digits, valid **15 minutes**, **5 attempts**, resend after **60 s**. A wrong
code returns `CODE_INVALID` *and burns an attempt*; the 6th try returns
`CODE_EXPIRED` even if it is right — offer "Resend" at that point. `resend`
inside the brake returns 429 `CODE_RESEND_TOO_SOON` with
`details.retryAfterSeconds`.

`forgot` and `verify-email/resend` **always answer the same way** for an unknown
address, on purpose: never tell the user "no account with that email".

**Checking a reset code early**: `POST /app/auth/reset/verify {email, code}`
answers 204 when the code is valid **without consuming it** — call it before
asking the user to type a new password twice. A wrong code still burns one of
the 5 attempts; the errors are the same `CODE_INVALID` / `CODE_EXPIRED`.

### Accounts an admin created

They have no password and were emailed `{APP_PUBLIC_URL}/set-password?token=…`.
Handle that deep link with `POST /app/auth/set-password {token, password}`,
which sets the password, marks the email verified and signs in.

## 2. Errors

One shape, everywhere:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "code": "EMAIL_TAKEN",
  "message": "This email address is already in use.",
  "details": null,
  "path": "/api/v1/app/auth/register",
  "timestamp": "2026-09-20T10:00:00.000Z",
  "requestId": "req_9f2a71c0"
}
```

**Switch on `code`, never on `message`** — the message is prose in the caller's
language and may be reworded. Show `message` to the user as-is. Quote
`requestId` in bug reports; it is in the `x-request-id` header too.

Validation failures are `400 VALIDATION_FAILED` with
`details: [{ field, code, message }]` — render each under its field.

| Status | Means |
| --- | --- |
| 400 | validation / malformed input |
| 401 | no, expired or revoked token (`AUTH_TOKEN_EXPIRED` → refresh once, then re-login) |
| 403 | authenticated but not allowed (`FORBIDDEN_ROLE`, `FORBIDDEN_AUDIENCE`, `NOT_OWNER`, `ACCOUNT_BLOCKED`, `EMAIL_NOT_VERIFIED`) |
| 404 | not found, soft-deleted, **or not visible to you** |
| 409 | state conflict (`EMAIL_TAKEN`, `PHONE_TAKEN`, `ACCOUNT_HAS_ACTIVE_ITEMS`) |
| 413 / 415 | upload too large / type not allowed |
| 422 | valid input, rule refused (`PASSWORD_WEAK`, `CODE_INVALID`, `NOT_A_PROVIDER`, `FAVOURITE_TARGET_INVALID`) |
| 429 | rate limited — honour `Retry-After` / `details.retryAfterSeconds` |
| 500 | our fault; show a generic message and keep `requestId` |

Codes you will meet in part 1, beyond the auth table above (part 2 adds its own list at the end of §9):
`VALIDATION_FAILED`, `RATE_LIMITED`, `SORT_FIELD_NOT_ALLOWED`, `MONTH_INVALID`,
`SERVICE_NOT_FOUND`, `PACK_NOT_FOUND`, `PROVIDER_NOT_FOUND`, `CATEGORY_NOT_FOUND`,
`WILAYA_NOT_FOUND`, `USER_NOT_FOUND`, `SESSION_NOT_FOUND`, `FILE_NOT_FOUND`,
`FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED`, `CURRENT_PASSWORD_INVALID`,
`PASSWORD_WEAK`, `PHONE_TAKEN`, `EMAIL_TAKEN`, `NOT_A_PROVIDER`,
`PROVIDER_FIELDS_REQUIRED`, `PROVIDER_FIELDS_NOT_ALLOWED`, `FAVOURITE_NOT_FOUND`,
`FAVOURITE_TARGET_INVALID`, `BUDGET_NOT_FOUND`, `BUDGET_ITEM_NOT_FOUND`,
`BUDGET_ITEM_LIMIT`, `DEVICE_TOKEN_NOT_FOUND`, `ACCOUNT_HAS_ACTIVE_ITEMS`,
`RESET_TOKEN_INVALID`, `RESET_TOKEN_EXPIRED`, `CODE_INVALID`, `CODE_EXPIRED`,
`CODE_RESEND_TOO_SOON`. The full list with both messages is in
`src/common/errors/error-codes.ts`, and every operation in Swagger names the
codes it can return.

## 3. Language

Send **`Accept-Language: ar`** or **`en`** on every request (q-values are
honoured). The API falls back to the signed-in account's `language`, then `en`.
The same header picks the language of `message` in errors.

Every localised object carries **three** fields: `title` (resolved for you),
`titleEn` and `titleAr` — likewise `name`/`nameEn`/`nameAr`,
`description`/`descriptionEn`/`descriptionAr`. Use the resolved one; the pair is
there for screens that print both. **A half-translated row falls back to the
other language rather than returning an empty string**, so never treat a blank
`titleAr` as missing data.

Changing the language in Profile is `PATCH /app/me {language}` *and* your local
setting: the stored one drives emails and push.

## 4. Pagination

Every list takes `?page=1&limit=20` (max **100**) and answers:

```json
{ "data": [ … ], "meta": { "page": 1, "limit": 20, "total": 2847, "totalPages": 143 } }
```

For infinite scroll, request `page + 1` until `page === totalPages`. Search
ordering is `?order=` with a fixed vocabulary (`relevance`, `price_asc`,
`price_desc`, `rating`, `popular`, `newest`), **not** the admin `sort=field:dir`.

## 5. Photos and files

- Photo objects carry `thumbUrl` (320 px), `mediumUrl` (800 px) and `largeUrl`;
  cards carry a single `coverUrl`. All WebP. Use `thumbUrl` in lists.
- **URLs are signed and expire (~15 min).** Do not cache the URL itself past a
  session or persist it in a database — cache the *bytes* keyed by the file id,
  and re-fetch the object to get a fresh URL.
- A freshly uploaded photo is processed by a background job; for a second or two
  the variants may not exist yet. Fall back to `largeUrl`, or refetch.
- **Uploads** are `multipart/form-data`. The real type is sniffed from the
  bytes, so renaming a `.exe` to `.pdf` is refused with 415. Limits come from
  `GET /app/config` (`uploads.maxDocumentMb`, `uploads.maxPhotoMb`,
  `uploads.imageTypes`, and the `limits` object below) — check locally before
  sending, and still handle 413.
- **Documents** are described **both ways** in `GET /app/config`:
  `limits.documentAcceptedMimeTypes` (what the server matches on the bytes) and
  `limits.documentAcceptedExtensions` (what a file picker filters on). Use the
  extensions in pickers; the server always decides from the MIME it sniffs.
- Documents accept PDF, JPEG, PNG, WebP and HEIC. **HEIC photos cannot be
  resized by the server**: prefer JPEG for avatars.

## 6. Money, dates and phones

- **Money** is a **string** with 2 decimals, in DZD: `"45000.00"`. Never parse
  it into a float for arithmetic you display — format it for the UI only.
- **Timestamps** are ISO 8601 **UTC** (`2026-03-14T13:00:00.000Z`). Convert to
  Africa/Algiers for display.
- **Event dates** are `YYYY-MM-DD` and **times** `HH:mm`, already in
  Africa/Algiers. Do not timezone-convert those two.
- **Phones** may be typed `0XXXXXXXXX`; the API stores and returns
  `+213XXXXXXXXX`.

## 7. Privacy rules you will notice

- Provider objects never carry a phone or an email. Clients reach a provider
  through the chat (§9), where contact details stay masked until the pair
  share an accepted or completed booking.
- Review authors appear as `"Yasmine K."`, never a full name.
- A service that is not visible answers **404, not 403** — the API does not
  confirm that a hidden thing exists.
- The **budget is private to its owner**. No admin endpoint reads it, and there
  is no route that takes somebody else's user id.

## 8. Screen → endpoint

Screens are the Figma page **Screens** (`5GRFrMfyv979o63DSFXLjB`). "part 2"
means the endpoint is not built yet.

### Auth & onboarding

| Screen | Endpoints |
| --- | --- |
| 01 Splash | `GET /app/config` · `POST /app/auth/refresh` |
| 02–06 Onboarding, Welcome, Role | none (local) |
| 07 Login | `POST /app/auth/login` |
| 08 Register · client | `POST /app/auth/register` |
| 08a Register · provider | `POST /app/auth/register` then `POST /app/me/documents` ×3 |
| 09 Forgot password | `POST /app/auth/forgot` |
| 10 Verify code | `POST /app/auth/verify-email` · `POST /app/auth/verify-email/resend` |
| 10a Set new password | `POST /app/auth/reset/verify` (check the code first) · `POST /app/auth/reset` |
| — Set password (admin-created account) | `POST /app/auth/set-password` |
| — Log out | `DELETE /app/me/device-tokens/{token}` then `POST /app/auth/logout` |

### Provider verification

| Screen | Endpoints |
| --- | --- |
| 21a Home · Provider · Pending | `GET /app/me` (`verificationStatus`) · `GET /app/me/documents` |
| 08d Resubmit documents | `GET /app/me/documents` · `POST /app/me/documents` |

### Client browsing

| Screen | Endpoints |
| --- | --- |
| 11 Home · Client | **`GET /app/home`** (one call: greeting, wilaya, categories, 2 upcoming bookings, budget summary, packs, nearby services, unread counts) |
| 11a Filters | `GET /app/categories` · `GET /app/wilayas` (rows carry `servicesCount`; ordered by it — no `position`) |
| — Search | `GET /app/services?q&categoryId&wilaya&priceMin&priceMax&rating&eventDate&order&page` (repeat `categoryId` and `wilaya` for several values) · `POST /app/events` |
| 12 Service detail | `GET /app/services/{id}` · `GET /app/services/{id}/availability?month=YYYY-MM` · `GET /app/services/{id}/reviews` · `POST /app/me/favourites` / `DELETE /app/me/favourites/{id}` · `POST /app/events` |
| 13 Provider profile | `GET /app/providers/{id}` · `GET /app/providers/{id}/reviews` |
| 17 Favorites | `GET /app/me/favourites?categoryId&kind` · `DELETE /app/me/favourites/{id}` · `DELETE /app/me/favourites?serviceId=\|packId=` |
| 18 Budget | `GET /app/me/budget` · `PUT /app/me/budget` · `POST /app/me/budget/items` · `PATCH`/`DELETE /app/me/budget/items/{id}` |
| 19 Ready Packs | `GET /app/packs?eventType&wilaya&order` |
| 20 Pack detail | `GET /app/packs/{id}` · `GET /app/packs/{id}/availability?month=YYYY-MM` |
| 16 Notifications | `GET /app/me/notifications` · `GET /app/me/notifications/unread-count` · `POST /app/me/notifications/read` · `DELETE /app/me/notifications/{id}` (hard delete) · `POST /app/me/device-tokens` |
| — Profile & settings | `GET`/`PATCH /app/me` · `POST /app/me/avatar` · `POST /app/me/password` · `GET`/`DELETE /app/me/sessions` · `GET`/`PATCH /app/me/notification-preferences` · `DELETE /app/me` |
| 14 Messages, 15 Chat | see **Messaging** below |
| — Booking flow, Bookings tab, Leave a review | see **Bookings** below |

### Notes on the trickier ones

- **`GET /app/home`** needs a token and is the only personalised browse route.
  Everything else under `app-catalog` is public: browsing without an account
  works, and `isFavourite` is simply `false`. Sending a token to a public route
  is allowed and fills `isFavourite` — do send it when you have one.
- **Availability** (`?month=YYYY-MM`, one month per call) returns every day of
  the month as `available` | `busy` | `blocked`. `blocked` also covers days
  before `firstBookableDate`, which already honours the platform's minimum
  notice — grey those out rather than computing it yourself. For a **pack** the
  calendar is the intersection of all its providers, matching screen 20's "Only
  days when all providers are free".
- **Favourites**: `POST` takes exactly one of `serviceId` / `packId` and is
  idempotent (tapping ♥ twice is fine). Un-save either with the **favourite row
  id** (`DELETE /app/me/favourites/{id}`) or **by target**
  (`DELETE /app/me/favourites?serviceId=` / `?packId=`, idempotent 204). Every
  catalog card also carries `favouriteId` when you are signed in, so one DELETE
  does it. A row whose target stopped being visible stays in the list with
  `available: false` — grey the card rather than dropping it.
- **Budget**: `GET` answers 404 `BUDGET_NOT_FOUND` until the client creates one
  with `PUT`; treat that as the empty state, not an error. Every write returns
  the **whole recomputed budget**, so the header updates in one round trip.
  `DELETE /app/me/budget` (204) removes it with all its lines.
  - `totalAmount` is the client's **plan ceiling** (set in the header) and
    `plannedTotal` the sum of the lines. They may diverge on purpose: the gap is
    the "unallocated / over plan" signal, never an error. `remaining` is
    `totalAmount − spentTotal`.
  - **One line per booking**: linking a booking a second line already holds
    answers 409 `BUDGET_BOOKING_ALREADY_LINKED` with `details.itemId`. When a
    booking is **cancelled**, its line and its link are kept — the client
    decides what to do with the amount.
- **`POST /app/events`** validates and answers 202 but **stores nothing in V1**
  (analytics is V2 per the signed offer). Ship the calls; they start counting
  later. Nothing in the UI may depend on it.

## 9. Part 2: bookings, messaging, reviews, disputes, provider

Everything below is live. The rules are `status-rules.md` §5–§10; this section
is only the map from screen to endpoint, plus the traps.

### Bookings (client) — `app-bookings`

| Screen | Endpoints |
| --- | --- |
| 12 / 20 → booking sheet | `GET /app/wilayas/{code}/communes?q=` (the `communeId` picker) · `POST /app/bookings/quote` then `POST /app/bookings` |
| — Bookings tab | `GET /app/bookings?tab=upcoming\|pending\|past\|cancelled&page` |
| — Booking detail | `GET /app/bookings/{id}` |
| — Cancel | `POST /app/bookings/{id}/cancel {reason}` |
| — Reschedule | `POST /app/bookings/{id}/reschedule {date,startTime?,endTime?,reason}` |
| — Answer a proposal | `POST /app/bookings/{id}/reschedules/{rid}/accept` · `/reject` · `/withdraw` (proposer only) |
| — After the event | `POST /app/bookings/{id}/check-in {answer:"ok"\|"problem"}` |
| — Invoice | `GET /app/bookings/{id}/invoice` · `GET /app/bookings/{id}/invoice.pdf` |

- **`quote` writes nothing** and never fails on a bad date: `available` is
  `false` and `unavailableReason` is `DATE_UNAVAILABLE`, `MIN_NOTICE` or
  `PROVIDER_NOT_ACCEPTING`. Use it to grey the button; `POST /app/bookings`
  turns the same reasons into errors (409 / 422).
- `feePercent` is **informational**. Payment is cash between the two of you:
  the client owes `total` and Eventor takes nothing at the door.
- Send **`X-Platform: android | ios | web`** on `POST /app/bookings`, so
  `bookings.source` is honest. It defaults to `android`.
- **Reschedules**: either party proposes; the **other** answers with
  `/accept` or `/reject`, and only the **proposer** may `/withdraw` a pending
  proposal (403 `NOT_OWNER` the other way round, 409 `RESCHEDULE_NOT_PENDING`
  once answered). The provider's mirror routes live under
  `/app/provider/bookings/{id}/reschedules/{rid}/…`.
- Cards and details carry **`category`** (`{id, slug, nameEn, nameAr}`) from
  the booked service — "Photography · Sat 14 Mar". It is **null for a pack
  booking**: use `eventType` there.
- Every card and detail carries **`allowedActions`** — draw the buttons from it
  rather than re-deriving the status machine. The write endpoints enforce the
  same list, so the two can never disagree.
- The **tabs are derived, not stored**: `upcoming` is accepted with the event
  still ahead, `past` is completed *or* accepted with the event behind us, and
  `cancelled` holds cancelled **and declined** bookings.
- **Privacy:** the provider's phone appears only once the booking is accepted,
  and their email never does. A provider sees the client's phone and email from
  acceptance on.
- **Cancelling costs nothing.** No fee and no window are enforced; the
  service's own `cancellationPolicy` text is shown and not applied. A
  disagreement becomes a dispute.
- **Check-in** is the "All good / Report a problem" pair. `"ok"` from **both**
  parties completes the booking immediately instead of waiting out the 72-hour
  dispute window. `"problem"` deliberately answers **422
  `CHECK_IN_NOT_ALLOWED`** with `details.next` pointing at the dispute
  endpoint — reporting a problem needs a description, so it is a dispute.

### Provider — `app-provider`

| Screen | Endpoints |
| --- | --- |
| 21 / 21a Home · Provider | **`GET /app/provider/home`** (one call) |
| — Available for bookings | `PATCH /app/provider/profile {acceptingBookings}` |
| — Requests tab | `GET /app/provider/bookings?tab=requests\|upcoming\|past` · `GET /app/provider/bookings/{id}` |
| — Invoice | `GET /app/provider/bookings/{id}/invoice` · `/invoice.pdf` (accepted or completed bookings only) |
| — Accept / Decline / Complete | `POST /app/provider/bookings/{id}/accept` · `/decline {reason}` · `/complete` |
| — Cancel, reschedule, check-in | `/cancel {reason}` · `/reschedule` · `/reschedules/{rid}/accept\|reject` · `/check-in` |
| — Services tab | `GET/POST /app/provider/services` · `GET /app/provider/services/{id}` · `PATCH /app/provider/services/{id}` · `/publish` · `/unpublish` · `DELETE` |
| — Service photos | `POST /app/provider/services/{id}/photos` (multipart) · `PATCH …/photos/order` · `DELETE …/photos/{photoId}` |
| — My packs | `GET/POST /app/provider/packs` · `GET /app/provider/packs/{id}` · `PATCH /app/provider/packs/{id}` · `/publish` · `/unpublish` · `DELETE` · the same three photo routes |
| — Calendar | `GET /app/provider/availability?month=YYYY-MM` · `POST /app/provider/availability/blocks` · `DELETE /app/provider/availability/blocks/{id}` |
| — Profile | `PATCH /app/provider/profile` |
| — Reviews received | `GET /app/provider/reviews` · `POST /app/reviews/{id}/reply` · `PATCH`/`DELETE /app/reviews/replies/{id}` |

- **`GET /app/provider/home` decides which screen to draw.** `state` is
  `verified` (screen 21), `pending` or `rejected` (screen 21a) or `blocked`.
  On 21a it also returns `verificationSteps` and the whole `documents` payload
  of `GET /app/me/documents`, so the resubmit flow needs no second call.
- **Publishing and accepting need a verified, active profile** — otherwise
  **422 `PROVIDER_NOT_VERIFIED`**. Everything else (drafts, photos, packs,
  calendar, profile) works while the profile is under review.
- **Publishing runs the checklist** of status-rules §3. A refusal is
  **422 `SERVICE_PUBLISH_INVALID`** with `details.missing`, an array of
  `titleEn`, `titleAr`, `descriptionEn`, `descriptionAr`, `price`, `photos`,
  `category`, `wilayas`. Render it as a to-do list, do not re-check locally.
- You cannot remove the **last photo of a published service** (422
  `SERVICE_PUBLISH_INVALID`); unpublish it first.
- Service rows carry `priceType` ("45 000 DA · per day") and pack rows carry
  `attentionReasons` — the same values as the detail — so a list can say which
  item to fix, not just `needsAttention: true`.
- A **pack is built from your own published services** (at least two, one
  wilaya, price below the sum) — somebody else's service answers 422
  `PACK_SERVICE_OTHER_PROVIDER`.
- **Publishing a pack enforces exactly** (status-rules §4): EN **and** AR name;
  at least 2 items; every item a **published** service of yours; your account
  active and verified; the price strictly below the sum of the items; and the
  pack's `wilayaCode` **covered by every item's wilaya set**. The detail's
  `publishMissing` lists what still fails (`nameEn`, `nameAr`, `items`,
  `unpublishedItems`, `providerBlocked`, `providerNotVerified`,
  `priceNotBelowSum`, `wilayaNotCovered`). A refusal is 422
  `PACK_PUBLISH_INVALID` with `details.missing` — except the wilaya rule, which
  answers its own **422 `PACK_WILAYA_NOT_COVERED`** so the app can point at the
  wilaya picker. Note: at least one photo is **not** enforced by the server —
  treat it as a quality prompt, not a publish rule.
- Turning **`acceptingBookings` off keeps your services visible** and refuses
  new bookings. It is not a way to hide yourself.
- Everything under `/app/provider/**` is **yours only**: another provider's row
  is **403 `NOT_OWNER`**, never 404.

### Messaging — `app-messages`

| Screen | Endpoints |
| --- | --- |
| 14 Messages | `GET /app/conversations?filter=all\|unread\|booking&q&userId&page` |
| — Contact support | `POST /app/conversations/support {body}` (find-or-create my support thread) |
| 15 Chat · header | `GET /app/conversations/{id}` |
| 15 Chat · bubbles | `GET /app/conversations/{id}/messages?before&limit` |
| 12 "Message" | `POST /app/conversations {userId, bookingId?, body}` |
| 15 composer | `POST /app/conversations/{id}/messages` — JSON `{body}` or multipart `file` |
| 15 on open | `POST /app/conversations/{id}/read` |
| 15 long-press | `POST /app/messages/{id}/report {reason, note?}` |
| 12 / 13 "Report" | `POST /app/reports {targetType, targetId, reason, note?}` |

- **One direct conversation per client ↔ provider pair.** `POST
  /app/conversations` is idempotent: it reuses the existing chat and just adds
  your message. `bookingId` attaches the context card and must be a booking the
  two of you share. To know whether a chat already exists **before** writing,
  call `GET /app/conversations?userId=<their id>` — it returns only the direct
  conversation with that user, or an empty list.
- **Support**: `POST /app/conversations/support {body}` finds or creates your
  one open support thread (status-rules §10) and sends the message; an admin
  joins as "Eventor support" when they answer.
- Conversation rows carry `lastMessage` as an **object**
  `{ body, kind, mine }` — `mine` draws the "You: " prefix and
  `kind: "attachment"` the "📷 Photo" line (its `body` is the caption, possibly
  empty). The body is already masked for you.
- Message bodies are capped at `limits.messageMaxLength` (4000) from
  `GET /app/config`, on every send route.
- **Messages page backwards.** `data` is oldest-first so you append at the
  bottom; scroll up with `before = meta.nextBefore` until `meta.hasMore` is
  `false`. Note the envelope here is the **cursor page** `{ data, meta: {
  limit, hasMore, nextBefore } }`, not the numbered `page/total` one.
- **Masking is done for you.** Until the pair share an accepted or completed
  booking, `body` already contains `[phone hidden]`, `[email hidden]`,
  `[link hidden]` or `[handle hidden]` and `masked` is `true`. **The original
  text is never sent to a participant** — there is nothing to reveal client
  side. `contactUnmasked` on the conversation says when that stops.
- A message an admin hid comes back with **`removed: true`** and its `body`
  replaced by `[removed by Eventor]` — key off the flag, never the text. A
  deleted message is simply absent.
- **No participant's email or phone is ever in these payloads.** A support or
  dispute participant is named "Eventor support".
- Writing is refused with **409 `CONVERSATION_CLOSED`** (an admin closed the
  chat — a state conflict, so 409 **everywhere**, including the dispute routes)
  or **403 `CONVERSATION_READ_ONLY`** (your account is muted there). A chat you
  are not in is **403 `NOT_A_PARTICIPANT`**, never 404.
- A closed conversation says only **`closedByModeration: true`** — the admin's
  free-text reason is internal and never sent. Show your own localised "This
  conversation was closed by Eventor" line.
- **Reports are idempotent per reporter and target**: reporting twice answers
  201 with `created: false` and returns the first report's id.

### Reviews and disputes — `app-reviews`

| Screen | Endpoints |
| --- | --- |
| — Leave a review | `POST /app/bookings/{id}/review {rating, comment}` |
| — Edit it | `PATCH /app/reviews/{id}` |
| — My reviews | `GET /app/me/reviews` |
| — Provider reply | `POST /app/reviews/{id}/reply {body}` · `PATCH`/`DELETE /app/reviews/replies/{id}` |
| — Report a problem | `POST /app/bookings/{id}/disputes {type, description, evidenceFileIds?}` |
| — My disputes | `GET /app/disputes` · `GET /app/disputes/{id}` |
| — Dispute chat | `POST /app/disputes/{id}/messages {body}` (text convenience) · the normal `POST /app/conversations/{conversationId}/messages` also works, images included |
| — Evidence | `POST /app/disputes/{id}/evidence` (multipart `file`, optional `note`) |
| — Withdraw | `POST /app/disputes/{id}/withdraw {note}` |

- A review is written by the **client of a completed booking**, one per
  booking, **from 24 h after the completion until 60 days after it**, and never
  while a dispute is open. The detail's `reviewWindowOpen` and its
  `allowedActions` containing `review` are the two flags to trust. Outside the
  window: 422 `REVIEW_WINDOW_CLOSED`; already written: 409 `REVIEW_EXISTS`.
- The comment is **scanned for phone numbers, emails, links and insults**. A
  flagged review is **still published** and quietly opens a report for an
  admin — do not warn the user, and do not filter locally.
- **48 hours** to edit a review, and the same for a provider's reply
  (422 `REVIEW_EDIT_WINDOW_CLOSED`). `editable` / `replyEditable` say so.
- A review an admin hid or redacted **keeps its row** in `GET /app/me/reviews`
  with `status` telling you which — the author is never left wondering.
- A **dispute** can be opened by either party from the event start until 72 h
  after the event end, or within 7 days of a contested cancellation
  (422 `DISPUTE_WINDOW_CLOSED`), one at a time per booking
  (409 `DISPUTE_ALREADY_OPEN`). Opening one **pauses the automatic completion
  and the reviews**, attaches a snapshot of your chat as evidence and opens a
  conversation with the other party and Eventor.
- **There are no refunds and no fees.** A dispute is a way to hand the problem
  to an admin, who answers with a decision note (`decisionNote`).
- Evidence is **private to the two parties and Eventor**, one file per call,
  5 MB each, capped per party (422 `DISPUTE_EVIDENCE_LIMIT`).
- Only the person who opened a dispute can **withdraw** it, and only while it
  is open or in review (409 `DISPUTE_NOT_WITHDRAWABLE`).

### Part-2 error codes

Beyond the part-1 list: `NOT_OWNER`, `NOT_A_PARTICIPANT`,
`CONVERSATION_READ_ONLY`, `CONVERSATION_CLOSED`, `CONVERSATION_NOT_FOUND`,
`MESSAGE_NOT_FOUND`, `RECIPIENT_INVALID`, `BOOKING_NOT_FOUND`,
`BOOKING_INVALID_TRANSITION`, `BOOKING_NOT_EDITABLE`, `BOOKING_DATE_PAST`,
`DATE_UNAVAILABLE`, `BOOKING_DUPLICATE`, `MIN_NOTICE`, `PROVIDER_NOT_ACCEPTING`,
`SERVICE_UNAVAILABLE_FOR_BOOKING`, `PACK_UNAVAILABLE`, `BOOKING_EXTRA_INVALID`,
`COMMUNE_NOT_FOUND`, `COMMUNE_WILAYA_MISMATCH`, `RESCHEDULE_NOT_FOUND`,
`RESCHEDULE_NOT_PENDING`, `RESCHEDULE_PENDING_EXISTS`, `CHECK_IN_NOT_ALLOWED`,
`CHECK_IN_TOO_EARLY`, `CHECK_IN_DISPUTED`, `INVOICE_NOT_FOUND`,
`PROVIDER_NOT_VERIFIED`, `SERVICE_PUBLISH_INVALID`, `SERVICE_INVALID_TRANSITION`,
`SERVICE_HAS_BOOKINGS`, `SERVICE_IN_PACKS`, `PHOTO_LIMIT_REACHED`,
`PHOTO_NOT_FOUND`, `PHOTO_ORDER_INVALID`, `PACK_PUBLISH_INVALID`,
`PACK_INVALID_TRANSITION`, `PACK_SERVICE_NOT_FOUND`,
`PACK_SERVICE_OTHER_PROVIDER`, `PACK_HAS_BOOKINGS`,
`AVAILABILITY_DATE_PAST`, `AVAILABILITY_SERVICE_INVALID`,
`AVAILABILITY_BLOCK_NOT_FOUND`, `AVAILABILITY_BLOCK_NOT_REMOVABLE`,
`CATEGORY_HIDDEN`, `WILAYA_CLOSED`, `REVIEW_EXISTS`, `REVIEW_NOT_ALLOWED`,
`REVIEW_WINDOW_CLOSED`, `REVIEW_EDIT_WINDOW_CLOSED`, `REVIEW_NOT_FOUND`,
`REVIEW_REPLY_EXISTS`, `REVIEW_REPLY_NOT_FOUND`, `REPORT_TARGET_NOT_FOUND`,
`DISPUTE_NOT_FOUND`, `DISPUTE_ALREADY_OPEN`, `DISPUTE_WINDOW_CLOSED`,
`BOOKING_NOT_DISPUTABLE`, `DISPUTE_EVIDENCE_LIMIT`, `EVIDENCE_FILE_INVALID`,
`DISPUTE_NOT_WITHDRAWABLE`, `BUDGET_BOOKING_ALREADY_LINKED`,
`PACK_WILAYA_NOT_COVERED`, `NOTIFICATION_NOT_FOUND`, `ACADEMIC_REQUEST_NOT_FOUND`.

## 10. `GET /app/config`: the `limits` object

Beyond the version / maintenance / uploads fields, `/app/config` carries one
`limits` object the app should enforce **before** the server refuses:

| Field | Backs the error | Meaning |
| --- | --- | --- |
| `budgetItemsMax` | `422 BUDGET_ITEM_LIMIT` (with `details.max`) | Budget lines per client |
| `photosPerService` / `photosPerPack` | `422 PHOTO_LIMIT_REACHED` | Gallery sizes |
| `documentMaxMb` / `photoMaxMb` | `413 FILE_TOO_LARGE` | Upload ceilings |
| `disputeEvidenceMax` | `422 DISPUTE_EVIDENCE_LIMIT` | Evidence files per party |
| `messageMaxLength` | `400 VALIDATION_FAILED` | Message body cap (4000), on every send route |
| `eventRequestFormSlug` | — | Slug of the default published form: open `{APP_PUBLIC_URL}/f/{slug}` in a WebView; null while none is published |
| `documentAcceptedMimeTypes` / `documentAcceptedExtensions` | `415 FILE_TYPE_NOT_ALLOWED` | Documents both ways: MIME for the server, extensions for pickers |

## 11. My event requests

A request submitted through the web form **while signed in** links to the
account, and the app lists it:

| Screen | Endpoints |
| --- | --- |
| — My event requests | `GET /app/me/academic-requests` (reference, title, status, eventDate, submittedAt) |
| — Request detail | `GET /app/me/academic-requests/{id}` — the answers rendered with the request's own immutable form version |

Requests sent without an account are followed by email only. Editing answers
still goes through the emailed token link (status-rules §7); these routes are
read-only.

## 12. Notifications: types and deep links

`AppNotificationDto.type` is a **closed enum** (also in the spec):
`dispute.opened`, `dispute.message`, `dispute.evidence_requested`,
`dispute.resolved`, `dispute.closed`, `review.new`, `review.shown`,
`review.hidden`, `review.redacted`, `review_reply.hidden`,
`review_reply.shown`, `report.resolved`, `report.dismissed`,
`academic_request.cancelled`, `verification.approved`, `verification.rejected`.

**Deep links.** Web URLs (like the invite email's
`{APP_PUBLIC_URL}/set-password?token=…`, or a `data.href`) are **for
browsers**: `href` is a path relative to `APP_PUBLIC_URL`. The app should
register `APP_PUBLIC_URL` links (iOS Universal Links / Android App Links) and
handle `/set-password` and `/f/{slug}` at minimum. For everything in-app,
**never parse URLs**: notification `data` carries typed ids — `bookingId`,
`conversationId` (every `dispute.*` type carries the dispute chat's id),
`disputeId`, `requestId`, `reviewId`, `reportId` — route on `type` + ids.

Other enums that used to be free strings are now closed in the spec: the
booking timeline entry `type` (`created`, a booking status, `rescheduled`,
`checked_in`, `dispute_opened`) and the review `status`
(`published | hidden | redacted`).

## 13. Live updates: the `/app` socket

```ts
import { io } from 'socket.io-client';

const socket = io(`${API_URL}/app`, {
  transports: ['websocket'],
  auth: { token: accessToken },   // the same 15-minute app access token
});
```

- **Namespace `/app`**, same host, port and CORS policy as the API. A dashboard
  token is refused here exactly as it is over HTTP.
- A refused handshake fires **`connect_error`** whose `error.data.code` is an
  API error code: `AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID`,
  `AUTH_TOKEN_EXPIRED`, `AUTH_SESSION_REVOKED`, `ACCOUNT_BLOCKED`,
  `FORBIDDEN_AUDIENCE`, `FORBIDDEN_ROLE`. On `AUTH_TOKEN_EXPIRED`, refresh and
  reconnect; the socket does **not** refresh for you.
- On success the server emits **`ready`** `{ userId, role }`. Every socket
  automatically joins your own room — you do not subscribe to get your events.

| Event | Payload | When |
| --- | --- | --- |
| `message:new` | an app message, **already masked for you** | somebody writes in one of your chats |
| `conversation:updated` | `{ conversationId, reason }` | a message, a read, a chat created or closed |
| `booking:updated` | `{ bookingId, reference, status }` | any booking of yours moves |
| `notification:new` | the row `GET /app/me/notifications` returns | a notification is written for you |

Client → server, both acknowledged:

| Call | Answer |
| --- | --- |
| `conversation:join` `{ conversationId }` | `{ ok: true, room }`, or `{ ok: false, code: 'NOT_A_PARTICIPANT' }` |
| `conversation:leave` `{ conversationId }` | `{ ok: true }` |

Joining a room you are not a participant of is refused, so ids cannot be
guessed. You do **not** need to join to receive `message:new` for your own
chats — the room is there for screens that want only one conversation's
traffic.

**Treat the socket as an optimisation, never as the source of truth.** Reload
the list on reconnect; a dropped event must never lose a message.

`notification:new` fires for **every** notification row written for you —
including `verification.approved` / `verification.rejected` when an admin
decides on your documents — so a connected app learns about approval without
reloading. **Push (FCM) is still a logging stub**: nothing reaches a closed
app until Firebase credentials are configured server-side; the in-app rows and
this socket event are the reliable channel today.

## 14. What is still not built

- `POST /app/events` validates and answers 202 but **stores nothing in V1**
  (analytics is V2 per the signed offer). Nothing in the UI may depend on it.
- Typing indicators and presence on the socket: not implemented. Screen 15's
  "online" dot has no data behind it yet.
- The academic side of the app (screens 22, 22a, 08b, 08c) was **removed** by
  the decisions of 15 Sep 2026. "New event request" opens the admin-built web
  form `/f/:slug` in a WebView.

## 15. Rate limits

100 requests/min per user or IP globally; **10/min** on `/app/auth/*`; **30/min**
on uploads. 429 carries `Retry-After`. Back off — do not hammer `refresh` in a
loop when it fails.

## 16. Changelog

### 2026-10-07 — two provider checkboxes: "Only one booking per day" and "Allow several clients at the same time"

- "Clients at the same time" is now a checkbox too. Send **`allowSimultaneous`** (boolean) on `POST/PATCH /app/provider/services`: `true` = any number of different clients can book the same hours, `false` = one client per time slot (409 `SLOT_UNAVAILABLE` for the next). New services start with `false`.
- Service details gain `allowSimultaneous`; **`concurrentClients` is now `number | null`** (1 = one client per slot, `null` = several) and deprecated on writes, where `allowSimultaneous` wins. With `allowSimultaneous`, calendar `freeRanges` are never reduced by bookings.
- Existing services: those at 1 stay "one client per time slot"; any set above 1 now allow several.
- The provider's daily limit is now a checkbox. Send **`onePerDay`** (boolean) on `POST/PATCH /app/provider/services`: `true` = one booking a day, `false` = no daily limit (only the hours and `allowSimultaneous` limit bookings). New services start with `true`.
- Service details (`GET /app/services/{id}`, `GET /app/provider/services/{id}`) gain `onePerDay`; **`maxEventsPerDay` is now `number | null`**: 1 when ticked, `null` = no daily limit. The same on the calendars (`maxEventsPerDay: null` when unlimited); a day without a limit is never `busy` because of bookings alone.
- `maxEventsPerDay` is still accepted on writes but **deprecated**; `onePerDay` wins when both are sent.
- Existing services: those at 1 stay ticked; those that allowed more than one a day now have no daily limit.

### 2026-10-06 — service schedule and multi-day bookings (issues 3 #6–#11, report #79, #81, #82)

**Service fields** (provider `POST/PATCH /app/provider/services`, service detail on both sides):

- `hours: [{ weekday, startTime, endTime }]`: bookable hours, `weekday` 1 = Monday … 7 = Sunday (Dart's `DateTime.weekday`), `HH:mm`. An end at or before the start runs past midnight. Several ranges per day are allowed, but ranges of one weekday must not overlap (400 `OVERLAP`) and start ≠ end (400 `SAME_AS_START`). Sending the field replaces the set; `[]` = bookable at any time.
- `concurrentClients` (1–50, default 1): different clients who may book **overlapping hours**. Only timed bookings compare; whole-day bookings still count against `maxEventsPerDay` only.
- `availableFrom` / `availableUntil` (`YYYY-MM-DD` or null): the **event dates** the service can be booked for, inclusive. The service leaves the catalog after `availableUntil` (dashboard visibility reason `period_ended`).

**Booking rules** (`/app/bookings`, `/quote`, both reschedule routes, accepting a proposed date):

| Code | When |
|---|---|
| 422 `OUTSIDE_SERVICE_PERIOD` | event date outside `availableFrom`–`availableUntil`; `details: { availableFrom, availableUntil }` |
| 422 `SERVICE_TIMES_REQUIRED` | the service has `hours` and the request has no times |
| 422 `OUTSIDE_SERVICE_HOURS` | the times don't fit inside one range of that weekday; `details: { weekday, hours: [{ startTime, endTime }] }` |
| 409 `SLOT_UNAVAILABLE` | `concurrentClients` timed bookings already overlap those hours; `details: { date, startTime, endTime }` |

`POST /app/bookings/quote` never throws for these: it answers `available: false` with the same code in `unavailableReason`. A provider accepting a request is not re-checked against hours changed afterwards.

**Free hours in the calendar:** `GET /app/services/{id}/availability` days gain `freeRanges: [{ startTime, endTime }]`, the hours still bookable that day: the service hours (all day if none) minus partial blocks and minus moments already taken by `concurrentClients` clients. Empty unless `state` is `available`. `00:00 → 00:00` means the whole day. Days outside the period and weekdays without hours are `blocked`; a day with nothing free left is `busy`. Pack calendars send `freeRanges: null`.

**Multi-day bookings** (`per_day` services only):

- `endDate` on `/quote` and `POST /app/bookings` (inclusive, ≤ 30 days, ≥ `eventDate`; equal = one day). Refusals: 422 `MULTI_DAY_NOT_ALLOWED` (other price types, packs), 422 `BOOKING_TOO_LONG` (`details.maxDays` = 30), 400 `VALIDATION_FAILED` `endDate`/`BEFORE_EVENT_DATE`.
- Priced per day (the service line's `quantity` = days). Times, when sent, apply to every day. Every day is checked (capacity, blocks, hours, period, slots) and held.
- The quote adds `days`, `endDate` and `unavailableDate` (the first refused day).
- Booking cards and details carry `endDate` (null for one day). Upcoming / Past, check-in, completion and the dispute window use the **last** day. A reschedule moves the whole range and keeps its length.

### 2026-10-05 — email live, booking time rules, open items from the issue report

- **#1** Email is live: the server sends through SMTP (`/health/ready` → `mail: "smtp"`) and runs with `AUTH_SKIP_EMAIL_VERIFICATION=false`, so `GET /app/config` → `emailVerificationRequired: true`. Sign-up goes through screen 10 again; resend and the forgot-password code arrive too.
- **#15** `DELETE /app/me/budget` added: 204, deletes the budget and all its lines for good (linked bookings untouched). 404 `BUDGET_NOT_FOUND` when there is none. Afterwards Home's budget card has `exists: false` and `PUT` creates a new one.
- **#49** Event times on `POST /app/bookings/quote`, `POST /app/bookings` and both reschedule routes:
  - `endTime` without `startTime` → 400 `VALIDATION_FAILED`, `details[0]: { field: "startTime", code: "REQUIRED_WITH_END" }`.
  - `endTime` equal to `startTime` → 400 `VALIDATION_FAILED`, `details[0]: { field: "endTime", code: "SAME_AS_START" }`.
  - An end earlier than the start is an **overnight** event ending the next day, exactly as the app already reads it: 18:00 → 02:00 is 8 h, and a `per_hour` service counts started hours across midnight (20:00 → 02:30 = 7). Previously an equal end was priced as 24 h.
  - Availability now compares overnight hours correctly: an 18:00 → 02:00 request meets a 20:00–22:00 block (it used to slip through).
- **#50** `GET /app/provider/bookings?tab=cancelled` added: cancelled and declined bookings, newest event first, like the client tab.
- **#68** `AvailabilityBookingRefDto.clientName` added on calendar day items (`GET /app/provider/availability`).
- **#75** `booking:updated.status` is now always the booking's current status, including on create, cancel, reschedule and price change.
- **#80** `POST /app/bookings` answers 409 `BOOKING_DUPLICATE` (`details: { reference, date }`) when the same client already has a pending or accepted booking of the same service or pack on that date with overlapping hours. A booking without times covers the whole day. Other clients are still governed by `maxEventsPerDay` (see #79, still open).

### 2026-09-27 — email verification can be switched off

The server has no email account yet, so no code could ever arrive. Until SMTP is set up, the live server runs with `AUTH_SKIP_EMAIL_VERIFICATION=true`:

- `GET /app/config` → `emailVerificationRequired: false`. Read this on start-up.
- `POST /app/auth/register` → the account is already verified, no code is sent, and the response carries `session` (`accessToken`, `refreshToken`, `user`). Skip screen 10 and sign the user straight in.
- `emailSentTo`, `expiresAt` and `resendAfterSeconds` are `null` in that case (they are now nullable).
- Login and booking no longer answer `EMAIL_NOT_VERIFIED`.

When email goes live, `emailVerificationRequired` becomes `true` and the normal flow (screen 10, `verify-email`) comes back with no app change, as long as the app follows that flag. Password reset still needs email: until then an admin can set a temporary password from the dashboard (user profile → Actions → Reset password).

### 2026-09-27 — integration fixes

One entry per item of the mobile developer's issue report (2026-09-27):

- **#1 (partial)** `/health/ready` now reports `mail: "smtp" | "console"` — `console` means no email leaves the server. (SMTP credentials themselves are an ops fix.)
- **#2** `GET /api/v1/health` added as a public alias of `/health/live`.
- **#6** `GET /app/wilayas/{code}/communes?q=` added (public, sorted by name).
- **#7** `GET /app/provider/services/{id}` and `GET /app/provider/packs/{id}` added — the same detail DTOs the PATCH routes answer with.
- **#8** `GET /app/provider/bookings/{id}/invoice` and `/invoice.pdf` added (accepted/completed bookings only).
- **#9** `POST /app/conversations/support {body}` added — find-or-create my support thread.
- **#10** `GET /app/me/academic-requests` and `/{id}` added (§11).
- **#11** `POST …/reschedules/{rid}/withdraw` added on both sides (proposer only).
- **#12** `GET /app/conversations?userId=` returns the direct chat with that user (empty list if none).
- **#13** `DELETE /app/me/notifications/{id}` added (hard delete, 204).
- **#14** `POST /app/auth/reset/verify {email, code}` added — 204 without consuming the code.
- **#15–19, #46** `GET /app/config` gained the `limits` object (§10), including `messageMaxLength` (4000, enforced on every send route), `eventRequestFormSlug`, and the document types as both MIME and extensions. `BUDGET_ITEM_LIMIT` carries `details.max`.
- **#20** `ACCOUNT_BLOCKED` carries `details: { reason, message, blockedUntil }` on login, refresh and every guarded call (`until` kept as a legacy alias).
- **#21** Booking cards/details gained `category` (null for packs).
- **#22** Provider service rows gained `priceType`.
- **#23** Provider pack rows gained `attentionReasons` (same values as the detail).
- **#24** `GET /app/wilayas` rows gained `servicesCount`; the list is ordered by it (no `position`).
- **#25** Catalog cards gained `favouriteId`; `DELETE /app/me/favourites?serviceId=|packId=` removes by target, idempotently.
- **#26** Messages gained `removed: boolean` (admin-hidden; body already replaced).
- **#27** Every `dispute.*` notification's `data` carries `conversationId` (plus `bookingId`, `disputeId`).
- **#28** Conversation rows: `lastMessage` is now an object `{ body, kind, mine }` (**breaking**: it was a string).
- **#29** Conversation detail: `closedReason` replaced by `closedByModeration: boolean` (**breaking**); show a localised line.
- **#30** The `/app` socket contract is documented in full (§13 and the spec header); `notification:new` is emitted and covered by e2e.
- **#31/#33** Notification `type`, booking timeline `type` and review `status` are closed enums in the spec; `data.href` documented (§12).
- **#32** Deep links documented (§12): web links are for browsers; `data` carries typed ids — never parse URLs.
- **#34** `AppProviderHomeDto.state` documents `blocked` and what to show.
- **#35** Documented on the DTO: catalog `provider.id` **is** the provider's user id.
- **#36** `CONVERSATION_CLOSED` is 409 everywhere (it always was at runtime; the stray "403" docs were fixed).
- **#37** Pack ratings are numbers in every DTO: `AppPackCardDto.avgRating` is now a number (**breaking**: was a string like "4.90").
- **#38** One budget line per booking → 409 `BUDGET_BOOKING_ALREADY_LINKED`; a cancelled booking keeps its line and link.
- **#39** `totalAmount` vs `plannedTotal` semantics documented (§8 Budget bullet + DTO descriptions) — the divergence is intended.
- **#40** `/app/services` accepts repeated `categoryId`, like `wilaya`.
- **#41** Confirmed + tested: the normal send route works in open dispute chats (images included); `/app/disputes/{id}/messages` is a text convenience and now answers the app message shape.
- **#42** `PATCH /app/provider/profile` keeps answering `AppMeDto` — deliberate, now stated in its description.
- **#43** Pack publishing additionally requires the pack wilaya to be covered by every item → 422 `PACK_WILAYA_NOT_COVERED`, `wilayaNotCovered` in `publishMissing`; the demo seed was fixed accordingly; the enforced checklist is spelled out in §9.
- **#44** Provider verification approve/reject now writes an in-app notification (`verification.approved` / `verification.rejected`) and emits `notification:new`; FCM push remains a stub until Firebase credentials exist.
- **#45** The mobile spec is pruned to mobile-reachable schemas, titled "Eventor Mobile API", with an app-specific description (socket contract included); the admin spec is pruned the same way.
