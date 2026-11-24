# Eventor backend: bugs fixed from the 23 Nov 2026 acceptance plan

**Source list:** `BACKEND_FIXES_2026-11-23.md` (26 bugs from the acceptance run).
**Branch:** `some-bug-fixes` (local commits, **not pushed yet**: GitHub write access pending).
**Live server:** **nothing deployed**; every deploy, migration and live data change waits for approval.
**Verification:** build OK · lint 0 warnings · unit 471/471 · e2e 731/731 · `openapi.json` in sync · migrations up/down/up OK on a local database.

## Summary

| # | Bug | Priority | Status | Commit |
|---|---|---|---|---|
| 1 | BUG-M2 double booking on accept | P0 | Fixed | `b2cecf7` |
| 2 | BUG-F1 requests never expire | P1 | Fixed (behind a setting, off) | `b2cecf7` |
| 3 | BUG-D2 `eventDate` filter ignored | P1 | Fixed | `b2cecf7` |
| 4 | BUG-E6 cancel/reschedule offered after the event | P1 | Fixed | `b2cecf7` |
| 5 | BUG-E3 per-hour price not recomputed on reschedule | P1 | Fixed | `b2cecf7` |
| 6 | BUG-E5 invoice not reissued after reschedule | P1 | Fixed | `b2cecf7` |
| 6b | BUG-E7 cancelled booking keeps its pending reschedule proposal | P2 | Fixed; **old rows on live: preview, then `--apply` after approval** | `e58befe` |
| 7 | BUG-M4 block "Cancel them" leaves bookings active | P1 | Fixed (backend); dashboard wording pending | `b2cecf7` |
| 8 | BUG-F6 + BUG-M1 admin availability block | P1 | Fixed (backend); dashboard label pending | `2179c40` |
| 9 | BUG-F5 + BUG-J1 blocked user never sees why | P1 | Fixed | `ad049eb` |
| 10 | BUG-L4 `/set-password` page is 404 | P1 | Backend done; **page to build in the dashboard** | `f9607c6` |
| 11 | BUG-L3 dashboard reset links always "expired" | P1 | Fixed | `275fc4b` |
| 12 | BUG-C3 invite links don't open the app | P1 | Fixed in code; **nginx change on live pending** | `cab0cff` |
| 13 | BUG-H3 user/provider reports invisible | P1 | Backend done; **dashboard screens pending** | `b2cecf7` |
| 14 | BUG-G2 chat system messages | P1 | Fixed | `12060fd` |
| 15 | BUG-G4 hide/delete doesn't reach an open chat | P2 | Fixed | `20d7985` |
| 16 | BUG-H5 dispute reopen shown as "accepted" | P2 | Fixed | `0313c46` |
| 17 | BUG-M5 deleted user still messageable | P1 | Fixed (backend); dashboard badge pending | `cabe342` |
| 18 | BUG-H4 + BUG-M3 cancellations blamed on the provider, raw codes | P1 | Fixed | `d70e1f8` |
| 19 | BUG-N2 device-token 500 after account switch | P1 | Fixed | `01b3919` |
| 20 | BUG-B1 verification e-mails (sender, empty body) | P1 | Fixed in code; **Gmail app password on live pending** | `b2cecf7` |
| 21 | BUG-C1 reset accepts the same password | P2 | Fixed | `1e5a408` |
| 22 | BUG-O2 English title in Arabic invoice / price line | P2 | Fixed | `24eb074` |
| 23 | BUG-L1 saved view trash applies instead of deleting | P2 | API already correct; **dashboard click fix pending** | `cfc95c6` |
| 24 | Other P2s: ISO dates in notifications, admin list refresh | P2 | Fixed (backend); dashboard refetch pending | `f57f0b1` |

Not started (they need decisions first): **#25 BUG-N3** (seed data on live: list, backup and a go) and **#26 BUG-P1** (production domain).

Dashboard follow-ups are described in `docs/dashboard-handoff.md` (the dashboard is a separate repository). Mobile app changes are in `docs/mobile-api.md` → "2026-11-23 — acceptance run fixes".

---

## Details

### 1 · BUG-M2 — two overlapping requests could both be accepted (P0)
- **Cause:** accept only checked the daily limit and blocks, not hours already taken by accepted bookings, and not inside a lock.
- **Fix:** capacity re-checked inside a locked transaction, with the same overlap rule as availability (overnight and multi-day included), for services and each pack item. Two simultaneous requests for the same slot no longer both get 201.
- **Contract:** 409 `SLOT_UNAVAILABLE` (existing code). `accept` is removed from `allowedActions` when the slot is full.
- **Tests:** M-08 / M-09 scenarios (concurrent requests, second accept refused).

### 2 · BUG-F1 — booking requests never expired (P1)
- **Fix:** a pending request expires at the reply deadline or the event start, whichever comes first. It becomes `declined` with reason `expired`, both parties are notified, the chat gets a message, and `booking:updated` is emitted. An hourly job does this, and a guard applies at read time.
- **Safety:** the behaviour is behind the admin setting `booking_auto_expire`, which is **off** (migration `1791600000000`). `pnpm bookings:expire-preview[:prod]` lists what it would expire, read-only, before anyone turns it on.
- **Contract:** 409 `BOOKING_EXPIRED` (new code). No new status value.

### 3 · BUG-D2 — `/app/services?eventDate=` was ignored (P1)
- **Cause:** the list filter was a partial copy of the calendar rules (blocks and daily limit only).
- **Fix:** the filter and `/app/services/{id}/availability` now share one calendar loader. It covers closed weekdays, the service period, free hours, blocks, the daily limit and `firstBookableDate`. Paging and `total` count only the remaining services.
- **Tests:** each closing reason; list and calendar agree for every service.

### 4 · BUG-E6 — cancel / reschedule still offered after the event (P1)
- **Fix:** once an accepted event is over (the end time of its last day, the next morning for overnight hours), `cancel` and `reschedule` leave `allowedActions` on both sides. The endpoints answer 409.
- **Contract:** 409 `BOOKING_EVENT_OVER` (new code). Admins can still cancel (dispute outcomes).

### 5 · BUG-E3 — per-hour price not recomputed on reschedule (P1)
- **Decision:** recompute at the **agreed** rate. Pending moves apply directly, and the notification shows the old → new total.
- **Fix:** the per-hour line is re-counted for the new hours, and extras and other price types are untouched. Each proposal stores `oldTotal` / `newTotal` (migration `1791700000000`), and a price-history row is recorded.
- **Contract:** new `oldTotal` / `newTotal` on `reschedules[]`.

### 6 · BUG-E5 — invoice not reissued after a reschedule (P1)
- **Fix:** an accepted booking gets a new invoice version (new number, old version voided) whenever something printed on it changes: dates, price or event type. An admin edit now also emits `booking:updated`.

### 6b · BUG-E7 — a cancelled booking kept its pending reschedule proposal (P2, E-24)
- **Added later:** item 6b of the plan, added after `BACKEND_FIXES_2026-11-23.md` was committed here.
- **Fix:** a booking that becomes cancelled, declined (expiry included) or completed closes its pending proposals as `cancelled` (resolved now) in the same transaction. One shared helper inside `applyTransition`, the only writer of a booking status, covers every path: client, provider, admin, block "Cancel them", account deletion, service and pack deletion, expiry and auto-complete jobs, and dispute outcomes. No extra notification. A `booking.reschedule_closed` audit row records the close. A proposal waiting on an accepted booking whose event is over stays answerable (BUG-E6 unchanged).
- **Contract:** additive. `allowedActions` never has `respond_reschedule` or `reschedule` on an ended booking, and `awaitingMe` is false. Accept, reject and withdraw answer 409 `RESCHEDULE_NOT_PENDING`, or `BOOKING_NOT_EDITABLE` for an older row. No new code.
- **Old data:** `pnpm bookings:stale-reschedules[:prod]` lists, read-only, the proposals left pending on ended bookings (e.g. EVT-000156). `--apply` closes them. Not run on live.
- **App:** shows a proposal (B4, P2) only while the booking is `pending` or `accepted` (mobile session, after the deploy).

### 7 · BUG-M4 — blocking with "Cancel them" left accepted bookings active (P1)
- **Decisions:** "Cancel" means pending **and** accepted-not-over bookings, for both roles. "Keep" means the other party is told, and can't propose a new date until the unblock.
- **Fix:** cancellations are recorded as admin with reason `account_blocked`, invoices are voided and the other party is notified. With "Keep", a `booking.counterparty_blocked` notification goes out.
- **Contract:** new `counterpartyBlocked` field, new code 409 `COUNTERPARTY_UNAVAILABLE`, new notification type.
- **Remaining:** dashboard dialog wording.

### 8 · BUG-F6 + BUG-M1 — admin availability block leaked its note and was removable (P1)
- **Fix:** new `availability_blocks.source` (`provider` | `admin`, migration `1791800000000`, with existing blocks backfilled from the audit log). In the provider app an Eventor block has `note: null` and `removable: false`, and deleting it answers 403.
- **Contract:** new `source` field, new code 403 `AVAILABILITY_BLOCKED_BY_EVENTOR`.
- **Remaining:** "Blocked by Eventor" label in the dashboard.

### 9 · BUG-F5 + BUG-J1 — a blocked user only saw "session ended" (P1)
- **Decision:** revoke sessions, but say why.
- **Fix:** sessions ended by a block are marked. While the account stays blocked, the next call, the refresh and the socket answer `ACCOUNT_BLOCKED`, and sign-in answers 403, all with the full details. The error message no longer repeats the title.
- **Contract:** `ACCOUNT_BLOCKED.details` gains `reasonLabel`, `blockedAt` and `deleteAccountUrl`.

### 10 · BUG-L4 — the emailed `/set-password` link was a 404 (P1)
- **Cause:** the dashboard (a separate Next.js repository) has no such page.
- **Fix (backend):** new `POST /app/auth/set-password/check` lets the page show valid / invalid / expired / blocked before the form. The full page spec is in the dashboard handoff.
- **Remaining:** build the page in the dashboard.

### 11 · BUG-L3 — dashboard "Email a reset link" links were always "expired" (P1)
- **Cause:** the dashboard page posts every reset link to `POST /admin/auth/reset`, which only accepted admin accounts.
- **Fix:** the route also redeems links sent to app accounts. It sets the password only and never signs anyone in.

### 12 · BUG-C3 — invite links didn't open the app (P1)
- **Fix:** the API serves `/.well-known/assetlinks.json` (200, JSON, no redirect) from `ANDROID_APP_PACKAGE` / `ANDROID_CERT_SHA256`. nginx sends that path of the admin host to the API (`deploy/nginx/eventor.conf`).
- **Remaining:** apply the nginx change on live.

### 13 · BUG-H3 — user/provider reports invisible in the dashboard (P1)
- **Fix (backend):** new `aboutUserId` and `targetId` filters on `GET /admin/reports`, and new `stats.reports { open, openOnAccount, total }` on the admin user detail, with one shared definition.
- **Remaining:** moderation list and counters in the dashboard.

### 14 · BUG-G2 — chat system messages: no booking link, missing events, English only (P1)
- **Fix:** system messages carry `system { event, bookingId, bookingRef, params }` (migration `1791900000000`). Every booking event now posts one: requested, accepted, declined, cancelled, completed, expired, reschedule proposed / accepted / declined, rescheduled. `body` is rendered in each reader's language, with dates in words.

### 15 · BUG-G4 — hiding / deleting a message didn't reach an open chat (P2)
- **Fix:** new app socket event `message:updated` (same shape as `message:new`) for both participants on hide / restore / delete. New `deleted` flag.

### 16 · BUG-H5 — dispute reopen recorded as "accepted" in the timeline (P2)
- **Fix:** the app timeline shows completed → accepted as `reopened` (`toStatus: null`) and adds a `dispute_resolved` entry with the outcome. The dispute link on the booking is guaranteed.

### 17 · BUG-M5 — a deleted user was still messageable (P1)
- **Fix:** chat people carry `deleted`, `canWrite` becomes false, and sending answers 410. Dashboard booking refs carry `client.deleted` / `provider.deleted`.
- **Contract:** new code 410 `RECIPIENT_DELETED`.
- **Remaining:** "Deleted user" badge in the dashboard.

### 18 · BUG-H4 + BUG-M3 — admin/system cancellations blamed on the provider; raw reason codes (P1)
- **Fix:** `cancelledBy` is now `client | provider | admin | system` (migration `1792000000000`), derived from whoever acted. New `cancelReasonLabel`, `declineReasonLabel` and `timeline[].reasonLabel`, in the request language. A raw code never reaches the screen.

### 19 · BUG-N2 — device-token registration 500 after an account switch (P1)
- **Cause:** two simultaneous registrations both inserted the same token (unique index).
- **Fix:** one atomic upsert; the last account owns the token. `POST /app/auth/logout` accepts `deviceToken` and removes it from the account signing out.

### 20 · BUG-B1 — verification e-mails from a personal Gmail; empty body at some providers (P1)
- **Cause:** Gmail sends as the signed-in account whatever `MAIL_FROM` says. The MIME message was correct, with a text part on every template.
- **Fix:** startup warning when Gmail would rewrite the sender; a test that every template's text part carries its code or link; `pnpm mail:test[:prod]`; settings documented for `eventorsupport@gmail.com`.
- **Remaining:** the account's Gmail app password in the live environment, then a test send.

### 21 · BUG-C1 — password reset accepted the same password (P2)
- **Fix:** app reset, in-app change, set-password link and dashboard reset all refuse the current password. The code or link is not used up by the refusal.
- **Contract:** new code 422 `PASSWORD_UNCHANGED` (`details[].field`).

### 22 · BUG-O2 — English service title in the Arabic invoice and price line (P2)
- **Cause:** price lines were stored in English only.
- **Fix:** lines keep `label_ar` (migration `1792100000000`, existing lines backfilled from the current Arabic names). App lines give `label` in the reader's language plus `labelEn` / `labelAr`. New invoices carry `labelAr`, and the PDF prints it.

### 23 · BUG-L1 — saved view: the trash icon applied the view instead of deleting it (P2)
- **Finding:** the API (`DELETE` / `PATCH /admin/saved-views/{id}`) is correct and tested. The bug is the dashboard click handler.
- **Remaining:** the fix spec for the dashboard (stop the click, confirm, delete).

### 24 · Other P2s (P2)
- **Notification dates:** booking notifications and e-mails write dates in words per language ("16 December 2026" / "16 ديسمبر 2026") instead of ISO.
- **Admin accounts list:** the admin socket emits `admins:updated` when an invitation is sent, accepted or revoked, or an admin is removed.
- **Remaining:** the dashboard refetches the team list on that event.
- **Covered elsewhere:** the admin calendar label is covered by #8.

---

## Before going live (needs approval)
- **Deploy** with the migrations: `1791600000000` … `1792100000000` from this list.
- **6b:** run `pnpm bookings:stale-reschedules:prod` (read-only), share the list, then `--apply` after approval.
- **#2:** run `pnpm bookings:expire-preview:prod`, then decide on `booking_auto_expire`.
- **#12:** nginx rule for `assetlinks.json`, then `adb shell pm verify-app-links`.
- **#20:** Gmail app password, then `pnpm mail:test:prod`.
- **Acceptance tests:** re-run each bug's tests on live after the deploy.
