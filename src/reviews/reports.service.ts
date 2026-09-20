import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { addDays } from '../bookings/bookings.policy.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { ReportStatus, ReportTargetType } from '../common/enums/moderation.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { DisputesService } from '../disputes/disputes.service.js';
import { preview } from '../messaging/contact-masking.js';
import {
  REPORT_SORT_FIELDS,
  type ConvertReportDto,
  type DismissReportDto,
  type MessageReportsDismissedDto,
  type ReportFiltersDto,
  type ReportRowDto,
  type ReportsQueryDto,
  type ReportTabCountsDto,
  type ReportTargetDto,
  type ResolveReportDto,
} from './dto/reports.dto.js';
import { Report } from './entities/report.entity.js';
import { REVIEW_EVENTS, type ReportCreatedEvent, type ReportsClosedEvent } from './reviews.events.js';
import { CONVERTIBLE_TARGETS } from './reviews.policy.js';
import { closeOpenReports, insertReport, type InsertReportInput } from './reviews.writes.js';

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

const FROM = `FROM reports rp
  LEFT JOIN users ru ON ru.id = rp.reporter_id
  LEFT JOIN users rb ON rb.id = rp.resolved_by_id
  LEFT JOIN disputes d ON d.id = rp.dispute_id`;

/** STA / REV-02 / MSG-01: reports on reviews, replies, messages, services, packs and users (status-rules §9). */
@Injectable()
export class ReportsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly disputes: DisputesService,
  ) {}

  // ── list ────────────────────────────────────────────────────

  private where(filters: ReportFiltersDto, options: { tab: boolean }): { sql: string; params: unknown[] } {
    const clauses = ['rp.deleted_at IS NULL'];
    const params: unknown[] = [];
    const add = (sql: string, ...values: unknown[]) => {
      clauses.push(sql);
      params.push(...values);
    };
    const tab = filters.tab ?? 'open';
    if (options.tab && tab !== 'all') add('rp.status = ?', tab);
    if (filters.targetType?.length) add('rp.target_type IN (?)', filters.targetType);
    if (filters.reason?.length) add('rp.reason IN (?)', filters.reason);
    if (filters.createdFrom) add('rp.created_at >= ?', new Date(`${filters.createdFrom}T00:00:00Z`));
    if (filters.createdTo) add('rp.created_at < ?', new Date(`${addDays(filters.createdTo, 1)}T00:00:00Z`));
    return { sql: clauses.join(' AND '), params };
  }

  async count(filters: ReportFiltersDto): Promise<number> {
    const where = this.where(filters, { tab: true });
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n ${FROM} WHERE ${where.sql}`, where.params);
    return Number(n);
  }

  async fetchRows(filters: ReportFiltersDto, sort: string | undefined, page: { offset: number; limit: number }, em: EntityManager = this.dataSource.manager): Promise<ReportRowDto[]> {
    const fallback: ['createdAt', 'ASC' | 'DESC'] = (filters.tab ?? 'open') === 'open' ? ['createdAt', 'ASC'] : ['createdAt', 'DESC'];
    const direction = toOrder(sort, REPORT_SORT_FIELDS, fallback).createdAt ?? 'DESC';
    const where = this.where(filters, { tab: true });
    const rows: any[] = await em.query(
      `SELECT rp.*, ru.full_name AS reporter_name, rb.full_name AS resolved_by_name, d.reference AS dispute_reference
       ${FROM} WHERE ${where.sql} ORDER BY rp.created_at ${direction}, rp.id ASC LIMIT ? OFFSET ?`,
      [...where.params, page.limit, page.offset],
    );
    return this.toRows(rows, em);
  }

  private async toRows(rows: any[], em: EntityManager): Promise<ReportRowDto[]> {
    const targets = await this.targetSummaries(
      rows.map((r) => ({ type: r.target_type, id: r.target_id })),
      em,
    );
    const person = (id: string | null, name: string | null) => (id ? { id, fullName: name ?? 'Deleted user' } : null);
    return rows.map((r) => ({
      id: r.id,
      targetType: r.target_type,
      targetId: r.target_id,
      target: targets.get(`${r.target_type}:${r.target_id}`)!,
      reason: r.reason,
      note: r.note,
      reporter: person(r.reporter_id, r.reporter_name),
      status: r.status,
      createdAt: iso(r.created_at)!,
      resolvedBy: person(r.resolved_by_id, r.resolved_by_name),
      resolvedAt: iso(r.resolved_at),
      resolutionNote: r.resolution_note,
      disputeId: r.dispute_id,
      disputeReference: r.dispute_reference ?? null,
    }));
  }

  async tabCounts(filters: ReportFiltersDto): Promise<ReportTabCountsDto> {
    const where = this.where(filters, { tab: false });
    const [raw] = await this.dataSource.query(
      `SELECT COUNT(*) AS all_n, SUM(rp.status = 'open') AS open_n, SUM(rp.status = 'resolved') AS resolved, SUM(rp.status = 'dismissed') AS dismissed ${FROM} WHERE ${where.sql}`,
      where.params,
    );
    const n = (v: unknown) => Number(v ?? 0);
    return { open: n(raw.open_n), resolved: n(raw.resolved), dismissed: n(raw.dismissed), all: n(raw.all_n) };
  }

  async list(query: ReportsQueryDto): Promise<Paginated<ReportRowDto, ReportTabCountsDto>> {
    const [rows, total, counts] = await Promise.all([
      this.fetchRows(query, query.sort, { offset: (query.page - 1) * query.limit, limit: query.limit }),
      this.count(query),
      this.tabCounts(query),
    ]);
    return paginateWithCounts(rows, total, query, counts);
  }

  async getRow(id: string, em: EntityManager = this.dataSource.manager): Promise<ReportRowDto> {
    const rows: any[] = await em.query(`SELECT rp.*, ru.full_name AS reporter_name, rb.full_name AS resolved_by_name, d.reference AS dispute_reference ${FROM} WHERE rp.id = ? AND rp.deleted_at IS NULL`, [id]);
    if (!rows.length) throw AppException.of('REPORT_NOT_FOUND');
    return (await this.toRows(rows, em))[0]!;
  }

  /**
   * Label, dashboard route and linked booking of each target, one batched query
   * per target type (never one per row).
   */
  async targetSummaries(targets: { type: ReportTargetType; id: string }[], em: EntityManager = this.dataSource.manager): Promise<Map<string, ReportTargetDto>> {
    const result = new Map<string, ReportTargetDto>();
    const idsOf = (type: ReportTargetType) => [...new Set(targets.filter((t) => t.type === type).map((t) => t.id))];
    const empty = (type: ReportTargetType): ReportTargetDto => ({ label: `Deleted ${type.replace('_', ' ')}`, href: null, reviewId: null, conversationId: null, bookingId: null, bookingReference: null, exists: false });
    for (const t of targets) result.set(`${t.type}:${t.id}`, empty(t.type));
    const set = (type: ReportTargetType, id: string, value: Omit<ReportTargetDto, 'exists'> & { deleted?: unknown }) => {
      const { deleted, ...rest } = value;
      result.set(`${type}:${id}`, { ...rest, exists: !deleted });
    };

    const reviewIds = idsOf(ReportTargetType.Review);
    if (reviewIds.length) {
      const rows: any[] = await em.query(
        `SELECT r.id, r.rating, r.deleted_at, au.full_name AS author, COALESCE(pp.business_name, pu.full_name) AS provider, b.id AS booking_id, b.reference
         FROM reviews r JOIN users au ON au.id = r.author_id JOIN users pu ON pu.id = r.provider_id LEFT JOIN provider_profiles pp ON pp.user_id = r.provider_id
         JOIN bookings b ON b.id = r.booking_id WHERE r.id IN (?)`,
        [reviewIds],
      );
      for (const r of rows) {
        set(ReportTargetType.Review, r.id, {
          label: `★${r.rating} · ${r.author} on ${r.provider}`,
          href: r.deleted_at ? null : `/reviews/${r.id}`,
          reviewId: r.id,
          conversationId: null,
          bookingId: r.booking_id,
          bookingReference: r.reference,
          deleted: r.deleted_at,
        });
      }
    }
    const replyIds = idsOf(ReportTargetType.ReviewReply);
    if (replyIds.length) {
      const rows: any[] = await em.query(
        `SELECT rr.id, rr.review_id, rr.body, rr.deleted_at, r.deleted_at AS review_deleted, COALESCE(pp.business_name, pu.full_name) AS provider
         FROM review_replies rr JOIN reviews r ON r.id = rr.review_id JOIN users pu ON pu.id = rr.provider_id LEFT JOIN provider_profiles pp ON pp.user_id = rr.provider_id WHERE rr.id IN (?)`,
        [replyIds],
      );
      for (const r of rows) {
        set(ReportTargetType.ReviewReply, r.id, {
          label: `Reply by ${r.provider}: ${preview(r.body, 80)}`,
          href: r.review_deleted ? null : `/reviews/${r.review_id}`,
          reviewId: r.review_id,
          conversationId: null,
          bookingId: null,
          bookingReference: null,
          deleted: r.deleted_at ?? r.review_deleted,
        });
      }
    }
    const messageIds = idsOf(ReportTargetType.Message);
    if (messageIds.length) {
      const rows: any[] = await em.query(
        `SELECT m.id, m.conversation_id, COALESCE(m.body_masked, m.body) AS body, m.status, su.full_name AS sender, b.id AS booking_id, b.reference
         FROM messages m JOIN conversations c ON c.id = m.conversation_id LEFT JOIN users su ON su.id = m.sender_id LEFT JOIN bookings b ON b.id = c.booking_id AND b.deleted_at IS NULL
         WHERE m.id IN (?)`,
        [messageIds],
      );
      for (const r of rows) {
        set(ReportTargetType.Message, r.id, {
          label: `Message from ${r.sender ?? 'Eventor'}: ${preview(r.body, 80) ?? ''}`,
          href: `/messages/${r.conversation_id}?message=${r.id}`,
          reviewId: null,
          conversationId: r.conversation_id,
          bookingId: r.booking_id ?? null,
          bookingReference: r.reference ?? null,
          deleted: r.status === 'deleted',
        });
      }
    }
    const serviceIds = idsOf(ReportTargetType.Service);
    if (serviceIds.length) {
      const rows: any[] = await em.query('SELECT s.id, s.title_en, s.deleted_at, COALESCE(pp.business_name, u.full_name) AS provider FROM services s JOIN users u ON u.id = s.provider_id LEFT JOIN provider_profiles pp ON pp.user_id = s.provider_id WHERE s.id IN (?)', [serviceIds]);
      for (const r of rows) set(ReportTargetType.Service, r.id, { label: `${r.title_en} · ${r.provider}`, href: r.deleted_at ? null : `/services/${r.id}`, reviewId: null, conversationId: null, bookingId: null, bookingReference: null, deleted: r.deleted_at });
    }
    const packIds = idsOf(ReportTargetType.Pack);
    if (packIds.length) {
      const rows: any[] = await em.query('SELECT p.id, p.name_en, p.deleted_at, COALESCE(pp.business_name, u.full_name) AS provider FROM packs p JOIN users u ON u.id = p.provider_id LEFT JOIN provider_profiles pp ON pp.user_id = p.provider_id WHERE p.id IN (?)', [packIds]);
      for (const r of rows) set(ReportTargetType.Pack, r.id, { label: `${r.name_en} · ${r.provider}`, href: r.deleted_at ? null : `/packs/${r.id}`, reviewId: null, conversationId: null, bookingId: null, bookingReference: null, deleted: r.deleted_at });
    }
    const userIds = idsOf(ReportTargetType.User);
    if (userIds.length) {
      const rows: any[] = await em.query('SELECT u.id, u.full_name, u.role, u.deleted_at, pp.business_name FROM users u LEFT JOIN provider_profiles pp ON pp.user_id = u.id WHERE u.id IN (?)', [userIds]);
      for (const r of rows) {
        set(ReportTargetType.User, r.id, {
          label: `${r.full_name}${r.business_name ? ` (${r.business_name})` : ''} · ${r.role}`,
          href: r.deleted_at ? null : `/users/${r.id}`,
          reviewId: null,
          conversationId: null,
          bookingId: null,
          bookingReference: null,
          deleted: r.deleted_at,
        });
      }
    }
    return result;
  }

  // ── create (future mobile API, seed) ────────────────────────

  /** A user's report (one open report per reporter and target), then 🔔 admins after COMMIT. */
  async createInTransaction(em: EntityManager, afterCommit: AfterCommit, input: InsertReportInput): Promise<{ id: string; created: boolean }> {
    const report = await insertReport(em, input);
    if (report.created) {
      this.events.emitAfterCommit<ReportCreatedEvent>(afterCommit, REVIEW_EVENTS.reportCreated, {
        reportId: report.id,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        automatic: input.reporterId === null,
      });
    }
    return report;
  }

  // ── decisions ───────────────────────────────────────────────

  private async lock(em: EntityManager, id: string): Promise<Report> {
    const report = await em.getRepository(Report).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!report) throw AppException.of('REPORT_NOT_FOUND');
    if (report.status !== ReportStatus.Open) throw AppException.of('REPORT_INVALID_TRANSITION', { status: report.status });
    return report;
  }

  /** Acting on the target resolves every open report on it (status-rules §9). */
  async resolve(auth: AuthUser, id: string, dto: ResolveReportDto): Promise<ReportRowDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const report = await this.lock(em, id);
      const closed = await closeOpenReports(em, { type: report.targetType, id: report.targetId }, { status: ReportStatus.Resolved, adminId: auth.id, note: dto.note });
      await this.audit.log(
        {
          action: 'report.resolved',
          objectType: 'report',
          objectId: id,
          objectLabel: `${report.targetType} · ${report.reason}`,
          level: AuditLevel.Normal,
          changes: { status: { from: 'open', to: 'resolved' }, action: dto.action ?? null, targetType: report.targetType, targetId: report.targetId, reportIds: closed.map((c) => c.id) },
          note: dto.note,
        },
        em,
      );
      this.events.emitAfterCommit<ReportsClosedEvent>(afterCommit, REVIEW_EVENTS.reportsClosed, { reports: closed, status: ReportStatus.Resolved, targetType: report.targetType, targetId: report.targetId, disputeReference: null });
    });
    return this.getRow(id);
  }

  async dismiss(auth: AuthUser, id: string, dto: DismissReportDto): Promise<ReportRowDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const report = await this.lock(em, id);
      const now = new Date();
      await em.query("UPDATE reports SET status = 'dismissed', resolved_by_id = ?, resolved_at = ?, resolution_note = ?, updated_at = ? WHERE id = ?", [auth.id, now, dto.note, now, id]);
      await this.audit.log(
        {
          action: 'report.dismissed',
          objectType: 'report',
          objectId: id,
          objectLabel: `${report.targetType} · ${report.reason}`,
          level: AuditLevel.Normal,
          changes: { status: { from: 'open', to: 'dismissed' }, targetType: report.targetType, targetId: report.targetId },
          note: dto.note,
        },
        em,
      );
      this.events.emitAfterCommit<ReportsClosedEvent>(afterCommit, REVIEW_EVENTS.reportsClosed, {
        reports: [{ id, reporterId: report.reporterId }],
        status: ReportStatus.Dismissed,
        targetType: report.targetType,
        targetId: report.targetId,
        disputeReference: null,
      });
    });
    return this.getRow(id);
  }

  /** MSG-01 "Dismiss report": dismisses every open report on a message. */
  async dismissForMessage(auth: AuthUser, messageId: string, dto: DismissReportDto): Promise<MessageReportsDismissedDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const [message] = await em.query('SELECT id, conversation_id FROM messages WHERE id = ?', [messageId]);
      if (!message) throw AppException.of('MESSAGE_NOT_FOUND');
      const closed = await closeOpenReports(em, { type: ReportTargetType.Message, id: messageId }, { status: ReportStatus.Dismissed, adminId: auth.id, note: dto.note });
      if (!closed.length) throw AppException.of('MESSAGE_NO_OPEN_REPORTS');
      await this.audit.log(
        { action: 'message.reports_dismissed', objectType: 'message', objectId: messageId, level: AuditLevel.Normal, changes: { conversationId: message.conversation_id, reportIds: closed.map((c) => c.id) }, note: dto.note },
        em,
      );
      this.events.emitAfterCommit<ReportsClosedEvent>(afterCommit, REVIEW_EVENTS.reportsClosed, { reports: closed, status: ReportStatus.Dismissed, targetType: ReportTargetType.Message, targetId: messageId, disputeReference: null });
      return { messageId, dismissed: closed.length };
    });
  }

  /**
   * Opens a dispute on the booking behind the target (review → its booking,
   * message → the booking of its conversation; otherwise 422
   * REPORT_NOT_CONVERTIBLE) through DisputesService, in the same transaction.
   * The dispute window is not enforced (the admin decides); the report and every
   * other open report on the target are resolved with `dispute_id`.
   */
  async convertToDispute(auth: AuthUser, id: string, dto: ConvertReportDto): Promise<ReportRowDto> {
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const report = await this.lock(em, id);
      if (!CONVERTIBLE_TARGETS.includes(report.targetType)) throw AppException.of('REPORT_NOT_CONVERTIBLE', { targetType: report.targetType });
      const target = (await this.targetSummaries([{ type: report.targetType, id: report.targetId }], em)).get(`${report.targetType}:${report.targetId}`)!;
      if (!target.bookingId) throw AppException.of('REPORT_NOT_CONVERTIBLE', { targetType: report.targetType });

      const disputeId = await this.disputes.openInTransaction(em, afterCommit, auth, {
        bookingId: target.bookingId,
        openedByRole: dto.openedByRole,
        type: dto.type,
        description: dto.description,
        ignoreWindow: true,
        note: `Converted from report ${id} (${report.targetType}, ${report.reason}).`,
      });
      const [dispute] = await em.query('SELECT reference FROM disputes WHERE id = ?', [disputeId]);
      const closed = await closeOpenReports(em, { type: report.targetType, id: report.targetId }, { status: ReportStatus.Resolved, adminId: auth.id, note: `Converted to dispute ${dispute.reference}.`, disputeId });
      await this.audit.log(
        {
          action: 'report.converted_to_dispute',
          objectType: 'report',
          objectId: id,
          objectLabel: `${report.targetType} · ${report.reason}`,
          level: AuditLevel.Sensitive,
          changes: { status: { from: 'open', to: 'resolved' }, disputeId, disputeReference: dispute.reference, bookingId: target.bookingId, reportIds: closed.map((c) => c.id) },
        },
        em,
      );
      this.events.emitAfterCommit<ReportsClosedEvent>(afterCommit, REVIEW_EVENTS.reportsClosed, {
        reports: closed,
        status: ReportStatus.Resolved,
        targetType: report.targetType,
        targetId: report.targetId,
        disputeReference: dispute.reference,
      });
    });
    return this.getRow(id);
  }
}
