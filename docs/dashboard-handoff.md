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

## BUG-L4 — the emailed `/set-password` page is a 404 (L-15, C-18)

A user created from the dashboard gets `${APP_PUBLIC_URL}/set-password?token=…`
(valid 7 days, single use). On the live host that URL goes to the dashboard,
which redirects to `/en/set-password` and has no such page.

**API (ready):**
- `POST /api/v1/app/auth/set-password/check` `{ token }` (public): checks the link
  without using it. 200 → `{ firstName, emailHint, expiresAt }`. Errors:
  `RESET_TOKEN_INVALID` 400 (unknown, already used or altered), `RESET_TOKEN_EXPIRED`
  410, `ACCOUNT_BLOCKED` 403 (same `details` as the app: `reasonLabel`, `message`…).
- `POST /api/v1/app/auth/set-password` `{ token, password }` (public, existing):
  sets the password, marks the email verified. Same errors plus `PASSWORD_WEAK`
  (`details.minLength`). It answers an app session (tokens): the page must **not**
  keep or store them.
- Send `Accept-Language: en|ar` so error messages come back in the page's language.

**Dashboard to do — a public page (no dashboard login):**
1. Route: `/set-password` and `/{en,ar}/set-password`, keeping `?token=`. Keep the
   path exactly `/set-password`: the Android app claims that path (#12).
2. On load: call `…/set-password/check`. Valid → "Hello {firstName}, choose a password
   for {emailHint}". Invalid → "This link is not valid or was already used". Expired →
   "This link has expired, ask Eventor for a new one". Blocked → the blocked message.
3. Form: password + confirmation. Rules shown and checked before sending, identical to the
   app: **at least 10 characters, with at least one letter and one digit** (max 128).
4. Submit → `…/set-password`. Success → "Your password is set. Open the Eventor app and
   sign in with {email}", with the store links (`/app/config` → `storeUrls`) when set.
5. Bilingual EN / AR, RTL for Arabic, no dashboard navigation.

## BUG-L3 — "Email a reset link" links always said "expired" (L-19, L-15, L-22)

**Fixed in the API, no dashboard change required.** The `/reset-password` page posts
every link to `POST /admin/auth/reset`, which only accepted admin accounts; a link
sent to an app account came back `RESET_TOKEN_INVALID`, shown as "expired". The route
now redeems both. **Small dashboard follow-up:** the success screen should not send an
app user to the dashboard sign-in. Use a neutral text such as "Your password has been
changed. Sign in again on the dashboard or in the Eventor app." Show
`RESET_TOKEN_EXPIRED` (410) as "expired" and `RESET_TOKEN_INVALID` (400) as "not valid
or already used", rather than one message for both.

## BUG-F6 / BUG-M1 — admin availability blocks (F-32, M-22, L-12, L-20)

**API (ready):** each item of `GET /admin/providers/{id}/availability` has a new
`source`: `provider` or `admin` (blocks created from the dashboard; older ones
were backfilled from the audit log). The dashboard still sees the note and can
remove any manual block. The provider app no longer gets the note of an `admin`
block and cannot remove it.

**Dashboard to do:** label the block by `source`: "Blocked by Eventor" for
`admin`, "Blocked by provider" for `provider` (today every block says "Blocked by
provider"). Optionally, mention in the create-block form that the note stays
internal.

## #24 — admin accounts list stays on "Invitation sent" after acceptance (L-02)

The API list was already right: an accepted invitation is no longer listed, the new
admin is. The open dashboard simply never knew, because the invitee accepts in their own
browser. **API (ready):** the admin socket (`/admin` namespace) now emits
**`admins:updated`** `{ reason, userId, invitationId }` to every connected admin when an
invitation is sent, accepted or revoked, or an admin is removed (`reason`:
`invitation_sent` | `invitation_accepted` | `invitation_revoked` | `admin_removed`).
**Dashboard to do:** on `admins:updated`, invalidate / refetch the team list (and the
pending invitations badge if there is one).

## BUG-L1 — saved view: the trash icon applies the view instead of deleting it (L-39)

**API (ready, unchanged, tested):** `DELETE /admin/saved-views/{id}` → 204 (owner only,
soft delete; 403 `NOT_OWNER` on another admin's shared view). Rename:
`PATCH /admin/saved-views/{id}` `{ name }` (409 `SAVED_VIEW_NAME_TAKEN`).

**Dashboard to do:**
1. In the trash button's click handler, call `event.stopPropagation()` (and
   `preventDefault()` if the row is a link), so the click no longer reaches the row.
2. Ask for confirmation ("Delete the view {name}?"), then call the DELETE and remove the
   row. Hide the trash icon on views the admin does not own.
3. Optional: a rename action through the same PATCH.

The QA view "QA L view" on live can be deleted afterwards, with the owner's OK.

## BUG-H4 / BUG-M3 — who cancelled (H-13, M-13, M-16, L-17, L-24)

`cancelledBy` on bookings can now also be **`system`** (no person, e.g. a job); the
typed client marks it `CancelledBy`. Show it as "Eventor (automatic)". A provider deleting
their own service, or a user deleting their account, is now recorded as that party
instead of `admin`. Older rows keep their stored value.

## BUG-M5 — deleted accounts shown as normal users (M-30, N-25)

**API (ready):** booking rows and the booking detail have `client.deleted` and
`provider.deleted` (true once the account was deleted). **Dashboard to do:** when it is
true, show the name with a "Deleted user" badge and no "Open profile" link (the user page
answers 404 `USER_NOT_FOUND`). Do the same wherever the dashboard links a person from a
booking. Listing deleted accounts in Users search is a separate product choice, not
done here.

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
