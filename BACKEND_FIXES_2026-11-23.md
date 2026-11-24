# Eventor — backend fix plan (from the 23 Nov 2026 acceptance run)

**For:** the Claude Code session working in the **backend repository** (NestJS API + admin dashboard).
**Written:** 23 Nov 2026, from the acceptance test run of the mobile app (363 tests: 306 pass · 44 fail · 12 blocked).
**Mobile app fixes** are being done **at the same time in a separate session** in `D:\Eventor` (Flutter). Do not edit the mobile app from the backend session.

---

## 0. Rules for this work — read first, follow for every bug

1. **One bug at a time.** Take the bugs in the order of §3. Finish one completely (fix → tests → re-run of its acceptance test → report) before touching the next.
2. **Ask for the user's validation before moving to the next bug.** At the end of each bug, report what you changed and what you verified, then **stop and wait** for the user to say "OK, next". Never chain two bugs without that OK.
3. **The fix must not cause a new bug anywhere else.** Before changing anything:
   - find **every caller** of the code you are about to change (other endpoints, the admin dashboard, cron jobs, socket emitters, notifications, e-mails, invoices, seed scripts);
   - check the **mobile app contract** (§1.3). The released app reads these responses, so keep changes **additive**: new fields or new values are fine; renaming, removing or retyping a field is not, unless this plan says so;
   - if the fix **does affect another part**, make sure that part still works and gains no new bug: adapt it in the same fix, test it, and say so in your report.
4. **After each fix, re-run the corresponding acceptance tests** (the test ids are listed under each bug) by following the steps in the test guide:
   **Test guide (PDF, on the Desktop):** [Eventor_Acceptance_Test_Guide.pdf](file:///C:/Users/USER/Desktop/Eventor_Acceptance_Test_Guide.pdf) — `C:\Users\USER\Desktop\Eventor_Acceptance_Test_Guide.pdf`
   Run results and notes: `C:\Users\USER\Desktop\eventor_test_run\`
   A test that needs the phone app is run on the Android emulator by the user or by the mobile session. Say exactly which steps you could verify through the API or the dashboard yourself, and which ones need the app.
5. **Write or update automated tests** (unit or e2e) for every fix, and include one that would have caught the bug. Ask the user before running the backend test suite.
6. **Live server = real data.** The API at `https://api.eventor.72-60-190-211.sslip.io/api/v1` and the dashboard at `https://admin.eventor.72-60-190-211.sslip.io` are live. **Ask before every deploy, migration, data change or deletion** on that server, and say what it will change. Never delete data without a backup and an explicit yes.
7. **No secrets in code, commits, logs or this file.** Passwords, keys and tokens stay in the existing env/secret files.
8. **The API contract lives in the mobile spec** (Swagger "Eventor Mobile API", `…/api/v1/docs/mobile`). Update it with every contract change, so the mobile session can adopt the change.
9. **Report format per bug:** root cause (file:line) · what changed · contract change (if any) · side effects checked · automated tests added · acceptance test re-run result (pass/fail, with evidence) · what the mobile app needs to do (if anything).

---

## 1. Context

### 1.1 Systems
| | |
|---|---|
| API (mobile) | `https://api.eventor.72-60-190-211.sslip.io/api/v1` (`/app/...` routes) |
| Mobile API spec | `https://api.eventor.72-60-190-211.sslip.io/api/v1/docs/mobile` |
| Admin dashboard | `https://admin.eventor.72-60-190-211.sslip.io` (`/admin/...` routes) |
| Live socket events the app listens to | `ready`, `message:new`, `conversation:updated`, `booking:updated`, `notification:new`, plus the block / service visibility events added on 18 Oct |
| Android package / release cert SHA-256 | `com.symloop.eventor` · `80:74:C0:3F:BA:FC:B0:1C:DD:8F:ED:7D:80:B2:24:1F:27:BB:04:F7:C1:28:A3:43:6C:DD:C5:EE:70:F4:49:A3` |

### 1.2 Test accounts
Use the QA and seed accounts listed in the test guide. **Never use the two store-review accounts** (`client@eventor.test`, `studio.lumiere@eventor.test`) for testing. Passwords are not in this file.

### 1.3 Endpoints the mobile app calls (do not break them)
`/app/auth/{login,register,refresh,logout,forgot,reset,reset/verify,set-password,verify-email,verify-email/resend}` · `/app/config` · `/app/home` · `/app/me` (+ `/avatar`, `/blocks`, `/budget`, `/device-tokens`, `/documents`, `/favourites`, `/notification-preferences`, `/notifications`, `/password`, `/reviews`, `/sessions`) · `/app/services` (+ `/:id`, `/:id/availability`, `/:id/reviews`) · `/app/packs` (+ `/:id`, `/:id/availability`) · `/app/providers/:id` (+ `/reviews`) · `/app/bookings` (+ `/:id/disputes`) · `/app/disputes` (+ `/:id/messages`) · `/app/conversations` (+ `/:id`, `/:id/messages`, `/:id/read`) · `/app/messages/:id/report` · `/app/reports` · `/app/reviews/:id` (+ `/reply`, `/replies/:id`) · `/app/provider/{home,bookings,services,packs,profile,reviews,availability,availability/blocks,availability/blocks/:id}` · `/app/categories` · `/app/wilayas` (+ `/:code/communes`).

Fields the app relies on and that some fixes touch: booking `allowedActions[]`, booking `cancelledBy`, availability day item `kind` + `removable` + `note`, chat message `kind` / `body` / `removed`, config `booking.replyDeadlineHours`.

---

## 2. Already fixed on the app side (no backend action)
For information only. These are done in the mobile repo: BUG-A2 (offline banner), BUG-A4 (unsent chat messages kept), BUG-D1 (Back on tabs), BUG-D4 (photo viewer), BUG-E4 (invoice PDF pill), BUG-G3 (chat composer shape), and the app half of BUG-C3 (it now claims the `admin.` host for `/set-password`).
App-only bugs still open in the mobile session: A1, C2, D3, E1, E2, F4, G1, G3 (4 000-char counter), H1, H2, N1, N4, O1.

---

## 3. Order of work

| # | Bug | Priority | Side | Acceptance tests to re-run |
|---|---|---|---|---|
| 1 | BUG-M2 double booking on accept | P0 | Backend | M-09 (+ M-08, F-08…F-10 accept/decline) |
| 2 | BUG-F1 requests never expire | P1 | Backend | F-10, N-02, L-35 |
| 3 | BUG-D2 `eventDate` filter ignored | P1 | Backend | D-15 |
| 4 | BUG-E6 cancel/reschedule offered after the event | P1 | Backend (+ app follows) | E-25 |
| 5 | BUG-E3 per-hour price not recomputed on reschedule | P1 | Backend (+ product call) | E-24 |
| 6 | BUG-E5 invoice not reissued after reschedule | P1 | Backend | E-23, E-28, F-11, M-05, L-25 |
| 7 | BUG-M4 block "Cancel them" leaves bookings active | P1 | Backend + dashboard | M-16, L-17 |
| 8 | BUG-F6 + BUG-M1 admin availability block leaks note / is removable | P1 | Backend + dashboard (+ app) | F-32, M-22, L-12, L-20 |
| 9 | BUG-F5 + BUG-J1 blocked user never sees why | P1 | Both | F-05, J-17, M-17, N-36, L-17 |
| 10 | BUG-L4 `/set-password` web page is 404 | P1 | Backend/web | L-15, C-18 |
| 11 | BUG-L3 dashboard reset links always "expired" | P1 | Backend | L-19, L-15, L-22, L-02 |
| 12 | BUG-C3 invite links don't open the app (assetlinks) | P1 | Backend/ops (app part done) | C-18, L-15 |
| 13 | BUG-H3 user/provider reports invisible in the dashboard | P1 | Dashboard | H-08, P-09, L-31, L-40 |
| 14 | BUG-G2 chat system messages: no booking link, missing events, English only | P1 | Both | G-09, M-05, N-09, O-07, L-24 |
| 15 | BUG-G4 hide/delete of a message doesn't reach an open chat | P2 | Both | G-11, M-15, N-02, L-29 |
| 16 | BUG-H5 timeline: dispute reopen recorded as "accepted" | P2 | Both | H-13, M-13, L-32 |
| 17 | BUG-M5 deleted user still messageable | P1 | Both | M-30, N-25 |
| 18 | BUG-H4 + BUG-M3 admin/system cancellations blamed on provider, raw reason codes | P1 | Both | H-13, M-13, M-16, N-22, L-17, L-24 |
| 19 | BUG-N2 device-token registration 500 after account switch | P1 | Backend | N-33 |
| 20 | BUG-B1 verification e-mails: personal sender, empty body | P1 | Backend/ops | B-01 |
| 21 | BUG-C1 reset accepts the same password | P2 | Backend (+ app message) | C-14, M-29 |
| 22 | BUG-O2 English service title in Arabic invoice / price line | P2 | Backend (+ app) | O-07, O-09 |
| 23 | BUG-L1 dashboard saved view: trash applies instead of deleting | P2 | Dashboard | L-39 |
| 24 | Other server-side P2s (§5) | P2 | Backend/dashboard | listed in §5 |
| 25 | BUG-N3 seed data on the live server | P0 before launch | Data/ops — **needs explicit go + backup** | N-31, N-32 |
| 26 | BUG-P1 production domain (+ BUG-A3, BUG-A1) | P0 before launch | Ops first, then app | P-11, A-21, C-18, A-17 |

#25 and #26 depend on business decisions: the real domain, and which data to keep. Prepare them, but **do not execute without the user's go.**

---

## 4. Bugs in detail

### 1 · BUG-M2 — two overlapping requests can both be accepted (double booking) · P0 · Backend
**Tests:** M-09 (also re-check M-08 and the F accept/decline tests).
**Observed:** EVT-000147 and EVT-000148 were both pending for the same day, 18:00–20:00, on a service with `concurrentClients = 1` and no simultaneous bookings. The provider accepted 147, but 148 stayed pending with `accept` still in `allowedActions`. Accepting 148 also returned **200**, so the provider calendar showed both bookings on 4 Dec, 18:00–20:00.
**Expected:** once one request is accepted, an overlapping one beyond capacity can no longer be accepted.
**Backend fix:**
- In the provider accept handler (`/app/provider/bookings/:id` accept action), re-check capacity **inside a DB transaction with a lock** (row lock on the service/day, or `SERIALIZABLE`). Count the *accepted* bookings that overlap the requested time window, and refuse when the count reaches `concurrentClients`. Use the same overlap rule as the availability endpoint (including overnight ranges and multi-day events), so the two can't disagree.
- On refusal, return **409** with a clear error code (for example `SLOT_UNAVAILABLE`; check the codes the app already knows in the mobile spec before adding one), and leave the booking pending or decline it, as product prefers.
- Compute `allowedActions` with the same check, so `accept` disappears for a request that can no longer be accepted.
- Optional (product): when a booking is accepted, auto-decline the conflicting pending requests with a reason, a notification and a chat system message. Ask the user before doing this.
- Apply the same check to **packs** (they book several services at once) and to the **admin** status change, if it can set a booking to accepted.

**Don't break:** reschedule acceptance (a reschedule moving into a full slot must be refused the same way); the availability endpoint; the provider calendar; packs.
**Verify:** an automated test with two pending requests on a capacity-1 slot. Then, on live (ask first), recreate the M-09 scenario with QA accounts and confirm the second accept gets 409, and that `accept` has gone from its `allowedActions`. Cancel the QA bookings afterwards.

### 2 · BUG-F1 — booking requests never expire · P1 · Backend
**Tests:** F-10, N-02, L-35.
**Observed:** config `replyDeadlineHours = 48`, yet EVT-000003 (requested 29 Sep, event 13 Nov, now in the past) is still **pending**, with accept/decline still allowed.
**Expected:** a request with no reply by the deadline, or whose event date has passed, expires automatically.
**Backend fix:**
- Add a scheduled job (NestJS `@Cron`, or the existing scheduler), plus a guard at read time. Move pending requests to an expired/declined state when `now > requestedAt + replyDeadlineHours` **or** when the event start has passed.
- Check whether a status such as `expired` already exists in the mobile spec. If it doesn't, decide with the user between adding one (a contract change: the app must know it) and reusing `declined` with a reason code such as `expired`.
- On expiry: drop accept/decline from `allowedActions`, free the hold on the calendar, send a notification and a chat system message to both sides, and emit `booking:updated`.
- Make the job idempotent and safe to run on the existing backlog (EVT-000003 and other old requests): **list what it will change and ask before the first run on live.**

**Don't break:** the provider home "reply now" counts, the request holds in the P15 calendar, and accepted bookings (never touch them).

### 3 · BUG-D2 — `/app/services?eventDate=` is ignored · P1 · Backend
**Tests:** D-15.
**Observed:** "Solo oud for dinners" is blocked on 22 Nov 2026 (its calendar and the availability API both say blocked), yet `/app/services?eventDate=2026-11-22` still returns it, along with all 50 services. The spec says: "Keep only services free on that day". The app sends the parameter correctly.
**Backend fix:**
- Apply `eventDate` in the services list query: exclude services that are unavailable that day. That covers provider blocks, admin blocks, days that are fully booked against capacity, and closed weekdays.
- Use **the same availability logic** as `/app/services/:id/availability` (one shared function), so the list and the calendar can't disagree.
- Check `/app/packs?eventDate=` and `/app/home` for the same parameter, if the spec documents it there.
- Keep pagination and `total` counts correct after filtering.

**Don't break:** the other filters (wilaya, category, budget, guests, query), sorting, the featured flag, `servicesCount` on providers.

### 4 · BUG-E6 — cancel / reschedule still offered after the event is over · P1 · Backend (the app follows `allowedActions`)
**Tests:** E-25.
**Observed:** after the event end, the client booking (B4) still offers "Propose a new date" and "Cancel booking", because the server's `allowedActions` keeps `cancel` and `reschedule` until the booking is completed (both before and after check-in).
**Backend fix:**
- In the `allowedActions` computation, once `now >= event end`, remove `cancel` and `reschedule`, and keep only what makes sense after the event (check-in/complete, review, dispute, invoice, message).
- Enforce the same rule in the **action handlers**: cancelling or rescheduling a past booking returns 409 even if a client calls it directly.

**Don't break:** completion, check-in, disputes and reviews; overnight events (the end is the next day); multi-day bookings.
**App:** nothing to change; it already follows `allowedActions`.

### 5 · BUG-E3 — per-hour price not recomputed when a reschedule changes the duration · P1 · Backend (product call)
**Tests:** E-24.
**Observed:** a reschedule from 4 h to 5 h on a per-hour service was accepted, but the total stayed 24 000 DA (the price block still shows "4 × 6 000").
**Product decision needed:** should an accepted reschedule recompute the price for per-hour (and per-person) lines? **Ask the user.** The likely answer is yes: recompute from the service's current or originally agreed unit price, then show the new total in the proposal so the other side accepts it knowingly.
**Backend fix (if yes):**
- When a reschedule proposal is created, compute the new lines and total and store them on the proposal.
- When it is accepted, apply them to the booking.
- Expose the new total on the proposal, so the app can show "new total" before accepting (additive field).

**Don't break:** flat-price services (no change), packs, invoices (see #6), already-completed bookings.

### 6 · BUG-E5 — invoice not reissued after a reschedule · P1 · Backend
**Tests:** E-23, E-28, F-11, M-05, L-25.
**Observed:** INV-2026-0105 (version 1) still says 3 December 2026 and 4 hours, while the booking is now 9 Dec, 18:00–23:00.
**Backend fix:**
- When a reschedule is accepted (and on any change to date, time, guests or price), issue a **new invoice version** (version 2), or regenerate the document. Use whatever versioning model already exists (the invoice already has a version field).
- The old version stays visible in history or is voided, following the existing rules.
- Emit `booking:updated`, so the app reloads the invoice.

**Don't break:** invoice numbering (no gaps or duplicates), voided invoices on cancellation, PDF generation in EN and AR.

### 7 · BUG-M4 — blocking a provider with "Cancel them" leaves accepted bookings active · P1 · Backend + dashboard
**Tests:** M-16, L-17.
**Observed:**
- With "Cancel them" chosen in the block dialog, the accepted upcoming EVT-000144 and EVT-000146 stayed **Accepted**.
- The client got no notice, and B4 still offered "Message" and "Propose a new date" to a blocked provider.
- The dialog contradicts itself: its radio button says the upcoming bookings are cancelled, while its list says they stay active.

**Backend fix:**
- When the block request carries the "cancel upcoming bookings" option, cancel every accepted or pending upcoming booking of that provider in the same transaction. Set `cancelledBy` to `admin` (or `system`; see #18) and the reason to `provider_unavailable`/`account_blocked`. Void the invoices, notify the clients (push, in-app, chat system message) and emit `booking:updated`.
- When the option is "keep them", the bookings stay, but the client still needs to know the provider is unavailable. Ask the user what product wants here.
- **Dashboard:** make the dialog's wording consistent with what actually happens.

**Don't break:** unblocking (bookings cancelled by a block are not restored automatically; say so in the dialog), packs, disputes on those bookings.

### 8 · BUG-F6 + BUG-M1 — admin availability block: note leaked, looks like the provider's own, removable · P1 · Backend + dashboard (app follows)
**Tests:** F-32, M-22, L-12, L-20.
**Observed:**
- The provider API returns an admin-made block as `kind: "blocked"`, `removable: true`, with **`note` = the admin-only note**. The provider sees that note in the P15 day sheet.
- Nothing tells the provider it is an Eventor block, and the provider can remove it.
- In the dashboard's own calendar, the admin block is labelled "Blocked by provider".

**Backend fix:**
- **Never return the admin note** to `/app/provider/availability` (strip it in the serializer for every app route).
- Give admin blocks a distinct identity. Preferred: a new `kind` value such as `admin_blocked` (or keep `kind` and add a `source: "admin"` field). Ask the user which; either way it is a contract change the app must adopt, so document it in the spec.
- Return `removable: false` for admin blocks, **and** refuse `DELETE /app/provider/availability/blocks/:id` with 403 for them.
- **Dashboard:** label admin blocks "Blocked by Eventor", not "Blocked by provider".

**Don't break:** the provider's own blocks (still removable, notes still shown), availability computation, service list filtering (#3).
**App:** the mobile session will show admin blocks as "Blocked by Eventor", with no Remove button. Tell the user the exact `kind`/`source` value you chose.

### 9 · BUG-F5 + BUG-J1 — a blocked user never sees why (sessions revoked → generic "session ended") · P1 · Both
**Tests:** F-05, J-17, M-17, N-36, L-17.
**Observed:**
- Blocking from the dashboard revokes every session. The open app therefore only shows "Your session has ended", never the blocked screens (21c for providers, 23 for clients) with the reason, the date and the "Delete on the web" link.
- Signing in again shows "This account is blocked / This account is blocked." (the same text twice, with no reason or date), while the login API returns `403 ACCOUNT_BLOCKED` with reason `other`.

**Decision needed (ask the user):**
- **Option A (backend):** on block, don't revoke the sessions. Instead, answer every authenticated request with `403 ACCOUNT_BLOCKED` plus details. The app already routes that error to the blocked screen.
- **Option B (both):** keep revoking, but have `POST /app/auth/login` return `403 ACCOUNT_BLOCKED` with a complete payload, which the app uses to show the blocked screen from the login screen.

**Backend part (either option):**
- The `ACCOUNT_BLOCKED` error body includes `reason` (code), `reasonLabel` (localised by `Accept-Language`), `message` (the admin's message to the user, if any), `blockedAt`, `until` (or null) and `deleteAccountUrl`.
- `error.message` must **not** duplicate the title (that is where the doubled "This account is blocked." comes from).

**App part:** done by the mobile session once the format is fixed. Tell the user the final payload.

### 10 · BUG-L4 — the e-mailed `/set-password` link opens a 404 · P1 · Backend / web
**Tests:** L-15, C-18.
**Observed:** a dashboard-created user receives `https://admin.eventor.72-60-190-211.sslip.io/set-password?token=…`. That URL answers **307 → `/en/set-password` → 404**, so the user can never set a password without the app.
**Backend / web fix:**
- Add a public web page at `/set-password` (and the locale variants `/en/…`, `/ar/…`) on the `APP_PUBLIC_URL` host. It reads the token and posts to `POST /app/auth/set-password` `{ token, password }`.
- The page shows success, invalid/expired token and the password rules (the same rules as the app: at least 10 characters, with a letter and a digit).
- Bilingual EN/AR, with RTL for Arabic.

**Don't break:** the dashboard's own routes on that host; the app's deep link (#12: the app claims exactly `/set-password` on that host, so the page must stay at that path).

### 11 · BUG-L3 — dashboard "Email a reset link" links are always "expired" · P1 · Backend
**Tests:** L-19, L-15, L-22, L-02.
**Observed:** links sent at 11:39 and 11:50 (valid 1 h) were refused as "link expired" when the new password was submitted, even within minutes. Admin reset links work (L-02); user reset links from the dashboard don't.
**Hypothesis (unverified):** the expiry is compared in the wrong time zone (UTC+1, local Algeria), or the token is checked against the wrong table or type (admin vs user), or "sign out on all devices" invalidates the token it just created.
**Backend fix:**
- Trace the user-reset flow end to end: creation (`expiresAt`, stored in UTC?), the e-mailed URL (`/reset-password?token=…`), and the validation (which table, which type, which clock).
- Fix the cause, then add a test that creates a link, waits a minute, and redeems it.
- Check that the `/reset-password` web page exists and works the same way as `/set-password` (#10).

**Don't break:** admin password reset (L-02, which works), the app's code-based reset (`/app/auth/forgot` → `/reset/verify` → `/reset`).

### 12 · BUG-C3 — invite / set-password links don't open the app · P1 · Backend/ops (app part done)
**Tests:** C-18, L-15.
**Done in the app (23 Nov):** the Android app now claims `https://admin.eventor.72-60-190-211.sslip.io/set-password` (exact path). Verified on the emulator: when the app is allowed for the domain, the link opens the "Set your password" screen, cold and warm.
**Backend / ops fix:**
- Serve `https://admin.eventor.72-60-190-211.sslip.io/.well-known/assetlinks.json` as `Content-Type: application/json`, with no redirect:
  ```json
  [{
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.symloop.eventor",
      "sha256_cert_fingerprints": [
        "80:74:C0:3F:BA:FC:B0:1C:DD:8F:ED:7D:80:B2:24:1F:27:BB:04:F7:C1:28:A3:43:6C:DD:C5:EE:70:F4:49:A3"
      ]
    }
  }]
  ```
- Once the app is on Google Play with Play App Signing, add the **Play signing key** SHA-256 (from Play Console) as a second fingerprint.
- Serve `apple-app-site-association` when the iOS team id and bundle id are final.
- Do the same on the production domain (#26).
- The `/reset-password` link stays web-only: the app has no API for that token.

**Verify:** `curl -I` returns 200 with JSON. On the emulator, `adb shell pm verify-app-links --re-verify com.symloop.eventor`, then `pm get-app-links com.symloop.eventor` shows `verified`. Then re-run C-18.

### 13 · BUG-H3 — user/provider reports are stored but invisible in the dashboard · P1 · Dashboard
**Tests:** H-08, P-09, L-31, L-40.
**Observed:** a report on a provider or user is stored (`GET /admin/reports` covers every `targetType`), but the dashboard shows it nowhere. The user page only counts reported reviews.
**Fix:**
- List all report target types (`review`, `message`, `service`, `pack`, `provider`, `user`) in the dashboard's moderation view, with filters and the same actions (resolve/dismiss, go to target).
- Show the report counts on the user and provider pages.

**Also check:** `POST /app/reports` accepts `targetType: "pack"`. The app will add a Report entry on the pack page (BUG-H2, app side).

### 14 · BUG-G2 — chat system messages: not linked to their booking, missing events, English only · P1 · Both
**Tests:** G-09, M-05, N-09, O-07, L-24.
**Observed:**
1. System messages ("Booking EVT-… requested for 2026-12-03 (…)", "… accepted. Contact details are now visible…") carry no booking reference, so the app can't make them open the booking.
2. There is **no** system message for reschedule proposals, declines or cancellations.
3. The texts are raw English with ISO dates, even in an Arabic user's chat.

**Backend fix (additive):**
- Give each `kind: "system"` message a structured part: `event` (`booking_requested`, `booking_accepted`, `booking_declined`, `booking_cancelled`, `reschedule_proposed`, `reschedule_accepted`, `reschedule_declined`, `booking_completed`, `booking_expired`), `bookingId`, `bookingRef`, and `params` (dates as ISO, service title in EN and AR, who acted).
- Keep `body` for older app versions, but render it in the **recipient's language** (`/app/me` language) with a human date ("3 December" in EN, "3 ديسمبر" in AR, not "2026-12-03").
- Emit system messages for **all** the events above. Today only *requested* and *accepted* exist.
- Document the new fields in the spec.

**App part:** the mobile session will make system messages tappable (open B4 via `bookingId`) and render them from `event` + `params` in the app's language.

### 15 · BUG-G4 — hiding or deleting a message doesn't reach a chat that is already open · P2 · Both
**Tests:** G-11, M-15, N-02, L-29.
**Observed:** after a moderator hid or deleted a message, the original text stayed visible in the open client chat for 25+ seconds, until the chat was reopened. There is no live event for it, and the poll only fetches new messages.
**Backend fix:** when a message is hidden, deleted or restored (by moderation or by its sender), emit a socket event to both participants, such as `message:updated` `{ conversationId, messageId, removed: true, body: "" }`, and update `conversation:updated` if it was the last message. Document it in the spec.
**App part:** the mobile session will listen for it and replace the bubble.

### 16 · BUG-H5 — timeline: a dispute reopen is recorded as "accepted" · P2 · Both
**Tests:** H-13, M-13, L-32.
**Observed:**
- Both timelines (client and provider) take the last `accepted` event, which comes from the dispute's internal reopen. They show "Accepted / You accepted Sun 22 Nov 13:41", drop the completion and the dispute, and show "Completed · Not applicable".
- The reason appears as the raw code "dispute".
- The cancelled B4 no longer links to the dispute.

**Backend fix:**
- Don't record a dispute's reopen as an `accepted` status event. Use a distinct event type (for example `reopened_for_dispute`) or don't put it in the booking's status history.
- Keep the completion and dispute events in the booking timeline.
- Return the dispute id on the booking detail when one exists (additive), so the app can link to it.
- Send a `reasonLabel` next to every reason code (#18).

**App part:** the mobile session will render the new event and stop showing raw codes.

### 17 · BUG-M5 — a deleted user's conversations stay active · P1 · Both
**Tests:** M-30, N-25.
**Observed:**
- After a client deleted their account, the provider still saw the conversation as a normal user (name, initials, active composer), and a new message **was accepted (201)**.
- In the dashboard, "Users" search no longer finds the client, while booking EVT-000154 still shows "Zakaria Amrani · Open profile".

**Backend fix:**
- On account deletion, mark the counterpart in conversations: an additive field such as `counterpart.deleted: true` (and a display name "Deleted user" if product wants anonymisation).
- `POST /app/conversations/:id/messages` to a deleted user returns **409/410** with a clear code (for example `RECIPIENT_DELETED`).
- **Dashboard:** bookings, reviews and conversations show "Deleted user" without a broken "Open profile" link. Users search can show deleted accounts with a "deleted" badge, if product wants.

**Don't break:** invoices and reviews kept after deletion (the 30-day rule), disputes.
**App part:** read-only chat with a "This account was deleted" banner (mobile session).

### 18 · BUG-H4 + BUG-M3 — admin or system cancellations blamed on the provider; raw reason codes shown · P1 · Both
**Tests:** H-13, M-13, M-16, N-22, L-17, L-24.
**Observed:**
- A booking cancelled by an admin, or by a provider block, shows "Traiteur El Djazair cancelled this booking". The app treats `cancelledBy` as client-or-everyone-else.
- The reason shows as the raw code "account_blocked" or "dispute".

**Backend part:**
- Make sure `cancelledBy` takes distinct values for every actor (`client`, `provider`, `admin`, `system`), and that admin and block cancellations set `admin`/`system`, not `provider`. Check old rows.
- Return a localised `reasonLabel` next to every `reason` code (booking cancel/decline, block, dispute), in the language of `Accept-Language`.
- Document both in the spec.

**App part:** the mobile session will map `admin`/`system` to "Eventor cancelled this booking" and show `reasonLabel`.

### 19 · BUG-N2 — device-token registration returns 500 after switching accounts on one phone · P1 · Backend
**Tests:** N-33.
**Observed:** `POST /app/me/device-tokens` returned **500 INTERNAL_ERROR** when a second account signed in on the same device right after the first signed out. The same FCM token was registered again for a different user (likely a unique-constraint violation), so that user may get no push notifications.
**Backend fix:**
- Make the registration an **upsert keyed on the token**: if the token belongs to another user, move it to the current user (and delete it from the old one).
- On logout (`/app/auth/logout`), delete that device's token.
- Never return 500 for this.

**Don't break:** multiple devices per user, and token refresh.

### 20 · BUG-B1 — verification e-mails come from a personal Gmail; empty body at some providers · P1 · Backend/ops
**Tests:** B-01.
**Observed:** code e-mails are sent from a personal Gmail address. At two disposable inboxes they arrived with an **empty body** (Guerrilla Mail) or not at all (mail.tm).
**Fix:**
- Send from a domain address on the production domain (#26), through a transactional provider with **SPF, DKIM and DMARC** set up.
- Every e-mail has a `text/plain` part that contains the code or link, as well as the HTML part.
- Check every template: verification code, reset code, set-password, dashboard reset, admin invites, event-request (E1–E7).

### 21 · BUG-C1 — password reset accepts the same password as before · P2 · Backend (+ app message)
**Tests:** C-14, M-29.
**Observed:** the reset flow accepted the **same** password, although the screen says it must differ from the previous one.
**Backend fix:**
- In `POST /app/auth/reset` (and `/app/me/password`, `/app/auth/set-password` if relevant), compare the new password against the current hash, and refuse with **422** and a specific code (for example `PASSWORD_UNCHANGED`).
- Document the code in the spec.

**App part:** show that code's message on the field (mobile session).

### 22 · BUG-O2 — English service title in the Arabic invoice and price line · P2 · Backend (+ app)
**Tests:** O-07, O-09.
**Observed:** the booking price line (B4/P2) and the invoice line use the service's English title, although an Arabic title exists.
**Backend fix:**
- Store both titles on the booking/invoice line snapshot (`title`, `titleAr`), or return the title in the request's language.
- Generate the Arabic invoice with the Arabic title.

**App part:** pick the right title by language (mobile session).

### 23 · BUG-L1 — dashboard saved view: the trash icon applies the view instead of deleting it · P2 · Dashboard
**Tests:** L-39.
**Fix:**
- Stop the click from bubbling from the trash button to the row (`stopPropagation`), and wire the delete with a confirmation.
- Add rename, if it's cheap.
- Afterwards, the QA view "QA L view" can be deleted: ask the user.

### 24 · Other server-side P2s · Backend/dashboard
Take these one at a time, like the others:
- **Notification texts carry ISO dates** ("2026-12-16") in EN and AR (O-07). Format dates per language.
- **The admin calendar labels admin blocks "Blocked by provider"** (F-32). Covered by #8.
- **The admin accounts list** keeps showing an accepted admin as "Invitation sent · Resend/Revoke" until a full reload (L-02). Refresh the list after acceptance, or invalidate the cache.

### 25 · BUG-N3 — the live server still serves the September seed data to real users · P0 before launch · Data/ops
**Tests:** N-31, N-32.
**Observed:** every real user sees the seed data: 34 `@eventor.test` accounts, 53 services, seed reviews, misfiled services ("Party", "Guest shuttle"), and the QA test packs, services and messages.
**Plan (do NOT run without an explicit go and a backup):**
1. Write a script that **lists** exactly what would be deleted.
2. **Keep:** the store-review accounts, the dev accounts, and anything the user names.
3. Show the list to the user, take a DB backup, then run it on the user's yes.
4. Re-run N-31/N-32 and spot-check Home, Search and provider profiles.

### 26 · BUG-P1 — production domain (also fixes BUG-A3 and BUG-A1) · P0 before launch · Ops first, then app
**Tests:** P-11, A-21, C-18, A-17.
**Observed:**
- Everything runs on `*.72-60-190-211.sslip.io`: the API, the dashboard, the legal pages and the delete-account page.
- `storeUrls` is null.
- BUG-A3 (lists failing until an app restart) is most likely the 180-second negative DNS cache on sslip.io.
- BUG-A1: the offline screen tip mentions `eventor.dz`, which isn't a confirmed domain.

**Backend / ops part (when the business gives the domain):**
- Set up DNS + TLS for `api.<domain>` and `admin.<domain>` (or the chosen web host), and set the server's `APP_PUBLIC_URL`.
- Update the legal/terms/privacy URLs and `deleteAccountUrl` in `/app/config`.
- Serve `assetlinks.json` on the new host (#12), and fill `storeUrls` once the stores have the app.
- Move the e-mail sender (#20).

**App part (mobile session):** new `baseUrl` (or `--dart-define`), the manifest `appLinkHost`, a version bump, a new AAB. Until then, publish only to an internal/closed testing track.

---

## 5. When everything above is done
Report to the user:
- a list of every bug with status (fixed / needs product decision / blocked);
- every contract change (field, value, error code, socket event), so the mobile session can adopt them;
- every live data change made, with the user's approval;
- any acceptance test that still fails.
