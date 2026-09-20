import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { PACK_EVENTS, type PackNeedsAttentionEvent } from '../packs/packs.events.js';
import { JOBS } from '../queue/jobs.js';
import { QueueService } from '../queue/queue.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { VERIFICATION_EVENTS, type DocumentUploadedEvent } from '../verification/verification.events.js';
import { NotificationsService } from './notifications.service.js';

const HOUR = 3_600_000;
/** Pending bookings that crossed the no-reply deadline longer ago than this are not announced (first run on an old database). */
export const NO_REPLY_LOOKBACK_DAYS = 7;

/**
 * Admin notifications (SHL-02) for events owned by modules that have no admin
 * listener of their own: verification submitted / resubmitted, pack needing
 * attention and bookings without a reply (hourly job).
 */
@Injectable()
export class AdminAlertsService implements OnModuleInit {
  private readonly logger = new Logger(AdminAlertsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit(): void {
    this.queue.registerHandler(JOBS.bookingNoReplyAlerts, async () => void (await this.notifyNoReply()));
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'notifications.booking-no-reply' })
  async scheduleHourly(): Promise<void> {
    await this.queue.add(JOBS.bookingNoReplyAlerts, {}, { jobId: `no-reply-alerts-${new Date().toISOString().slice(0, 13)}` });
  }

  /** A verification document was uploaded (by the provider, or by an admin on their behalf): a replacement counts as resubmitted. */
  @OnEvent(VERIFICATION_EVENTS.documentUploaded)
  async onDocumentUploaded(event: DocumentUploadedEvent): Promise<void> {
    const [user] = await this.dataSource.query(
      `SELECT u.full_name, pp.business_name,
              EXISTS (SELECT 1 FROM user_documents o WHERE o.user_id = u.id AND o.type = ? AND o.id <> ? AND o.deleted_at IS NULL) AS replaced
       FROM users u LEFT JOIN provider_profiles pp ON pp.user_id = u.id WHERE u.id = ?`,
      [event.type, event.documentId, event.userId],
    );
    if (!user) return;
    const resubmitted = Number(user.replaced) === 1;
    const who = user.business_name ? `${user.full_name} (${user.business_name})` : user.full_name;
    const doc = event.type.replace(/_/g, ' ');
    await this.notifications.notifyAdmins({
      type: resubmitted ? 'verification.resubmitted' : 'verification.submitted',
      en: resubmitted
        ? { title: 'Documents resubmitted', body: `${who} sent a new ${doc} for verification.` }
        : { title: 'New verification document', body: `${who} submitted a ${doc} for verification.` },
      ar: resubmitted
        ? { title: 'إعادة إرسال الوثائق', body: `أرسل ${who} وثيقة جديدة (${doc}) للتحقق.` }
        : { title: 'وثيقة تحقق جديدة', body: `أرسل ${who} وثيقة (${doc}) للتحقق.` },
      data: { href: `/verifications/${event.userId}?doc=${event.documentId}`, userId: event.userId, documentId: event.documentId },
    });
  }

  @OnEvent(PACK_EVENTS.needsAttention)
  async onPackNeedsAttention(event: PackNeedsAttentionEvent): Promise<void> {
    await this.notifications.notifyAdmins({
      type: 'pack.needs_attention',
      en: { title: 'Pack needs attention', body: `"${event.nameEn}" by ${event.provider.name}: ${event.reasons.join(', ').replace(/_/g, ' ')}.` },
      ar: { title: 'باقة تحتاج إلى مراجعة', body: `«${event.nameAr || event.nameEn}» لـ ${event.provider.name}: ${event.reasons.join('، ').replace(/_/g, ' ')}.` },
      data: { href: `/packs/${event.packId}`, packId: event.packId },
    });
  }

  /**
   * Pending bookings past `booking_reply_deadline_hours` (the BKG-01 "no reply"
   * flag), announced once: a booking with a `booking.no_reply` notification is
   * skipped. Returns the number of bookings announced.
   */
  async notifyNoReply(now = new Date()): Promise<number> {
    const deadline = Number(await this.settings.get('booking_reply_deadline_hours'));
    const cutoff = new Date(now.getTime() - deadline * HOUR);
    const since = new Date(cutoff.getTime() - NO_REPLY_LOOKBACK_DAYS * 24 * HOUR);
    const rows: any[] = await this.dataSource.query(
      `SELECT b.id, b.reference, b.created_at, cu.full_name AS client_name, COALESCE(pp.business_name, pu.full_name) AS provider_name
       FROM bookings b JOIN users cu ON cu.id = b.client_id JOIN users pu ON pu.id = b.provider_id LEFT JOIN provider_profiles pp ON pp.user_id = b.provider_id
       WHERE b.status = 'pending' AND b.deleted_at IS NULL AND b.created_at <= ? AND b.created_at > ?
         AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.type = 'booking.no_reply' AND JSON_UNQUOTE(JSON_EXTRACT(n.data, '$.bookingId')) = b.id)
       ORDER BY b.created_at LIMIT 200`,
      [cutoff, since],
    );
    for (const r of rows) {
      const hours = Math.floor((now.getTime() - new Date(r.created_at).getTime()) / HOUR);
      await this.notifications.notifyAdmins({
        type: 'booking.no_reply',
        en: { title: `No reply on ${r.reference}`, body: `${r.provider_name} has not answered ${r.client_name}’s request for ${hours} h.` },
        ar: { title: `لا رد على ${r.reference}`, body: `لم يرد ${r.provider_name} على طلب ${r.client_name} منذ ${hours} ساعة.` },
        data: { href: `/bookings/${r.id}`, bookingId: r.id, reference: r.reference },
      });
    }
    if (rows.length) this.logger.log(`Announced ${rows.length} booking(s) without a reply`);
    return rows.length;
  }
}
