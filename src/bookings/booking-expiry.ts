import type { DataSource, EntityManager } from 'typeorm';
import { BookingStatus } from '../common/enums/booking.enums.js';
import { algiersToday } from '../users/users.service.js';
import { pendingExpiry, type ExpiryCause } from './bookings.policy.js';

const HOUR = 3_600_000;

/** A pending request whose reply deadline or event start has passed (BUG-F1). */
export interface ExpiredRequest {
  id: string;
  reference: string;
  eventDate: string;
  startTime: string | null;
  createdAt: Date;
  cause: ExpiryCause;
  expiredAt: Date;
  providerName: string;
  clientName: string;
}

const day = (value: Date | string): string => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

/**
 * The pending requests that have expired at `now`, oldest first. Read-only: the
 * hourly job declines them, and `pnpm bookings:expire-preview` prints them so an
 * admin sees the backlog before turning `booking_auto_expire` on.
 *
 * The SQL is a coarse pre-filter (created before the deadline cutoff, or an event
 * day already reached in Algiers); `pendingExpiry` gives the exact answer per row.
 */
export async function findExpiredRequests(
  db: DataSource | EntityManager,
  replyDeadlineHours: number,
  now = new Date(),
  limit = 500,
): Promise<ExpiredRequest[]> {
  const cutoff = new Date(now.getTime() - replyDeadlineHours * HOUR);
  const rows: any[] = await db.query(
    `SELECT b.id, b.reference, b.event_date, b.start_time, b.created_at, cu.full_name AS client_name, COALESCE(pp.business_name, pu.full_name) AS provider_name
       FROM bookings b JOIN users cu ON cu.id = b.client_id JOIN users pu ON pu.id = b.provider_id
       LEFT JOIN provider_profiles pp ON pp.user_id = b.provider_id
      WHERE b.status = 'pending' AND b.deleted_at IS NULL AND (b.created_at <= ? OR b.event_date <= ?)
      ORDER BY b.created_at LIMIT ?`,
    [cutoff, algiersToday(now), limit],
  );
  const expired: ExpiredRequest[] = [];
  for (const r of rows) {
    const startTime = r.start_time ? String(r.start_time).slice(0, 5) : null;
    const createdAt = new Date(r.created_at);
    const expiry = pendingExpiry({ status: BookingStatus.Pending, createdAt, eventDate: day(r.event_date), startTime }, replyDeadlineHours);
    if (!expiry || expiry.at.getTime() > now.getTime()) continue;
    expired.push({
      id: r.id,
      reference: r.reference,
      eventDate: day(r.event_date),
      startTime,
      createdAt,
      cause: expiry.cause,
      expiredAt: expiry.at,
      providerName: r.provider_name,
      clientName: r.client_name,
    });
  }
  return expired;
}
