import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { Lang } from '../common/i18n/language.js';
import { PushService, type PushTarget } from '../push/push.service.js';

export type NotificationData = Record<string, string | number | boolean | null>;

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
} as const;

export interface AdminNotificationCreatedEvent {
  userId: string;
  notification: { id: string; type: string; title: string; body: string; data: Record<string, unknown> | null; readAt: null; createdAt: string };
}

/**
 * In-app notifications (🔔 rows in `notifications`) plus a push (📱, stub
 * provider) to the users' registered devices. Called by event listeners after
 * COMMIT, never inside a service transaction.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly push: PushService,
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

  async notify(userIds: string[], notification: InAppNotification, options: { push?: boolean } = {}): Promise<void> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (ids.length === 0) return;
    const now = new Date();
    for (const userId of ids) await this.insert(userId, notification.type, notification.title, notification.body, notification.data ?? null, now);
    if (!options.push) return;
    const tokens: { token: string; platform: PushTarget['platform'] }[] = await this.dataSource.query(
      'SELECT token, platform FROM device_tokens WHERE user_id IN (?) AND deleted_at IS NULL',
      [ids],
    );
    await this.push.send(tokens, {
      title: notification.title,
      body: notification.body,
      data: Object.fromEntries(Object.entries(notification.data ?? {}).map(([k, v]) => [k, String(v)])),
    });
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
