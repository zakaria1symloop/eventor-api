import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { AuditLevel, AuditSource } from '../common/enums/admin.enums.js';
import { BookingDisputeStatus, BookingStatus } from '../common/enums/booking.enums.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { runInTransaction } from '../database/transaction.js';
import { JOBS } from '../queue/jobs.js';
import { QueueService } from '../queue/queue.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { BOOKING_EVENTS, type BookingEvent, type BookingReminderEvent } from './bookings.events.js';
import { findExpiredRequests } from './booking-expiry.js';
import { isDueForAutoComplete, isExpired, pendingExpiry, REMINDER_INTERVAL_HOURS } from './bookings.policy.js';
import { BookingsService, dateOnly } from './bookings.service.js';
import { Booking } from './entities/booking.entity.js';

const HOUR = 3_600_000;

/**
 * Hourly booking jobs (status-rules §5). Cron methods only enqueue; handlers are
 * idempotent: every row is re-read under a lock and re-checked before acting.
 */
@Injectable()
export class BookingJobsService implements OnModuleInit {
  private readonly logger = new Logger(BookingJobsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly bookings: BookingsService,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit(): void {
    this.queue.registerHandler(JOBS.bookingReplyReminders, async () => void (await this.sendReplyReminders()));
    this.queue.registerHandler(JOBS.bookingAutoComplete, async () => void (await this.autoComplete()));
    this.queue.registerHandler(JOBS.bookingReviewRequests, async () => void (await this.requestReviews()));
    this.queue.registerHandler(JOBS.bookingExpireRequests, async () => void (await this.expireRequests()));
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'bookings.hourly' })
  async scheduleHourly(): Promise<void> {
    const hour = new Date().toISOString().slice(0, 13);
    await this.queue.add(JOBS.bookingReplyReminders, {}, { jobId: `reply-reminders-${hour}` });
    await this.queue.add(JOBS.bookingAutoComplete, {}, { jobId: `auto-complete-${hour}` });
    await this.queue.add(JOBS.bookingReviewRequests, {}, { jobId: `review-requests-${hour}` });
    await this.queue.add(JOBS.bookingExpireRequests, {}, { jobId: `expire-requests-${hour}` });
  }

  /**
   * BUG-F1: pending requests expire at the reply deadline (`booking_reply_deadline_hours`
   * after the request) or at the event start, whichever comes first. They are
   * declined by the system with the reason `expired` (`BookingsService.expireRequest`).
   * Does nothing while `booking_auto_expire` is off. Idempotent: each row is
   * re-read under a lock and re-checked; accepted bookings are never touched.
   */
  async expireRequests(now = new Date()): Promise<number> {
    const { booking_auto_expire: enabled, booking_reply_deadline_hours: deadline } = await this.settings.getMany(['booking_auto_expire', 'booking_reply_deadline_hours']);
    if (!enabled) return 0;
    const hours = Number(deadline);
    let expired = 0;
    for (const candidate of await findExpiredRequests(this.dataSource, hours, now)) {
      await runInTransaction(this.dataSource, async (em, afterCommit) => {
        const booking = await em.getRepository(Booking).findOne({ where: { id: candidate.id }, lock: { mode: 'pessimistic_write' } });
        if (!booking) return;
        const state = { status: booking.status, createdAt: booking.createdAt, eventDate: dateOnly(booking.eventDate), startTime: booking.startTime };
        const expiry = pendingExpiry(state, hours);
        if (!expiry || !isExpired(state, hours, now)) return;
        await this.bookings.expireRequest(em, afterCommit, booking, expiry.cause, hours);
        expired += 1;
      });
    }
    if (expired > 0) this.logger.log(`Expired ${expired} booking request(s)`);
    return expired;
  }

  /**
   * Reminder to the provider at reply deadline − 12 h for pending bookings never
   * reminded (`booking_auto_reminder`). The "no reply" flag itself is derived from
   * `created_at` + deadline, so it needs no write.
   */
  async sendReplyReminders(now = new Date()): Promise<number> {
    const {
      booking_auto_reminder: enabled,
      booking_reply_deadline_hours: deadline,
      booking_auto_expire: autoExpire,
    } = await this.settings.getMany(['booking_auto_reminder', 'booking_reply_deadline_hours', 'booking_auto_expire']);
    if (!enabled) return 0;
    const cutoff = new Date(now.getTime() - Math.max(0, Number(deadline) - REMINDER_INTERVAL_HOURS) * HOUR);
    const due: { id: string }[] = await this.dataSource.query(
      "SELECT id FROM bookings WHERE status = 'pending' AND reminder_sent_at IS NULL AND created_at <= ? AND deleted_at IS NULL ORDER BY created_at LIMIT 500",
      [cutoff],
    );
    let sent = 0;
    for (const { id } of due) {
      await runInTransaction(this.dataSource, async (em, afterCommit) => {
        const booking = await em.getRepository(Booking).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!booking || booking.status !== BookingStatus.Pending || booking.reminderSentAt || booking.createdAt > cutoff) return;
        // Already expired (BUG-F1): the expiry job declines it this hour, a "please reply" would arrive just before "expired".
        const state = { status: booking.status, createdAt: booking.createdAt, eventDate: dateOnly(booking.eventDate), startTime: booking.startTime };
        if (autoExpire && isExpired(state, Number(deadline), now)) return;
        await em.getRepository(Booking).update(id, { reminderSentAt: now });
        await this.audit.log(
          { action: 'booking.reminder_sent', objectType: 'booking', objectId: id, objectLabel: booking.reference, level: AuditLevel.Info, actorId: null, actorRole: null, source: AuditSource.System, changes: { automatic: true } },
          em,
        );
        this.events.emitAfterCommit<BookingReminderEvent>(afterCommit, BOOKING_EVENTS.reminderSent, {
          bookingId: id,
          reference: booking.reference,
          clientId: booking.clientId,
          providerId: booking.providerId,
          notify: true,
          automatic: true,
        });
        sent += 1;
      });
    }
    if (sent > 0) this.logger.log(`Sent ${sent} reply reminder(s)`);
    return sent;
  }

  /** accepted → completed once the event end + `dispute_window_hours` has passed, unless a dispute is open. */
  async autoComplete(now = new Date()): Promise<number> {
    const windowHours = Number(await this.settings.get('dispute_window_hours'));
    // Coarse SQL pre-filter (event day at least window hours ago); the exact rule runs per row.
    const candidates: { id: string }[] = await this.dataSource.query(
      "SELECT id FROM bookings WHERE status = 'accepted' AND dispute_status <> 'open' AND COALESCE(end_date, event_date) <= ? AND deleted_at IS NULL ORDER BY event_date LIMIT 500",
      [dateOnly(new Date(now.getTime() - windowHours * HOUR + 2 * 86_400_000))],
    );
    let completed = 0;
    for (const { id } of candidates) {
      await runInTransaction(this.dataSource, async (em, afterCommit) => {
        const booking = await em.getRepository(Booking).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!booking) return;
        // The real end: last day of a multi-day booking, next morning for overnight hours (`eventEndsAt`).
        const input = {
          status: booking.status,
          disputeStatus: booking.disputeStatus,
          eventDate: dateOnly(booking.eventDate),
          endDate: booking.endDate ? dateOnly(booking.endDate) : null,
          startTime: booking.startTime,
          endTime: booking.endTime,
        };
        if (!isDueForAutoComplete(input, windowHours, now)) return;
        await this.bookings.applyTransition(em, afterCommit, booking, 'completed', {
          actorId: null,
          reason: 'auto_completed',
          note: `Completed automatically ${windowHours} h after the event.`,
          notify: true,
          source: AuditSource.System,
        });
        completed += 1;
      });
    }
    if (completed > 0) this.logger.log(`Auto-completed ${completed} booking(s)`);
    return completed;
  }

  /** "Leave a review" to the client `review_open_after_hours` after completion (once; not with an open dispute or an existing review). */
  async requestReviews(now = new Date()): Promise<number> {
    const hours = Number(await this.settings.get('review_open_after_hours'));
    const cutoff = new Date(now.getTime() - hours * HOUR);
    const due: { id: string }[] = await this.dataSource.query(
      `SELECT b.id FROM bookings b WHERE b.status = 'completed' AND b.review_requested_at IS NULL AND b.completed_at <= ? AND b.dispute_status <> 'open' AND b.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id AND r.deleted_at IS NULL) ORDER BY b.completed_at LIMIT 500`,
      [cutoff],
    );
    let requested = 0;
    for (const { id } of due) {
      await runInTransaction(this.dataSource, async (em, afterCommit) => {
        const booking = await em.getRepository(Booking).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!booking || booking.status !== BookingStatus.Completed || booking.reviewRequestedAt || booking.disputeStatus === BookingDisputeStatus.Open) return;
        if (!booking.completedAt || booking.completedAt > cutoff) return;
        await em.getRepository(Booking).update(id, { reviewRequestedAt: now });
        this.events.emitAfterCommit<BookingEvent>(afterCommit, BOOKING_EVENTS.reviewRequested, {
          bookingId: id,
          reference: booking.reference,
          clientId: booking.clientId,
          providerId: booking.providerId,
          notify: true,
        });
        requested += 1;
      });
    }
    if (requested > 0) this.logger.log(`Requested ${requested} review(s)`);
    return requested;
  }
}
