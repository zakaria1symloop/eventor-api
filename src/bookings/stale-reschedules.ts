import type { DataSource, EntityManager } from 'typeorm';

/**
 * BUG-E7: pending reschedule proposals left on bookings that already ended
 * (cancelled, declined, completed) by code older than the fix, which never
 * closed them. Since the fix, `BookingsService.applyTransition` closes them at
 * the status change, so this only concerns existing rows. Used by
 * `pnpm bookings:stale-reschedules[:prod]` and by the demo seed.
 */

export interface StaleReschedule {
  rescheduleId: string;
  bookingId: string;
  reference: string;
  bookingStatus: string;
  oldDate: string;
  newDate: string;
  newStartTime: string | null;
  newEndTime: string | null;
  proposedAt: string;
}

const day = (value: unknown): string => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
const time = (value: unknown): string | null => (value ? String(value).slice(0, 5) : null);

/** Read-only: every pending proposal of an ended booking, oldest first. `lock` takes the rows FOR UPDATE. */
export async function findStaleReschedules(db: DataSource | EntityManager, lock = false): Promise<StaleReschedule[]> {
  const rows: any[] = await db.query(
    `SELECT br.id, br.booking_id, b.reference, b.status AS booking_status, br.old_date, br.new_date, br.new_start, br.new_end, br.created_at
     FROM booking_reschedules br JOIN bookings b ON b.id = br.booking_id
     WHERE br.status = 'pending' AND br.deleted_at IS NULL AND b.status IN ('cancelled', 'declined', 'completed')
     ORDER BY br.created_at, br.id${lock ? ' FOR UPDATE' : ''}`,
  );
  return rows.map((r) => ({
    rescheduleId: r.id,
    bookingId: r.booking_id,
    reference: r.reference,
    bookingStatus: r.booking_status,
    oldDate: day(r.old_date),
    newDate: day(r.new_date),
    newStartTime: time(r.new_start),
    newEndTime: time(r.new_end),
    proposedAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * Closes them exactly as the live code now does: status `cancelled`, resolved
 * now, and one `booking.reschedule_closed` audit row per booking (source
 * `system`, reason = the booking's status). No notification: the bookings ended
 * long ago. Returns the number of proposals closed. One transaction.
 */
export async function closeStaleReschedules(dataSource: DataSource, now = new Date()): Promise<number> {
  return dataSource.transaction(async (em) => {
    const stale = await findStaleReschedules(em, true);
    if (stale.length === 0) return 0;
    await em.query("UPDATE booking_reschedules SET status = 'cancelled', resolved_at = ?, updated_at = ? WHERE id IN (?) AND status = 'pending'", [
      now,
      now,
      stale.map((s) => s.rescheduleId),
    ]);
    const byBooking = new Map<string, StaleReschedule[]>();
    for (const s of stale) byBooking.set(s.bookingId, [...(byBooking.get(s.bookingId) ?? []), s]);
    for (const [bookingId, rows] of byBooking) {
      await em.query(
        `INSERT INTO audit_logs (id, created_at, actor_id, actor_role, action, object_type, object_id, object_label, level, changes, note, source)
         VALUES (UUID(), ?, NULL, NULL, 'booking.reschedule_closed', 'booking', ?, ?, 'normal', ?, ?, 'system')`,
        [
          now,
          bookingId,
          rows[0]!.reference,
          JSON.stringify({ closed: rows.length, reason: rows[0]!.bookingStatus, cleanup: true }),
          `Pending reschedule proposal closed by the BUG-E7 cleanup: the booking was already ${rows[0]!.bookingStatus}.`,
        ],
      );
    }
    return stale.length;
  });
}
