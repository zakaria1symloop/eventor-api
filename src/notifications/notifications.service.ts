import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { UserStatus } from '../common/enums/user.enums.js';
import type { Lang } from '../common/i18n/language.js';
import { PushService, type PushMessage, type PushTarget } from '../push/push.service.js';

export type NotificationData = Record<string, string | number | boolean | null>;

/**
 * Every `type` the API writes for a **client or provider** notification row
 * (`GET /app/me/notifications`, socket `notification:new`). Add here when a
 * listener starts emitting a new one — the mobile spec documents this list.
 */
export const APP_NOTIFICATION_TYPES = [
  'booking.requested',
  'booking.accepted',
  'booking.declined',
  'booking.cancelled',
  'booking.completed',
  'booking.rescheduled',
  'booking.reschedule_proposed',
  'booking.reschedule_rejected',
  'booking.price_changed',
  'booking.reminder',
  'booking.review_requested',
  'dispute.opened',
  'dispute.message',
  'dispute.evidence_requested',
  'dispute.resolved',
  'dispute.closed',
  'review.new',
  'review.shown',
  'review.hidden',
  'review.redacted',
  'review_reply.hidden',
  'review_reply.shown',
  'report.resolved',
  'report.dismissed',
  'academic_request.cancelled',
  'verification.approved',
  'verification.rejected',
] as const;
export type AppNotificationType = (typeof APP_NOTIFICATION_TYPES)[number];

/** Push-only `type`s: no notification row (a chat has its own unread counts). */
export const APP_PUSH_ONLY_TYPES = ['message.new', 'test'] as const;

/**
 * The Profile · Notifications switch (`notification_preferences`) that mutes
 * a push of this type; `null` = always sent. The 🔔 row is written either way.
 */
export function pushPreferenceOf(type: string): 'push_bookings' | 'push_messages' | 'push_reviews' | null {
  if (type.startsWith('message.') || type === 'dispute.message') return 'push_messages';
  if (type.startsWith('booking.') || type.startsWith('dispute.') || type.startsWith('academic_request.')) return 'push_bookings';
  if (type.startsWith('review.') || type.startsWith('review_reply.')) return 'push_reviews';
  return null;
}

/** FCM data values are strings; empty values are left out. */
export function pushData(data: NotificationData | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data ?? {})
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

export interface InAppNotification {
  type: string;
  title: string;
  body: string;
  data?: NotificationData;
}

/** An admin notification written in each admin's language (SHL-02). */
export interface AdminNotification {
  type: string;
  en: { title: string; body: string };
  ar: { title: string; body: string };
  /** `href` (dashboard route hint) plus the ids the panel needs. */
  data: NotificationData & { href: string };
}

export const NOTIFICATION_EVENTS = {
  /** A notification row was written for an admin: pushed as `notification:new` to that admin's sockets. */
  adminCreated: 'notification.admin_created',
  /** A notification row was written for a client or a provider: pushed as `notification:new` on the `/app` socket. */
  userCreated: 'notification.user_created',
} as const;

export interface UserNotificationCreatedEvent {
  userId: string;
  notification: { id: string; type: string; title: string; body: string; data: Record<string, unknown> | null; readAt: null; createdAt: string };
}

export interface AdminNotificationCreatedEvent {
  userId: string;
  notification: { id: string; type: string; title: string; body: string; data: Record<string, unknown> | null; readAt: null; createdAt: string };
}

/**
 * In-app notifications (🔔 rows in `notifications`) plus a push (📱 FCM) to
 * the users' registered devices. Called by event listeners after COMMIT,
 * never inside a service transaction.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pushService: PushService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** Active admins (the 🔔 admins audience). */
  async adminIds(): Promise<string[]> {
    return (await this.admins()).map((a) => a.id);
  }

  private async admins(): Promise<{ id: string; lang: Lang }[]> {
    const rows: { id: string; language: string }[] = await this.dataSource.query(
      "SELECT id, language FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL",
    );
    return rows.map((r) => ({ id: r.id, lang: r.language === 'ar' ? 'ar' : 'en' }));
  }

  private async insert(userId: string, type: string, title: string, body: string, data: Record<string, unknown> | null, now: Date): Promise<string> {
    const id = crypto.randomUUID();
    await this.dataSource.query(
      'INSERT INTO notifications (id, created_at, updated_at, user_id, type, title, body, data, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      [id, now, now, userId, type.slice(0, 60), title.slice(0, 190), body, data ? JSON.stringify(data) : null],
    );
    return id;
  }

  /** 🔔 one row per user, and with `push` 📱 the same text to their phones (`data` + `type` + `notificationId`). */
  async notify(userIds: string[], notification: InAppNotification, options: { push?: boolean } = {}): Promise<void> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (ids.length === 0) return;
    const now = new Date();
    const rowIds = new Map<string, string>();
    for (const userId of ids) {
      const id = await this.insert(userId, notification.type, notification.title, notification.body, notification.data ?? null, now);
      rowIds.set(userId, id);
      // The `/app` socket turns this into `notification:new` for that user's devices.
      await this.emitter.emitAsync(NOTIFICATION_EVENTS.userCreated, {
        userId,
        notification: {
          id,
          type: notification.type.slice(0, 60),
          title: notification.title.slice(0, 190),
          body: notification.body,
          data: (notification.data ?? null) as Record<string, unknown> | null,
          readAt: null,
          createdAt: now.toISOString(),
        },
      } satisfies UserNotificationCreatedEvent);
    }
    if (!options.push) return;
    const data = pushData(notification.data);
    await this.push(ids, notification.type, (userId) => ({
      title: notification.title,
      body: notification.body,
      data: { ...data, notificationId: rowIds.get(userId)! },
    }));
  }

  /**
   * 📱 To every registered device of these users — active accounts only, and
   * not to those who turned this kind of push off. `message` gets each
   * recipient's language and may return null to skip them. `type` is added to
   * the data. FCM is called in the background: the caller never waits for it.
   */
  async push(userIds: string[], type: string, message: (userId: string, lang: Lang) => PushMessage | null): Promise<void> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (ids.length === 0) return;
    const preference = pushPreferenceOf(type);
    const rows: { user_id: string; language: string; token: string; platform: PushTarget['platform'] }[] = await this.dataSource.query(
      `SELECT d.user_id, u.language, d.token, d.platform
         FROM device_tokens d
         JOIN users u ON u.id = d.user_id AND u.deleted_at IS NULL AND u.status = ?
         LEFT JOIN notification_preferences p ON p.user_id = d.user_id
        WHERE d.user_id IN (?) AND d.deleted_at IS NULL${preference ? ` AND COALESCE(p.${preference}, 1) = 1` : ''}`,
      [UserStatus.Active, ids],
    );
    const devices = new Map<string, { lang: Lang; targets: PushTarget[] }>();
    for (const row of rows) {
      const entry = devices.get(row.user_id) ?? { lang: row.language === 'ar' ? 'ar' : 'en', targets: [] };
      entry.targets.push({ token: row.token, platform: row.platform });
      devices.set(row.user_id, entry);
    }
    for (const [userId, { lang, targets }] of devices) {
      const built = message(userId, lang);
      if (built) this.pushService.dispatch(targets, { ...built, data: { ...built.data, type } });
    }
  }

  /**
   * One row per active admin (or only `onlyUserIds` among them), title and body
   * in that admin's language, then `notification:new` on the `/admin` socket.
   * Returns the number of rows written.
   */
  async notifyAdmins(notification: AdminNotification, options: { onlyUserIds?: string[] } = {}): Promise<number> {
    let admins = await this.admins();
    if (options.onlyUserIds) admins = admins.filter((a) => options.onlyUserIds!.includes(a.id));
    const now = new Date();
    for (const admin of admins) {
      const text = notification[admin.lang];
      const id = await this.insert(admin.id, notification.type, text.title, text.body, notification.data, now);
      await this.emitter.emitAsync(NOTIFICATION_EVENTS.adminCreated, {
        userId: admin.id,
        notification: { id, type: notification.type.slice(0, 60), title: text.title.slice(0, 190), body: text.body, data: notification.data, readAt: null, createdAt: now.toISOString() },
      } satisfies AdminNotificationCreatedEvent);
    }
    return admins.length;
  }
}
