import type { DataSource, EntityManager } from 'typeorm';
import { buildDailyRows, dayBoundsUtc, daysBetween, STATS_METRICS, type RawMetricRow, type StatsRow } from './stats.policy.js';

type Db = Pick<DataSource | EntityManager, 'query'>;

/** Algiers day of a UTC datetime column, in SQL. */
const DAY = (column: string) => `DATE_FORMAT(${column} + INTERVAL 1 HOUR, '%Y-%m-%d')`;

/**
 * Metrics for Algiers days `from`..`to` computed live from bookings, users and
 * reviews (soft-deleted rows excluded):
 * - bookings_created: bookings created that day;
 * - bookings_completed: bookings completed that day (`completed_at`, still completed);
 * - booking_value: sum of `total` of bookings created that day that are accepted or completed now;
 * - users_new (client / provider): accounts created that day;
 * - reviews_new, avg_rating: reviews written that day.
 */
export async function computeDailyMetrics(db: Db, from: string, to: string): Promise<StatsRow[]> {
  const { start, end } = dayBoundsUtc(from, to);
  const range = [start, end];
  const [created, completed, users, reviews] = await Promise.all([
    db.query(
      `SELECT ${DAY('created_at')} AS day, COUNT(*) AS n, COALESCE(SUM(CASE WHEN status IN ('accepted', 'completed') THEN total ELSE 0 END), 0) AS value
       FROM bookings WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ? GROUP BY day`,
      range,
    ),
    db.query(
      `SELECT ${DAY('completed_at')} AS day, COUNT(*) AS n FROM bookings
       WHERE deleted_at IS NULL AND status = 'completed' AND completed_at >= ? AND completed_at < ? GROUP BY day`,
      range,
    ),
    db.query(
      `SELECT ${DAY('created_at')} AS day, role, COUNT(*) AS n FROM users
       WHERE deleted_at IS NULL AND role IN ('client', 'provider') AND created_at >= ? AND created_at < ? GROUP BY day, role`,
      range,
    ),
    db.query(
      `SELECT ${DAY('created_at')} AS day, COUNT(*) AS n, AVG(rating) AS avg_rating FROM reviews
       WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ? GROUP BY day`,
      range,
    ),
  ]);
  const raw: RawMetricRow[] = [
    ...created.flatMap((r: any) => [
      { day: r.day, metric: 'bookings_created', value: r.n },
      { day: r.day, metric: 'booking_value', value: r.value },
    ]),
    ...completed.map((r: any) => ({ day: r.day, metric: 'bookings_completed', value: r.n })),
    ...users.map((r: any) => ({ day: r.day, metric: 'users_new', dimension: r.role, value: r.n })),
    ...reviews.flatMap((r: any) => [
      { day: r.day, metric: 'reviews_new', value: r.n },
      { day: r.day, metric: 'avg_rating', value: r.avg_rating },
    ]),
  ];
  return buildDailyRows(daysBetween(from, to), raw.map((r) => ({ ...r, day: normaliseDay(r.day) })));
}

/** mysql2 returns DATE columns as local-midnight Date objects: read the calendar day back in local time. */
function normaliseDay(value: string | Date): string {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** Replaces the `stats_daily` rows of days `from`..`to` with freshly computed values. Returns the rows written. */
export async function rollupStats(db: Db, from: string, to: string): Promise<number> {
  const rows = await computeDailyMetrics(db, from, to);
  await db.query('DELETE FROM stats_daily WHERE day >= ? AND day <= ? AND metric IN (?)', [from, to, STATS_METRICS]);
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    await db.query(`INSERT INTO stats_daily (day, metric, dimension, value) VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')}`, batch.flatMap((r) => [r.day, r.metric, r.dimension, r.value]));
  }
  return rows.length;
}

/** Stored rows of days `from`..`to`, day as `YYYY-MM-DD`. */
export async function readStats(db: Db, from: string, to: string): Promise<StatsRow[]> {
  const rows: any[] = await db.query("SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, metric, dimension, value FROM stats_daily WHERE day >= ? AND day <= ?", [from, to]);
  return rows.map((r) => ({ day: r.day, metric: r.metric, dimension: r.dimension, value: String(r.value) }));
}
