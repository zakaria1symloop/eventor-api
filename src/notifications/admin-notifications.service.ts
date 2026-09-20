import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import type { AdminNotificationDto, AdminNotificationsQueryDto, MarkNotificationsReadDto, MarkReadResultDto } from './dto/admin-notifications.dto.js';

const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);

/** SHL-02: the signed-in admin's own notifications (index `(user_id, read_at, created_at)`). */
@Injectable()
export class AdminNotificationsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(userId: string, query: AdminNotificationsQueryDto): Promise<Paginated<AdminNotificationDto>> {
    const where = `user_id = ? AND deleted_at IS NULL${query.unread ? ' AND read_at IS NULL' : ''}`;
    const [rows, [{ n }]] = await Promise.all([
      this.dataSource.query(`SELECT id, type, title, body, data, read_at, created_at FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
        userId,
        query.limit,
        (query.page - 1) * query.limit,
      ]),
      this.dataSource.query(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`, [userId]),
    ]);
    return paginate(
      rows.map((r: any) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
        readAt: iso(r.read_at),
        createdAt: iso(r.created_at)!,
      })),
      Number(n),
      query,
    );
  }

  async unreadCount(userId: string): Promise<number> {
    const [{ n }] = await this.dataSource.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL', [userId]);
    return Number(n);
  }

  async markRead(userId: string, dto: MarkNotificationsReadDto): Promise<MarkReadResultDto> {
    const now = new Date();
    const result = dto.all
      ? await this.dataSource.query('UPDATE notifications SET read_at = ?, updated_at = ? WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL', [now, now, userId])
      : await this.dataSource.query('UPDATE notifications SET read_at = ?, updated_at = ? WHERE user_id = ? AND id IN (?) AND read_at IS NULL AND deleted_at IS NULL', [
          now,
          now,
          userId,
          dto.ids,
        ]);
    return { updated: Number(result?.affectedRows ?? 0), unread: await this.unreadCount(userId) };
  }
}
