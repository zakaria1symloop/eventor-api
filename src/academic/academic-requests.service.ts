import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { VerificationCode } from '../auth/entities/verification-code.entity.js';
import { createKeyedToken } from '../auth/refresh-token.js';
import { BookingsService, algiersToday, dateOnly } from '../bookings/bookings.service.js';
import { Booking } from '../bookings/entities/booking.entity.js';
import { likeContains } from '../common/dto/transforms.js';
import { AcademicRequestStatus as S } from '../common/enums/academic.enums.js';
import { AuditLevel, AuditSource } from '../common/enums/admin.enums.js';
import { VerificationCodePurpose } from '../common/enums/auth.enums.js';
import { BookingStatus } from '../common/enums/booking.enums.js';
import { EventType } from '../common/enums/catalog.enums.js';
import { Language, PartyRole, UserRole, UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import type { Lang } from '../common/i18n/language.js';
import { paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { JOBS } from '../queue/jobs.js';
import { QueueService } from '../queue/queue.service.js';
import { User } from '../users/entities/user.entity.js';
import { USER_EVENTS, type UserInvitedEvent } from '../users/users.events.js';
import { ACADEMIC_EVENTS, type RequestBookedEvent, type RequestChangesRequestedEvent, type RequestDecisionEvent, type RequestEventBase } from './academic.events.js';
import { allowedRequestActions, canDo, EDIT_LINK_TTL_DAYS, isDueForCompletion, type RequestAction } from './academic.policy.js';
import {
  ACADEMIC_REQUEST_SORT_FIELDS,
  type AcademicRequestDetailDto,
  type AcademicRequestFiltersDto,
  type AcademicRequestRowDto,
  type AcademicRequestsQueryDto,
  type AcademicRequestTabCountsDto,
  type ApproveRequestDto,
  type BookProposalDto,
  type RenderedAnswerDto,
  type RequestBookingRefDto,
  type RequestChangesDto,
} from './dto/academic-requests.dto.js';
import { AcademicRequestProposal } from './entities/academic-request-proposal.entity.js';
import { AcademicRequest } from './entities/academic-request.entity.js';
import type { FormField, FormSchema } from './entities/form-version.entity.js';
import type { RequestedChangesState } from './public-forms.service.js';

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);
const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;
/** Same as UsersService invitations. */
const INVITATION_TOKEN_TTL_DAYS = 7;
const REFERENCE = /^#?ACR-\d{1,8}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SORT_COLUMNS: Record<(typeof ACADEMIC_REQUEST_SORT_FIELDS)[number], string> = {
  submittedAt: 'ar.submitted_at',
  eventDate: 'ar.event_date',
  reference: 'ar.reference',
};

const FROM = `FROM academic_requests ar
  JOIN forms f ON f.id = ar.form_id
  JOIN form_versions fv ON fv.id = ar.form_version_id
  LEFT JOIN wilayas w ON w.code = ar.wilaya_code
  LEFT JOIN users aa ON aa.id = ar.assigned_admin_id`;

const person = (id: string | null, name: string | null) => (id ? { id, fullName: name ?? 'Deleted user' } : null);

/** ACR-01…ACR-04: academic requests, proposals, bookings from proposals and the completion job. */
@Injectable()
export class AcademicRequestsService implements OnModuleInit {
  private readonly logger = new Logger(AcademicRequestsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly files: FilesService,
    private readonly bookings: BookingsService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit(): void {
    this.queue.registerHandler(JOBS.academicRequestsComplete, async () => void (await this.completeDue()));
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'academic-requests.complete' })
  async scheduleCompletion(): Promise<void> {
    await this.queue.add(JOBS.academicRequestsComplete, {}, { jobId: `academic-complete-${new Date().toISOString().slice(0, 13)}` });
  }

  // ── list ────────────────────────────────────────────────────

  private where(filters: AcademicRequestFiltersDto, adminId: string | null, tab: boolean): { sql: string; params: unknown[] } {
    const clauses = ['ar.deleted_at IS NULL'];
    const params: unknown[] = [];
    const add = (sql: string, ...values: unknown[]) => {
      clauses.push(sql);
      params.push(...values);
    };
    if (tab && filters.tab && filters.tab !== 'all') add('ar.status = ?', filters.tab);
    if (filters.formId) add('ar.form_id = ?', filters.formId);
    if (filters.wilaya?.length) add('ar.wilaya_code IN (?)', filters.wilaya);
    if (filters.eventDateFrom) add('ar.event_date >= ?', filters.eventDateFrom);
    if (filters.eventDateTo) add('ar.event_date <= ?', filters.eventDateTo);
    if (filters.assignedAdminId === 'unassigned') add('ar.assigned_admin_id IS NULL');
    else if (filters.assignedAdminId === 'me') add('ar.assigned_admin_id = ?', adminId);
    else if (filters.assignedAdminId) add('ar.assigned_admin_id = ?', filters.assignedAdminId);
    if (filters.q) {
      if (REFERENCE.test(filters.q)) add('ar.reference = ?', filters.q.replace(/^#/, '').toUpperCase());
      else {
        const like = likeContains(filters.q);
        add('(ar.requester_name LIKE ? OR ar.requester_email LIKE ? OR ar.institution_name LIKE ? OR ar.title LIKE ?)', like, like, like, like);
      }
    }
    return { sql: clauses.join(' AND '), params };
  }

  async count(filters: AcademicRequestFiltersDto, adminId: string | null = null): Promise<number> {
    const where = this.where(filters, adminId, true);
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n ${FROM} WHERE ${where.sql}`, where.params);
    return Number(n);
  }

  async fetchRows(filters: AcademicRequestFiltersDto, sort: string | undefined, page: { offset: number; limit: number }, adminId: string | null = null): Promise<AcademicRequestRowDto[]> {
    const [field, direction] = Object.entries(toOrder(sort, ACADEMIC_REQUEST_SORT_FIELDS, ['submittedAt', 'DESC']))[0]! as [(typeof ACADEMIC_REQUEST_SORT_FIELDS)[number], 'ASC' | 'DESC'];
    const where = this.where(filters, adminId, true);
    const rows: any[] = await this.dataSource.query(
      `SELECT ar.*, f.name_en AS form_name_en, f.name_ar AS form_name_ar, f.slug AS form_slug, fv.version, w.name AS wilaya_name, w.name_ar AS wilaya_name_ar, aa.full_name AS assigned_name,
              (SELECT COUNT(*) FROM academic_request_proposals p WHERE p.request_id = ar.id AND p.deleted_at IS NULL) AS proposals_count,
              (SELECT COUNT(*) FROM bookings b WHERE b.academic_request_id = ar.id AND b.deleted_at IS NULL) AS bookings_count
       ${FROM} WHERE ${where.sql} ORDER BY ${SORT_COLUMNS[field]} ${direction}, ar.id ASC LIMIT ? OFFSET ?`,
      [...where.params, page.limit, page.offset],
    );
    return rows.map((r) => this.toRow(r));
  }

  private toRow(r: any): AcademicRequestRowDto {
    return {
      id: r.id,
      reference: r.reference,
      title: r.title,
      institutionName: r.institution_name,
      requester: { name: r.requester_name, email: r.requester_email, phone: r.requester_phone, userId: r.requester_id },
      eventType: r.event_type,
      eventDate: r.event_date ? dateOnly(r.event_date) : null,
      wilaya: r.wilaya_code ? { code: Number(r.wilaya_code), name: r.wilaya_name ?? '', nameAr: r.wilaya_name_ar ?? '' } : null,
      attendees: r.attendees === null ? null : Number(r.attendees),
      budgetMin: r.budget_min === null ? null : String(r.budget_min),
      budgetMax: r.budget_max === null ? null : String(r.budget_max),
      form: { id: r.form_id, nameEn: r.form_name_en, nameAr: r.form_name_ar, slug: r.form_slug, versionId: r.form_version_id, version: Number(r.version) },
      status: r.status,
      assignedAdmin: person(r.assigned_admin_id, r.assigned_name),
      proposalsCount: Number(r.proposals_count ?? 0),
      bookingsCount: Number(r.bookings_count ?? 0),
      submittedAt: iso(r.submitted_at)!,
    };
  }

  async list(auth: AuthUser, query: AcademicRequestsQueryDto): Promise<Paginated<AcademicRequestRowDto, AcademicRequestTabCountsDto>> {
    const where = this.where(query, auth.id, false);
    const [rows, total, [c]] = await Promise.all([
      this.fetchRows(query, query.sort, { offset: (query.page - 1) * query.limit, limit: query.limit }, auth.id),
      this.count(query, auth.id),
      this.dataSource.query(
        `SELECT COUNT(*) AS all_n, ${Object.values(S)
          .map((s) => `COALESCE(SUM(ar.status = '${s}'), 0) AS ${s}`)
          .join(', ')} ${FROM} WHERE ${where.sql}`,
        where.params,
      ),
    ]);
    const n = (v: unknown) => Number(v ?? 0);
    return paginateWithCounts(rows, total, query, {
      all: n(c.all_n),
      pending: n(c.pending),
      changes_requested: n(c.changes_requested),
      approved: n(c.approved),
      in_progress: n(c.in_progress),
      rejected: n(c.rejected),
      completed: n(c.completed),
      cancelled: n(c.cancelled),
    });
  }

  // ── detail ──────────────────────────────────────────────────

  async resolveId(idOrReference: string): Promise<string> {
    const isUuid = UUID.test(idOrReference);
    if (!isUuid && !REFERENCE.test(idOrReference)) throw AppException.of('ACADEMIC_REQUEST_NOT_FOUND');
    const [row] = await this.dataSource.query(`SELECT id FROM academic_requests WHERE ${isUuid ? 'id' : 'reference'} = ? AND deleted_at IS NULL`, [
      isUuid ? idOrReference : idOrReference.replace(/^#/, '').toUpperCase(),
    ]);
    if (!row) throw AppException.of('ACADEMIC_REQUEST_NOT_FOUND');
    return row.id;
  }

  async get(id: string, em: EntityManager = this.dataSource.manager): Promise<AcademicRequestDetailDto> {
    const [r] = await em.query(
      `SELECT ar.*, f.name_en AS form_name_en, f.name_ar AS form_name_ar, f.slug AS form_slug, fv.version, fv.schema, w.name AS wilaya_name, w.name_ar AS wilaya_name_ar,
              aa.full_name AS assigned_name, db.full_name AS decided_by_name
       ${FROM} LEFT JOIN users db ON db.id = ar.decided_by_id WHERE ar.id = ? AND ar.deleted_at IS NULL`,
      [id],
    );
    if (!r) throw AppException.of('ACADEMIC_REQUEST_NOT_FOUND');
    const [attachments, needs, proposals, bookings, timeline, wilayas, categories] = await Promise.all([
      em.query(
        'SELECT a.id, a.field_key, a.file_id, f.original_name, f.mime_type, f.size_bytes FROM academic_request_attachments a JOIN files f ON f.id = a.file_id WHERE a.request_id = ? ORDER BY a.created_at',
        [id],
      ),
      em.query('SELECT n.note, c.id, c.name_en, c.name_ar FROM academic_request_needs n JOIN categories c ON c.id = n.category_id WHERE n.request_id = ? ORDER BY n.created_at', [id]),
      em.query(
        `SELECT p.id, p.note, p.created_at, p.proposed_by_id, pu.full_name AS proposed_by_name, p.booking_id,
                s.id AS service_id, s.title_en, s.title_ar, s.base_price, s.price_type, s.status AS service_status, s.provider_id, u.full_name AS provider_name, pp.business_name,
                c.id AS category_id, c.name_en AS category_en, c.name_ar AS category_ar
         FROM academic_request_proposals p JOIN services s ON s.id = p.service_id JOIN users u ON u.id = s.provider_id
         LEFT JOIN provider_profiles pp ON pp.user_id = s.provider_id AND pp.deleted_at IS NULL JOIN categories c ON c.id = s.category_id LEFT JOIN users pu ON pu.id = p.proposed_by_id
         WHERE p.request_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at`,
        [id],
      ),
      em.query(
        `SELECT b.id, b.reference, b.status, b.event_date, b.total, b.provider_id, u.full_name AS provider_name, COALESCE(s.title_en, pk.name_en) AS title_en
         FROM bookings b JOIN users u ON u.id = b.provider_id LEFT JOIN services s ON s.id = b.service_id LEFT JOIN packs pk ON pk.id = b.pack_id
         WHERE b.academic_request_id = ? AND b.deleted_at IS NULL ORDER BY b.created_at`,
        [id],
      ),
      em.query(
        `SELECT a.id, a.action, a.actor_id, u.full_name, a.changes, a.note, a.created_at FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.object_type = 'academic_request' AND a.object_id = ? ORDER BY a.created_at, a.id LIMIT 100`,
        [id],
      ),
      em.query('SELECT code, name FROM wilayas'),
      em.query('SELECT id, name_en FROM categories'),
    ]);

    const schema = json<FormSchema>(r.schema);
    const answers = json<Record<string, unknown>>(r.answers);
    const state = r.requested_changes ? json<RequestedChangesState>(r.requested_changes) : null;
    const changedFields = state?.changedFields ?? [];
    const wilayaNames = new Map<number, string>(wilayas.map((w: any) => [Number(w.code), w.name]));
    const categoryNames = new Map<string, string>(categories.map((c: any) => [c.id, c.name_en]));
    const fileNames = new Map<string, string>(attachments.map((a: any) => [a.file_id, a.original_name]));
    const bookingDto = (b: any): RequestBookingRefDto => ({
      id: b.id,
      reference: b.reference,
      status: b.status,
      eventDate: dateOnly(b.event_date),
      total: String(b.total),
      titleEn: b.title_en ?? null,
      provider: { id: b.provider_id, fullName: b.provider_name },
    });
    const bookingById = new Map<string, any>(bookings.map((b: any) => [b.id, b]));
    const [requestedBy] = state?.requestedById ? await em.query('SELECT full_name FROM users WHERE id = ?', [state.requestedById]) : [];
    const status = r.status as S;

    return {
      ...this.toRow({ ...r, proposals_count: proposals.length, bookings_count: bookings.length }),
      answers: schema.fields
        .filter((field) => field.type !== 'section' && field.type !== 'info')
        .map((field): RenderedAnswerDto => ({
          key: field.key,
          type: field.type,
          labelEn: field.label_en,
          labelAr: field.label_ar,
          section: field.section ?? null,
          value: answers[field.key] ?? null,
          displayValue: displayValue(field, answers[field.key], { wilayaNames, categoryNames, fileNames }),
          changed: changedFields.includes(field.key),
        })),
      attachments: attachments.map((a: any) => ({
        id: a.id,
        fileId: a.file_id,
        fieldKey: a.field_key,
        fileName: a.original_name,
        mimeType: a.mime_type,
        sizeBytes: Number(a.size_bytes),
        url: this.files.signedUrl(a.file_id),
      })),
      needs: needs.map((n: any) => ({ category: { id: n.id, nameEn: n.name_en, nameAr: n.name_ar }, note: n.note })),
      proposals: proposals.map((p: any) => ({
        id: p.id,
        service: {
          id: p.service_id,
          titleEn: p.title_en,
          titleAr: p.title_ar,
          basePrice: String(p.base_price),
          priceType: p.price_type,
          status: p.service_status,
          provider: { id: p.provider_id, fullName: p.provider_name },
          businessName: p.business_name ?? null,
          category: { id: p.category_id, nameEn: p.category_en, nameAr: p.category_ar },
        },
        note: p.note,
        proposedBy: person(p.proposed_by_id, p.proposed_by_name),
        booking: p.booking_id && bookingById.has(p.booking_id) ? bookingDto(bookingById.get(p.booking_id)) : null,
        createdAt: iso(p.created_at)!,
      })),
      bookings: bookings.map(bookingDto),
      requestedChanges: state
        ? {
            fields: state.fields,
            message: state.message,
            requestedAt: state.requestedAt,
            requestedBy: person(state.requestedById, requestedBy?.full_name ?? null),
            linkExpiresAt: state.tokenHash ? state.tokenExpiresAt : null,
            resubmittedAt: state.resubmittedAt,
          }
        : null,
      changedFields,
      decisionMessage: r.decision_message,
      rejectReason: r.reject_reason,
      decidedBy: person(r.decided_by_id, r.decided_by_name),
      decidedAt: iso(r.decided_at),
      allowedActions: allowedRequestActions(status),
      timeline: timeline.map((t: any) => ({
        id: t.id,
        action: t.action,
        actor: person(t.actor_id, t.full_name),
        changes: t.changes ? json(t.changes) : null,
        note: t.note,
        createdAt: iso(t.created_at)!,
      })),
      updatedAt: iso(r.updated_at)!,
    };
  }

  // ── helpers ─────────────────────────────────────────────────

  private async load(em: EntityManager, id: string): Promise<AcademicRequest> {
    const request = await em.getRepository(AcademicRequest).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!request) throw AppException.of('ACADEMIC_REQUEST_NOT_FOUND');
    return request;
  }

  private assert(request: AcademicRequest, action: RequestAction): void {
    if (!canDo(request.status, action)) throw AppException.of('ACADEMIC_REQUEST_INVALID_TRANSITION', { status: request.status, action });
  }

  /** Language for requester emails: the linked account, else the Accept-Language recorded at submission. */
  private async requesterLang(em: EntityManager, request: AcademicRequest): Promise<Lang> {
    if (request.requesterId) {
      const [user] = await em.query('SELECT language FROM users WHERE id = ?', [request.requesterId]);
      if (user?.language === 'ar' || user?.language === 'en') return user.language;
    }
    const [row] = await em.query(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(changes, '$.lang')) AS lang FROM audit_logs WHERE object_type = 'academic_request' AND object_id = ? AND action = 'academic_request.submitted' LIMIT 1",
      [request.id],
    );
    return row?.lang === 'ar' ? 'ar' : 'en';
  }

  private async eventBase(em: EntityManager, request: AcademicRequest): Promise<RequestEventBase> {
    const [form] = await em.query('SELECT slug FROM forms WHERE id = ?', [request.formId]);
    return {
      requestId: request.id,
      reference: request.reference,
      title: request.title,
      formSlug: form?.slug ?? '',
      requester: { name: request.requesterName, email: request.requesterEmail, userId: request.requesterId },
      lang: await this.requesterLang(em, request),
    };
  }

  private log(em: EntityManager, request: AcademicRequest, action: string, changes: Record<string, unknown>, note: string | null = null, level = AuditLevel.Normal) {
    return this.audit.log({ action, objectType: 'academic_request', objectId: request.id, objectLabel: `${request.reference} ${request.title}`, level, changes, note }, em);
  }

  // ── actions ─────────────────────────────────────────────────

  async assign(auth: AuthUser, id: string, adminId: string | undefined): Promise<AcademicRequestDetailDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const request = await this.load(em, id);
      this.assert(request, 'assign');
      const targetId = adminId ?? auth.id;
      const [admin] = await em.query("SELECT id, full_name FROM users WHERE id = ? AND role = 'admin' AND status = 'active' AND deleted_at IS NULL", [targetId]);
      if (!admin) throw AppException.of('ADMIN_NOT_FOUND');
      await em.getRepository(AcademicRequest).update(id, { assignedAdminId: targetId });
      await this.log(em, request, 'academic_request.assigned', { assignedAdminId: { from: request.assignedAdminId, to: targetId } }, null, AuditLevel.Info);
      return this.get(id, em);
    });
  }

  async requestChanges(auth: AuthUser, id: string, dto: RequestChangesDto): Promise<AcademicRequestDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const request = await this.load(em, id);
      this.assert(request, 'request_changes');
      const [version] = await em.query('SELECT `schema` FROM form_versions WHERE id = ?', [request.formVersionId]);
      const schema = json<FormSchema>(version.schema);
      const unknown = dto.fields.filter((key) => !schema.fields.some((f) => f.key === key && f.type !== 'section' && f.type !== 'info'));
      if (unknown.length > 0) throw AppException.of('ACADEMIC_REQUEST_FIELDS_INVALID', { fields: unknown });
      const { token, hash } = createKeyedToken(request.id);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + EDIT_LINK_TTL_DAYS * 86_400_000);
      const state: RequestedChangesState = {
        fields: dto.fields,
        message: dto.message,
        requestedAt: now.toISOString(),
        requestedById: auth.id,
        tokenHash: hash,
        tokenExpiresAt: expiresAt.toISOString(),
        previousAnswers: request.answers,
        resubmittedAt: null,
        changedFields: [],
      };
      await em.getRepository(AcademicRequest).update(id, { status: S.ChangesRequested, requestedChanges: state as never, decisionMessage: dto.message });
      await this.log(em, request, 'academic_request.changes_requested', { status: { from: request.status, to: S.ChangesRequested }, fields: dto.fields }, dto.message);
      this.events.emitAfterCommit<RequestChangesRequestedEvent>(afterCommit, ACADEMIC_EVENTS.changesRequested, {
        ...(await this.eventBase(em, request)),
        fields: dto.fields,
        message: dto.message,
        token,
        expiresAt: expiresAt.toISOString(),
      });
      return this.get(id, em);
    });
  }

  private async insertProposal(em: EntityManager, auth: AuthUser, request: AcademicRequest, serviceId: string, note: string | null): Promise<{ id: string; title: string }> {
    const [service] = await em.query('SELECT id, title_en FROM services WHERE id = ? AND deleted_at IS NULL', [serviceId]);
    if (!service) throw AppException.of('SERVICE_NOT_FOUND', { serviceId });
    const [existing] = await em.query('SELECT id FROM academic_request_proposals WHERE request_id = ? AND service_id = ?', [request.id, serviceId]);
    if (existing) throw AppException.of('PROPOSAL_EXISTS', { serviceId });
    const repository = em.getRepository(AcademicRequestProposal);
    const proposal = await repository.save(repository.create({ requestId: request.id, serviceId, proposedById: auth.id, note, bookingId: null }));
    return { id: proposal.id, title: service.title_en };
  }

  async approve(auth: AuthUser, id: string, dto: ApproveRequestDto): Promise<AcademicRequestDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const request = await this.load(em, id);
      this.assert(request, 'approve');
      const added: string[] = [];
      for (const serviceId of dto.serviceIds ?? []) added.push((await this.insertProposal(em, auth, request, serviceId, null)).title);
      const now = new Date();
      await em.getRepository(AcademicRequest).update(id, { status: S.Approved, decisionMessage: dto.message ?? null, decidedById: auth.id, decidedAt: now, rejectReason: null });
      await this.log(em, request, 'academic_request.approved', { status: { from: request.status, to: S.Approved }, proposedServiceIds: dto.serviceIds ?? [] }, dto.message ?? null);
      const [{ titles }] = await em.query(
        'SELECT GROUP_CONCAT(s.title_en ORDER BY p.created_at SEPARATOR \'\\n\') AS titles FROM academic_request_proposals p JOIN services s ON s.id = p.service_id WHERE p.request_id = ?',
        [id],
      );
      this.events.emitAfterCommit<RequestDecisionEvent>(afterCommit, ACADEMIC_EVENTS.approved, {
        ...(await this.eventBase(em, request)),
        message: dto.message ?? null,
        reason: null,
        proposals: titles ? String(titles).split('\n') : added,
        providerIds: [],
      });
      return this.get(id, em);
    });
  }

  async reject(auth: AuthUser, id: string, reason: string, message: string): Promise<AcademicRequestDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const request = await this.load(em, id);
      this.assert(request, 'reject');
      await em.getRepository(AcademicRequest).update(id, { status: S.Rejected, rejectReason: reason, decisionMessage: message, decidedById: auth.id, decidedAt: new Date() });
      await this.log(em, request, 'academic_request.rejected', { status: { from: request.status, to: S.Rejected }, reason }, message, AuditLevel.Sensitive);
      this.events.emitAfterCommit<RequestDecisionEvent>(afterCommit, ACADEMIC_EVENTS.rejected, { ...(await this.eventBase(em, request)), message, reason, proposals: [], providerIds: [] });
      return this.get(id, em);
    });
  }

  async cancel(auth: AuthUser, id: string, reason: string): Promise<AcademicRequestDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const request = await this.load(em, id);
      this.assert(request, 'cancel');
      const pending: { id: string }[] = await em.query("SELECT id FROM bookings WHERE academic_request_id = ? AND status = 'pending' AND deleted_at IS NULL ORDER BY created_at FOR UPDATE", [id]);
      const providerIds: string[] = [];
      for (const { id: bookingId } of pending) {
        const booking = await em.getRepository(Booking).findOneOrFail({ where: { id: bookingId }, lock: { mode: 'pessimistic_write' } });
        await this.bookings.applyTransition(em, afterCommit, booking, 'cancelled', { actorId: auth.id, reason: 'academic_request_cancelled', note: reason, notify: true, cancelledBy: PartyRole.Admin });
        providerIds.push(booking.providerId);
      }
      await em.getRepository(AcademicRequest).update(id, { status: S.Cancelled, decidedById: auth.id, decidedAt: new Date(), rejectReason: reason });
      await this.log(em, request, 'academic_request.cancelled', { status: { from: request.status, to: S.Cancelled }, reason, cancelledBookings: pending.map((b) => b.id) }, reason, AuditLevel.Sensitive);
      this.events.emitAfterCommit<RequestDecisionEvent>(afterCommit, ACADEMIC_EVENTS.cancelled, { ...(await this.eventBase(em, request)), message: null, reason, proposals: [], providerIds: [...new Set(providerIds)] });
      return this.get(id, em);
    });
  }

  async addProposal(auth: AuthUser, id: string, serviceId: string, note: string | null): Promise<AcademicRequestDetailDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const request = await this.load(em, id);
      this.assert(request, 'propose');
      const proposal = await this.insertProposal(em, auth, request, serviceId, note);
      await this.log(em, request, 'academic_request.proposal_added', { proposalId: proposal.id, serviceId, service: proposal.title }, note, AuditLevel.Info);
      return this.get(id, em);
    });
  }

  async removeProposal(auth: AuthUser, id: string, proposalId: string): Promise<AcademicRequestDetailDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const request = await this.load(em, id);
      const [proposal] = await em.query('SELECT id, service_id, booking_id FROM academic_request_proposals WHERE id = ? AND request_id = ? FOR UPDATE', [proposalId, id]);
      if (!proposal) throw AppException.of('PROPOSAL_NOT_FOUND');
      if (proposal.booking_id) throw AppException.of('PROPOSAL_BOOKED', { bookingId: proposal.booking_id });
      // Hard delete: the (request, service) pair can be proposed again.
      await em.query('DELETE FROM academic_request_proposals WHERE id = ?', [proposalId]);
      await this.log(em, request, 'academic_request.proposal_removed', { proposalId, serviceId: proposal.service_id }, null, AuditLevel.Info);
      return this.get(id, em);
    });
  }

  /** Links or creates the requester's client account; new accounts get a set-password invitation. */
  private async ensureClient(em: EntityManager, afterCommit: AfterCommit, request: AcademicRequest, lang: Lang): Promise<{ id: string; created: boolean }> {
    const users = em.getRepository(User);
    const existing = await users.findOne({ where: { email: request.requesterEmail }, withDeleted: true });
    if (existing) {
      if (existing.role !== UserRole.Client || existing.deletedAt || existing.status !== UserStatus.Active) throw AppException.of('REQUESTER_NOT_CLIENT', { email: request.requesterEmail });
      return { id: existing.id, created: false };
    }
    const phone = request.requesterPhone && /^\+?\d{8,15}$/.test(request.requesterPhone) ? request.requesterPhone : null;
    const phoneTaken = phone ? await users.exists({ where: { phone }, withDeleted: true }) : false;
    const user = await users.save(
      users.create({
        role: UserRole.Client,
        status: UserStatus.Active,
        verificationStatus: VerificationStatus.NotRequired,
        fullName: request.requesterName,
        email: request.requesterEmail,
        emailVerifiedAt: new Date(),
        phone: phoneTaken ? null : phone,
        passwordHash: null,
        language: lang === 'ar' ? Language.Ar : Language.En,
        wilayaCode: request.wilayaCode,
      }),
    );
    const codes = em.getRepository(VerificationCode);
    const code = await codes.save(
      codes.create({
        userId: user.id,
        purpose: VerificationCodePurpose.PasswordReset,
        createdAt: new Date(),
        destination: user.email,
        codeHash: 'pending',
        expiresAt: new Date(Date.now() + INVITATION_TOKEN_TTL_DAYS * 86_400_000),
        consumedAt: null,
      }),
    );
    const { token, hash } = createKeyedToken(code.id);
    await codes.update(code.id, { codeHash: hash });
    await this.audit.log(
      {
        action: 'user.created',
        objectType: 'user',
        objectId: user.id,
        objectLabel: user.fullName,
        level: AuditLevel.Normal,
        changes: { role: { from: null, to: UserRole.Client }, email: { from: null, to: user.email }, academicRequestId: request.id },
        note: `Created from academic request ${request.reference}`,
      },
      em,
    );
    this.events.emitAfterCommit<UserInvitedEvent>(afterCommit, USER_EVENTS.invited, { userId: user.id, email: user.email, name: user.fullName, lang, token, days: INVITATION_TOKEN_TTL_DAYS });
    return { id: user.id, created: true };
  }

  async book(auth: AuthUser, id: string, proposalId: string, dto: BookProposalDto): Promise<AcademicRequestDetailDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const request = await this.load(em, id);
      const [proposal] = await em.query('SELECT id, service_id, booking_id FROM academic_request_proposals WHERE id = ? AND request_id = ? FOR UPDATE', [proposalId, id]);
      if (!proposal) throw AppException.of('PROPOSAL_NOT_FOUND');
      this.assert(request, 'book');
      if (proposal.booking_id) throw AppException.of('PROPOSAL_BOOKED', { bookingId: proposal.booking_id });
      const eventDate = dto.eventDate ?? (request.eventDate ? dateOnly(request.eventDate) : null);
      if (!eventDate) throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'eventDate', code: 'IS_DEFINED', message: 'eventDate is required: the request has no event date' }]);
      if (!request.wilayaCode) throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'wilayaCode', code: 'IS_DEFINED', message: 'The request has no wilaya' }]);

      const lang = await this.requesterLang(em, request);
      const client = await this.ensureClient(em, afterCommit, request, lang);
      const bookingId = await this.bookings.createInTransaction(em, afterCommit, auth, {
        clientId: client.id,
        serviceId: proposal.service_id,
        eventDate,
        startTime: dto.startTime,
        endTime: dto.endTime,
        eventType: request.eventType ?? EventType.Academic,
        wilayaCode: request.wilayaCode,
        guests: dto.guests ?? request.attendees ?? undefined,
        clientNote: dto.notes ?? `Academic request ${request.reference}: ${request.title}`,
        academicRequestId: request.id,
      } as never);
      await em.query('UPDATE academic_request_proposals SET booking_id = ?, updated_at = ? WHERE id = ?', [bookingId, new Date(), proposalId]);
      await em.getRepository(AcademicRequest).update(id, { status: S.InProgress, requesterId: client.id });
      await em.query("UPDATE files f JOIN academic_request_attachments a ON a.file_id = f.id SET f.owner_id = ? WHERE a.request_id = ? AND f.owner_id IS NULL", [client.id, id]);
      const [booking] = await em.query('SELECT reference, provider_id FROM bookings WHERE id = ?', [bookingId]);
      await this.log(em, request, 'academic_request.booked', {
        status: { from: request.status, to: S.InProgress },
        proposalId,
        bookingId,
        bookingReference: booking.reference,
        clientId: client.id,
        clientCreated: client.created,
      });
      this.events.emitAfterCommit<RequestBookedEvent>(afterCommit, ACADEMIC_EVENTS.booked, {
        ...(await this.eventBase(em, request)),
        lang,
        bookingId,
        bookingReference: booking.reference,
        providerId: booking.provider_id,
        clientCreated: client.created,
      });
      return this.get(id, em);
    });
  }

  // ── job ─────────────────────────────────────────────────────

  /** in_progress → completed when every linked booking is completed or cancelled and the event date has passed. Idempotent. */
  async completeDue(now = new Date()): Promise<number> {
    const today = algiersToday(now);
    const candidates: { id: string }[] = await this.dataSource.query(
      `SELECT ar.id FROM academic_requests ar WHERE ar.status = 'in_progress' AND ar.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM bookings b WHERE b.academic_request_id = ar.id AND b.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.academic_request_id = ar.id AND b.deleted_at IS NULL AND b.status NOT IN ('completed', 'cancelled'))
       ORDER BY ar.event_date LIMIT 500`,
    );
    let completed = 0;
    for (const { id } of candidates) {
      await runInTransaction(this.dataSource, async (em) => {
        const request = await em.getRepository(AcademicRequest).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!request) return;
        const bookings: { status: BookingStatus; event_date: string }[] = await em.query('SELECT status, event_date FROM bookings WHERE academic_request_id = ? AND deleted_at IS NULL', [id]);
        const input = { status: request.status, eventDate: request.eventDate ? dateOnly(request.eventDate) : null, bookings: bookings.map((b) => ({ status: b.status, eventDate: dateOnly(b.event_date) })) };
        if (!isDueForCompletion(input, today)) return;
        await em.getRepository(AcademicRequest).update(id, { status: S.Completed });
        await this.audit.log(
          {
            actorId: null,
            actorRole: null,
            source: AuditSource.System,
            action: 'academic_request.completed',
            objectType: 'academic_request',
            objectId: id,
            objectLabel: `${request.reference} ${request.title}`,
            level: AuditLevel.Info,
            changes: { status: { from: S.InProgress, to: S.Completed }, bookings: bookings.length },
          },
          em,
        );
        completed += 1;
      });
    }
    if (completed > 0) this.logger.log(`Completed ${completed} academic request(s)`);
    return completed;
  }
}

/** Human text for an answer (EN): option labels, wilaya and category names, file names, ranges. */
export function displayValue(
  field: FormField,
  value: unknown,
  names: { wilayaNames: Map<number, string>; categoryNames: Map<string, string>; fileNames: Map<string, string> },
): string | null {
  if (value === undefined || value === null || value === '') return null;
  const option = (v: unknown) => field.options?.find((o) => o.value === v)?.label_en ?? String(v);
  switch (field.type) {
    case 'single_choice':
    case 'dropdown':
      return option(value);
    case 'multi_choice':
      return Array.isArray(value) ? value.map(option).join(', ') : String(value);
    case 'wilaya':
      return `${value} ${names.wilayaNames.get(Number(value)) ?? ''}`.trim();
    case 'service_categories':
      return Array.isArray(value) ? value.map((id) => names.categoryNames.get(String(id)) ?? String(id)).join(', ') : String(value);
    case 'file':
      return Array.isArray(value) ? value.map((id) => names.fileNames.get(String(id)) ?? String(id)).join(', ') : String(value);
    case 'time_range': {
      const t = value as { start?: string; end?: string };
      return `${t.start ?? ''}–${t.end ?? ''}`;
    }
    case 'budget_range': {
      const b = value as { min?: number; max?: number };
      return `${b.min ?? ''}–${b.max ?? ''} DZD`;
    }
    case 'consent':
      return value === true ? 'Yes' : 'No';
    default:
      return String(value);
  }
}

