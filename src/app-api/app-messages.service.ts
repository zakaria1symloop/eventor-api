import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { ConversationClosedScope, ConversationKind, ConversationStatus, MessageKind, MessageStatus, ParticipantRole } from '../common/enums/messaging.enums.js';
import { FilePurpose, FileVariantKind } from '../common/enums/file.enums.js';
import { ReportReason, ReportTargetType } from '../common/enums/moderation.enums.js';
import { UserRole, UserStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { likeContains } from '../common/dto/transforms.js';
import type { Lang } from '../common/i18n/language.js';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import { runInTransaction } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import type { UploadedPhotoFile } from '../files/photo-gallery.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { ReportsService } from '../reviews/reports.service.js';
import { avatarUrl } from './app-refs.js';
import { pickText } from './app.policy.js';
import type {
  AppConversationDetailDto,
  AppConversationRowDto,
  AppConversationsQueryDto,
  AppChatPersonDto,
  AppMessageDto,
  AppMessagesPageDto,
  AppMessagesQueryDto,
  AppReadResultDto,
  AppReportResultDto,
  AppStartConversationDto,
} from './dto/app-messages.dto.js';

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);
const dateOnly = (value: Date | string): string =>
  value instanceof Date ? new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : String(value).slice(0, 10);

/** The pair share an accepted or completed booking → contact details stop being masked (status-rules §10). */
const UNMASKED_SQL = `EXISTS (SELECT 1 FROM bookings ub
   JOIN conversation_participants uc ON uc.conversation_id = c.id AND uc.user_id = ub.client_id
   JOIN conversation_participants up ON up.conversation_id = c.id AND up.user_id = ub.provider_id
  WHERE ub.status IN ('accepted', 'completed') AND ub.deleted_at IS NULL)`;

const UNREAD_SQL = `(SELECT COUNT(*) FROM messages um
   JOIN conversation_participants ucp ON ucp.conversation_id = um.conversation_id AND ucp.user_id = ?
  WHERE um.conversation_id = c.id AND um.kind <> 'system' AND um.status <> 'deleted'
    AND (um.sender_id IS NULL OR um.sender_id <> ?)
    AND (ucp.last_read_at IS NULL OR um.created_at > ucp.last_read_at))`;

/** Where the chat image goes; the same purpose the admin attachments use. */
const IMAGE_PURPOSE = FilePurpose.Message;

/**
 * Screens 14 Messages and 15 Chat, for both roles. The conversation rows, the
 * masking rule and the message table are the ones `MessagingService` owns —
 * this class adds the participant check (a chat you are not in is 403
 * `NOT_A_PARTICIPANT`), the app's message shape (already masked, never the raw
 * body) and the privacy rule that no other user's email or phone is ever
 * returned here.
 */
@Injectable()
export class AppMessagesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly messaging: MessagingService,
    private readonly reports: ReportsService,
    private readonly files: FilesService,
  ) {}

  // ── participants ──────────────────────────────────────────────

  /** The caller's participant row, or 403 / 404. */
  private async participant(em: EntityManager, conversationId: string, userId: string) {
    const [conversation] = await em.query('SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL', [conversationId]);
    if (!conversation) throw AppException.of('CONVERSATION_NOT_FOUND');
    const [me] = await em.query('SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [conversationId, userId]);
    if (!me) throw AppException.of('NOT_A_PARTICIPANT');
    return { conversation, me };
  }

  private async people(em: EntityManager, conversationIds: string[]): Promise<Map<string, AppChatPersonDto[]>> {
    if (!conversationIds.length) return new Map();
    const rows: any[] = await em.query(
      `SELECT cp.conversation_id, cp.user_id, cp.role, u.full_name, u.role AS user_role, u.status, u.avatar_file_id, pp.business_name
         FROM conversation_participants cp JOIN users u ON u.id = cp.user_id
         LEFT JOIN provider_profiles pp ON pp.user_id = u.id AND pp.deleted_at IS NULL
        WHERE cp.conversation_id IN (?)`,
      [conversationIds],
    );
    const map = new Map<string, AppChatPersonDto[]>();
    for (const r of rows) {
      const person: AppChatPersonDto = {
        id: r.user_id,
        name: r.role === ParticipantRole.Support || r.user_role === UserRole.Admin ? 'Eventor support' : (r.business_name ?? r.full_name),
        avatarUrl: avatarUrl(this.files, r.avatar_file_id),
        role: r.role,
        blocked: r.status === UserStatus.Blocked,
      };
      map.set(r.conversation_id, [...(map.get(r.conversation_id) ?? []), person]);
    }
    return map;
  }

  // ── list (screen 14) ──────────────────────────────────────────

  async list(auth: AuthUser, query: AppConversationsQueryDto, lang: Lang): Promise<Paginated<AppConversationRowDto>> {
    const em = this.dataSource.manager;
    const clauses = ['c.deleted_at IS NULL', 'EXISTS (SELECT 1 FROM conversation_participants mp WHERE mp.conversation_id = c.id AND mp.user_id = ?)'];
    const params: unknown[] = [auth.id];
    if (query.filter === 'unread') {
      clauses.push(`${UNREAD_SQL} > 0`);
      params.push(auth.id, auth.id);
    }
    if (query.filter === 'booking') clauses.push('c.booking_id IS NOT NULL');
    if (query.q) {
      clauses.push(
        `EXISTS (SELECT 1 FROM conversation_participants qp JOIN users qu ON qu.id = qp.user_id
                   LEFT JOIN provider_profiles qpp ON qpp.user_id = qu.id
                  WHERE qp.conversation_id = c.id AND qp.user_id <> ? AND (qu.full_name LIKE ? OR qpp.business_name LIKE ?))`,
      );
      params.push(auth.id, likeContains(query.q), likeContains(query.q));
    }
    const where = clauses.join(' AND ');

    const [[count], rows] = await Promise.all([
      em.query(`SELECT COUNT(*) AS n FROM conversations c WHERE ${where}`, params),
      em.query(
        `SELECT c.*, ${UNREAD_SQL} AS unread, ${UNMASKED_SQL} AS unmasked,
                b.reference, b.status AS booking_status, b.event_date, b.total, COALESCE(s.title_en, p.name_en) AS title_en, COALESCE(s.title_ar, p.name_ar) AS title_ar,
                (SELECT mp.can_write FROM conversation_participants mp WHERE mp.conversation_id = c.id AND mp.user_id = ?) AS my_can_write
           FROM conversations c
           LEFT JOIN bookings b ON b.id = c.booking_id
           LEFT JOIN services s ON s.id = b.service_id
           LEFT JOIN packs p ON p.id = b.pack_id
          WHERE ${where}
          ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT ? OFFSET ?`,
        [auth.id, auth.id, auth.id, ...params, query.limit, (query.page - 1) * query.limit],
      ),
    ]);

    const ids = (rows as any[]).map((r) => r.id);
    const [people, lastMessages] = await Promise.all([this.people(em, ids), this.lastMessages(em, ids)]);
    const data = (rows as any[]).map((r) => this.toRow(r, auth, lang, people.get(r.id) ?? [], lastMessages.get(r.id) ?? null));
    return paginate(data, Number(count.n), query);
  }

  private async lastMessages(em: EntityManager, ids: string[]): Promise<Map<string, any>> {
    if (!ids.length) return new Map();
    const rows: any[] = await em.query(
      `SELECT m.conversation_id, m.body, m.body_masked, m.kind, m.created_at FROM messages m
        JOIN (SELECT conversation_id, MAX(created_at) AS at FROM messages WHERE conversation_id IN (?) AND status <> 'deleted' GROUP BY conversation_id) last
          ON last.conversation_id = m.conversation_id AND last.at = m.created_at
       WHERE m.status <> 'deleted'`,
      [ids],
    );
    return new Map(rows.map((r) => [r.conversation_id, r]));
  }

  private toRow(r: any, auth: AuthUser, lang: Lang, people: AppChatPersonDto[], last: any | null): AppConversationRowDto {
    const unmasked = Number(r.unmasked) === 1;
    const other = people.find((p) => p.id !== auth.id) ?? null;
    return {
      id: r.id,
      kind: r.kind as ConversationKind,
      status: r.status as ConversationStatus,
      other,
      lastMessage: last ? (last.kind === MessageKind.Attachment ? '📷' : (!unmasked && last.body_masked ? last.body_masked : last.body)) : null,
      lastMessageAt: iso(r.last_message_at),
      unreadCount: Number(r.unread ?? 0),
      booking: r.booking_id
        ? {
            id: r.booking_id,
            reference: r.reference,
            status: r.booking_status,
            eventDate: dateOnly(r.event_date),
            title: pickText(lang, r.title_en, r.title_ar),
            total: String(r.total),
          }
        : null,
      canWrite: r.status === ConversationStatus.Open && Number(r.my_can_write ?? 0) === 1,
    };
  }

  // ── detail (screen 15 header) ─────────────────────────────────

  async get(auth: AuthUser, id: string, lang: Lang): Promise<AppConversationDetailDto> {
    const em = this.dataSource.manager;
    await this.participant(em, id, auth.id);
    const [r] = await em.query(
      `SELECT c.*, ${UNREAD_SQL} AS unread, ${UNMASKED_SQL} AS unmasked,
              b.reference, b.status AS booking_status, b.event_date, b.total, COALESCE(s.title_en, p.name_en) AS title_en, COALESCE(s.title_ar, p.name_ar) AS title_ar,
              (SELECT mp.can_write FROM conversation_participants mp WHERE mp.conversation_id = c.id AND mp.user_id = ?) AS my_can_write
         FROM conversations c
         LEFT JOIN bookings b ON b.id = c.booking_id
         LEFT JOIN services s ON s.id = b.service_id
         LEFT JOIN packs p ON p.id = b.pack_id
        WHERE c.id = ?`,
      [auth.id, auth.id, auth.id, id],
    );
    const people = (await this.people(em, [id])).get(id) ?? [];
    const last = (await this.lastMessages(em, [id])).get(id) ?? null;
    return {
      ...this.toRow(r, auth, lang, people, last),
      participants: people,
      contactUnmasked: Number(r.unmasked) === 1,
      disputeId: r.dispute_id ?? null,
      closedReason: r.closed_reason ?? null,
      createdAt: iso(r.created_at)!,
    };
  }

  // ── messages ──────────────────────────────────────────────────

  async messages(auth: AuthUser, id: string, query: AppMessagesQueryDto): Promise<AppMessagesPageDto> {
    const em = this.dataSource.manager;
    await this.participant(em, id, auth.id);
    const [flags] = await em.query(`SELECT ${UNMASKED_SQL} AS unmasked FROM conversations c WHERE c.id = ?`, [id]);
    const unmasked = Number(flags?.unmasked ?? 0) === 1;

    let where = "m.conversation_id = ? AND m.status <> 'deleted'";
    const params: unknown[] = [id];
    if (query.before) {
      const [cursor] = await em.query('SELECT created_at, id FROM messages WHERE id = ? AND conversation_id = ?', [query.before, id]);
      if (!cursor) throw AppException.of('MESSAGE_NOT_FOUND');
      where += ' AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))';
      params.push(cursor.created_at, cursor.created_at, cursor.id);
    }
    const rows: any[] = await em.query(
      `SELECT m.* FROM messages m WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      [...params, query.limit + 1],
    );
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).reverse();
    return {
      data: page.map((m) => this.toMessage(m, auth.id, unmasked)),
      meta: { limit: query.limit, hasMore, nextBefore: hasMore ? (page[0]?.id ?? null) : null },
    };
  }

  /**
   * The app never receives the unmasked text of a message while masking still
   * applies: a hidden message is replaced entirely, and `body_masked` wins over
   * `body` until the pair share an accepted booking (status-rules §10).
   */
  private toMessage(m: any, meId: string, unmasked: boolean): AppMessageDto {
    const hidden = m.status === MessageStatus.Hidden;
    const masked = !unmasked && m.body_masked !== null;
    return {
      id: m.id,
      conversationId: m.conversation_id,
      kind: m.kind as MessageKind,
      senderId: m.sender_id ?? null,
      mine: m.sender_id === meId,
      body: hidden ? '[removed by Eventor]' : masked ? m.body_masked : (m.body ?? ''),
      masked,
      imageUrl: m.file_id && !hidden ? this.files.signedUrl(m.file_id, { variant: FileVariantKind.Medium }) : null,
      imageLargeUrl: m.file_id && !hidden ? this.files.signedUrl(m.file_id) : null,
      createdAt: iso(m.created_at)!,
    };
  }

  /** The app shape of one message plus who must receive it — used by the `/app` socket. */
  async socketMessage(conversationId: string, messageId: string): Promise<{ recipients: string[]; message: (forUserId: string) => AppMessageDto } | null> {
    const em = this.dataSource.manager;
    const [m] = await em.query('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!m) return null;
    const [flags] = await em.query(`SELECT ${UNMASKED_SQL} AS unmasked FROM conversations c WHERE c.id = ?`, [conversationId]);
    const unmasked = Number(flags?.unmasked ?? 0) === 1;
    const rows: any[] = await em.query('SELECT user_id FROM conversation_participants WHERE conversation_id = ?', [conversationId]);
    return { recipients: rows.map((r) => r.user_id), message: (forUserId: string) => this.toMessage(m, forUserId, unmasked) };
  }

  // ── writes ────────────────────────────────────────────────────

  /** A participant may write while the chat is open and they are not muted. */
  private assertCanWrite(conversation: any, me: any): void {
    if (conversation.status === ConversationStatus.Closed && conversation.closed_scope !== ConversationClosedScope.OneParticipant) {
      throw AppException.of('CONVERSATION_CLOSED');
    }
    if (Number(me.can_write) !== 1) throw AppException.of('CONVERSATION_READ_ONLY');
  }

  /**
   * Screen 12 "Message the provider" and screen 14's new-chat button. One
   * direct conversation exists per client ↔ provider pair (status-rules §10),
   * so calling this twice reuses the first one.
   */
  async start(auth: AuthUser, dto: AppStartConversationDto, lang: Lang): Promise<AppConversationDetailDto> {
    const id = await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const [other] = await em.query('SELECT id, role, status FROM users WHERE id = ? AND deleted_at IS NULL', [dto.userId]);
      if (!other) throw AppException.of('USER_NOT_FOUND');
      if (other.id === auth.id || other.role === UserRole.Admin || other.role === auth.role) {
        throw AppException.of('RECIPIENT_INVALID', { userId: dto.userId });
      }
      const clientId = auth.role === UserRole.Client ? auth.id : other.id;
      const providerId = auth.role === UserRole.Provider ? auth.id : other.id;

      let bookingId: string | null = null;
      if (dto.bookingId) {
        const [booking] = await em.query('SELECT id, client_id, provider_id FROM bookings WHERE id = ? AND deleted_at IS NULL', [dto.bookingId]);
        if (!booking) throw AppException.of('BOOKING_NOT_FOUND');
        if (booking.client_id !== clientId || booking.provider_id !== providerId) throw AppException.of('NOT_OWNER');
        bookingId = booking.id;
      }
      const conversationId = await this.messaging.ensureDirectConversation(em, afterCommit, { clientId, providerId, bookingId, serviceId: null });
      const [me] = await em.query('SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [conversationId, auth.id]);
      const [conversation] = await em.query('SELECT * FROM conversations WHERE id = ?', [conversationId]);
      this.assertCanWrite(conversation, me);
      await this.messaging.insertMessage(em, afterCommit, { conversationId, senderId: auth.id, body: dto.body });
      await em.query('UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', [new Date(), conversationId, auth.id]);
      return conversationId;
    });
    return this.get(auth, id, lang);
  }

  /** A text message, or an image when `file` is sent as multipart. */
  async send(auth: AuthUser, id: string, body: string | null, file: UploadedPhotoFile | undefined): Promise<AppMessageDto> {
    if (!file && (body === null || body.trim() === '')) {
      throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'body', code: 'REQUIRED', message: 'Send a body or an image' }]);
    }
    const messageId = await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const { conversation, me } = await this.participant(em, id, auth.id);
      this.assertCanWrite(conversation, me);
      let fileId: string | null = null;
      if (file) {
        const stored = await this.files.store(
          { buffer: file.buffer, originalName: file.originalname, purpose: IMAGE_PURPOSE, ownerId: auth.id },
          { em, afterCommit },
        );
        fileId = stored.id;
      }
      const created = await this.messaging.insertMessage(em, afterCommit, {
        conversationId: id,
        senderId: auth.id,
        body: body ?? '',
        kind: fileId ? MessageKind.Attachment : MessageKind.Text,
      });
      if (fileId) await em.query('UPDATE messages SET file_id = ? WHERE id = ?', [fileId, created]);
      await em.query('UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', [new Date(), id, auth.id]);
      return created;
    });
    const em = this.dataSource.manager;
    const [m] = await em.query('SELECT * FROM messages WHERE id = ?', [messageId]);
    const [flags] = await em.query(`SELECT ${UNMASKED_SQL} AS unmasked FROM conversations c WHERE c.id = ?`, [id]);
    return this.toMessage(m, auth.id, Number(flags?.unmasked ?? 0) === 1);
  }

  async markRead(auth: AuthUser, id: string): Promise<AppReadResultDto> {
    const em = this.dataSource.manager;
    await this.participant(em, id, auth.id);
    const result = await this.messaging.markRead(auth, id);
    return { conversationId: result.conversationId, unreadCount: 0, lastReadAt: result.lastReadAt };
  }

  // ── reports ───────────────────────────────────────────────────

  /** Report a message from the chat (screen 15 long-press). You must be in the conversation. */
  async reportMessage(auth: AuthUser, messageId: string, reason: ReportReason, note: string | null): Promise<AppReportResultDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const [message] = await em.query('SELECT id, conversation_id FROM messages WHERE id = ?', [messageId]);
      if (!message) throw AppException.of('MESSAGE_NOT_FOUND');
      await this.participant(em, message.conversation_id, auth.id);
      return this.reports.createInTransaction(em, afterCommit, { reporterId: auth.id, targetType: ReportTargetType.Message, targetId: messageId, reason, note });
    });
  }

  /**
   * Report a service, a pack, a user or a review (status-rules §9). One open
   * report per reporter and target, so reporting twice returns the first one
   * with `created: false` rather than an error.
   */
  async report(auth: AuthUser, targetType: ReportTargetType, targetId: string, reason: ReportReason, note: string | null): Promise<AppReportResultDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const table: Record<string, string> = {
        [ReportTargetType.Service]: 'services',
        [ReportTargetType.Pack]: 'packs',
        [ReportTargetType.User]: 'users',
        [ReportTargetType.Review]: 'reviews',
        [ReportTargetType.Message]: 'messages',
      };
      const target = table[targetType];
      if (!target) throw AppException.of('REPORT_TARGET_NOT_FOUND');
      if (targetType === ReportTargetType.Message) return this.reportMessage(auth, targetId, reason, note);
      const [row] = await em.query(`SELECT id FROM ${target} WHERE id = ?${target === 'messages' ? '' : ' AND deleted_at IS NULL'}`, [targetId]);
      if (!row) throw AppException.of('REPORT_TARGET_NOT_FOUND');
      if (targetType === ReportTargetType.User && targetId === auth.id) {
        throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'targetId', code: 'SELF', message: 'You cannot report yourself' }]);
      }
      return this.reports.createInTransaction(em, afterCommit, { reporterId: auth.id, targetType, targetId, reason, note });
    });
  }
}
