/**
 * Demo data that only the mobile API reads (module 15), called by
 * `demo-seed.ts` inside its transaction, after the services, packs and
 * bookings exist.
 *
 * The admin dashboard has no screen for any of it, so without this step a
 * mobile developer pointing the app at the demo database finds screen 17
 * Favorites and screen 18 Budget empty and cannot tell a bug from no data:
 *
 * - **Favourites** for a handful of clients: visible services plus a pack, so
 *   the category chips on screen 17 have something to filter.
 * - **A budget** for the client with the most bookings: six lines matching the
 *   categories of screen 18, three of them linked to real accepted bookings so
 *   "3 of 6 services booked" and the provider names are genuine.
 * - **Notification preferences** and a **device token** for that same client,
 *   so the Profile · Notifications screen and the push registration round trip
 *   have a row to start from.
 *
 * Idempotent: every block is skipped when its rows already exist, so a second
 * `pnpm seed:demo` changes nothing and never breaks existing data.
 */
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { DevicePlatform } from '../../common/enums/messaging.enums.js';

export interface AppSeedSummary {
  favourites: number;
  budgets: number;
  budgetItems: number;
  deviceTokens: number;
}

/** The lines screen 18 draws, in order, matched to real categories by slug. */
const BUDGET_LINES: { slug: string; label: string; planned: number; spent: number }[] = [
  { slug: 'salles-des-fetes', label: 'Venue', planned: 120_000, spent: 110_000 },
  { slug: 'photographie', label: 'Photography', planned: 45_000, spent: 45_000 },
  { slug: 'decoration', label: 'Decor', planned: 30_000, spent: 25_000 },
  { slug: 'traiteur', label: 'Catering', planned: 150_000, spent: 0 },
  { slug: 'musique-dj', label: 'Music', planned: 30_000, spent: 0 },
  { slug: 'gateaux-patisserie', label: 'Cake & sweets', planned: 25_000, spent: 0 },
];

const money = (value: number): string => value.toFixed(2);

export async function seedAppData(em: EntityManager): Promise<AppSeedSummary> {
  const summary: AppSeedSummary = { favourites: 0, budgets: 0, budgetItems: 0, deviceTokens: 0 };

  // ── favourites ──────────────────────────────────────────────
  const [{ n: existingFavourites }] = await em.query('SELECT COUNT(*) AS n FROM favourites');
  if (Number(existingFavourites) === 0) {
    const clients: { id: string }[] = await em.query(
      "SELECT id FROM users WHERE role = 'client' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at LIMIT 8",
    );
    const services: { id: string }[] = await em.query(
      `SELECT s.id FROM services s JOIN users u ON u.id = s.provider_id
       WHERE s.status = 'published' AND s.deleted_at IS NULL AND u.status = 'active'
         AND u.verification_status = 'verified' AND u.deleted_at IS NULL
       ORDER BY s.avg_rating DESC, s.id LIMIT 12`,
    );
    const packs: { id: string }[] = await em.query(
      "SELECT id FROM packs WHERE status = 'published' AND needs_attention = 0 AND deleted_at IS NULL ORDER BY id LIMIT 3",
    );

    for (const [index, client] of clients.entries()) {
      // Three or four services each, overlapping between clients so the
      // `favourites_count` counters are not all 1.
      const picks = services.filter((_, position) => position % clients.length === index % clients.length || position === index);
      for (const service of picks.slice(0, 4)) {
        await em.query(
          'INSERT INTO favourites (id, created_at, updated_at, user_id, service_id, pack_id) VALUES (?, NOW(6), NOW(6), ?, ?, NULL)',
          [randomUUID(), client.id, service.id],
        );
        summary.favourites++;
      }
      const pack = packs[index % Math.max(1, packs.length)];
      if (pack) {
        await em.query(
          'INSERT INTO favourites (id, created_at, updated_at, user_id, service_id, pack_id) VALUES (?, NOW(6), NOW(6), ?, NULL, ?)',
          [randomUUID(), client.id, pack.id],
        );
        summary.favourites++;
      }
    }
    // Keep the cached counter the admin list shows in step with the new rows.
    await em.query(
      'UPDATE services s SET s.favourites_count = (SELECT COUNT(*) FROM favourites f WHERE f.service_id = s.id AND f.deleted_at IS NULL)',
    );
  }

  // ── budget (screen 18) ──────────────────────────────────────
  const [{ n: existingBudgets }] = await em.query('SELECT COUNT(*) AS n FROM budgets');
  if (Number(existingBudgets) === 0) {
    const [owner]: { id: string }[] = await em.query(
      `SELECT b.client_id AS id FROM bookings b JOIN users u ON u.id = b.client_id
       WHERE u.role = 'client' AND u.deleted_at IS NULL AND b.deleted_at IS NULL
       GROUP BY b.client_id ORDER BY COUNT(*) DESC LIMIT 1`,
    );
    if (owner) {
      const budgetId = randomUUID();
      const [nextEvent]: { event_date: Date | string }[] = await em.query(
        "SELECT event_date FROM bookings WHERE client_id = ? AND status IN ('pending', 'accepted') AND deleted_at IS NULL ORDER BY event_date LIMIT 1",
        [owner.id],
      );
      const eventDate = nextEvent ? new Date(nextEvent.event_date).toISOString().slice(0, 10) : null;
      await em.query(
        'INSERT INTO budgets (id, created_at, updated_at, client_id, title, event_date, total_amount) VALUES (?, NOW(6), NOW(6), ?, ?, ?, ?)',
        [budgetId, owner.id, 'Our wedding', eventDate, money(400_000)],
      );
      summary.budgets = 1;

      // Real accepted bookings back the first lines, so `providerName` and
      // "x of y services booked" are not invented.
      const accepted: { id: string; category_id: string | null }[] = await em.query(
        `SELECT b.id, s.category_id FROM bookings b LEFT JOIN services s ON s.id = b.service_id
         WHERE b.client_id = ? AND b.status IN ('accepted', 'completed') AND b.deleted_at IS NULL
         ORDER BY b.event_date LIMIT 3`,
        [owner.id],
      );
      for (const [position, line] of BUDGET_LINES.entries()) {
        const [category]: { id: string }[] = await em.query('SELECT id FROM categories WHERE slug = ? AND deleted_at IS NULL LIMIT 1', [line.slug]);
        const booking = accepted[position];
        await em.query(
          `INSERT INTO budget_items (id, created_at, updated_at, budget_id, category_id, label, planned_amount, spent_amount, booking_id, position)
           VALUES (?, NOW(6), NOW(6), ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            budgetId,
            category?.id ?? booking?.category_id ?? null,
            line.label,
            money(line.planned),
            money(booking ? line.spent : 0),
            booking?.id ?? null,
            position,
          ],
        );
        summary.budgetItems++;
      }

      // Notification preferences and one registered device for that client.
      await em.query(
        `INSERT INTO notification_preferences (user_id, push_bookings, push_messages, push_reviews, email_bookings, updated_at)
         VALUES (?, 1, 1, 0, 1, NOW(6)) ON DUPLICATE KEY UPDATE updated_at = NOW(6)`,
        [owner.id],
      );
      await em.query(
        'INSERT INTO device_tokens (id, created_at, updated_at, user_id, token, platform, last_seen_at) VALUES (?, NOW(6), NOW(6), ?, ?, ?, NOW(6))',
        [randomUUID(), owner.id, `demo-fcm-${owner.id.slice(0, 8)}`, DevicePlatform.Android],
      );
      summary.deviceTokens = 1;
    }
  }

  return summary;
}
