import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { addDays } from '../bookings/bookings.policy.js';
import { dateOnly } from '../bookings/bookings.service.js';
import { JOBS } from '../queue/jobs.js';
import { QueueService } from '../queue/queue.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { AttentionDto, OverviewBookingsByStatusDto, KpiDto, LatestBookingDto, NavCountsDto, OverviewDto, OverviewQueryDto, RecentActivityDto } from './dto/overview.dto.js';
import { algiersDay, daysBetween, deltaPercent, resolveRange, totals, type Period, type PeriodTotals, type StatsRow } from './stats.policy.js';
import { computeDailyMetrics, readStats, rollupStats } from './stats.rollup.js';

const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);
const HOUR = 3_600_000;
export const OVERVIEW_CACHE_MS = 60_000;
export const NAV_COUNTS_CACHE_MS = 30_000;
/** Days re-rolled by the nightly job (yesterday and the day before, for late status changes). */
export const NIGHTLY_ROLLUP_DAYS = 2;

const OBJECT_ROUTES: Record<string, (id: string) => string> = {
  user: (id) => `/users/${id}`,
  provider: (id) => `/users/${id}`,
  document: () => '/verifications',
  booking: (id) => `/bookings/${id}`,
  invoice: () => '/bookings',
  dispute: (id) => `/disputes/${id}`,
  review: (id) => `/reviews/${id}`,
  service: (id) => `/services/${id}`,
  pack: (id) => `/packs/${id}`,
  academic_request: (id) => `/academic-requests/${id}`,
  form: (id) => `/academic-requests/forms/${id}/edit`,
  conversation: (id) => `/messages/${id}`,
  category: () => '/categories',
  wilaya: (id) => `/locations/${id}`,
  setting: () => '/settings',
  admin: () => '/settings/admins',
};

/** OVR-01 aggregates, sidebar counts and the nightly `stats_daily` rollup. */
@Injectable()
export class OverviewService implements OnModuleInit {
  private readonly logger = new Logger(OverviewService.name);
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit(): void {
    this.queue.registerHandler<{ from?: string; to?: string }>(JOBS.statsRollup, async (data) => void (await this.rollup(data.from, data.to)));
  }

  /** 01:00 Africa/Algiers. */
  @Cron('0 0 1 * * *', { name: 'stats.nightly-rollup', timeZone: 'Africa/Algiers' })
  async scheduleNightly(): Promise<void> {
    const today = algiersDay(new Date());
    await this.queue.add(JOBS.statsRollup, { from: addDays(today, -NIGHTLY_ROLLUP_DAYS), to: addDays(today, -1) }, { jobId: `stats-rollup-${today}` });
  }

  /** Rolls up `from`..`to` (default: yesterday and the day before). */
  async rollup(from?: string, to?: string): Promise<number> {
    const today = algiersDay(new Date());
    const start = from ?? addDays(today, -NIGHTLY_ROLLUP_DAYS);
    const end = to ?? addDays(today, -1);
    const written = await rollupStats(this.dataSource, start, end);
    this.logger.log(`stats_daily: ${written} rows for ${start}..${end}`);
    this.clearCache();
    return written;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async cached<T>(key: string, ttl: number, compute: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    const value = await compute();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  // ── overview ────────────────────────────────────────────────

  async overview(query: OverviewQueryDto, now = new Date()): Promise<OverviewDto> {
    const resolved = resolveRange(query.range ?? '30d', query.from, query.to, now);
    return this.cached(`overview:${resolved.range}:${resolved.current.from}:${resolved.current.to}`, OVERVIEW_CACHE_MS, async () => {
      const [attention, currentRows, previousRows, bookingsByStatus, latestBookings, recentActivity] = await Promise.all([
        this.attention(now),
        this.dailyRows(resolved.current, now),
        this.dailyRows(resolved.previous, now),
        this.bookingsByStatus(),
        this.latestBookings(now),
        this.recentActivity(),
      ]);
      const current = totals(currentRows);
      const previous = totals(previousRows);
      return {
        range: resolved.range,
        period: resolved.current,
        previousPeriod: resolved.previous,
        attention,
        kpis: this.kpis(current, previous),
        bookingsPerDay: daysBetween(resolved.current.from, resolved.current.to).map((date) => ({
          date,
          requests: Number(currentRows.find((r) => r.day === date && r.metric === 'bookings_created')?.value ?? 0),
          completed: Number(currentRows.find((r) => r.day === date && r.metric === 'bookings_completed')?.value ?? 0),
        })),
        bookingsByStatus,
        latestBookings,
        recentActivity,
        generatedAt: now.toISOString(),
      };
    });
  }

  /**
   * Daily metrics of a period: `stats_daily` for the days already rolled up,
   * computed live for the others (today, or days the nightly job has not covered).
   */
  async dailyRows(period: Period, now = new Date()): Promise<StatsRow[]> {
    const today = algiersDay(now);
    const to = period.to > today ? today : period.to;
    if (period.from > to) return [];
    const stored = (await readStats(this.dataSource, period.from, to)).filter((r) => r.day < today);
    const storedDays = new Set(stored.filter((r) => r.metric === 'bookings_created').map((r) => r.day));
    const missing = daysBetween(period.from, to).filter((d) => !storedDays.has(d));
    if (!missing.length) return stored;
    const live = (await computeDailyMetrics(this.dataSource, missing[0]!, missing[missing.length - 1]!)).filter((r) => missing.includes(r.day));
    return [...stored.filter((r) => storedDays.has(r.day)), ...live];
  }

  private kpis(current: PeriodTotals, previous: PeriodTotals): KpiDto[] {
    const int = (n: number) => String(n);
    const money = (n: number) => n.toFixed(2);
    const rating = (n: number | null) => (n === null ? null : n.toFixed(2));
    return [
      { key: 'bookings', value: int(current.bookingsCreated), previousValue: int(previous.bookingsCreated), deltaPercent: deltaPercent(current.bookingsCreated, previous.bookingsCreated) },
      { key: 'booking_value', value: money(current.bookingValue), previousValue: money(previous.bookingValue), deltaPercent: deltaPercent(current.bookingValue, previous.bookingValue) },
      { key: 'new_users', value: int(current.usersNew), previousValue: int(previous.usersNew), deltaPercent: deltaPercent(current.usersNew, previous.usersNew) },
      { key: 'average_rating', value: rating(current.avgRating), previousValue: rating(previous.avgRating), deltaPercent: deltaPercent(current.avgRating, previous.avgRating) },
    ];
  }

  // ── live counters ───────────────────────────────────────────

  private async counters(now: Date): Promise<Omit<NavCountsDto, 'messagesUnread'> & Pick<AttentionDto, 'oldestVerificationWaitingHours' | 'servicesReported'>> {
    const deadline = Number(await this.settings.get('booking_reply_deadline_hours'));
    const cutoff = new Date(now.getTime() - deadline * HOUR);
    const [[verifications], [row]] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*) AS n, MIN(submitted_at) AS oldest FROM (
           SELECT u.id, MAX(d.created_at) AS submitted_at FROM users u
           JOIN user_documents d ON d.user_id = u.id AND d.is_current = 1 AND d.deleted_at IS NULL
           WHERE u.role = 'provider' AND u.deleted_at IS NULL AND u.verification_status NOT IN ('verified', 'rejected')
           GROUP BY u.id HAVING SUM(d.status = 'pending') > 0) w`,
      ),
      this.dataSource.query(
        `SELECT
           (SELECT COUNT(*) FROM bookings WHERE status = 'pending' AND created_at <= ? AND deleted_at IS NULL) AS no_reply,
           (SELECT COUNT(*) FROM disputes WHERE status IN ('open', 'in_review') AND deleted_at IS NULL) AS disputes_open,
           (SELECT COUNT(*) FROM academic_requests WHERE status = 'pending' AND deleted_at IS NULL) AS academic_pending,
           (SELECT COUNT(DISTINCT rp.target_id) FROM reports rp JOIN reviews r ON r.id = rp.target_id AND r.deleted_at IS NULL
             WHERE rp.target_type = 'review' AND rp.status = 'open' AND rp.deleted_at IS NULL) AS reviews_reported,
           (SELECT COUNT(DISTINCT rp.target_id) FROM reports rp JOIN services s ON s.id = rp.target_id AND s.deleted_at IS NULL
             WHERE rp.target_type = 'service' AND rp.status = 'open' AND rp.deleted_at IS NULL) AS services_reported,
           (SELECT COUNT(DISTINCT rp.target_id) FROM reports rp WHERE rp.target_type = 'message' AND rp.status = 'open' AND rp.deleted_at IS NULL) AS messages_reported`,
        [cutoff],
      ),
    ]);
    return {
      verificationsWaiting: Number(verifications.n),
      oldestVerificationWaitingHours: verifications.oldest ? Math.max(0, Math.floor((now.getTime() - new Date(verifications.oldest).getTime()) / HOUR)) : null,
      bookingsNoReply: Number(row.no_reply),
      disputesOpen: Number(row.disputes_open),
      academicRequestsPending: Number(row.academic_pending),
      reviewsReported: Number(row.reviews_reported),
      servicesReported: Number(row.services_reported),
      messagesReported: Number(row.messages_reported),
    };
  }

  async attention(now = new Date()): Promise<AttentionDto> {
    const c = await this.counters(now);
    return {
      verificationsWaiting: c.verificationsWaiting,
      oldestVerificationWaitingHours: c.oldestVerificationWaitingHours,
      bookingsNoReply: c.bookingsNoReply,
      disputesOpen: c.disputesOpen,
      academicRequestsPending: c.academicRequestsPending,
      reviewsReported: c.reviewsReported,
      servicesReported: c.servicesReported,
    };
  }

  async navCounts(adminId: string, now = new Date()): Promise<NavCountsDto> {
    return this.cached(`nav:${adminId}`, NAV_COUNTS_CACHE_MS, async () => {
      const [c, [unread]] = await Promise.all([
        this.counters(now),
        this.dataSource.query(
          `SELECT COUNT(DISTINCT m.conversation_id) AS n FROM messages m
           JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = ?
           JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
           WHERE m.kind <> 'system' AND m.status <> 'deleted' AND (m.sender_id IS NULL OR m.sender_id <> ?) AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)`,
          [adminId, adminId],
        ),
      ]);
      return {
        verificationsWaiting: c.verificationsWaiting,
        bookingsNoReply: c.bookingsNoReply,
        disputesOpen: c.disputesOpen,
        academicRequestsPending: c.academicRequestsPending,
        reviewsReported: c.reviewsReported,
        messagesReported: c.messagesReported,
        messagesUnread: Number(unread.n),
      };
    });
  }

  private async bookingsByStatus(): Promise<OverviewBookingsByStatusDto[]> {
    const rows: { status: OverviewBookingsByStatusDto['status']; n: string }[] = await this.dataSource.query('SELECT status, COUNT(*) AS n FROM bookings WHERE deleted_at IS NULL GROUP BY status ORDER BY n DESC, status');
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    return rows.map((r) => ({ status: r.status, count: Number(r.n), percent: total ? Math.round((Number(r.n) / total) * 1000) / 10 : 0 }));
  }

  private async latestBookings(now: Date): Promise<LatestBookingDto[]> {
    const select = `SELECT b.id, b.reference, b.status, b.event_date, b.total, b.created_at, b.client_id, cu.full_name AS client_name, b.provider_id, pu.full_name AS provider_name,
        pp.business_name, COALESCE(s.title_en, pk.name_en) AS title_en, COALESCE(NULLIF(s.title_ar, ''), NULLIF(pk.name_ar, ''), s.title_en, pk.name_en) AS title_ar
      FROM bookings b JOIN users cu ON cu.id = b.client_id JOIN users pu ON pu.id = b.provider_id LEFT JOIN provider_profiles pp ON pp.user_id = b.provider_id
      LEFT JOIN services s ON s.id = b.service_id LEFT JOIN packs pk ON pk.id = b.pack_id
      WHERE b.deleted_at IS NULL`;
    let rows: any[] = await this.dataSource.query(`${select} AND b.created_at >= ? ORDER BY b.created_at DESC, b.id LIMIT 5`, [new Date(now.getTime() - 24 * HOUR)]);
    if (!rows.length) rows = await this.dataSource.query(`${select} ORDER BY b.created_at DESC, b.id LIMIT 5`);
    return rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status,
      client: { id: r.client_id, fullName: r.client_name },
      provider: { id: r.provider_id, fullName: r.provider_name, businessName: r.business_name ?? null },
      titleEn: r.title_en ?? '',
      titleAr: r.title_ar ?? '',
      eventDate: dateOnly(r.event_date),
      total: String(r.total),
      createdAt: iso(r.created_at)!,
    }));
  }

  private async recentActivity(): Promise<RecentActivityDto[]> {
    const rows: any[] = await this.dataSource.query(
      `SELECT l.id, l.action, l.actor_id, l.actor_role, u.full_name, l.object_type, l.object_id, l.object_label, l.level, l.created_at
       FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.created_at DESC, l.id DESC LIMIT 8`,
    );
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.actor_id ? { id: r.actor_id, fullName: r.full_name ?? 'Deleted user', role: r.actor_role } : null,
      objectType: r.object_type,
      objectId: r.object_id,
      objectLabel: r.object_label,
      href: r.object_id && OBJECT_ROUTES[r.object_type] ? OBJECT_ROUTES[r.object_type]!(r.object_id) : null,
      logHref: `/activity-log/${r.id}`,
      level: r.level,
      createdAt: iso(r.created_at)!,
    }));
  }
}
