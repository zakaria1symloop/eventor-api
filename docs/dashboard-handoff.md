# Dashboard handoff — backend fixes of the 23 Nov 2026 acceptance run

The Next.js dashboard is a separate repository. These fixes changed or added
backend behaviour that the dashboard must use. The API is ready in each case;
regenerate the typed client from `openapi.json` first.

## BUG-H3 — reports on users and providers are invisible (H-08, P-09, L-31, L-40)

The API stores and returns every report type. The dashboard only shows reports on
reviews (and messages in MSG-01).

**API (ready):**
- `GET /admin/reports` lists **every** `targetType`: `review`, `review_reply`,
  `message`, `service`, `pack`, `user`. A provider is reported as `user` (the app
  reports the provider's account). Each row has `target.label` (name, business
  name, role) and `target.href` (`/users/{id}` for a user, `null` once deleted).
- New filters:
  - `targetId` (uuid): one target, e.g. `?targetType=user&targetId={userId}`.
  - `aboutUserId` (uuid): everything about one account — reports on the account
    itself and on what it owns or wrote (its services and packs, messages it
    sent, reviews and replies it wrote).
- `GET /admin/users/{id}` → new `stats.reports`:
  `{ open, openOnAccount, total }`, the same definition as `aboutUserId`
  (`open` = open tab, `total` = all statuses, `openOnAccount` = open reports with
  `targetType=user`). `stats.reviews.reported` is unchanged (open reports on reviews).
- Resolve / dismiss work the same for every type (`POST /admin/reports/{id}/resolve|dismiss`).

**Dashboard to do:**
1. Moderation view: one "Reports" list with a **Type** filter covering all six
   types (multi-select → repeated `targetType`), the existing tab / reason / date
   filters, the target label, "Go to target" from `target.href`, and the existing
   Resolve / Dismiss actions.
2. User and provider pages: a "Reports" counter from `stats.reports` (e.g.
   "3 open · 1 on the account"), opening the list with `aboutUserId={id}`.
3. Keep the existing reviews "reported" counter as it is.

## BUG-M4 — block dialog wording (M-16, L-17)

`POST /admin/users/{id}/block` with `bookings`:
- `cancel`: every **pending** request **and** every **accepted** booking whose event
  is not over is cancelled (cancelled by admin, reason `account_blocked`, invoices
  voided, the other party notified).
- `keep`: they all stay. The other party of each accepted booking is told the
  counterpart is unavailable and cannot propose a new date until the unblock.

Unblocking never restores cancelled bookings.

**Dashboard to do:** make the dialog say exactly that. Its radio labels and its
impact list (`GET /admin/users/{id}/block-impact` → `pendingBookings`,
`upcomingBookings`) must agree: with "Cancel them" both counts are cancelled, with
"Keep them" both stay. Add the line "Unblocking does not restore cancelled bookings."
