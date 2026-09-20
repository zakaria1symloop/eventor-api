# Database schema (admin side, V1)

MySQL 8, TypeORM, `utf8mb4_unicode_ci`. **Consolidated on 15 September 2026.** This file is the single current version: code is generated from it and there are no superseded sections.

- **Rules:** `status-rules.md`
- **Screens:** `../../docs/admin-dashboard-screen-map.md`
- **Diagram:** Figma page **DB Schema**

The entities and migrations already in `backend/src` predate this version. **Delete and regenerate them when coding starts.**

## Product facts behind the schema

- **Roles:** `client`, `provider`, `admin`. Academic is **not** a role.
- **Payment:** cash between client and provider, outside the app. Eventor stores prices, issues invoice documents and tracks **no** money, refunds or cancellation fees.
- **Ready Packs:** a provider bundles **their own** services.
- **Academic requests:** sent by anyone through admin-built web forms and handled by admins.
- **Disputes:** raised by a client or provider and handled by an admin. No refunds, strikes or appeals.
- **Languages:** English and Arabic (`*_en`, `*_ar`), both required to publish.
- **Scope now:** admin side only. Tables that only the mobile app will write (favourites, budgets, device tokens) are included so the schema doesn't change later.

## Conventions

- **Primary key:** `id` is a UUID stored as `varchar(36)`, which is how TypeORM's MySQL driver generates it; foreign keys match.
  - Exceptions: `wilayas.code` (tinyint 1–58), `settings.key`, `sequences.name`, `stats_daily` (composite key).
- **Base columns (`AbstractEntity`):** `id`, `created_at`, `updated_at`, `deleted_at` (soft delete).
- **Append-only tables (`AppendOnlyEntity`):** `id`, `created_at` only. Used for logs, history, join rows and messages.
- **Naming:** snake_case in the database, camelCase in entities.
- **Money:** `decimal(12,2)` in DZD; entity type `string`.
- **Enums:** MySQL `enum`, mirrored in `src/common/enums`.
- **Foreign keys:** `RESTRICT` by default; `CASCADE` only for pure children (photos, extras, join rows, lines, evidence, attachments).
- **References:** allocated from `sequences` inside the transaction:
  - `EVT-000123` for bookings
  - `ACR-000142` for academic requests
  - `DSP-000031` for disputes
  - `INV-2026-0318` for invoices
- **Cached counters:** `avg_rating`, `rating_count`, `bookings_count`, … are updated in the same transaction and can be rebuilt by a job.

Tables below: *name*, then its columns (base columns implied unless marked append-only).

## 1. Identity & access

**users**
| column | type | notes |
|---|---|---|
| role | enum `client, provider, admin` | immutable |
| status | enum `active, blocked` | default active |
| verification_status | enum `not_required, pending, verified, rejected` | providers only; others `not_required` |
| full_name | varchar(120) | |
| email | varchar(190) unique | |
| email_verified_at | datetime null | |
| phone | varchar(20) unique null | `+213…` |
| password_hash | varchar(255) null | argon2id; null for invited admins until accepted |
| avatar_file_id | FK files null | |
| language | enum `ar, en` | |
| wilaya_code | FK wilayas null | |
| last_active_at | datetime null | |
| blocked_at, blocked_until | datetime null | |
| blocked_reason | varchar(60) null | |
| blocked_message | text null | |
| blocked_by_id | FK users null | |
| anonymised_at | datetime null | |

Indexes: `(role, status)`, `(verification_status)`, `(created_at)`, fulltext `(full_name, email)`.

**provider_profiles**: 1:1 with provider users.
- `user_id` FK unique, `business_name varchar(150)`, `category_id` FK categories.
- `bio_en`, `bio_ar` text null, `languages_spoken json null`, `years_active tinyint null`.
- `accepting_bookings bool default true`.
- Cached: `avg_rating decimal(3,2)`, `rating_count int`, `completed_bookings_count int`, `reply_rate tinyint null`, `avg_reply_minutes int null`.

**provider_wilayas**: append-only join. `provider_profile_id` FK cascade + `wilaya_code` FK; PK is both columns. This is the provider's default area; the admin can edit it.

**sessions**: append-only plus `revoked_at`.
- `user_id` FK cascade, `token_hash varchar(128) unique`, `audience enum(dashboard, app)`.
- `device_label` null, `ip` null, `user_agent` null, `last_used_at` null, `expires_at`, `revoked_at` null.

**verification_codes**: append-only.
- `user_id` FK cascade null, `purpose enum(email_verify, password_reset, email_change, form_submission)`.
- `destination varchar(190)`, `code_hash`, `attempts tinyint default 0`, `expires_at`, `consumed_at` null.
- Index `(destination, purpose, created_at)`.

**login_attempts**: append-only. `email`, `ip`, `success bool`. Index `(email, created_at)`.

**admin_invitations**: `email`, `full_name`, `token_hash unique`, `invited_by_id` FK users, `expires_at`, `accepted_at` null, `revoked_at` null, `user_id` FK null.

**user_notes**: `user_id` FK, `author_id` FK users, `body text`.

**notification_preferences**: `user_id` FK PK; `push_bookings`, `push_messages`, `push_reviews`, `email_bookings` bool default true; `updated_at`.

## 2. Files & provider verification

**files**
- `owner_id` FK users null.
- `purpose enum(avatar, document, service_photo, pack_photo, attachment, evidence, invoice, export, message)`.
- `storage_path` (the served, compressed file), `original_name`, `mime_type`.
- `size_bytes int`, `original_size_bytes int null`, `width int null`, `height int null`.
- `processing_status enum(pending, ready, failed) default ready`, `checksum char(64)`.
- `is_private bool` (documents, evidence, invoices, attachments).

**file_variants**: append-only. `file_id` FK cascade, `variant enum(thumb, medium, large)`, `storage_path`, `mime_type`, `width`, `height`, `size_bytes`. Unique `(file_id, variant)`.

**Photo rules:**
- **On upload:** EXIF removed, rotated upright, converted to WebP, longest side capped at `photo_max_dimension_px`, quality `photo_quality`. Variants: thumb 320 px and medium 800 px. The original is not kept.
- **Limits (settings):** `max_photos_per_service`, `max_photos_per_pack`, `max_photo_upload_mb`, `allowed_image_types`.
- **Documents:** not recompressed, max `max_document_upload_mb` (5).
- **Lowering a limit:** never deletes existing photos.

**user_documents**: provider verification, one row per submitted file version.
- `user_id` FK users, `type enum(national_id, commercial_register_or_artisan_card, tax_card)`, `file_id` FK files.
- `status enum(pending, approved, rejected) default pending`, `is_current bool default true`.
- `reject_reason enum(unreadable, expired, name_mismatch, wrong_document, other) null`, `reject_note text null`.
- `reviewed_by_id` FK null, `reviewed_at` null.
- Indexes `(user_id, type, is_current)`, `(status, created_at)`.

## 3. Reference data

**wilayas**: `code tinyint unsigned PK`, `name`, `name_ar`, `region enum(north_centre, north_east, north_west, highlands, south)`, `is_open bool default true`, `updated_at`. All 58 are seeded.

**communes**: `wilaya_code` FK, `name`, `name_ar`, `postal_code` null. Unique `(wilaya_code, name)`.

**categories**: `slug unique`, `name_en`, `name_ar`, `description_en` null, `description_ar` null, `icon varchar(40)`, `position int`, `is_visible bool default true`.

**sequences**: `name varchar(40) PK`, `value int`.

## 4. Services & availability

**services**
| column | type | notes |
|---|---|---|
| provider_id | FK users | |
| category_id | FK categories | |
| title_en, title_ar | varchar(160) | |
| description_en, description_ar | text | |
| cancellation_policy_en, cancellation_policy_ar | text null | provider's own policy text; shown to clients; **not enforced or tracked** (cash payment) |
| facts | json null | key facts e.g. `[{label_en, label_ar, value_en, value_ar}]` (duration, team, deliverables) |
| base_price | decimal(12,2) | |
| price_type | enum `per_event, per_hour, per_person, per_day, on_quote` | |
| max_events_per_day | tinyint default 1 | |
| max_guests | int null | |
| status | enum `draft, published, hidden` default draft | |
| hidden_reason | varchar(60) null | |
| hidden_note | text null | |
| hidden_by_id | FK users null | |
| hidden_at | datetime null | |
| allow_resubmit | bool default true | |
| is_featured | bool default false | |
| featured_position | tinyint null | |
| avg_rating, rating_count, bookings_count, favourites_count | cached | |

Indexes: `(status, category_id)`, `(provider_id, status)`, `(is_featured, featured_position)`, fulltext `(title_en, title_ar)`.

**Visible in the app** when all of these hold:
- `status = published`
- provider `active`, `verified` and `accepting_bookings`
- at least one of its wilayas is open
- not soft-deleted

A provider who isn't accepting bookings still has visible services, with booking disabled.

**service_wilayas**: append-only join. `service_id` FK cascade + `wilaya_code` FK; PK is both columns.

**service_extras**: `service_id` FK cascade, `name_en`, `name_ar`, `price decimal`, `position`.

**service_photos**: append-only. `service_id` FK cascade, `file_id` FK, `position` (0 = cover).

**availability_blocks**: `provider_id` FK users, `service_id` FK null, `date`, `start_time` null, `end_time` null, `kind enum(blocked, held, booked)`, `booking_id` FK null, `note` null. Index `(provider_id, date)`.

## 5. Ready Packs

**packs**
- `provider_id` FK users (owner; every item belongs to them, checked by the API).
- `name_en`, `name_ar`, `description_en`, `description_ar` null.
- `event_type enum`, `wilaya_code` FK, `price decimal`, `max_guests` null.
- `status enum(draft, published, unpublished) default draft`, `needs_attention bool default false`.
- `created_by_id` FK users.
- Cached: `avg_rating`, `rating_count`, `bookings_count`.

**pack_items**: append-only. `pack_id` FK cascade, `service_id` FK, `position`. Unique `(pack_id, service_id)`.

**pack_photos**: append-only. `pack_id` FK cascade, `file_id` FK, `position`.

`event_type` enum (shared): `wedding, engagement, henna, birthday, circumcision, graduation, corporate, conference, academic, other`.

## 6. Bookings & invoices

**bookings**
| column | type | notes |
|---|---|---|
| reference | varchar(12) unique | EVT-000123 |
| client_id | FK users | |
| provider_id | FK users | |
| service_id | FK services null | exactly one of service / pack |
| pack_id | FK packs null | |
| academic_request_id | FK academic_requests null | when created by an admin for a request |
| status | enum `pending, accepted, declined, cancelled, completed` | |
| dispute_status | enum `none, open, resolved` default none | open → auto-completion and reviews paused |
| event_type | enum | |
| event_date | date | |
| start_time, end_time | time null | |
| location_text | varchar(255) null | |
| commune_id | FK communes null | |
| wilaya_code | FK wilayas | |
| guests | int null | |
| client_note | text null | |
| subtotal, discount_total, total | decimal(12,2) | informational (paid in cash) |
| fee_percent | decimal(5,2) | snapshot, shown on invoice |
| responded_at | datetime null | |
| reminder_sent_at | datetime null | |
| decline_reason | varchar(60) null | |
| cancelled_by | enum `client, provider, admin` null | |
| cancel_reason | varchar(60) null | |
| client_checked_in_at, provider_checked_in_at | datetime null | "All good" after the event |
| completed_at | datetime null | |
| review_requested_at | datetime null | |
| source | enum `android, ios, web, dashboard` | |
| created_by_id | FK users null | admin when created from dashboard |

Indexes: `(status, event_date)`, `(provider_id, status)`, `(client_id, created_at)`, `(service_id)`, `(pack_id)`, `(status, responded_at, created_at)`, `(dispute_status)`.

**booking_lines**: `booking_id` FK cascade, `kind enum(service, extra, pack_service, discount, adjustment)`, `service_id` FK null, `label`, `quantity int default 1`, `unit_amount decimal`, `amount decimal`, `position`.

**booking_status_changes**: append-only. `booking_id` FK cascade, `from_status` null, `to_status`, `actor_id` FK null, `reason` null, `note` null, `notified bool`.

**booking_reschedules**: `booking_id` FK cascade, `old_date`, `old_start` null, `old_end` null, `new_date`, `new_start` null, `new_end` null, `proposed_by_id` FK users, `reason` null, `forced bool`, `status enum(pending, accepted, rejected, cancelled)`, `resolved_at` null.

**booking_price_changes**: append-only. `booking_id` FK cascade, `old_total`, `new_total`, `lines_before json`, `lines_after json`, `reason` null, `actor_id` FK.

**invoices**: issued by **Eventor**, an immutable snapshot document; no payment status.
- `booking_id` FK, `version int default 1`, `number unique`, `issued_at`, `currency char(3) default 'DZD'`.
- `subtotal`, `discount_total`, `total`, `fee_percent`, `fee_amount`, `provider_amount`.
- `issuer json`: Eventor/Symloop company details from settings at issue time.
- `snapshot json`: parties, lines, service names in EN/AR.
- `pdf_file_id` FK null, `sent_to_client_at` null.
- Unique `(booking_id, version)`. A price change voids the old version (soft delete) and issues version + 1.

## 7. Academic requests & dynamic forms

**forms**
- `slug unique`, `name_en`, `name_ar`, `description_en` null, `description_ar` null.
- `status enum(draft, published, closed) default draft`, `is_default bool` (exactly one).
- `requires_auth bool default false`, `max_submissions_per_email_per_month tinyint null`.
- `confirmation_en`, `confirmation_ar`.
- `live_version_id` FK form_versions null, `draft_schema json null`, `created_by_id` FK users.

**form_versions**: append-only, immutable.
- `form_id` FK cascade, `version int`, `schema json`, `published_by_id` FK users, `published_at`. Unique `(form_id, version)`.
- Each field in `schema` has: `key`, `type`, `label_en/ar`, `help_en/ar`, `required`, `options[]`, `validation{}`, `showIf{}`, `section`, `maps_to`.
- Field types: `short_text, long_text, number, email, phone, single_choice, multi_choice, dropdown, date, time_range, wilaya, service_categories, budget_range, file, section, info, consent`.
- Mappable system fields: `title, event_type, event_date, wilaya, attendees, institution_name, needs, budget`.

**academic_requests**
| column | type | notes |
|---|---|---|
| reference | varchar(12) unique | ACR-000142 |
| form_id | FK forms | |
| form_version_id | FK form_versions | |
| answers | json | all answers of that version |
| requester_id | FK users null | linked if signed in |
| requester_name | varchar(120) | |
| requester_email | varchar(190) | confirmed by code |
| requester_phone | varchar(20) | |
| institution_name | varchar(190) null | mapped |
| title | varchar(190) | mapped |
| event_type | enum null | mapped |
| event_date | date null | mapped |
| wilaya_code | FK wilayas null | mapped |
| attendees | int null | mapped |
| budget_min, budget_max | decimal null | mapped |
| status | enum `pending, changes_requested, approved, in_progress, rejected, completed, cancelled` | |
| requested_changes | json null | |
| decision_message | text null | |
| reject_reason | varchar(60) null | |
| decided_by_id | FK users null | |
| decided_at | datetime null | |
| assigned_admin_id | FK users null | |
| submitted_at | datetime | |

Indexes: `(status, submitted_at)`, `(form_id)`, `(requester_email)`, `(event_date)`.

**academic_request_needs**: append-only. `request_id` FK cascade, `category_id` FK, `note` null.

**academic_request_attachments**: append-only. `request_id` FK cascade, `file_id` FK, `field_key varchar(60)`.

**academic_request_proposals**: services the admin proposes. `request_id` FK cascade, `service_id` FK, `proposed_by_id` FK users, `note` null, `booking_id` FK null (set when booked). Unique `(request_id, service_id)`.

## 8. Disputes

**disputes**
- `reference unique` (DSP-…), `booking_id` FK.
- `opened_by_id` FK users, `opened_by_role enum(client, provider, admin)`, `against_user_id` FK users.
- `type enum(provider_no_show, client_no_show, service_not_as_described, incomplete_or_late, price_disagreement, cancellation_disagreement, damage_or_safety, behaviour, other)`, `description text`.
- `status enum(open, in_review, resolved, closed) default open`, `assigned_admin_id` FK null, `conversation_id` FK conversations.
- `booking_outcome enum(completed, cancelled, unchanged) null`, `decision_note text null`.
- `resolved_by_id` FK null, `resolved_at` null.
- Indexes `(status, created_at)`, `(booking_id)`, `(against_user_id)`.
- Rule: one open or in-review dispute per booking (checked by the API).

**dispute_evidence**: append-only. `dispute_id` FK cascade, `uploaded_by_id` FK users, `file_id` FK null, `kind enum(file, chat_snapshot, note)`, `note` null.

**dispute_events**: append-only. `dispute_id` FK cascade, `actor_id` FK null, `type varchar(40)`, `data json null`.

## 9. Reviews & reports

**reviews**
- `booking_id` FK unique, `author_id` FK users, `service_id` FK null, `pack_id` FK null, `provider_id` FK users.
- `rating tinyint`, `comment text`, `status enum(published, hidden, redacted) default published`, `redacted_comment text null`.
- `detected_flags json null`, `edited_at` null, `moderated_by_id` null, `moderated_at` null, `moderation_note` null.
- `had_dispute bool default false`.
- Indexes `(provider_id, status)`, `(service_id, status)`, `(status, created_at)`.

**review_replies**: one per review. `review_id` FK unique, `provider_id` FK users, `body text`, `status enum(published, hidden) default published`, `edited_at` null, `moderated_by_id` null.

**reports**
- `reporter_id` FK users null (null = automatic report by the flag scan, migration `ReportsSystemReporter`), `target_type enum(review, review_reply, message, service, pack, user)`, `target_id char(36)`.
- `reason enum(inappropriate, spam, contact_outside, harassment, fake, other)`, `note` null.
- `status enum(open, resolved, dismissed) default open`, `resolved_by_id` null, `resolved_at` null, `resolution_note` null, `dispute_id` FK null (if converted).
- Index `(target_type, target_id)`, `(status, created_at)`.

## 10. Messaging & notifications

**conversations**
- `kind enum(direct, support, dispute)`.
- `booking_id` FK null, `service_id` FK null, `dispute_id` FK null, `academic_request_id` FK null.
- `status enum(open, closed) default open`, `closed_scope enum(all, one_participant) null`, `closed_reason` null, `closed_by_id` null, `closed_at` null.
- `last_message_at` null.

**conversation_participants**: append-only. `conversation_id` FK cascade, `user_id` FK users, `role enum(client, provider, support)`, `can_write bool default true`, `last_read_at` null. Unique `(conversation_id, user_id)`.

**messages**
- `conversation_id` FK cascade, `sender_id` FK null (system), `kind enum(text, attachment, system)`.
- `body text null`, `body_masked text null` (contact details masked, shown until the booking is accepted), `file_id` FK null.
- `status enum(visible, hidden, deleted) default visible`, `moderated_by_id` null, `moderated_at` null.
- `created_at`, `updated_at`. Index `(conversation_id, created_at)`.

**notifications**: `user_id` FK cascade, `type varchar(60)`, `title`, `body`, `data json null`, `read_at` null. Index `(user_id, read_at, created_at)`.

**device_tokens**: `user_id` FK cascade, `token varchar(255) unique`, `platform enum(android, ios, web)`, `last_seen_at` null. Written by the future mobile API.

**favourites**: `user_id` FK cascade, `service_id` FK null, `pack_id` FK null. Unique `(user_id, service_id)`, `(user_id, pack_id)`. Written by the future mobile API.

**budgets** / **budget_items**: private to the client. Written by the future mobile API.
- `budgets`: `client_id` FK unique, `title`, `event_date` null, `total_amount`.
- `budget_items`: `budget_id` FK cascade, `category_id` FK null, `label`, `planned_amount`, `spent_amount`, `booking_id` FK null, `position`.

## 11. Admin, audit & analytics

**settings**: `key varchar(80) PK`, `value json`, `updated_by_id` FK null, `updated_at`. Keys and defaults:

| Key | Default |
|---|---|
| `platform_fee_percent` | 10 |
| `pack_fee_percent` | 10 |
| `currency` | "DZD" |
| `invoice_issuer` | `{name, address, nif, rc, email, phone}` — to be provided |
| `booking_reply_deadline_hours` | 48 |
| `booking_auto_reminder` | true |
| `booking_min_notice_days` | 1 |
| `dispute_window_hours` | 72 |
| `review_open_after_hours` | 24 |
| `review_window_days` | 60 |
| `review_edit_hours` | 48 |
| `languages_required` | ["en","ar"] |
| `max_photos_per_service` | 12 |
| `max_photos_per_pack` | 6 |
| `max_photo_upload_mb` | 10 |
| `photo_max_dimension_px` | 1920 |
| `photo_quality` | 80 |
| `allowed_image_types` | jpeg, png, webp, heic |
| `max_document_upload_mb` | 5 |
| `max_dispute_evidence_files` | 10 |
| `maintenance_mode` | false |
| `maintenance_message_en` / `_ar` | "" |
| `min_app_version` | "1.0.0" |
| `support_email` / `support_phone` | "" |
| `terms_url` / `privacy_url` | "" |

**audit_logs**: append-only.
- `actor_id` FK null, `actor_role` null, `action varchar(60)`.
- `object_type varchar(40)`, `object_id char(36) null`, `object_label` null.
- `level enum(info, normal, sensitive, security)`, `changes json null`, `note` null.
- `source enum(dashboard, android, ios, web, system)`, `ip` null, `user_agent` null, `request_id` null.
- Indexes `(object_type, object_id, created_at)`, `(actor_id, created_at)`, `(level, created_at)`.

**saved_views**: `owner_id` FK users, `resource varchar(40)`, `name`, `query json`, `is_shared bool`.

**exports**: `requested_by_id` FK, `resource`, `filters json`, `columns json`, `format enum(csv, xlsx, pdf)`, `status enum(queued, running, done, failed)`, `row_count` null, `file_id` FK null, `emailed_at` null, `error` null.

**stats_daily**: `day date`, `metric varchar(60)`, `dimension varchar(80) default ''`, `value decimal(14,2)`. PK is all three. Filled nightly from bookings, reviews and users. V1 has no view or search tracking; the `events` table is deferred to V2.

## Relationship summary

- **users:** 1–1 provider_profiles; 1–n user_documents, sessions, notifications, user_notes, services (provider), packs (provider), bookings (as client and as provider), reviews (author / provider), disputes (opened / against)
- **categories:** 1–n services, provider_profiles, academic_request_needs
- **wilayas:** 1–n communes; n–n services and provider_profiles
- **services:** 1–n service_photos, service_extras, pack_items, bookings, reviews, academic_request_proposals
- **packs:** 1–n pack_items, pack_photos, bookings
- **bookings:** 1–n booking_lines, booking_status_changes, booking_reschedules, booking_price_changes, invoices (versions), disputes; 0–1 review
- **forms:** 1–n form_versions, academic_requests
- **academic_requests:** 1–n needs, attachments, proposals, bookings
- **disputes:** 1–n dispute_evidence, dispute_events; 1–1 conversation
- **conversations:** 1–n participants, messages
- **reports** and **audit_logs** point to any object by `(type, id)`

## Screen → table check

| Screens | Tables |
|---|---|
| OVR-01 | bookings, user_documents, academic_requests, disputes, reports, reviews, audit_logs, stats_daily |
| USR-01…11, USR-13 | users, provider_profiles, provider_wilayas, sessions, verification_codes, user_notes, audit_logs |
| VER-01…04 | user_documents, files |
| SRV-01…06 | services, service_extras, service_photos, service_wilayas, availability_blocks, files, file_variants |
| PCK-01…03 | packs, pack_items, pack_photos |
| BKG-01…07 | bookings, booking_lines, booking_status_changes, booking_reschedules, booking_price_changes, invoices |
| DSP-01…03 | disputes, dispute_evidence, dispute_events, conversations, messages |
| ACR-01…07 | forms, form_versions, academic_requests, academic_request_needs, academic_request_attachments, academic_request_proposals |
| REV-01…03 | reviews, review_replies, reports |
| MSG-01…03 | conversations, conversation_participants, messages, reports |
| CAT / LOC | categories, wilayas, communes |
| SET-01/02 | settings, admin_invitations, users |
| LOG-01/02 | audit_logs |
| SHL-01…05 | users (fulltext), notifications, sessions, login_attempts, verification_codes |
| STA-05 | exports, saved_views |
