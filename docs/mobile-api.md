# Mobile API: the contract

The Eventor mobile app talks to `/api/v1/app/**`. This is everything you need
to call it; the exact shapes are in `openapi.json` (generate your client from
it — do not hand-write models).

| | |
| --- | --- |
| Base URL | `{API_URL}/api/v1` (local: `http://localhost:3000/api/v1`) |
| Swagger UI | `{API_URL}/api/v1/docs` |
| OpenAPI JSON | `{API_URL}/api/v1/docs/openapi.json`, committed as `backend/openapi.json` |
| Tags | `app-auth`, `app-me`, `app-catalog`, `app-config` |

**Part 1 is auth + client browsing.** Bookings, messaging, reviews, reports and
every `/app/provider/**` route are part 2 (§9). The screen map
(`../../docs/mobile-screen-map.md`) names them with the paths they will take.

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
| `ACCOUNT_BLOCKED` | 403 | Show `details.message` (the admin's own words); `details.until` may hold an end date. |
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

Codes you will meet in part 1, beyond the auth table above:
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
  `uploads.imageTypes`) — check locally before sending, and still handle 413.
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
  through the chat (part 2), where contact details stay masked until the pair
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
| 10a Set new password | `POST /app/auth/reset` |
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
| 11a Filters | `GET /app/categories` · `GET /app/wilayas` |
| — Search | `GET /app/services?q&categoryId&wilaya&priceMin&priceMax&rating&eventDate&order&page` · `POST /app/events` |
| 12 Service detail | `GET /app/services/{id}` · `GET /app/services/{id}/availability?month=YYYY-MM` · `GET /app/services/{id}/reviews` · `POST /app/me/favourites` / `DELETE /app/me/favourites/{id}` · `POST /app/events` |
| 13 Provider profile | `GET /app/providers/{id}` · `GET /app/providers/{id}/reviews` |
| 17 Favorites | `GET /app/me/favourites?categoryId&kind` · `DELETE /app/me/favourites/{id}` |
| 18 Budget | `GET /app/me/budget` · `PUT /app/me/budget` · `POST /app/me/budget/items` · `PATCH`/`DELETE /app/me/budget/items/{id}` |
| 19 Ready Packs | `GET /app/packs?eventType&wilaya&order` |
| 20 Pack detail | `GET /app/packs/{id}` · `GET /app/packs/{id}/availability?month=YYYY-MM` |
| 16 Notifications | `GET /app/me/notifications` · `GET /app/me/notifications/unread-count` · `POST /app/me/notifications/read` · `POST /app/me/device-tokens` |
| — Profile & settings | `GET`/`PATCH /app/me` · `POST /app/me/avatar` · `POST /app/me/password` · `GET`/`DELETE /app/me/sessions` · `GET`/`PATCH /app/me/notification-preferences` · `DELETE /app/me` |
| 14 Messages, 15 Chat | part 2 |
| — Booking flow, Bookings tab, Leave a review | part 2 |

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
  idempotent (tapping ♥ twice is fine). `DELETE` takes the **favourite row id**
  (`id`), not the service id. A row whose target stopped being visible stays in
  the list with `available: false` — grey the card rather than dropping it.
- **Budget**: `GET` answers 404 `BUDGET_NOT_FOUND` until the client creates one
  with `PUT`; treat that as the empty state, not an error. Every write returns
  the **whole recomputed budget**, so the header updates in one round trip.
- **`POST /app/events`** validates and answers 202 but **stores nothing in V1**
  (analytics is V2 per the signed offer). Ship the calls; they start counting
  later. Nothing in the UI may depend on it.

## 9. What part 2 still owes you

Not built yet, all named in the screen map: the booking flow
(`/app/bookings`, quote, cancel, reschedule, invoice PDF), messaging
(`/app/conversations`, the Socket.IO namespace for the app, typing and presence),
reviews (`POST /app/bookings/{id}/review`), reports, disputes, and the whole
provider side (`/app/provider/home`, requests, services, photos, availability
blocks, packs, the "Available for bookings" toggle). Build screens 14, 15 and
the Bookings tab against the screen map and expect the paths there.

## 10. Rate limits

100 requests/min per user or IP globally; **10/min** on `/app/auth/*`; **30/min**
on uploads. 429 carries `Retry-After`. Back off — do not hammer `refresh` in a
loop when it fails.
