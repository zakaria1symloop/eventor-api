import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { BookingsService, dateOnly, iso } from '../bookings/bookings.service.js';
import { addDays } from '../bookings/bookings.policy.js';
import { Booking } from '../bookings/entities/booking.entity.js';
import { InvoicesService } from '../bookings/invoices.service.js';
import { likeContains } from '../common/dto/transforms.js';
import { AuditLevel, AuditSource } from '../common/enums/admin.enums.js';
import { BookingDisputeStatus, BookingStatus } from '../common/enums/booking.enums.js';
import { FilePurpose, FileVariantKind } from '../common/enums/file.enums.js';
import { ConversationClosedScope, ConversationKind, ConversationStatus, MessageKind, ParticipantRole } from '../common/enums/messaging.enums.js';
import { DisputeEvidenceKind, DisputeStatus } from '../common/enums/moderation.enums.js';
import { PartyRole, UserStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { Conversation } from '../messaging/entities/conversation.entity.js';
import { MESSAGING_EVENTS, type ConversationUpdatedEvent } from '../messaging/messaging.events.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { JOBS } from '../queue/jobs.js';
import { QueueService } from '../queue/queue.service.js';
import { SequencesService } from '../sequences/sequences.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  DISPUTE_EVENTS,
  type DisputeClosedEvent,
  type DisputeEvent,
  type DisputeMessageEvent,
  type DisputeOpenedEvent,
  type DisputeResolvedEvent,
} from './disputes.events.js';
import { allowedActions, DISPUTE_CONVERSATION_CLOSE_DAYS, disputeWindow, isActive, isDisputable, outcomeActions } from './disputes.policy.js';
import {
  DISPUTE_SORT_FIELDS,
  type AddEvidenceDto,
  type AssignDisputeDto,
  type CloseDisputeDto,
  type DisputeDetailDto,
  type DisputeFiltersDto,
  type DisputeRowDto,
  type DisputeSideDto,
  type DisputesQueryDto,
  type DisputeTabCountsDto,
  type OpenDisputeDto,
  type RequestEvidenceDto,
  type ResolveDisputeDto,
} from './dto/disputes.dto.js';
import { DisputeEvidence } from './entities/dispute-evidence.entity.js';
import { Dispute } from './entities/dispute.entity.js';

export const DISPUTE_REFERENCE_PATTERN = /^#?DSP-\d{1,8}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hhmm = (value: string | null | undefined): string | null => (value ? String(value).slice(0, 5) : null);
/** Evidence limit for uploads through the dispute (status-rules §6). */
export const DISPUTE_EVIDENCE_MAX_MB = 5;
/** Files an admin can attach when opening: private uploads only. */
const EVIDENCE_SOURCE_PURPOSES = [FilePurpose.Evidence, FilePurpose.Attachment, FilePurpose.Message, FilePurpose.Document];

const FROM = `FROM disputes d
  JOIN bookings b ON b.id = d.booking_id
  JOIN users ou ON ou.id = d.opened_by_id
  JOIN users au ON au.id = d.against_user_id
  LEFT JOIN users ad ON ad.id = d.assigned_admin_id
  LEFT JOIN services s ON s.id = b.service_id
  LEFT JOIN packs pk ON pk.id = b.pack_id
  LEFT JOIN conversations c ON c.id = d.conversation_id`;

const LAST_ACTIVITY_SQL = `GREATEST(d.updated_at, COALESCE(c.last_message_at, d.created_at), COALESCE((SELECT MAX(e.created_at) FROM dispute_events e WHERE e.dispute_id = d.id), d.created_at))`;

const SORT_COLUMNS: Record<(typeof DISPUTE_SORT_FIELDS)[number], string> = {
  createdAt: 'd.created_at',
  lastActivityAt: LAST_ACTIVITY_SQL,
};

const TAB_STATUS: Record<Exclude<NonNullable<DisputeFiltersDto['tab']>, 'all'>, DisputeStatus> = {
  open: DisputeStatus.Open,
  in_review: DisputeStatus.InReview,
  resolved: DisputeStatus.Resolved,
  closed: DisputeStatus.Closed,
};

const otherRole = (role: PartyRole): PartyRole => (role === PartyRole.Client ? PartyRole.Provider : PartyRole.Client);

/** DSP-01…DSP-03: disputes on bookings (cash payment: no refunds, strikes, deadlines or appeals). */
@Injectable()
export class DisputesService implements OnModuleInit {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly settings: SettingsService,
    private readonly sequences: SequencesService,
    private readonly files: FilesService,
    private readonly bookings: BookingsService,
    private readonly invoices: InvoicesService,
    private readonly messaging: MessagingService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit(): void {
    this.queue.registerHandler(JOBS.disputeCloseConversations, async () => void (await this.closeStaleConversations()));
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'disputes.close-conversations' })
  async scheduleHourly(): Promise<void> {
    await this.queue.add(JOBS.disputeCloseConversations, {}, { jobId: `dispute-conversations-${new Date().toISOString().slice(0, 13)}` });
  }

  // ── list ────────────────────────────────────────────────────

  private where(filters: DisputeFiltersDto, adminId: string | null, options: { tab: boolean }): { sql: string; params: unknown[] } {
    const clauses = ['d.deleted_at IS NULL'];
    const params: unknown[] = [];
    const add = (sql: string, ...values: unknown[]) => {
      clauses.push(sql);
      params.push(...values);
    };
    if (options.tab && filters.tab && filters.tab !== 'all') add('d.status = ?', TAB_STATUS[filters.tab]);
    if (filters.type?.length) add('d.type IN (?)', filters.type);
    if (filters.openedByRole) add('d.opened_by_role = ?', filters.openedByRole);
    if (filters.assignedAdminId) {
      if (filters.assignedAdminId === 'unassigned') add('d.assigned_admin_id IS NULL');
      else if (filters.assignedAdminId.toLowerCase() === 'me') add('d.assigned_admin_id = ?', adminId);
      else add('d.assigned_admin_id = ?', filters.assignedAdminId);
    }
    if (filters.bookingId) add('d.booking_id = ?', filters.bookingId);
    if (filters.bookingStatus?.length) add('b.status IN (?)', filters.bookingStatus);
    if (filters.userId) add('(d.opened_by_id = ? OR d.against_user_id = ?)', filters.userId, filters.userId);
    if (filters.createdFrom) add('d.created_at >= ?', new Date(`${filters.createdFrom}T00:00:00Z`));
    if (filters.createdTo) add('d.created_at < ?', new Date(`${addDays(filters.createdTo, 1)}T00:00:00Z`));
    if (filters.q) {
      const q = filters.q.replace(/^#/, '');
      if (DISPUTE_REFERENCE_PATTERN.test(filters.q)) add('d.reference = ?', q.toUpperCase());
      else if (/^EVT-\d{1,8}$/i.test(q)) add('b.reference = ?', q.toUpperCase());
      else {
        const like = likeContains(filters.q);
        add('(d.reference LIKE ? OR b.reference LIKE ? OR ou.full_name LIKE ? OR au.full_name LIKE ?)', like, like, like, like);
      }
    }
    return { sql: clauses.join(' AND '), params };
  }

  async count(filters: DisputeFiltersDto, adminId: string | null = null): Promise<number> {
    const where = this.where(filters, adminId, { tab: true });
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n ${FROM} WHERE ${where.sql}`, where.params);
    return Number(n);
  }

  async fetchRows(filters: DisputeFiltersDto, sort: string | undefined, page: { offset: number; limit: number }, adminId: string | null = null): Promise<DisputeRowDto[]> {
    const fallback: [(typeof DISPUTE_SORT_FIELDS)[number], 'ASC' | 'DESC'] = filters.tab === 'open' ? ['createdAt', 'ASC'] : ['createdAt', 'DESC'];
    const [field, direction] = Object.entries(toOrder(sort, DISPUTE_SORT_FIELDS, fallback))[0]! as [(typeof DISPUTE_SORT_FIELDS)[number], 'ASC' | 'DESC'];
    const where = this.where(filters, adminId, { tab: true });
    const rows: any[] = await this.dataSource.query(
      `SELECT d.id, d.reference, d.type, d.status, d.created_at, d.opened_by_id, d.opened_by_role, ou.full_name AS opener_name, d.against_user_id, au.full_name AS against_name,
              d.assigned_admin_id, ad.full_name AS admin_name, b.id AS booking_id, b.reference AS booking_reference, b.event_date,
              COALESCE(s.title_en, pk.name_en) AS title_en, COALESCE(NULLIF(s.title_ar, ''), NULLIF(pk.name_ar, ''), s.title_en, pk.name_en) AS title_ar,
              (SELECT COUNT(*) FROM dispute_evidence ev WHERE ev.dispute_id = d.id) AS evidence_count, ${LAST_ACTIVITY_SQL} AS last_activity_at
       ${FROM} WHERE ${where.sql} ORDER BY ${SORT_COLUMNS[field]} ${direction}, d.id ASC LIMIT ? OFFSET ?`,
      [...where.params, page.limit, page.offset],
    );
    return rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      type: r.type,
      booking: { id: r.booking_id, reference: r.booking_reference, titleEn: r.title_en ?? '', titleAr: r.title_ar ?? '', eventDate: dateOnly(r.event_date) },
      openedBy: { id: r.opened_by_id, fullName: r.opener_name, role: r.opened_by_role },
      against: { id: r.against_user_id, fullName: r.against_name, role: otherRole(r.opened_by_role) },
      assignedAdmin: r.assigned_admin_id ? { id: r.assigned_admin_id, fullName: r.admin_name ?? 'Deleted admin' } : null,
      status: r.status,
      evidenceCount: Number(r.evidence_count),
      lastActivityAt: iso(r.last_activity_at)!,
      createdAt: iso(r.created_at)!,
    }));
  }

  async tabCounts(filters: DisputeFiltersDto, adminId: string | null): Promise<DisputeTabCountsDto> {
    const where = this.where(filters, adminId, { tab: false });
    const [raw] = await this.dataSource.query(
      `SELECT COUNT(*) AS all_n, SUM(d.status = 'open') AS open_n, SUM(d.status = 'in_review') AS in_review, SUM(d.status = 'resolved') AS resolved, SUM(d.status = 'closed') AS closed,
              SUM(d.status = 'resolved' AND COALESCE(d.resolved_at, d.updated_at) >= ?) AS resolved_30d, SUM(d.status = 'closed' AND COALESCE(d.resolved_at, d.updated_at) >= ?) AS closed_30d
       ${FROM} WHERE ${where.sql}`,
      [new Date(Date.now() - 30 * 86_400_000), new Date(Date.now() - 30 * 86_400_000), ...where.params],
    );
    const n = (value: unknown) => Number(value ?? 0);
    return { open: n(raw.open_n), inReview: n(raw.in_review), resolved: n(raw.resolved), closed: n(raw.closed), all: n(raw.all_n), resolved30d: n(raw.resolved_30d), closed30d: n(raw.closed_30d) };
  }

  async list(auth: AuthUser, query: DisputesQueryDto): Promise<Paginated<DisputeRowDto, DisputeTabCountsDto>> {
    const [rows, total, counts] = await Promise.all([
      this.fetchRows(query, query.sort, { offset: (query.page - 1) * query.limit, limit: query.limit }, auth.id),
      this.count(query, auth.id),
      this.tabCounts(query, auth.id),
    ]);
    return paginateWithCounts(rows, total, query, counts);
  }

  // ── detail ──────────────────────────────────────────────────

  /** A UUID or a reference (`DSP-000031`, `#DSP-000031`). */
  async resolveId(idOrReference: string): Promise<string> {
    const isUuid = UUID.test(idOrReference);
    if (!isUuid && !DISPUTE_REFERENCE_PATTERN.test(idOrReference)) throw AppException.of('DISPUTE_NOT_FOUND');
    const [row] = await this.dataSource.query(`SELECT id FROM disputes WHERE ${isUuid ? 'id' : 'reference'} = ? AND deleted_at IS NULL`, [
      isUuid ? idOrReference : idOrReference.replace(/^#/, '').toUpperCase(),
    ]);
    if (!row) throw AppException.of('DISPUTE_NOT_FOUND');
    return row.id;
  }

  async get(id: string, em: EntityManager = this.dataSource.manager): Promise<DisputeDetailDto> {
    const [r] = await em.query(
      `SELECT d.*, c.status AS conversation_status, ${LAST_ACTIVITY_SQL} AS last_activity_at, ad.full_name AS admin_name, rb.full_name AS resolved_by_name,
              b.reference AS booking_reference, b.status AS booking_status, b.dispute_status AS booking_dispute_status, b.event_date, b.start_time, b.end_time,
              b.subtotal, b.discount_total, b.total, b.cancelled_by, b.cancel_reason, b.completed_at, b.client_id, b.provider_id, b.service_id,
              COALESCE(s.title_en, pk.name_en) AS title_en, COALESCE(NULLIF(s.title_ar, ''), NULLIF(pk.name_ar, ''), s.title_en, pk.name_en) AS title_ar
       ${FROM} LEFT JOIN users rb ON rb.id = d.resolved_by_id WHERE d.id = ? AND d.deleted_at IS NULL`,
      [id],
    );
    if (!r) throw AppException.of('DISPUTE_NOT_FOUND');

    const partyIds = [r.client_id, r.provider_id];
    const [people, evidenceRows, events, messages, invoice, disputesCounts, cancellations] = await Promise.all([
      em.query(
        `SELECT u.id, u.full_name, u.email, u.phone, u.avatar_file_id, u.status, pp.business_name, pp.avg_rating
         FROM users u LEFT JOIN provider_profiles pp ON pp.user_id = u.id AND pp.deleted_at IS NULL WHERE u.id IN (?)`,
        [partyIds],
      ),
      em.query(
        `SELECT ev.id, ev.kind, ev.uploaded_by_id, ev.file_id, ev.note, ev.created_at, f.original_name, f.mime_type, f.size_bytes
         FROM dispute_evidence ev LEFT JOIN files f ON f.id = ev.file_id WHERE ev.dispute_id = ? ORDER BY ev.created_at, FIELD(ev.kind, 'chat_snapshot', 'file', 'note'), ev.id`,
        [id],
      ),
      em.query('SELECT e.id, e.type, e.actor_id, u.full_name, e.data, e.created_at FROM dispute_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.dispute_id = ? ORDER BY e.created_at, e.id', [id]),
      em.query("SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = ? AND sender_id IN (?) AND kind <> 'system' AND status = 'visible' ORDER BY created_at, id", [
        r.conversation_id,
        partyIds,
      ]),
      this.invoices.summary(r.booking_id, em),
      em.query(
        `SELECT u.id, (SELECT COUNT(*) FROM disputes x WHERE (x.opened_by_id = u.id OR x.against_user_id = u.id) AND x.deleted_at IS NULL) AS n FROM users u WHERE u.id IN (?)`,
        [partyIds],
      ),
      em.query(
        `SELECT
           (SELECT COUNT(*) FROM bookings x WHERE x.client_id = ? AND x.status = 'cancelled' AND x.cancelled_by = 'client' AND x.deleted_at IS NULL) AS client_n,
           (SELECT COUNT(*) FROM bookings x WHERE x.provider_id = ? AND x.status = 'cancelled' AND x.cancelled_by = 'provider' AND x.deleted_at IS NULL) AS provider_n`,
        [r.client_id, r.provider_id],
      ),
    ]);

    const roleOf = (userId: string): PartyRole => (userId === r.client_id ? PartyRole.Client : PartyRole.Provider);
    const person = (userId: string | null, name: string | null) => (userId ? { id: userId, fullName: name ?? 'Deleted user' } : null);
    const byId = new Map<string, any>(people.map((p: any) => [p.id, p]));
    const side = (userId: string, role: PartyRole): DisputeSideDto => {
      const p = byId.get(userId) ?? {};
      return {
        id: userId,
        fullName: p.full_name ?? 'Deleted user',
        role,
        email: p.email ?? '',
        phone: p.phone ?? null,
        avatarUrl: p.avatar_file_id ? this.files.signedUrl(p.avatar_file_id, { variant: FileVariantKind.Thumb }) : null,
        status: p.status ?? UserStatus.Active,
        businessName: role === PartyRole.Provider ? (p.business_name ?? null) : null,
        isOpener: userId === r.opened_by_id,
        description: userId === r.opened_by_id ? r.description : null,
        responses: messages.filter((m: any) => m.sender_id === userId).map((m: any) => ({ id: m.id, body: m.body, createdAt: iso(m.created_at)! })),
        evidenceCount: evidenceRows.filter((e: any) => e.uploaded_by_id === userId).length,
        history: {
          disputesCount: Number(disputesCounts.find((x: any) => x.id === userId)?.n ?? 0),
          cancellationsCount: Number(role === PartyRole.Client ? cancellations[0].client_n : cancellations[0].provider_n),
          ratingAvg: role === PartyRole.Provider && p.avg_rating !== null && p.avg_rating !== undefined ? Number(p.avg_rating) : null,
        },
      };
    };
    const name = (userId: string) => byId.get(userId)?.full_name ?? 'Deleted user';
    const conversationOpen = r.conversation_status === ConversationStatus.Open;

    return {
      id: r.id,
      reference: r.reference,
      type: r.type,
      status: r.status,
      description: r.description,
      openedBy: { id: r.opened_by_id, fullName: name(r.opened_by_id), role: r.opened_by_role },
      against: { id: r.against_user_id, fullName: name(r.against_user_id), role: otherRole(r.opened_by_role) },
      sides: { client: side(r.client_id, PartyRole.Client), provider: side(r.provider_id, PartyRole.Provider) },
      evidence: evidenceRows.map((e: any) => {
        const snapshot = e.kind === DisputeEvidenceKind.ChatSnapshot && typeof e.note === 'string' ? /conversation:([0-9a-f-]{36})/.exec(e.note)?.[1] ?? null : null;
        return {
          id: e.id,
          kind: e.kind,
          uploadedBy: { id: e.uploaded_by_id, fullName: name(e.uploaded_by_id), role: roleOf(e.uploaded_by_id) },
          file: e.file_id ? { id: e.file_id, name: e.original_name, mimeType: e.mime_type, sizeBytes: Number(e.size_bytes), url: this.files.signedUrl(e.file_id) } : null,
          conversationId: snapshot,
          note: e.note,
          createdAt: iso(e.created_at)!,
        };
      }),
      booking: {
        id: r.booking_id,
        reference: r.booking_reference,
        titleEn: r.title_en ?? '',
        titleAr: r.title_ar ?? '',
        eventDate: dateOnly(r.event_date),
        status: r.booking_status,
        disputeStatus: r.booking_dispute_status,
        kind: r.service_id ? 'service' : 'pack',
        startTime: hhmm(r.start_time),
        endTime: hhmm(r.end_time),
        subtotal: String(r.subtotal),
        discountTotal: String(r.discount_total),
        total: String(r.total),
        invoiceNumber: invoice?.number ?? null,
        cancelledBy: r.cancelled_by,
        cancelReason: r.cancel_reason,
        completedAt: iso(r.completed_at),
      },
      assignedAdmin: person(r.assigned_admin_id, r.admin_name),
      conversationId: r.conversation_id,
      conversationStatus: r.conversation_status ?? ConversationStatus.Closed,
      bookingOutcome: r.booking_outcome,
      decisionNote: r.decision_note,
      resolvedBy: person(r.resolved_by_id, r.resolved_by_name),
      resolvedAt: iso(r.resolved_at),
      timeline: events.map((e: any) => ({
        id: e.id,
        type: e.type,
        actor: person(e.actor_id, e.full_name),
        data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data,
        createdAt: iso(e.created_at)!,
      })),
      allowedActions: allowedActions(r.status, conversationOpen),
      lastActivityAt: iso(r.last_activity_at)!,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
    };
  }

  // ── helpers ─────────────────────────────────────────────────

  private async load(em: EntityManager, id: string, lock = false): Promise<Dispute> {
    const dispute = await em.getRepository(Dispute).findOne({ where: { id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!dispute) throw AppException.of('DISPUTE_NOT_FOUND');
    return dispute;
  }

  private async loadBooking(em: EntityManager, id: string, lock = true): Promise<Booking> {
    const booking = await em.getRepository(Booking).findOne({ where: { id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!booking) throw AppException.of('BOOKING_NOT_FOUND');
    return booking;
  }

  private assertActive(dispute: Dispute): void {
    if (!isActive(dispute.status)) throw AppException.of('DISPUTE_INVALID_TRANSITION', { status: dispute.status });
  }

  private async event(em: EntityManager, disputeId: string, actorId: string | null, type: string, data: Record<string, unknown> | null = null): Promise<void> {
    await em.query('INSERT INTO dispute_events (id, created_at, dispute_id, actor_id, type, data) VALUES (UUID(), ?, ?, ?, ?, ?)', [new Date(), disputeId, actorId, type, data ? JSON.stringify(data) : null]);
  }

  private base(dispute: Dispute, booking: Pick<Booking, 'reference' | 'clientId' | 'providerId'>, actorId: string | null): DisputeEvent {
    return {
      disputeId: dispute.id,
      reference: dispute.reference,
      conversationId: dispute.conversationId ?? null,
      bookingId: dispute.bookingId,
      bookingReference: booking.reference,
      clientId: booking.clientId,
      providerId: booking.providerId,
      openedById: dispute.openedById,
      againstUserId: dispute.againstUserId,
      actorId,
    };
  }

  /** The signed-in admin joins the dispute chat as support if needed. */
  private async ensureSupport(em: EntityManager, conversationId: string, adminId: string): Promise<void> {
    const [row] = await em.query('SELECT id FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [conversationId, adminId]);
    if (row) return;
    await em.query('INSERT INTO conversation_participants (id, created_at, conversation_id, user_id, role, can_write, last_read_at) VALUES (UUID(), ?, ?, ?, ?, 1, ?)', [
      new Date(),
      conversationId,
      adminId,
      ParticipantRole.Support,
      new Date(),
    ]);
  }

  private async partyEvidenceCount(em: EntityManager, disputeId: string, userId: string): Promise<number> {
    const [row] = await em.query("SELECT COUNT(*) AS n FROM dispute_evidence WHERE dispute_id = ? AND uploaded_by_id = ? AND kind = 'file'", [disputeId, userId]);
    return Number(row.n);
  }

  /** When the booking was cancelled (latest status change), for the 7-day rule. */
  private async cancelledAt(em: EntityManager, booking: Booking): Promise<Date | null> {
    if (booking.status !== BookingStatus.Cancelled) return null;
    const [row] = await em.query("SELECT MAX(created_at) AS at FROM booking_status_changes WHERE booking_id = ? AND to_status = 'cancelled'", [booking.id]);
    return row?.at ? new Date(row.at) : booking.updatedAt;
  }

  // ── open ────────────────────────────────────────────────────

  async open(auth: AuthUser, dto: OpenDisputeDto, now = new Date()): Promise<DisputeDetailDto> {
    const bookingId = await this.bookings.resolveId(dto.bookingId);
    const id = await runInTransaction(this.dataSource, (em, afterCommit) => this.openInTransaction(em, afterCommit, auth, { ...dto, bookingId }, now));
    return this.get(id);
  }

  /**
   * Opens a dispute inside the caller's transaction (`dto.bookingId` must be a
   * UUID). Used by `open` and by report → dispute conversion (REV-02). Returns the dispute id.
   */
  async openInTransaction(em: EntityManager, afterCommit: AfterCommit, auth: AuthUser, dto: OpenDisputeDto, now = new Date()): Promise<string> {
    const bookingId = dto.bookingId;
    {
      const booking = await this.loadBooking(em, bookingId);
      if (!isDisputable(booking.status)) throw AppException.of('BOOKING_NOT_DISPUTABLE', { status: booking.status });
      const [existing] = await em.query("SELECT reference FROM disputes WHERE booking_id = ? AND status IN ('open', 'in_review') AND deleted_at IS NULL LIMIT 1 FOR UPDATE", [booking.id]);
      if (existing) throw AppException.of('DISPUTE_ALREADY_OPEN', { reference: existing.reference });

      const windowHours = Number(await this.settings.get('dispute_window_hours'));
      const window = disputeWindow(
        { status: booking.status, eventDate: dateOnly(booking.eventDate), startTime: booking.startTime, endTime: booking.endTime, cancelledAt: await this.cancelledAt(em, booking) },
        windowHours,
        now,
      );
      if (!window.open && !dto.ignoreWindow) {
        throw AppException.of('DISPUTE_WINDOW_CLOSED', { opensAt: window.opensAt?.toISOString() ?? null, closesAt: window.closesAt?.toISOString() ?? null });
      }

      const openedById = dto.openedByRole === PartyRole.Client ? booking.clientId : booking.providerId;
      const againstUserId = dto.openedByRole === PartyRole.Client ? booking.providerId : booking.clientId;

      // Evidence files chosen at opening.
      const fileIds = [...new Set(dto.evidenceFileIds ?? [])];
      if (fileIds.length) {
        const files: { id: string }[] = await em.query('SELECT id FROM files WHERE id IN (?) AND is_private = 1 AND purpose IN (?) AND deleted_at IS NULL', [fileIds, EVIDENCE_SOURCE_PURPOSES]);
        const missing = fileIds.filter((f) => !files.some((x) => x.id === f));
        if (missing.length) throw AppException.of('EVIDENCE_FILE_INVALID', { fileIds: missing });
        const max = Number(await this.settings.get('max_dispute_evidence_files'));
        if (fileIds.length > max) throw AppException.of('DISPUTE_EVIDENCE_LIMIT', { max });
      }

      // Dispute chat: client + provider + Eventor support.
      const conversations = em.getRepository(Conversation);
      const conversation = await conversations.save(conversations.create({ kind: ConversationKind.Dispute, bookingId: booking.id, serviceId: booking.serviceId, status: ConversationStatus.Open }));
      const parties: any[] = await em.query('SELECT id, status, deleted_at FROM users WHERE id IN (?)', [[booking.clientId, booking.providerId]]);
      for (const [userId, role] of [
        [booking.clientId, ParticipantRole.Client],
        [booking.providerId, ParticipantRole.Provider],
      ] as const) {
        const user = parties.find((p) => p.id === userId);
        const canWrite = user && user.status !== UserStatus.Blocked && !user.deleted_at ? 1 : 0;
        await em.query('INSERT INTO conversation_participants (id, created_at, conversation_id, user_id, role, can_write, last_read_at) VALUES (UUID(), ?, ?, ?, ?, ?, NULL)', [
          now,
          conversation.id,
          userId,
          role,
          canWrite,
        ]);
      }
      await this.ensureSupport(em, conversation.id, auth.id);

      const repository = em.getRepository(Dispute);
      const dispute = await repository.save(
        repository.create({
          reference: await this.sequences.next('dispute', em),
          bookingId: booking.id,
          openedById,
          openedByRole: dto.openedByRole,
          againstUserId,
          type: dto.type,
          description: dto.description,
          status: DisputeStatus.Open,
          assignedAdminId: null,
          conversationId: conversation.id,
        }),
      );
      await conversations.update(conversation.id, { disputeId: dispute.id });
      await em.getRepository(Booking).update(booking.id, { disputeStatus: BookingDisputeStatus.Open });

      const evidence = em.getRepository(DisputeEvidence);
      const [direct] = await em.query(
        "SELECT c.id, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messages FROM conversations c WHERE c.booking_id = ? AND c.kind = 'direct' AND c.deleted_at IS NULL ORDER BY c.created_at LIMIT 1",
        [booking.id],
      );
      if (direct) {
        await evidence.save(
          evidence.create({ disputeId: dispute.id, uploadedById: openedById, fileId: null, kind: DisputeEvidenceKind.ChatSnapshot, note: `conversation:${direct.id} (${Number(direct.messages)} messages until ${now.toISOString()})`, createdAt: now }),
        );
      }
      for (const fileId of fileIds) {
        await evidence.save(evidence.create({ disputeId: dispute.id, uploadedById: openedById, fileId, kind: DisputeEvidenceKind.File, note: null, createdAt: now }));
      }

      await this.messaging.insertMessage(em, afterCommit, {
        conversationId: conversation.id,
        senderId: null,
        kind: MessageKind.System,
        body: `Dispute ${dispute.reference} opened for booking ${booking.reference} by the ${dto.openedByRole} (${dto.type.replace(/_/g, ' ')}). Eventor support will review it with you here.`,
        createdAt: now,
      });
      await this.event(em, dispute.id, auth.id, 'opened', {
        onBehalfOf: dto.openedByRole,
        type: dto.type,
        ignoreWindow: dto.ignoreWindow === true && !window.open,
        note: dto.note ?? null,
        evidenceFiles: fileIds.length,
        chatSnapshot: direct ? direct.id : null,
      });
      await this.audit.log(
        {
          action: 'dispute.opened',
          objectType: 'dispute',
          objectId: dispute.id,
          objectLabel: dispute.reference,
          level: AuditLevel.Sensitive,
          changes: { bookingId: booking.id, bookingReference: booking.reference, openedByRole: dto.openedByRole, type: dto.type, windowOverridden: dto.ignoreWindow === true && !window.open, conversationId: conversation.id },
          note: dto.note ?? null,
        },
        em,
      );
      this.events.emitAfterCommit<ConversationUpdatedEvent>(afterCommit, MESSAGING_EVENTS.conversationUpdated, { conversationId: conversation.id, reason: 'created' });
      this.events.emitAfterCommit<DisputeOpenedEvent>(afterCommit, DISPUTE_EVENTS.opened, { ...this.base(dispute, booking, auth.id), type: dto.type });
      return dispute.id;
    }
  }

  // ── assign ──────────────────────────────────────────────────

  async assign(auth: AuthUser, id: string, dto: AssignDisputeDto): Promise<DisputeDetailDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const dispute = await this.load(em, id, true);
      this.assertActive(dispute);
      const adminId = dto.adminId ?? auth.id;
      const [admin] = await em.query("SELECT id, full_name FROM users WHERE id = ? AND role = 'admin' AND status = 'active' AND deleted_at IS NULL", [adminId]);
      if (!admin) throw AppException.of('ADMIN_NOT_FOUND');
      const from = { status: dispute.status, assignedAdminId: dispute.assignedAdminId };
      await em.getRepository(Dispute).update(id, { assignedAdminId: adminId, status: DisputeStatus.InReview });
      await this.ensureSupport(em, dispute.conversationId, adminId);
      await this.event(em, id, auth.id, 'assigned', { adminId, adminName: admin.full_name, previousAdminId: from.assignedAdminId });
      await this.audit.log(
        {
          action: 'dispute.assigned',
          objectType: 'dispute',
          objectId: id,
          objectLabel: dispute.reference,
          level: AuditLevel.Normal,
          changes: { status: { from: from.status, to: DisputeStatus.InReview }, assignedAdminId: { from: from.assignedAdminId, to: adminId } },
        },
        em,
      );
      const booking = await this.loadBooking(em, dispute.bookingId, false);
      this.events.emitAfterCommit<DisputeEvent>(afterCommit, DISPUTE_EVENTS.assigned, this.base(dispute, booking, auth.id));
    });
    return this.get(id);
  }

  // ── evidence ────────────────────────────────────────────────

  async addEvidence(auth: AuthUser, id: string, dto: AddEvidenceDto, upload: { buffer: Buffer; originalName: string } | undefined): Promise<DisputeDetailDto> {
    if (!upload) throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'file', code: 'REQUIRED', message: 'file is required' }]);
    if (upload.buffer.length > DISPUTE_EVIDENCE_MAX_MB * 1024 * 1024) throw new AppException(413, 'FILE_TOO_LARGE', { maxMb: DISPUTE_EVIDENCE_MAX_MB });
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const dispute = await this.load(em, id, true);
      this.assertActive(dispute);
      const booking = await this.loadBooking(em, dispute.bookingId, false);
      if (dto.partyUserId !== booking.clientId && dto.partyUserId !== booking.providerId) throw AppException.of('DISPUTE_PARTY_INVALID', { userId: dto.partyUserId });
      const max = Number(await this.settings.get('max_dispute_evidence_files'));
      if ((await this.partyEvidenceCount(em, id, dto.partyUserId)) >= max) throw AppException.of('DISPUTE_EVIDENCE_LIMIT', { max });
      const file = await this.files.store({ buffer: upload.buffer, originalName: upload.originalName, purpose: FilePurpose.Evidence, ownerId: dto.partyUserId }, { em, afterCommit });
      const repository = em.getRepository(DisputeEvidence);
      const row = await repository.save(
        repository.create({ disputeId: id, uploadedById: dto.partyUserId, fileId: file.id, kind: DisputeEvidenceKind.File, note: dto.note ?? null, createdAt: new Date() }),
      );
      await em.query('UPDATE disputes SET updated_at = ? WHERE id = ?', [new Date(), id]);
      await this.event(em, id, auth.id, 'evidence_added', { evidenceId: row.id, fileId: file.id, partyUserId: dto.partyUserId, name: file.originalName, onBehalf: true });
      await this.audit.log(
        {
          action: 'dispute.evidence_added',
          objectType: 'dispute',
          objectId: id,
          objectLabel: dispute.reference,
          level: AuditLevel.Normal,
          changes: { evidenceId: row.id, fileId: file.id, partyUserId: dto.partyUserId, mimeType: file.mimeType, sizeBytes: file.sizeBytes },
          note: dto.note ?? null,
        },
        em,
      );
      this.events.emitAfterCommit<DisputeEvent>(afterCommit, DISPUTE_EVENTS.evidenceAdded, this.base(dispute, booking, auth.id));
    });
    return this.get(id);
  }

  // ── chat ────────────────────────────────────────────────────

  private async postSupportMessage(auth: AuthUser, id: string, body: string, evidenceFrom: string | null): Promise<string> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const dispute = await this.load(em, id, true);
      const booking = await this.loadBooking(em, dispute.bookingId, false);
      if (evidenceFrom !== null) {
        this.assertActive(dispute);
        if (evidenceFrom !== booking.clientId && evidenceFrom !== booking.providerId) throw AppException.of('DISPUTE_PARTY_INVALID', { userId: evidenceFrom });
      }
      const [conversation] = await em.query('SELECT id, status FROM conversations WHERE id = ? FOR UPDATE', [dispute.conversationId]);
      if (!conversation || conversation.status === ConversationStatus.Closed) throw AppException.of('CONVERSATION_CLOSED');
      await this.ensureSupport(em, dispute.conversationId, auth.id);
      const messageId = await this.messaging.insertMessage(em, afterCommit, { conversationId: dispute.conversationId, senderId: auth.id, body });
      await em.query('UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', [new Date(), dispute.conversationId, auth.id]);
      await em.query('UPDATE disputes SET updated_at = ? WHERE id = ?', [new Date(), id]);
      await this.event(em, id, auth.id, evidenceFrom ? 'evidence_requested' : 'message_sent', { messageId, ...(evidenceFrom ? { fromUserId: evidenceFrom } : {}) });
      await this.audit.log(
        {
          action: evidenceFrom ? 'dispute.evidence_requested' : 'dispute.message_sent',
          objectType: 'dispute',
          objectId: id,
          objectLabel: dispute.reference,
          level: AuditLevel.Info,
          changes: { messageId, conversationId: dispute.conversationId, ...(evidenceFrom ? { fromUserId: evidenceFrom } : {}) },
        },
        em,
      );
      this.events.emitAfterCommit<ConversationUpdatedEvent>(afterCommit, MESSAGING_EVENTS.conversationUpdated, { conversationId: dispute.conversationId, reason: 'message' });
      this.events.emitAfterCommit<DisputeMessageEvent>(afterCommit, DISPUTE_EVENTS.messageSent, { ...this.base(dispute, booking, auth.id), messageId, evidenceRequestedFrom: evidenceFrom });
      return messageId;
    });
  }

  async sendMessage(auth: AuthUser, id: string, body: string) {
    return this.messaging.message(await this.postSupportMessage(auth, id, body, null));
  }

  async requestEvidence(auth: AuthUser, id: string, dto: RequestEvidenceDto): Promise<DisputeDetailDto> {
    await this.postSupportMessage(auth, id, dto.message, dto.fromUserId);
    return this.get(id);
  }

  // ── resolve / close ─────────────────────────────────────────

  async resolve(auth: AuthUser, id: string, dto: ResolveDisputeDto): Promise<DisputeDetailDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const dispute = await this.load(em, id, true);
      this.assertActive(dispute);
      const booking = await this.loadBooking(em, dispute.bookingId);
      const actions = outcomeActions(dto.bookingOutcome, booking.status);
      if (actions === null) throw AppException.of('BOOKING_INVALID_TRANSITION', { from: booking.status, to: dto.bookingOutcome });
      const bookingFrom = booking.status;
      // Unfreeze first: the booking status machine then runs as usual.
      await em.getRepository(Booking).update(booking.id, { disputeStatus: BookingDisputeStatus.Resolved });
      booking.disputeStatus = BookingDisputeStatus.Resolved;
      for (const action of actions) {
        await this.bookings.applyTransition(em, afterCommit, booking, action, {
          actorId: auth.id,
          reason: action === 'cancelled' ? 'dispute' : 'dispute_resolved',
          note: `Dispute ${dispute.reference}: ${dto.decisionNote}`.slice(0, 2000),
          notify: false,
          cancelledBy: PartyRole.Admin,
        });
      }
      const now = new Date();
      await em.getRepository(Dispute).update(id, {
        status: DisputeStatus.Resolved,
        bookingOutcome: dto.bookingOutcome,
        decisionNote: dto.decisionNote,
        resolvedById: auth.id,
        resolvedAt: now,
        assignedAdminId: dispute.assignedAdminId ?? auth.id,
      });
      await this.messaging.insertMessage(em, afterCommit, {
        conversationId: dispute.conversationId,
        senderId: null,
        kind: MessageKind.System,
        body: `Dispute ${dispute.reference} resolved (booking ${dto.bookingOutcome}). Decision: ${dto.decisionNote}`,
      });
      await this.event(em, id, auth.id, 'resolved', { bookingOutcome: dto.bookingOutcome, bookingStatus: { from: bookingFrom, to: booking.status }, decisionNote: dto.decisionNote });
      await this.audit.log(
        {
          action: 'dispute.resolved',
          objectType: 'dispute',
          objectId: id,
          objectLabel: dispute.reference,
          level: AuditLevel.Sensitive,
          changes: {
            status: { from: dispute.status, to: DisputeStatus.Resolved },
            bookingOutcome: dto.bookingOutcome,
            bookingStatus: { from: bookingFrom, to: booking.status },
            bookingDisputeStatus: { from: BookingDisputeStatus.Open, to: BookingDisputeStatus.Resolved },
          },
          note: dto.decisionNote,
        },
        em,
      );
      this.events.emitAfterCommit<DisputeResolvedEvent>(afterCommit, DISPUTE_EVENTS.resolved, { ...this.base(dispute, booking, auth.id), bookingOutcome: dto.bookingOutcome, decisionNote: dto.decisionNote });
    });
    return this.get(id);
  }

  async close(auth: AuthUser, id: string, dto: CloseDisputeDto): Promise<DisputeDetailDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const dispute = await this.load(em, id, true);
      this.assertActive(dispute);
      const booking = await this.loadBooking(em, dispute.bookingId);
      // A booking keeps `resolved` if an earlier dispute on it was resolved.
      const [earlier] = await em.query("SELECT id FROM disputes WHERE booking_id = ? AND id <> ? AND status = 'resolved' AND deleted_at IS NULL LIMIT 1", [booking.id, id]);
      const bookingDisputeStatus = earlier ? BookingDisputeStatus.Resolved : BookingDisputeStatus.None;
      await em.getRepository(Booking).update(booking.id, { disputeStatus: bookingDisputeStatus });
      await em.getRepository(Dispute).update(id, { status: DisputeStatus.Closed, decisionNote: dto.note, resolvedById: auth.id, resolvedAt: new Date() });
      await this.messaging.insertMessage(em, afterCommit, {
        conversationId: dispute.conversationId,
        senderId: null,
        kind: MessageKind.System,
        body: `Dispute ${dispute.reference} closed without action. The booking continues normally.`,
      });
      await this.event(em, id, auth.id, 'closed', { note: dto.note, bookingDisputeStatus });
      await this.audit.log(
        {
          action: 'dispute.closed',
          objectType: 'dispute',
          objectId: id,
          objectLabel: dispute.reference,
          level: AuditLevel.Normal,
          changes: { status: { from: dispute.status, to: DisputeStatus.Closed }, bookingDisputeStatus: { from: booking.disputeStatus, to: bookingDisputeStatus } },
          note: dto.note,
        },
        em,
      );
      this.events.emitAfterCommit<DisputeClosedEvent>(afterCommit, DISPUTE_EVENTS.closed, { ...this.base(dispute, booking, auth.id), note: dto.note });
    });
    return this.get(id);
  }

  // ── job ─────────────────────────────────────────────────────

  /** Closes the dispute chat 7 days after the dispute was resolved or closed. Idempotent. */
  async closeStaleConversations(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - DISPUTE_CONVERSATION_CLOSE_DAYS * 86_400_000);
    const due: { id: string }[] = await this.dataSource.query(
      `SELECT d.id FROM disputes d JOIN conversations c ON c.id = d.conversation_id
       WHERE d.status IN ('resolved', 'closed') AND c.status = 'open' AND COALESCE(d.resolved_at, d.updated_at) <= ? AND d.deleted_at IS NULL LIMIT 500`,
      [cutoff],
    );
    let closed = 0;
    for (const { id } of due) {
      await runInTransaction(this.dataSource, async (em, afterCommit) => {
        const dispute = await this.load(em, id, true);
        if (isActive(dispute.status)) return;
        const since = dispute.resolvedAt ?? dispute.updatedAt;
        if (since > cutoff) return;
        const [conversation] = await em.query('SELECT id, status FROM conversations WHERE id = ? FOR UPDATE', [dispute.conversationId]);
        if (!conversation || conversation.status !== ConversationStatus.Open) return;
        await em.query("UPDATE conversation_participants SET can_write = 0 WHERE conversation_id = ? AND role <> 'support'", [conversation.id]);
        await em.getRepository(Conversation).update(conversation.id, { status: ConversationStatus.Closed, closedScope: ConversationClosedScope.All, closedReason: `dispute_${dispute.status}`, closedById: null, closedAt: now });
        await this.event(em, id, null, 'conversation_closed', { conversationId: conversation.id, afterDays: DISPUTE_CONVERSATION_CLOSE_DAYS });
        await this.audit.log(
          {
            action: 'conversation.closed',
            objectType: 'conversation',
            objectId: conversation.id,
            objectLabel: dispute.reference,
            level: AuditLevel.Info,
            actorId: null,
            actorRole: null,
            source: AuditSource.System,
            changes: { status: { from: 'open', to: 'closed' }, disputeId: id, reason: `dispute_${dispute.status}` },
          },
          em,
        );
        this.events.emitAfterCommit<ConversationUpdatedEvent>(afterCommit, MESSAGING_EVENTS.conversationUpdated, { conversationId: conversation.id, reason: 'closed' });
        closed += 1;
      });
    }
    if (closed > 0) this.logger.log(`Closed ${closed} dispute conversation(s)`);
    return closed;
  }
}

