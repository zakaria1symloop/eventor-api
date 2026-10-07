# Status rules (admin side, V1)

**Consolidated on 15 September 2026.** This is the single current version.

Every status in the platform: who can move it, when, and what happens as a result.
- **Enforcement:** in the module policy. The dashboard disables the buttons for moves that aren't allowed.
- **Invalid moves:** return `409 <DOMAIN>_INVALID_TRANSITION`.
- **Side effects:** listed under "Effects". They happen in the same transaction; notifications and jobs run after it commits.

## Product facts

- **Roles:** `client`, `provider`, `admin`. Academic is not a role.
- **Payment:** cash between client and provider. Eventor tracks no money, refunds or cancellation fees, and issues invoice documents only.
- **Ready Packs:** built by a provider from their own services.
- **Academic requests:** sent by anyone through admin-built web forms and handled by admins.
- **Disputes:** raised by a client or provider and handled by an admin.
- **Verification:** email codes only (Google mail), no SMS.

Notification channels: 🔔 in-app · 📱 push (FCM) · ✉️ email.

## 1. User account

**`users.status`: `active` ⇄ `blocked`**

| From → To | Who | Effects | Notify |
|---|---|---|---|
| active → blocked | admin (reason; optional `blocked_until`; message) | revoke sessions; provider: services and packs hidden; pending bookings cancelled **or** kept (admin chooses); conversations read-only for the user; audit (sensitive) | ✉️ user |
| blocked → active | admin, or job when `blocked_until` passes | services and packs visible again; cancelled bookings stay cancelled; audit | ✉️ user |

**Email verification:** a 6-digit code, valid 15 min, max 5 tries, resend after 60 s. Required before booking, messaging or submitting documents.

**Soft delete:**
- **Who:** an admin (type-to-confirm), or the user.
- **Refused** while the user has an accepted upcoming booking or an open dispute (`409 ACCOUNT_HAS_ACTIVE_ITEMS`).
- **After 30 days:** a job anonymises the personal data. Bookings, reviews, invoices and disputes remain, shown as "Deleted user".

**Role:** set at sign-up (client or provider) and never changes. Admins join by invitation (72 h). You can't remove yourself or the last admin.

**Repeated problems:** no strikes. Admins see dispute and cancellation counts on the profile and decide themselves.

## 2. Provider verification

**`user_documents.status`: `pending` → `approved` | `rejected`**, and `approved` → `pending` (admin undo).

| Event | Who | Effects | Notify |
|---|---|---|---|
| upload / resubmit | provider (or admin on their behalf) | new row `pending`, previous version `is_current=false` | 🔔 admins |
| approve | admin | recompute | only when the account becomes verified |
| reject | admin (reason + message) | recompute | 🔔📱✉️ provider |

**`users.verification_status`** (providers):
- **`verified`:** national ID, commercial register **or** artisan card, and tax card (NIF) all approved.
- **`rejected`:** any one of them rejected.
- **`pending`:** anything else.
- **Becoming verified:** published services and packs appear. 🔔📱✉️ "Profile approved".

## 3. Service

**`services.status`: `draft` → `published` ⇄ `hidden`**; `published` → `draft` (the provider unpublishes).

| From → To | Who | Guard | Effects | Notify |
|---|---|---|---|---|
| draft → published | provider or admin | EN + AR title/description, base price, ≥ 1 photo, category, ≥ 1 wilaya | visible when the provider is active and verified | 🔔 provider if the admin did it |
| published → hidden | admin (reason) | — | out of search and profile; packs containing it → `needs_attention` | 🔔📱 provider |
| hidden → published | admin | publish guard | packs recomputed | 🔔📱 provider |
| published → draft | provider | — | as hidden | — |
| delete (soft) | provider or admin | no accepted upcoming booking (`409 SERVICE_HAS_BOOKINGS`) unless admin override | pending bookings cancelled; packs recomputed | 🔔📱 affected clients |

**Other rules:**
- **Cancellation policy:** free text per service in EN and AR, set by the provider or admin. It's shown to clients and **not enforced**.
- **Wilayas:** the provider chooses from **open** wilayas and the admin can edit them. A closed wilaya stops that service being found there.
- **"Available for bookings" off:** the service stays visible and booking is disabled.
- **Featured:** admin only, max 12, published services only.

## 4. Ready Pack

**`packs.status`: `draft` → `published` ⇄ `unpublished`**

| From → To | Who | Guard |
|---|---|---|
| draft → published | provider (owner) or admin | ≥ 2 items, **all published services of the same provider**; provider active and verified; EN + AR name; price below the sum of the items |
| published → unpublished | provider or admin | — |

**`needs_attention`:** true when an item is not published or is deleted, or the provider is blocked or unverified. The pack is then hidden and listed under "Need attention", and 🔔 the provider is told.

**Booking a pack:** creates one booking with a line per item. The provider must be free on that date.

## 5. Booking

```
pending ──accept──▶ accepted ──complete──▶ completed
   ├─decline─▶ declined   └─cancel─▶ cancelled
   └─cancel──▶ cancelled
completed ──reopen (admin)──▶ accepted
```

| From → To | Who | Guard | Effects | Notify |
|---|---|---|---|---|
| create → pending | client (email verified) or admin (for a client, or for an academic request) | service or pack visible, provider accepting bookings, date ≥ today + `booking_min_notice_days`, provider free | `EVT-…`; lines + totals; `fee_percent` snapshot; availability `held`; conversation linked | 🔔📱 provider |
| pending → accepted | provider or admin | date still free (row lock) | availability `booked`; **invoice issued by Eventor**; contact details unmasked in chat | 🔔📱 client · ✉️ invoice |
| pending → declined | provider or admin (reason) | — | availability released | 🔔📱 client |
| pending → cancelled | client, provider or admin (reason) | — | availability released | 🔔📱 other party |
| accepted → cancelled | client, provider or admin (reason) | **no fee or window enforced** (cash); the service's policy text is shown; disagreements → dispute | availability released; invoice voided (soft delete) | 🔔📱 other party |
| accepted → completed | job at event end + `dispute_window_hours` (72 h) if no dispute is open; **immediately** if both parties tap "All good"; or admin | event date passed | `completed_at`, counters | 🔔📱 both parties, except whoever confirmed last · after `review_open_after_hours` 🔔📱 client "Leave a review" |
| completed → accepted | admin (reason) | — | review request withdrawn if no review yet | — |

**Other booking actions:**
- **Reply deadline:** pending longer than `booking_reply_deadline_hours` (48 h). Reminder to the provider at −12 h, then a "no reply" flag (a filter on BKG-01 and on the Overview).
- **Reschedule:** either party proposes and the other accepts. A pending booking changes directly; an admin can force it. 🔔📱 the other party on a proposal, a move and a rejection (both parties when the admin acts).
- **Price change:** by the provider while pending, or by an admin. A new invoice version is issued if the booking is already accepted. 🔔📱 the client.
- **Remind provider:** admin action. 🔔📱 the provider.

## 6. Dispute

Payment is cash, so a dispute is **only a way to raise a problem on a booking and hand it to an admin**. There are no refunds, strikes, appeals or deadlines.

`open → in_review → resolved | closed`

| Step | Who | What happens | Notify |
|---|---|---|---|
| open | client or provider: from the event start until 72 h after the event end, or within 7 days of a contested cancellation. Admin: any time, or by converting a report | type, description, optional evidence files (≤ 5 MB, max 10); `DSP-…`; booking `dispute_status=open` → **auto-completion and reviews paused**; dispute conversation (client + provider + Eventor) with the booking chat attached | 🔔📱 other party · 🔔 admins |
| in review | admin assigns themselves | talks to both sides in the dispute chat, can ask for more files | 🔔📱 parties on admin messages |
| resolved | admin | **decision note** (required) + booking outcome: `completed`, `cancelled` or `unchanged`. Other actions (block, hide service, remove review) use the normal flows | 🔔📱✉️ both parties |
| closed | admin (no action needed) or opener (withdraw) | booking continues normally | 🔔 other party |

**Rules:**
- Only one open or in-review dispute per booking.
- A review on a booking that had a dispute gets `had_dispute=true`, shown as a label.
- Evidence is private to the parties and admins.

## 7. Academic request

**Sending a request:** anyone can send one through the web form `/f/:slug`, with or without an account.
- **Required:** name, email (confirmed by code) and phone.
- **Signed in:** the request links to that account.

**Handling:** the admin checks the request, proposes services and creates the bookings.

`pending ⇄ changes_requested → approved → in_progress → completed`, and `rejected` or `cancelled` from open statuses.

| From → To | Who | Guard | Effects | Notify |
|---|---|---|---|---|
| submit → pending | requester | form validation from the version; email code confirmed; per-email monthly limit | `ACR-…`; mapped fields copied from the answers | ✉️ requester confirmation · 🔔 admins |
| pending → changes_requested | admin | fields + message | link to edit the answers (by emailed token) | ✉️ requester |
| changes_requested → pending | requester | edited | changed fields highlighted | 🔔 admins |
| pending → approved | admin | — | admin adds proposals (services) | ✉️ requester |
| approved → in_progress | admin creates the first booking (`academic_request_id`) | the requester needs a client account: created or linked by the admin, invitation email sent | bookings follow §5 | ✉️ requester · 🔔📱 providers |
| pending / changes_requested → rejected | admin (reason + message) | final | — | ✉️ requester |
| open → cancelled | admin (or requester by emailed link) | not completed | linked pending bookings cancelled | ✉️ requester · 🔔 providers |
| in_progress → completed | job | all linked bookings completed or cancelled, and the event date passed | — | — |

**Forms (`forms.status`: `draft → published → closed`):**
- **Publish:** creates an immutable version.
- **Versioning:** each request keeps its version.
- **Delete:** only with 0 submissions; otherwise close the form.
- **Default:** exactly one form is the default.

## 8. Review

**Who and when:**
- **Author:** the client of a **completed** booking, one review per booking.
- **Window:** from 24 h after completion until 60 days after it. Not while a dispute is open.
- **Editing:** the author can edit for 48 h.

`published ⇄ hidden`, `published → redacted`, soft delete by admin.

| Change | Who | Effects | Notify |
|---|---|---|---|
| create | client | flag scan (phone, email, link, insults); flagged → published + automatic report | 🔔📱 provider |
| hide / redact / show | admin | ratings recomputed; reports on it resolved | 🔔 author |
| delete | admin | recompute; can't be rewritten | — |

**Provider reply:** one public reply per review, editable for 48 h. The admin can hide it (`published ⇄ hidden`). 🔔 the client.

## 9. Report

`open → resolved | dismissed`

- **Targets:** review, review reply, message, service, pack, user. One open report per reporter and target.
- **Admin actions:**
  - **Act** (hide, redact, close chat, block): resolves all open reports on that target.
  - **Dismiss.**
  - **Convert to dispute:** only when the target is linked to a booking.
- **Notify:** 🔔 admins on a new report; 🔔 the reporter with the outcome.

## 10. Conversation & message

- **Kinds:**
  - `direct`: client ↔ provider, one per pair.
  - `support`: user ↔ Eventor.
  - `dispute`: both parties + Eventor, one per dispute.
- **Conversation status:** `open ⇄ closed`, admin only (scope: all or one participant). A dispute chat closes 7 days after resolution.
- **Contact details:** masked (`body_masked`) until the pair has an accepted booking. Admins see the original text.
- **Message status:** `visible → hidden | deleted`. Admin can do this to any message. The sender can delete their own within 5 min, except in dispute chats.
- **Push:** 📱 every message to the other participants (`message.new`, masked like the chat, no 🔔 row). Dispute chats use `dispute.message`; system messages send nothing.

## 11. Other statuses

| Entity | Statuses | Rule |
|---|---|---|
| `files.processing_status` | pending → ready / failed | failed → 🔔 uploader |
| `booking_reschedules.status` | pending → accepted / rejected / cancelled | §5 |
| `admin_invitations` | sent → accepted / revoked / expired | 72 h |
| `exports.status` | queued → running → done / failed | ≥ 5,000 rows emailed |
| `wilayas.is_open` | open ⇄ closed | closed: hidden from search, no new bookings there (confirm dialog shows count) |
| `categories.is_visible` | visible ⇄ hidden | hidden: not selectable for new services |
| `settings.maintenance_mode` | off ⇄ on | future mobile API returns 503; dashboard works |

## Decision log (15 Sep 2026)

| Topic | Decision |
|---|---|
| Verification | email code, no SMS |
| Password | ≥ 10 characters, a letter and a digit |
| Phone | input `0XXXXXXXXX`, stored `+213…` |
| Documents | 5 MB |
| Roles | client, provider, admin |
| Ready Packs | one provider's own services |
| Academic | web forms built by admins, sent by anyone, handled by admins |
| Payment | cash; no refunds, no cancellation fees; policy text per service |
| Invoices | issued by Eventor (company details pending) |
| Disputes | open → in review → resolved / closed, admin decides |
| Contact details in chat | masked until an accepted booking |
| Reviews | edit 48 h; one provider reply |
| Wilayas per service | provider chooses from open wilayas; admin can edit |
| Overview stats V1 | from bookings, reviews and users only (no view tracking) |
| Domains | undecided; env variables |
| Scope | admin dashboard + admin API only |
