import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { likeContains } from '../common/dto/transforms.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { FileVariantKind } from '../common/enums/file.enums.js';
import { ConversationClosedScope, ConversationKind, ConversationStatus, MessageKind, MessageStatus, ParticipantRole } from '../common/enums/messaging.enums.js';
import { UserRole, UserStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { User } from '../users/entities/user.entity.js';
import { maskContacts, preview } from './contact-masking.js';
import {
  CONVERSATION_SORT_FIELDS,
  type AdminMessageDto,
  type CloseConversationDto,
  type ConversationCountsDto,
  type ConversationDetailDto,
  type ConversationFiltersDto,
  type ConversationRowDto,
  type ConversationsQueryDto,
  type CreateConversationDto,
  type MessagesPageDto,
  type MessagesQueryDto,
  type ReadResultDto,
} from './dto/messaging.dto.js';
import { Conversation } from './entities/conversation.entity.js';
import { Message } from './entities/message.entity.js';
import {
  MESSAGING_EVENTS,
  type ConversationUpdatedEvent,
  type MessageCreatedEvent,
  type MessageUpdatedEvent,
  type SupportMessageEmailedEvent,
} from './messaging.events.js';

export const SUPPORT_LABEL = 'Eventor support';
export const SYSTEM_LABEL = 'Eventor';

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

/** A pair can see each other's contact details once they share an accepted (or completed) booking. */
export const UNMASKED_SQL = (alias: string) =>
  `EXISTS (SELECT 1 FROM bookings ub
     JOIN conversation_participants uc ON uc.conversation_id = ${alias}.id AND uc.user_id = ub.client_id
     JOIN conversation_participants up ON up.conversation_id = ${alias}.id AND up.user_id = ub.provider_id
     WHERE ub.status IN ('accepted', 'completed') AND ub.deleted_at IS NULL)`;

const REPORTS_OPEN_SQL = (alias: string) =>
  `(SELECT COUNT(*) FROM reports r JOIN messages rm ON rm.id = r.target_id
     WHERE r.target_type = 'message' AND r.status = 'open' AND r.deleted_at IS NULL AND rm.conversation_id = ${alias}.id)`;

const UNREAD_SQL = (alias: string) =>
  `(SELECT COUNT(*) FROM messages um JOIN conversation_participants ucp ON ucp.conversation_id = um.conversation_id AND ucp.user_id = ?
     WHERE um.conversation_id = ${alias}.id AND um.kind <> 'system' AND um.status <> 'deleted' AND (um.sender_id IS NULL OR um.sender_id <> ?)
       AND (ucp.last_read_at IS NULL OR um.created_at > ucp.last_read_at))`;

const SORT_COLUMNS: Record<(typeof CONVERSATION_SORT_FIELDS)[number], string> = {
  lastMessageAt: 'COALESCE(c.last_message_at, c.created_at)',
  createdAt: 'c.created_at',
};

interface RawMessage {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  kind: MessageKind;
  body: string | null;
  body_masked: string | null;
  file_id: string | null;
  status: MessageStatus;
  moderated_by_id: string | null;
  moderated_at: Date | null;
  created_at: Date;
  sender_name: string | null;
  sender_role: UserRole | null;
  sender_avatar: string | null;
  moderator_name: string | null;
  reports_open: number | string;
}

const MESSAGE_SELECT = `SELECT m.id, m.conversation_id, m.sender_id, m.kind, m.body, m.body_masked, m.file_id, m.status, m.moderated_by_id, m.moderated_at, m.created_at,
    su.full_name AS sender_name, su.role AS sender_role, su.avatar_file_id AS sender_avatar, mu.full_name AS moderator_name,
    (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'message' AND r.target_id = m.id AND r.status = 'open' AND r.deleted_at IS NULL) AS reports_open
  FROM messages m LEFT JOIN users su ON su.id = m.sender_id LEFT JOIN users mu ON mu.id = m.moderated_by_id`;

/** MSG-01…MSG-03: conversations, moderation and admin support messages. Also used by bookings to link chats. */
@Injectable()
export class MessagingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly files: FilesService,
  ) {}

  private avatar(fileId: string | null): string | null {
    return fileId ? this.files.signedUrl(fileId, { variant: FileVariantKind.Thumb }) : null;
  }

  // ── shared helpers (bookings) ───────────────────────────────

  /**
   * The direct conversation of a client ↔ provider pair (one per pair), created
   * when missing; `bookingId` points at the latest booking.
   */
  async ensureDirectConversation(em: EntityManager, afterCommit: AfterCommit, input: { clientId: string; providerId: string; bookingId: string; serviceId: string | null }): Promise<string> {
    const [existing]: { id: string }[] = await em.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants a ON a.conversation_id = c.id AND a.user_id = ?
       JOIN conversation_participants b ON b.conversation_id = c.id AND b.user_id = ?
       WHERE c.kind = 'direct' AND c.deleted_at IS NULL ORDER BY c.created_at LIMIT 1 FOR UPDATE`,
      [input.clientId, input.providerId],
    );
    if (existing) {
      await em.query('UPDATE conversations SET booking_id = ?, updated_at = ? WHERE id = ?', [input.bookingId, new Date(), existing.id]);
      return existing.id;
    }
    const repository = em.getRepository(Conversation);
    const conversation = await repository.save(repository.create({ kind: ConversationKind.Direct, bookingId: input.bookingId, serviceId: input.serviceId, status: ConversationStatus.Open }));
    await em.query(
      'INSERT INTO conversation_participants (id, created_at, conversation_id, user_id, role, can_write, last_read_at) VALUES (UUID(), ?, ?, ?, ?, 1, NULL), (UUID(), ?, ?, ?, ?, 1, NULL)',
      [new Date(), conversation.id, input.clientId, ParticipantRole.Client, new Date(), conversation.id, input.providerId, ParticipantRole.Provider],
    );
    this.events.emitAfterCommit<ConversationUpdatedEvent>(afterCommit, MESSAGING_EVENTS.conversationUpdated, { conversationId: conversation.id, reason: 'created' });
    return conversation.id;
  }

  /**
   * Inserts a message with `body_masked` computed, bumps `last_message_at`, and
   * pushes `message.created` after COMMIT. `senderId` null = system message.
   */
  async insertMessage(em: EntityManager, afterCommit: AfterCommit, input: { conversationId: string; senderId: string | null; body: string; kind?: MessageKind; createdAt?: Date }): Promise<string> {
    const kind = input.kind ?? (input.senderId ? MessageKind.Text : MessageKind.System);
    const masked = kind === MessageKind.System ? { masked: null } : maskContacts(input.body);
    const repository = em.getRepository(Message);
    const createdAt = input.createdAt ?? new Date();
    const message = await repository.save(
      repository.create({ conversationId: input.conversationId, senderId: input.senderId, kind, body: input.body, bodyMasked: masked.masked, status: MessageStatus.Visible, createdAt }),
    );
    await em.query('UPDATE conversations SET last_message_at = GREATEST(COALESCE(last_message_at, ?), ?) WHERE id = ?', [createdAt, createdAt, input.conversationId]);
    afterCommit(async () => {
      const dto = (await this.messageDtos(this.dataSource.manager, 'm.id = ?', [message.id]))[0];
      if (!dto) return;
      await this.events.emit<MessageCreatedEvent>(MESSAGING_EVENTS.messageCreated, { conversationId: input.conversationId, message: dto });
    });
    return message.id;
  }

  // ── list ────────────────────────────────────────────────────

  private where(filters: ConversationFiltersDto, adminId: string): { sql: string; params: unknown[] } {
    const clauses = ['c.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (filters.kind) {
      clauses.push('c.kind = ?');
      params.push(filters.kind);
    }
    if (filters.status) {
      clauses.push('c.status = ?');
      params.push(filters.status);
    }
    if (filters.bookingId) {
      clauses.push('c.booking_id = ?');
      params.push(filters.bookingId);
    }
    if (filters.aboutBooking === true) clauses.push('c.booking_id IS NOT NULL');
    if (filters.aboutBooking === false) clauses.push('c.booking_id IS NULL');
    if (filters.userId) {
      clauses.push('EXISTS (SELECT 1 FROM conversation_participants fp WHERE fp.conversation_id = c.id AND fp.user_id = ?)');
      params.push(filters.userId);
    }
    if (filters.reported !== undefined) clauses.push(`${REPORTS_OPEN_SQL('c')} ${filters.reported ? '>' : '='} 0`);
    if (filters.unread !== undefined) {
      clauses.push(`${UNREAD_SQL('c')} ${filters.unread ? '>' : '='} 0`);
      params.push(adminId, adminId);
    }
    if (filters.q) {
      const words = filters.q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
      const parts = ['EXISTS (SELECT 1 FROM conversation_participants qp JOIN users qu ON qu.id = qp.user_id WHERE qp.conversation_id = c.id AND qu.full_name LIKE ?)'];
      params.push(likeContains(filters.q));
      if (words.length > 0) {
        parts.push("EXISTS (SELECT 1 FROM messages qm WHERE qm.conversation_id = c.id AND MATCH(qm.body) AGAINST (? IN BOOLEAN MODE))");
        params.push(words.map((w) => `+${w}*`).join(' '));
      }
      clauses.push(`(${parts.join(' OR ')})`);
    }
    return { sql: clauses.join(' AND '), params };
  }

  async list(auth: AuthUser, query: ConversationsQueryDto): Promise<Paginated<ConversationRowDto, ConversationCountsDto>> {
    const em = this.dataSource.manager;
    const [field, direction] = Object.entries(toOrder(query.sort, CONVERSATION_SORT_FIELDS, ['lastMessageAt', 'DESC']))[0]! as [(typeof CONVERSATION_SORT_FIELDS)[number], 'ASC' | 'DESC'];
    const where = this.where(query, auth.id);
    const countsWhere = this.where({ ...query, kind: undefined, reported: undefined, aboutBooking: undefined, unread: undefined }, auth.id);
    const [rows, [{ n }], [counts]] = await Promise.all([
      em.query(
        `SELECT c.id, c.kind, c.status, c.dispute_id, c.last_message_at, c.booking_id, b.reference, b.status AS booking_status,
                ${REPORTS_OPEN_SQL('c')} AS reports_open, ${UNREAD_SQL('c')} AS unread
         FROM conversations c LEFT JOIN bookings b ON b.id = c.booking_id
         WHERE ${where.sql} ORDER BY ${SORT_COLUMNS[field]} ${direction}, c.id ASC LIMIT ? OFFSET ?`,
        [auth.id, auth.id, ...where.params, query.limit, (query.page - 1) * query.limit],
      ),
      em.query(`SELECT COUNT(*) AS n FROM conversations c WHERE ${where.sql}`, where.params),
      em.query(
        `SELECT COUNT(*) AS all_n, COALESCE(SUM(${REPORTS_OPEN_SQL('c')} > 0), 0) AS reported, COALESCE(SUM(c.booking_id IS NOT NULL), 0) AS about_booking,
                COALESCE(SUM(c.kind = 'dispute'), 0) AS disputes, COALESCE(SUM(${UNREAD_SQL('c')} > 0), 0) AS unread
         FROM conversations c WHERE ${countsWhere.sql}`,
        [auth.id, auth.id, ...countsWhere.params],
      ),
    ]);
    const ids: string[] = rows.map((r: any) => r.id);
    const [participants, lastMessages] = await Promise.all([this.participants(em, ids), this.lastMessages(em, ids)]);
    const data: ConversationRowDto[] = rows.map((r: any) => ({
      id: r.id,
      kind: r.kind,
      participants: (participants.get(r.id) ?? []).map((p) => ({ id: p.user_id, fullName: p.full_name, role: p.role, avatarUrl: this.avatar(p.avatar_file_id) })),
      lastMessage: lastMessages.get(r.id) ?? null,
      unreadCount: Number(r.unread),
      booking: r.booking_id ? { id: r.booking_id, reference: r.reference, status: r.booking_status } : null,
      disputeId: r.dispute_id,
      status: r.status,
      reportsOpen: Number(r.reports_open),
      lastMessageAt: iso(r.last_message_at),
    }));
    return paginateWithCounts(data, Number(n), query, {
      all: Number(counts.all_n),
      reported: Number(counts.reported),
      aboutBooking: Number(counts.about_booking),
      disputes: Number(counts.disputes),
      unread: Number(counts.unread),
    });
  }

  private async participants(em: EntityManager, conversationIds: string[]) {
    const map = new Map<string, any[]>();
    if (conversationIds.length === 0) return map;
    const rows: any[] = await em.query(
      `SELECT cp.conversation_id, cp.user_id, cp.role, cp.can_write, cp.last_read_at, u.full_name, u.avatar_file_id, u.role AS user_role, u.email, u.status AS user_status
       FROM conversation_participants cp JOIN users u ON u.id = cp.user_id
       WHERE cp.conversation_id IN (?) ORDER BY FIELD(cp.role, 'client', 'provider', 'support'), cp.created_at`,
      [conversationIds],
    );
    for (const row of rows) map.set(row.conversation_id, [...(map.get(row.conversation_id) ?? []), row]);
    return map;
  }

  private async lastMessages(em: EntityManager, conversationIds: string[]) {
    const map = new Map<string, ConversationRowDto['lastMessage']>();
    if (conversationIds.length === 0) return map;
    const rows: any[] = await em.query(
      `SELECT m.conversation_id, m.body, m.body_masked, m.kind, m.created_at, m.sender_id, u.full_name, u.role
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.id IN (
         SELECT (SELECT lm.id FROM messages lm WHERE lm.conversation_id = cid.id AND lm.status = 'visible' ORDER BY lm.created_at DESC, lm.id DESC LIMIT 1)
         FROM conversations cid WHERE cid.id IN (?))`,
      [conversationIds],
    );
    for (const row of rows) {
      map.set(row.conversation_id, {
        bodyPreview: preview(row.body_masked ?? row.body),
        createdAt: iso(row.created_at)!,
        senderName: !row.sender_id ? SYSTEM_LABEL : row.role === UserRole.Admin ? SUPPORT_LABEL : row.full_name,
      });
    }
    return map;
  }

  // ── detail & messages ───────────────────────────────────────

  private async loadConversation(em: EntityManager, id: string, lock = false): Promise<Conversation> {
    const conversation = await em.getRepository(Conversation).findOne({ where: { id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!conversation) throw AppException.of('CONVERSATION_NOT_FOUND');
    return conversation;
  }

  async get(auth: AuthUser, id: string, em: EntityManager = this.dataSource.manager): Promise<ConversationDetailDto> {
    const conversation = await this.loadConversation(em, id);
    const [participants, [booking], [dispute], reports, [flags]] = await Promise.all([
      this.participants(em, [id]),
      conversation.bookingId
        ? em.query(
            `SELECT b.id, b.reference, b.status, b.event_date, b.total, COALESCE(s.title_en, p.name_en) AS title_en, COALESCE(s.title_ar, p.name_ar) AS title_ar
             FROM bookings b LEFT JOIN services s ON s.id = b.service_id LEFT JOIN packs p ON p.id = b.pack_id WHERE b.id = ?`,
            [conversation.bookingId],
          )
        : [],
      conversation.disputeId ? em.query('SELECT id, reference, status, type FROM disputes WHERE id = ?', [conversation.disputeId]) : [],
      em.query(
        `SELECT r.id, r.target_id, r.reason, r.note, r.created_at, r.reporter_id, u.full_name FROM reports r JOIN messages m ON m.id = r.target_id JOIN users u ON u.id = r.reporter_id
         WHERE r.target_type = 'message' AND r.status = 'open' AND r.deleted_at IS NULL AND m.conversation_id = ? ORDER BY r.created_at`,
        [id],
      ),
      em.query(`SELECT ${UNMASKED_SQL('c')} AS unmasked, ${UNREAD_SQL('c')} AS unread FROM conversations c WHERE c.id = ?`, [auth.id, auth.id, id]),
    ]);
    const people = participants.get(id) ?? [];
    const closedBy = conversation.closedById ? await em.getRepository(User).findOne({ where: { id: conversation.closedById }, withDeleted: true }) : null;
    return {
      id: conversation.id,
      kind: conversation.kind,
      status: conversation.status,
      participants: people.map((p) => ({
        id: p.user_id,
        fullName: p.full_name,
        role: p.role,
        avatarUrl: this.avatar(p.avatar_file_id),
        userRole: p.user_role,
        email: p.email,
        canWrite: Number(p.can_write) === 1,
        blocked: p.user_status === UserStatus.Blocked,
        lastReadAt: iso(p.last_read_at),
      })),
      booking: booking
        ? {
            id: booking.id,
            reference: booking.reference,
            status: booking.status,
            eventDate: booking.event_date instanceof Date ? booking.event_date.toISOString().slice(0, 10) : String(booking.event_date).slice(0, 10),
            titleEn: booking.title_en,
            titleAr: booking.title_ar,
            total: String(booking.total),
          }
        : null,
      dispute: dispute ? { id: dispute.id, reference: dispute.reference, status: dispute.status, type: dispute.type } : null,
      reports: reports.map((r: any) => ({ id: r.id, messageId: r.target_id, reason: r.reason, note: r.note, reporter: { id: r.reporter_id, fullName: r.full_name }, createdAt: iso(r.created_at)! })),
      closed:
        conversation.status === ConversationStatus.Closed
          ? {
              scope: conversation.closedScope ?? ConversationClosedScope.All,
              reason: conversation.closedReason,
              closedBy: closedBy ? { id: closedBy.id, fullName: closedBy.fullName } : null,
              closedAt: iso(conversation.closedAt),
              mutedUserIds: people.filter((p) => Number(p.can_write) !== 1 && p.role !== ParticipantRole.Support).map((p) => p.user_id),
            }
          : null,
      contactUnmasked: Number(flags?.unmasked ?? 0) === 1,
      unreadCount: Number(flags?.unread ?? 0),
      lastMessageAt: iso(conversation.lastMessageAt),
      createdAt: iso(conversation.createdAt)!,
    };
  }

  private async messageDtos(em: EntityManager, where: string, params: unknown[], suffix = ''): Promise<AdminMessageDto[]> {
    const rows: RawMessage[] = await em.query(`${MESSAGE_SELECT} WHERE ${where} ${suffix}`, params);
    return rows.map((m) => this.toMessageDto(m));
  }

  private toMessageDto(m: RawMessage): AdminMessageDto {
    const detected = m.kind === MessageKind.System ? [] : maskContacts(m.body).kinds;
    return {
      id: m.id,
      conversationId: m.conversation_id,
      kind: m.kind,
      sender: m.sender_id ? { id: m.sender_id, fullName: m.sender_name ?? 'Deleted user', role: m.sender_role ?? UserRole.Client, avatarUrl: this.avatar(m.sender_avatar) } : null,
      senderLabel: !m.sender_id ? SYSTEM_LABEL : m.sender_role === UserRole.Admin ? SUPPORT_LABEL : (m.sender_name ?? 'Deleted user'),
      body: m.body,
      bodyMasked: m.body_masked,
      masked: m.body_masked !== null,
      detectedContacts: detected,
      status: m.status,
      moderation: m.moderated_by_id || m.moderated_at ? { by: m.moderated_by_id ? { id: m.moderated_by_id, fullName: m.moderator_name ?? '' } : null, at: iso(m.moderated_at) } : null,
      reportsOpen: Number(m.reports_open),
      fileId: m.file_id,
      createdAt: iso(m.created_at)!,
    };
  }

  async messages(id: string, query: MessagesQueryDto): Promise<MessagesPageDto> {
    const em = this.dataSource.manager;
    await this.loadConversation(em, id);
    const limit = query.limit ?? 30;
    let where = 'm.conversation_id = ?';
    const params: unknown[] = [id];
    if (query.before) {
      const [cursor] = await em.query('SELECT created_at, id FROM messages WHERE id = ? AND conversation_id = ?', [query.before, id]);
      if (!cursor) throw AppException.of('MESSAGE_NOT_FOUND');
      where += ' AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))';
      params.push(cursor.created_at, cursor.created_at, cursor.id);
    }
    const rows = await this.messageDtos(em, where, [...params, limit + 1], 'ORDER BY m.created_at DESC, m.id DESC LIMIT ?');
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return { data: page, meta: { limit, hasMore, nextBefore: hasMore ? (page[0]?.id ?? null) : null } };
  }

  async message(id: string, em: EntityManager = this.dataSource.manager): Promise<AdminMessageDto> {
    const [dto] = await this.messageDtos(em, 'm.id = ?', [id]);
    if (!dto) throw AppException.of('MESSAGE_NOT_FOUND');
    return dto;
  }

  // ── writes ──────────────────────────────────────────────────

  /** Adds the admin as support participant, with a system message the first time. */
  private async joinAsSupport(em: EntityManager, afterCommit: AfterCommit, conversationId: string, admin: User): Promise<void> {
    const [row] = await em.query('SELECT id FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [conversationId, admin.id]);
    if (row) return;
    await em.query('INSERT INTO conversation_participants (id, created_at, conversation_id, user_id, role, can_write, last_read_at) VALUES (UUID(), ?, ?, ?, ?, 1, ?)', [
      new Date(),
      conversationId,
      admin.id,
      ParticipantRole.Support,
      new Date(),
    ]);
    await this.insertMessage(em, afterCommit, { conversationId, senderId: null, body: `${admin.fullName} joined as ${SUPPORT_LABEL}`, kind: MessageKind.System });
    this.events.emitAfterCommit<ConversationUpdatedEvent>(afterCommit, MESSAGING_EVENTS.conversationUpdated, { conversationId, reason: 'participant_joined' });
  }

  async create(auth: AuthUser, dto: CreateConversationDto): Promise<ConversationDetailDto> {
    const id = await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const admin = await em.getRepository(User).findOneOrFail({ where: { id: auth.id } });
      const users = await em.getRepository(User).find({ where: dto.userIds.map((userId) => ({ id: userId })) });
      const invalid = dto.userIds.filter((userId) => {
        const user = users.find((u) => u.id === userId);
        return !user || user.role === UserRole.Admin;
      });
      if (invalid.length > 0) throw AppException.of('RECIPIENT_INVALID', { userIds: invalid });
      if (dto.bookingId && !(await em.query('SELECT id FROM bookings WHERE id = ? AND deleted_at IS NULL', [dto.bookingId])).length) throw AppException.of('BOOKING_NOT_FOUND');

      let conversationId: string | null = null;
      if (dto.userIds.length === 1) {
        // Reuse the user's open support conversation (only that user besides support staff).
        const [existing] = await em.query(
          `SELECT c.id FROM conversations c JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
           WHERE c.kind = 'support' AND c.status = 'open' AND c.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM conversation_participants o WHERE o.conversation_id = c.id AND o.user_id <> ? AND o.role <> 'support')
           ORDER BY c.created_at DESC LIMIT 1 FOR UPDATE`,
          [dto.userIds[0], dto.userIds[0]],
        );
        conversationId = existing?.id ?? null;
      }
      const created = !conversationId;
      if (!conversationId) {
        const repository = em.getRepository(Conversation);
        const conversation = await repository.save(repository.create({ kind: ConversationKind.Support, bookingId: dto.bookingId ?? null, status: ConversationStatus.Open }));
        conversationId = conversation.id;
        for (const user of users) {
          await em.query('INSERT INTO conversation_participants (id, created_at, conversation_id, user_id, role, can_write, last_read_at) VALUES (UUID(), ?, ?, ?, ?, ?, NULL)', [
            new Date(),
            conversationId,
            user.id,
            user.role === UserRole.Provider ? ParticipantRole.Provider : ParticipantRole.Client,
            user.status === UserStatus.Blocked ? 0 : 1,
          ]);
        }
        await em.query('INSERT INTO conversation_participants (id, created_at, conversation_id, user_id, role, can_write, last_read_at) VALUES (UUID(), ?, ?, ?, ?, 1, ?)', [
          new Date(),
          conversationId,
          admin.id,
          ParticipantRole.Support,
          new Date(),
        ]);
      } else {
        if (dto.bookingId) await em.query('UPDATE conversations SET booking_id = ? WHERE id = ?', [dto.bookingId, conversationId]);
        await this.joinAsSupport(em, afterCommit, conversationId, admin);
      }
      await this.insertMessage(em, afterCommit, { conversationId, senderId: admin.id, body: dto.body });
      await em.query('UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', [new Date(), conversationId, admin.id]);
      await this.audit.log(
        {
          action: 'conversation.support_message_sent',
          objectType: 'conversation',
          objectId: conversationId,
          objectLabel: users.map((u) => u.fullName).join(', '),
          level: AuditLevel.Normal,
          changes: { userIds: dto.userIds, created, bookingId: dto.bookingId ?? null, email: dto.email ?? false },
        },
        em,
      );
      this.events.emitAfterCommit<ConversationUpdatedEvent>(afterCommit, MESSAGING_EVENTS.conversationUpdated, { conversationId, reason: created ? 'created' : 'message' });
      if (dto.email) {
        this.events.emitAfterCommit<SupportMessageEmailedEvent>(afterCommit, MESSAGING_EVENTS.supportMessageEmailed, {
          conversationId,
          body: dto.body,
          recipients: users.map((u) => ({ userId: u.id, email: u.email, name: u.fullName, lang: u.language })),
        });
      }
      return conversationId;
    });
    return this.get(auth, id);
  }

  async send(auth: AuthUser, id: string, body: string): Promise<AdminMessageDto> {
    const messageId = await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const conversation = await this.loadConversation(em, id, true);
      if (conversation.status === ConversationStatus.Closed && conversation.closedScope !== ConversationClosedScope.OneParticipant) throw AppException.of('CONVERSATION_CLOSED');
      const admin = await em.getRepository(User).findOneOrFail({ where: { id: auth.id } });
      await this.joinAsSupport(em, afterCommit, id, admin);
      const created = await this.insertMessage(em, afterCommit, { conversationId: id, senderId: admin.id, body });
      await em.query('UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', [new Date(), id, admin.id]);
      await this.audit.log({ action: 'message.sent_as_support', objectType: 'conversation', objectId: id, level: AuditLevel.Info, changes: { messageId: created } }, em);
      this.events.emitAfterCommit<ConversationUpdatedEvent>(afterCommit, MESSAGING_EVENTS.conversationUpdated, { conversationId: id, reason: 'message' });
      return created;
    });
    return this.message(messageId);
  }

  async markRead(auth: AuthUser, id: string): Promise<ReadResultDto> {
    const em = this.dataSource.manager;
    await this.loadConversation(em, id);
    const now = new Date();
    const result = await em.query('UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', [now, id, auth.id]);
    const joined = Number(result?.affectedRows ?? 0) > 0;
    if (joined) await this.events.emit<ConversationUpdatedEvent>(MESSAGING_EVENTS.conversationUpdated, { conversationId: id, reason: 'read' });
    return { conversationId: id, unreadCount: 0, lastReadAt: joined ? now.toISOString() : null };
  }

  async moderate(auth: AuthUser, messageId: string, action: 'hide' | 'unhide' | 'delete', reason: string | null | undefined): Promise<AdminMessageDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const message = await em.getRepository(Message).findOne({ where: { id: messageId }, lock: { mode: 'pessimistic_write' } });
      if (!message) throw AppException.of('MESSAGE_NOT_FOUND');
      const allowed: Record<typeof action, MessageStatus[]> = {
        hide: [MessageStatus.Visible],
        unhide: [MessageStatus.Hidden],
        delete: [MessageStatus.Visible, MessageStatus.Hidden],
      };
      if (!allowed[action].includes(message.status)) throw AppException.of('MESSAGE_INVALID_TRANSITION', { status: message.status, action });
      const to = action === 'hide' ? MessageStatus.Hidden : action === 'unhide' ? MessageStatus.Visible : MessageStatus.Deleted;
      await em.getRepository(Message).update(messageId, { status: to, moderatedById: auth.id, moderatedAt: new Date() });
      await this.audit.log(
        {
          action: `message.${action === 'unhide' ? 'unhidden' : action === 'hide' ? 'hidden' : 'deleted'}`,
          objectType: 'message',
          objectId: messageId,
          objectLabel: preview(message.bodyMasked ?? message.body, 80),
          level: action === 'delete' ? AuditLevel.Sensitive : AuditLevel.Normal,
          changes: { conversationId: message.conversationId, status: { from: message.status, to } },
          note: reason ?? null,
        },
        em,
      );
      afterCommit(async () => {
        const dto = await this.message(messageId);
        await this.events.emit<MessageUpdatedEvent>(MESSAGING_EVENTS.messageUpdated, { conversationId: message.conversationId, message: dto });
        await this.events.emit<ConversationUpdatedEvent>(MESSAGING_EVENTS.conversationUpdated, { conversationId: message.conversationId, reason: 'moderated' });
      });
    });
    return this.message(messageId);
  }

  async close(auth: AuthUser, id: string, dto: CloseConversationDto): Promise<ConversationDetailDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const conversation = await this.loadConversation(em, id, true);
      if (conversation.status === ConversationStatus.Closed) throw AppException.of('CONVERSATION_ALREADY_CLOSED');
      if (dto.scope === ConversationClosedScope.OneParticipant) {
        const [participant] = await em.query("SELECT id FROM conversation_participants WHERE conversation_id = ? AND user_id = ? AND role <> 'support'", [id, dto.userId]);
        if (!participant) throw AppException.of('PARTICIPANT_NOT_FOUND', { userId: dto.userId });
        await em.query('UPDATE conversation_participants SET can_write = 0 WHERE id = ?', [participant.id]);
      } else {
        await em.query("UPDATE conversation_participants SET can_write = 0 WHERE conversation_id = ? AND role <> 'support'", [id]);
      }
      const now = new Date();
      await em.getRepository(Conversation).update(id, { status: ConversationStatus.Closed, closedScope: dto.scope, closedReason: dto.reason, closedById: auth.id, closedAt: now });
      let resolvedReports = 0;
      if (dto.resolveReports) {
        const result = await em.query(
          `UPDATE reports r JOIN messages m ON m.id = r.target_id SET r.status = 'resolved', r.resolved_by_id = ?, r.resolved_at = ?, r.resolution_note = ?, r.updated_at = ?
           WHERE r.target_type = 'message' AND r.status = 'open' AND r.deleted_at IS NULL AND m.conversation_id = ?`,
          [auth.id, now, `Conversation closed: ${dto.reason}`, now, id],
        );
        resolvedReports = Number(result?.affectedRows ?? 0);
      }
      await this.audit.log(
        {
          action: 'conversation.closed',
          objectType: 'conversation',
          objectId: id,
          level: AuditLevel.Sensitive,
          changes: { status: { from: 'open', to: 'closed' }, scope: dto.scope, userId: dto.userId ?? null, resolvedReports },
          note: dto.reason,
        },
        em,
      );
      this.events.emitAfterCommit<ConversationUpdatedEvent>(afterCommit, MESSAGING_EVENTS.conversationUpdated, { conversationId: id, reason: 'closed' });
    });
    return this.get(auth, id);
  }

  async reopen(auth: AuthUser, id: string): Promise<ConversationDetailDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const conversation = await this.loadConversation(em, id, true);
      if (conversation.status !== ConversationStatus.Closed) throw AppException.of('CONVERSATION_NOT_CLOSED');
      // Blocked accounts stay read-only (status-rules §1).
      await em.query(
        `UPDATE conversation_participants cp JOIN users u ON u.id = cp.user_id SET cp.can_write = IF(u.status = 'blocked' OR u.deleted_at IS NOT NULL, 0, 1) WHERE cp.conversation_id = ?`,
        [id],
      );
      await em.getRepository(Conversation).update(id, { status: ConversationStatus.Open, closedScope: null, closedReason: null, closedById: null, closedAt: null });
      await this.audit.log(
        { action: 'conversation.reopened', objectType: 'conversation', objectId: id, level: AuditLevel.Normal, changes: { status: { from: 'closed', to: 'open' }, previousScope: conversation.closedScope } },
        em,
      );
      this.events.emitAfterCommit<ConversationUpdatedEvent>(afterCommit, MESSAGING_EVENTS.conversationUpdated, { conversationId: id, reason: 'reopened' });
    });
    return this.get(auth, id);
  }

  // ── export (metadata only) ──────────────────────────────────

  async exportCount(filters: ConversationFiltersDto): Promise<number> {
    const where = this.where({ ...filters, unread: undefined }, '');
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n FROM conversations c WHERE ${where.sql}`, where.params);
    return Number(n);
  }

  async exportRows(filters: ConversationFiltersDto, page: { offset: number; limit: number }) {
    const em = this.dataSource.manager;
    const where = this.where({ ...filters, unread: undefined }, '');
    const rows: any[] = await em.query(
      `SELECT c.id, c.kind, c.status, c.created_at, c.last_message_at, c.closed_reason, b.reference, ${REPORTS_OPEN_SQL('c')} AS reports_open,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messages_count
       FROM conversations c LEFT JOIN bookings b ON b.id = c.booking_id WHERE ${where.sql}
       ORDER BY c.created_at DESC, c.id ASC LIMIT ? OFFSET ?`,
      [...where.params, page.limit, page.offset],
    );
    const participants = await this.participants(em, rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as ConversationKind,
      status: r.status as ConversationStatus,
      participants: (participants.get(r.id) ?? []).map((p) => `${p.full_name} (${p.role})`).join(', '),
      bookingReference: (r.reference ?? null) as string | null,
      messagesCount: Number(r.messages_count),
      reportsOpen: Number(r.reports_open),
      closedReason: (r.closed_reason ?? null) as string | null,
      createdAt: iso(r.created_at)!,
      lastMessageAt: iso(r.last_message_at),
    }));
  }
}
