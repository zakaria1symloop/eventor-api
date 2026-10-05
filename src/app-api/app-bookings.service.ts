import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { envConfig, type Env } from '../config/env.js';
import type { DataSource, EntityManager } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { InvoicesService } from '../bookings/invoices.service.js';
import {
  addDays,
  assertEventTimes,
  computeLines,
  computeTotals,
  packLines,
  serviceQuantity,
  toCents,
  type LineInput,
} from '../bookings/bookings.policy.js';
import { BookingDisputeStatus, BookingLineKind, BookingSource, BookingStatus, RescheduleStatus } from '../common/enums/booking.enums.js';
import type { PriceType } from '../common/enums/catalog.enums.js';
import { PartyRole, UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import type { Lang } from '../common/i18n/language.js';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import { runInTransaction } from '../database/transaction.js';
import { disputeWindow } from '../disputes/disputes.policy.js';
import { FilesService } from '../files/files.service.js';
import { PACK_VISIBLE_SQL } from '../packs/packs.policy.js';
import { SERVICE_VISIBLE_SQL } from '../services/services.policy.js';
import { SettingsService } from '../settings/settings.service.js';
import { algiersToday } from '../users/users.service.js';
import { API_PREFIX } from '../app.setup.js';
import {
  appBookingActions,
  assertOwner,
  bookingTabSql,
  reviewWindow,
  type AppBookingTab,
} from './app-bookings.policy.js';
import { avatarUrl, hhmm, photoUrls, toCategoryRef, toWilayaRef } from './app-refs.js';
import { pickText, pickTextOrNull, replyTimeLabel } from './app.policy.js';
import type {
  AppBookingCardDto,
  AppBookingDetailDto,
  AppBookingLineDto,
  AppBookingPartyDto,
  AppCreateBookingDto,
  AppQuoteDto,
  AppQuoteResultDto,
  AppRescheduleDto,
  AppRescheduleRowDto,
  AppBookingTimelineEntryDto,
} from './dto/app-bookings.dto.js';

/** Which side of the booking the caller is on. */
export type Party = 'client' | 'provider';

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);
const dateOnly = (value: Date | string): string =>
  value instanceof Date ? new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : String(value).slice(0, 10);

/**
 * The booking flow of the mobile app, for both parties. It owns no booking
 * rules: creating, cancelling, accepting, completing, rescheduling and checking
 * in all go through `BookingsService`, which is the single place status-rules
 * §5 lives. What is here is the app's view of a booking — ownership, the
 * caller's language, privacy (no contact details before acceptance) and the
 * `allowedActions` the screens draw their buttons from.
 */
@Injectable()
export class AppBookingsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly bookings: BookingsService,
    private readonly invoices: InvoicesService,
    private readonly settings: SettingsService,
    private readonly files: FilesService,
    @Inject(envConfig.KEY) private readonly env: Env,
  ) {}

  // ── quote ─────────────────────────────────────────────────────

  private async minNotice(): Promise<{ days: number; firstBookableDate: string }> {
    const days = Number(await this.settings.get('booking_min_notice_days'));
    return { days, firstBookableDate: addDays(algiersToday(), days) };
  }

  /**
   * Prices a booking without writing anything (screens 12 and 20 "Book"): the
   * same lines `POST /app/bookings` would create, plus whether the date is
   * actually bookable. It never throws for an unavailable date — the sheet
   * shows the reason instead.
   */
  async quote(dto: AppQuoteDto, lang: Lang): Promise<AppQuoteResultDto> {
    this.assertTarget(dto);
    const em = this.dataSource.manager;
    const { days, firstBookableDate } = await this.minNotice();

    const { providerId, lines, feeKey } = dto.serviceId
      ? await this.serviceLines(em, dto, lang)
      : await this.packLines(em, dto.packId!, lang);

    const computed = computeLines(lines);
    const totals = computeTotals(computed);
    const feePercent = Number(await this.settings.get(feeKey)).toFixed(2);

    const [profile] = await em.query('SELECT accepting_bookings FROM provider_profiles WHERE user_id = ? AND deleted_at IS NULL', [providerId]);
    let unavailableReason: string | null = null;
    if (!profile || Number(profile.accepting_bookings) !== 1) unavailableReason = 'PROVIDER_NOT_ACCEPTING';
    else if (dto.eventDate < firstBookableDate) unavailableReason = 'MIN_NOTICE';
    else {
      const free = await this.bookings.isAvailable(em, {
        providerId,
        serviceId: dto.serviceId ?? null,
        packId: dto.packId ?? null,
        date: dto.eventDate,
        startTime: dto.startTime ?? null,
        endTime: dto.endTime ?? null,
      });
      if (!free) unavailableReason = 'DATE_UNAVAILABLE';
    }

    return {
      lines: computed.map((line) => ({
        id: '',
        kind: line.kind,
        label: line.label,
        quantity: line.quantity,
        unitAmount: line.unitAmount,
        amount: line.amount,
      })),
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      total: totals.total,
      feePercent,
      available: unavailableReason === null,
      unavailableReason,
      firstBookableDate,
      minNoticeDays: days,
    };
  }

  private assertTarget(dto: AppQuoteDto): void {
    assertEventTimes(dto.startTime, dto.endTime);
    if ((dto.serviceId === undefined) === (dto.packId === undefined)) {
      throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'serviceId', code: 'EXACTLY_ONE', message: 'Send exactly one of serviceId or packId' }]);
    }
    if (dto.packId && dto.extras?.length) {
      throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'extras', code: 'SERVICE_ONLY', message: 'extras are only allowed with serviceId' }]);
    }
  }

  /** Quote lines for a service, labelled in the caller's language. */
  private async serviceLines(em: EntityManager, dto: AppQuoteDto, lang: Lang) {
    const [service] = await em.query(
      `SELECT s.id, s.provider_id, s.title_en, s.title_ar, s.base_price, s.price_type, ${SERVICE_VISIBLE_SQL} AS visible
         FROM services s JOIN users u ON u.id = s.provider_id WHERE s.id = ? AND s.deleted_at IS NULL`,
      [dto.serviceId],
    );
    if (!service || Number(service.visible) !== 1) throw AppException.of('SERVICE_NOT_FOUND');
    const lines: LineInput[] = [
      {
        kind: BookingLineKind.Service,
        label: pickText(lang, service.title_en, service.title_ar),
        quantity: serviceQuantity(service.price_type as PriceType, { guests: dto.guests, startTime: dto.startTime, endTime: dto.endTime }),
        unitAmount: String(service.base_price),
        serviceId: service.id,
      },
    ];
    if (dto.extras?.length) {
      const ids = dto.extras.map((e) => e.extraId);
      const extras: any[] = await em.query('SELECT id, name_en, name_ar, price FROM service_extras WHERE id IN (?) AND service_id = ? AND deleted_at IS NULL', [ids, service.id]);
      const invalid = ids.filter((id) => !extras.some((x) => x.id === id));
      if (invalid.length) throw AppException.of('BOOKING_EXTRA_INVALID', { extraIds: invalid });
      for (const extra of dto.extras) {
        const row = extras.find((x) => x.id === extra.extraId)!;
        lines.push({ kind: BookingLineKind.Extra, label: pickText(lang, row.name_en, row.name_ar), quantity: extra.quantity, unitAmount: String(row.price), serviceId: service.id });
      }
    }
    return { providerId: service.provider_id as string, lines, feeKey: 'platform_fee_percent' as const };
  }

  /** Quote lines for a Ready Pack: one line per item, then the pack discount. */
  private async packLines(em: EntityManager, packId: string, lang: Lang) {
    const [pack] = await em.query(
      `SELECT p.id, p.provider_id, p.name_en, p.name_ar, p.price, ${PACK_VISIBLE_SQL} AS visible FROM packs p JOIN users u ON u.id = p.provider_id WHERE p.id = ? AND p.deleted_at IS NULL`,
      [packId],
    );
    if (!pack || Number(pack.visible) !== 1) throw AppException.of('PACK_NOT_FOUND');
    const items: any[] = await em.query(
      'SELECT s.id AS service_id, s.title_en, s.title_ar, s.base_price FROM pack_items pi JOIN services s ON s.id = pi.service_id WHERE pi.pack_id = ? ORDER BY pi.position',
      [pack.id],
    );
    const lines = packLines(
      { price: String(pack.price), nameEn: pickText(lang, pack.name_en, pack.name_ar) },
      items.map((i) => ({ serviceId: i.service_id, titleEn: pickText(lang, i.title_en, i.title_ar), basePrice: String(i.base_price) })),
    );
    return { providerId: pack.provider_id as string, lines, feeKey: 'pack_fee_percent' as const };
  }

  // ── create ────────────────────────────────────────────────────

  /**
   * Screen 12 / 20 "Book": one pending booking (status-rules §5), created by
   * `BookingsService` so the availability hold, the invoice snapshot, the
   * conversation and the audit row are exactly the admin ones.
   */
  async create(auth: AuthUser, dto: AppCreateBookingDto, source: BookingSource, lang: Lang): Promise<AppBookingDetailDto> {
    this.assertTarget(dto);
    await this.assertEmailVerified(auth);
    const id = await runInTransaction(this.dataSource, (em, afterCommit) =>
      this.bookings.createInTransaction(
        em,
        afterCommit,
        auth,
        {
          clientId: auth.id,
          serviceId: dto.serviceId,
          packId: dto.packId,
          eventDate: dto.eventDate,
          startTime: dto.startTime,
          endTime: dto.endTime,
          eventType: dto.eventType,
          wilayaCode: dto.wilayaCode,
          communeId: dto.communeId,
          locationText: dto.locationText ?? null,
          guests: dto.guests,
          clientNote: dto.clientNote ?? null,
          extras: dto.extras,
        },
        { source },
      ),
    );
    return this.detail(auth, id, 'client', lang);
  }

  /** status-rules §1: booking, messaging and documents need a verified email. */
  private async assertEmailVerified(auth: AuthUser): Promise<void> {
    const [user] = await this.dataSource.query('SELECT email, email_verified_at FROM users WHERE id = ? AND deleted_at IS NULL', [auth.id]);
    if (!user) throw AppException.of('USER_NOT_FOUND');
    if (!user.email_verified_at && !this.env.AUTH_SKIP_EMAIL_VERIFICATION) {
      throw AppException.of('EMAIL_NOT_VERIFIED', { email: user.email });
    }
  }

  // ── read ──────────────────────────────────────────────────────

  private readonly FROM = `FROM bookings b
    JOIN users cu ON cu.id = b.client_id
    JOIN users pu ON pu.id = b.provider_id
    LEFT JOIN provider_profiles pp ON pp.user_id = b.provider_id AND pp.deleted_at IS NULL
    LEFT JOIN services s ON s.id = b.service_id
    LEFT JOIN categories sc ON sc.id = s.category_id AND sc.deleted_at IS NULL
    LEFT JOIN packs pk ON pk.id = b.pack_id
    LEFT JOIN wilayas w ON w.code = b.wilaya_code`;

  private readonly SELECT = `b.*, s.title_en, s.title_ar, s.price_type, s.cancellation_policy_en, s.cancellation_policy_ar,
    sc.id AS cat_id, sc.slug AS cat_slug, sc.name_en AS cat_name_en, sc.name_ar AS cat_name_ar, sc.icon AS cat_icon,
    pk.name_en AS pack_name_en, pk.name_ar AS pack_name_ar,
    cu.full_name AS client_name, cu.avatar_file_id AS client_avatar, cu.email AS client_email, cu.phone AS client_phone,
    pu.full_name AS provider_name, pu.avatar_file_id AS provider_avatar, pu.phone AS provider_phone, pu.verification_status AS provider_verification,
    pp.business_name, pp.avg_rating, pp.rating_count, pp.completed_bookings_count, pp.years_active, pp.avg_reply_minutes, pp.accepting_bookings, pp.category_id,
    w.code AS wilaya_code_ref, w.name AS wilaya_name, w.name_ar AS wilaya_name_ar`;

  /** The caller's own bookings, one tab at a time (client Bookings tab / provider Requests tab). */
  async list(auth: AuthUser, party: Party, tab: AppBookingTab, query: { page: number; limit: number }, lang: Lang): Promise<Paginated<AppBookingCardDto>> {
    const em = this.dataSource.manager;
    const today = algiersToday();
    const scope = party === 'client' ? 'b.client_id = ?' : 'b.provider_id = ?';
    const tabClause = bookingTabSql(tab);
    const where = `b.deleted_at IS NULL AND ${scope} AND ${tabClause.sql}`;
    const params = [auth.id, ...tabClause.params(today)];

    const [[count], rows] = await Promise.all([
      em.query(`SELECT COUNT(*) AS n FROM bookings b WHERE ${where}`, params),
      em.query(
        `SELECT ${this.SELECT} ${this.FROM} WHERE ${where} ORDER BY b.event_date ${tab === 'past' || tab === 'cancelled' ? 'DESC' : 'ASC'}, b.created_at DESC LIMIT ? OFFSET ?`,
        [...params, query.limit, (query.page - 1) * query.limit],
      ),
    ]);
    const ids = rows.map((r: any) => r.id);
    const [covers, conversations, reschedules, reviews] = await Promise.all([
      this.covers(em, rows),
      this.conversations(em, ids),
      this.pendingReschedules(em, ids),
      this.reviewIds(em, ids, auth.id),
    ]);
    const cards = await Promise.all(
      rows.map((r: any) =>
        this.toCard(r, party, auth, lang, today, {
          coverUrl: covers.get(r.service_id ?? r.pack_id) ?? null,
          conversationId: conversations.get(r.id) ?? null,
          pendingReschedule: reschedules.get(r.id) ?? null,
          reviewId: reviews.get(r.id) ?? null,
        }),
      ),
    );
    return paginate(cards, Number(count.n), query);
  }

  /** One booking, with everything the detail screen draws. 403 NOT_OWNER for somebody else's. */
  async detail(auth: AuthUser, id: string, party: Party, lang: Lang): Promise<AppBookingDetailDto> {
    const em = this.dataSource.manager;
    const [r] = await em.query(`SELECT ${this.SELECT} ${this.FROM} WHERE b.id = ? AND b.deleted_at IS NULL`, [id]);
    if (!r) throw AppException.of('BOOKING_NOT_FOUND');
    assertOwner(party === 'client' ? r.client_id : r.provider_id, auth.id);

    const today = algiersToday();
    const [covers, conversations, reschedules, reviews, lines, statusRows, invoice, [dispute]] = await Promise.all([
      this.covers(em, [r]),
      this.conversations(em, [id]),
      this.pendingReschedules(em, [id]),
      this.reviewIds(em, [id], auth.id),
      em.query('SELECT id, kind, label, quantity, unit_amount, amount FROM booking_lines WHERE booking_id = ? AND deleted_at IS NULL ORDER BY position, created_at', [id]),
      em.query('SELECT sc.from_status, sc.to_status, sc.reason, sc.created_at, u.full_name, u.role FROM booking_status_changes sc LEFT JOIN users u ON u.id = sc.actor_id WHERE sc.booking_id = ? ORDER BY sc.created_at', [id]),
      this.invoices.summary(id, em),
      em.query('SELECT id, reference, status, type, opened_by_id, created_at FROM disputes WHERE booking_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', [id]),
    ]);
    const allReschedules: any[] = await em.query(
      'SELECT br.*, u.role AS proposer_role FROM booking_reschedules br LEFT JOIN users u ON u.id = br.proposed_by_id WHERE br.booking_id = ? AND br.deleted_at IS NULL ORDER BY br.created_at DESC',
      [id],
    );

    const card = await this.toCard(r, party, auth, lang, today, {
      coverUrl: covers.get(r.service_id ?? r.pack_id) ?? null,
      conversationId: conversations.get(id) ?? null,
      pendingReschedule: reschedules.get(id) ?? null,
      reviewId: reviews.get(id) ?? null,
    });

    const timeline: AppBookingTimelineEntryDto[] = statusRows.map((s: any) => ({
      type: (s.from_status === null ? 'created' : String(s.to_status)) as AppBookingTimelineEntryDto['type'],
      toStatus: (s.to_status ?? null) as BookingStatus | null,
      actorLabel: s.full_name ?? null,
      reason: s.reason ?? null,
      at: iso(s.created_at)!,
    }));
    for (const row of allReschedules) {
      timeline.push({ type: 'rescheduled', toStatus: null, actorLabel: null, reason: row.reason ?? null, at: iso(row.created_at)! });
    }
    if (r.client_checked_in_at) timeline.push({ type: 'checked_in', toStatus: null, actorLabel: 'client', reason: null, at: iso(r.client_checked_in_at)! });
    if (r.provider_checked_in_at) timeline.push({ type: 'checked_in', toStatus: null, actorLabel: 'provider', reason: null, at: iso(r.provider_checked_in_at)! });
    if (dispute) timeline.push({ type: 'dispute_opened', toStatus: null, actorLabel: null, reason: null, at: iso(dispute.created_at)! });
    timeline.sort((a, b) => a.at.localeCompare(b.at));

    const [commune] = r.commune_id ? await em.query('SELECT name, name_ar FROM communes WHERE id = ?', [r.commune_id]) : [null];
    const completion = await this.reviewWindowFor(r);

    return {
      ...card,
      locationText: r.location_text ?? null,
      communeName: commune ? pickText(lang, commune.name, commune.name_ar) : null,
      clientNote: r.client_note ?? null,
      lines: lines.map(
        (l: any): AppBookingLineDto => ({ id: l.id, kind: l.kind, label: l.label, quantity: Number(l.quantity), unitAmount: String(l.unit_amount), amount: String(l.amount) }),
      ),
      subtotal: String(r.subtotal),
      discountTotal: String(r.discount_total),
      feePercent: String(r.fee_percent),
      cancellationPolicy: pickTextOrNull(lang, r.cancellation_policy_en, r.cancellation_policy_ar),
      cancelReason: r.cancel_reason ?? null,
      cancelledBy: r.cancelled_by ?? null,
      declineReason: r.decline_reason ?? null,
      provider: this.providerCard(r),
      timeline,
      reschedules: allReschedules.map((row): AppRescheduleRowDto => this.toReschedule(row, party)),
      invoice: invoice
        ? {
            id: invoice.id,
            number: invoice.number,
            version: invoice.version,
            total: invoice.total,
            voided: false,
            pdfPath: `${API_PREFIX}/app/bookings/${id}/invoice.pdf`,
            issuedAt: invoice.issuedAt,
          }
        : null,
      dispute: dispute
        ? { id: dispute.id, reference: dispute.reference, status: dispute.status, type: dispute.type, openedByMe: dispute.opened_by_id === auth.id, createdAt: iso(dispute.created_at)! }
        : null,
      checkedIn: (party === 'client' ? r.client_checked_in_at : r.provider_checked_in_at) !== null,
      otherCheckedIn: (party === 'client' ? r.provider_checked_in_at : r.client_checked_in_at) !== null,
      reviewId: card.allowedActions.includes('review') ? null : ((await this.reviewIds(em, [id], auth.id)).get(id) ?? null),
      reviewWindowOpen: completion.open,
      disputeWindowOpen: await this.disputeOpen(em, r),
    };
  }

  // ── row helpers ───────────────────────────────────────────────

  private async covers(em: EntityManager, rows: any[]): Promise<Map<string, string>> {
    const serviceIds = [...new Set(rows.filter((r) => r.service_id).map((r) => r.service_id))];
    const packIds = [...new Set(rows.filter((r) => r.pack_id).map((r) => r.pack_id))];
    const map = new Map<string, string>();
    if (serviceIds.length) {
      const photos: any[] = await em.query('SELECT service_id, file_id FROM service_photos WHERE service_id IN (?) ORDER BY position', [serviceIds]);
      for (const p of photos) if (!map.has(p.service_id)) map.set(p.service_id, photoUrls(this.files, p.file_id).thumbUrl);
    }
    if (packIds.length) {
      const photos: any[] = await em.query('SELECT pack_id, file_id FROM pack_photos WHERE pack_id IN (?) ORDER BY position', [packIds]);
      for (const p of photos) if (!map.has(p.pack_id)) map.set(p.pack_id, photoUrls(this.files, p.file_id).thumbUrl);
    }
    return map;
  }

  private async conversations(em: EntityManager, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows: any[] = await em.query("SELECT booking_id, id FROM conversations WHERE booking_id IN (?) AND kind = 'direct' AND deleted_at IS NULL ORDER BY created_at", [ids]);
    return new Map(rows.map((r) => [r.booking_id, r.id]));
  }

  private async pendingReschedules(em: EntityManager, ids: string[]): Promise<Map<string, any>> {
    if (!ids.length) return new Map();
    const rows: any[] = await em.query(
      "SELECT br.*, u.role AS proposer_role FROM booking_reschedules br LEFT JOIN users u ON u.id = br.proposed_by_id WHERE br.booking_id IN (?) AND br.status = 'pending' AND br.deleted_at IS NULL",
      [ids],
    );
    return new Map(rows.map((r) => [r.booking_id, r]));
  }

  private async reviewIds(em: EntityManager, ids: string[], authorId: string): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows: any[] = await em.query('SELECT booking_id, id FROM reviews WHERE booking_id IN (?) AND author_id = ? AND deleted_at IS NULL', [ids, authorId]);
    return new Map(rows.map((r) => [r.booking_id, r.id]));
  }

  private async reviewWindowFor(r: any) {
    const hours = Number(await this.settings.get('review_open_after_hours'));
    return reviewWindow(r.completed_at ? new Date(r.completed_at) : null, hours);
  }

  private async disputeOpen(em: EntityManager, r: any): Promise<boolean> {
    const hours = Number(await this.settings.get('dispute_window_hours'));
    let cancelledAt: Date | null = null;
    if (r.status === BookingStatus.Cancelled) {
      const [row] = await em.query("SELECT MAX(created_at) AS at FROM booking_status_changes WHERE booking_id = ? AND to_status = 'cancelled'", [r.id]);
      cancelledAt = row?.at ? new Date(row.at) : new Date(r.updated_at);
    }
    return disputeWindow({ status: r.status, eventDate: dateOnly(r.event_date), startTime: r.start_time, endTime: r.end_time, cancelledAt }, hours).open;
  }

  private toReschedule(row: any, party: Party): AppRescheduleRowDto {
    const proposedByRole = row.proposer_role === 'provider' ? PartyRole.Provider : row.proposer_role === 'admin' ? PartyRole.Admin : PartyRole.Client;
    return {
      id: row.id,
      status: row.status as RescheduleStatus,
      oldDate: dateOnly(row.old_date),
      newDate: dateOnly(row.new_date),
      newStartTime: hhmm(row.new_start),
      newEndTime: hhmm(row.new_end),
      reason: row.reason ?? null,
      proposedByRole,
      awaitingMe: row.status === RescheduleStatus.Pending && proposedByRole !== (party === 'client' ? PartyRole.Client : PartyRole.Provider),
      createdAt: iso(row.created_at)!,
    };
  }

  /**
   * status-rules §10: contact details stay masked until the pair share an
   * accepted booking. A provider's email is never exposed in the app at all
   * (mobile-api §7) — the client writes in the chat.
   */
  private counterparty(r: any, party: Party): AppBookingPartyDto {
    const unmasked = r.status === BookingStatus.Accepted || r.status === BookingStatus.Completed;
    if (party === 'client') {
      return {
        id: r.provider_id,
        fullName: r.business_name ?? r.provider_name,
        avatarUrl: avatarUrl(this.files, r.provider_avatar),
        businessName: r.business_name ?? null,
        phone: unmasked ? (r.provider_phone ?? null) : null,
        email: null,
      };
    }
    return {
      id: r.client_id,
      fullName: r.client_name,
      avatarUrl: avatarUrl(this.files, r.client_avatar),
      businessName: null,
      phone: unmasked ? (r.client_phone ?? null) : null,
      email: unmasked ? (r.client_email ?? null) : null,
    };
  }

  private providerCard(r: any) {
    if (!r.business_name) return null;
    return {
      id: r.provider_id,
      businessName: r.business_name,
      category: null,
      avatarUrl: avatarUrl(this.files, r.provider_avatar),
      verified: r.provider_verification === VerificationStatus.Verified,
      avgRating: String(r.avg_rating ?? '0.00'),
      ratingCount: Number(r.rating_count ?? 0),
      completedBookingsCount: Number(r.completed_bookings_count ?? 0),
      yearsActive: r.years_active === null || r.years_active === undefined ? null : Number(r.years_active),
      avgReplyMinutes: r.avg_reply_minutes === null ? null : Number(r.avg_reply_minutes),
      replyTime: replyTimeLabel(r.avg_reply_minutes === null ? null : Number(r.avg_reply_minutes)),
      acceptingBookings: Number(r.accepting_bookings ?? 0) === 1,
    };
  }

  private async toCard(
    r: any,
    party: Party,
    auth: AuthUser,
    lang: Lang,
    today: string,
    extra: { coverUrl: string | null; conversationId: string | null; pendingReschedule: any | null; reviewId: string | null },
  ): Promise<AppBookingCardDto> {
    const titleEn = r.title_en ?? r.pack_name_en ?? '';
    const titleAr = r.title_ar ?? r.pack_name_ar ?? '';
    const mineRole = party === 'client' ? PartyRole.Client : PartyRole.Provider;
    const pendingForMe =
      extra.pendingReschedule !== null &&
      (extra.pendingReschedule.proposer_role === 'provider' ? PartyRole.Provider : PartyRole.Client) !== mineRole;
    const window = await this.reviewWindowFor(r);
    const em = this.dataSource.manager;
    return {
      id: r.id,
      reference: r.reference,
      status: r.status,
      disputeStatus: r.dispute_status,
      eventType: r.event_type,
      eventDate: dateOnly(r.event_date),
      startTime: hhmm(r.start_time),
      endTime: hhmm(r.end_time),
      title: pickText(lang, titleEn, titleAr),
      titleEn,
      titleAr,
      serviceId: r.service_id ?? null,
      packId: r.pack_id ?? null,
      category: toCategoryRef(lang, r.cat_id ? { id: r.cat_id, slug: r.cat_slug, name_en: r.cat_name_en, name_ar: r.cat_name_ar, icon: r.cat_icon } : null),
      coverUrl: extra.coverUrl,
      wilaya: toWilayaRef(lang, r.wilaya_code_ref ? { code: r.wilaya_code_ref, name: r.wilaya_name, name_ar: r.wilaya_name_ar } : null),
      guests: r.guests === null ? null : Number(r.guests),
      total: String(r.total),
      counterparty: this.counterparty(r, party),
      conversationId: extra.conversationId,
      allowedActions: appBookingActions(party, {
        status: r.status,
        disputeStatus: r.dispute_status as BookingDisputeStatus,
        eventDate: dateOnly(r.event_date),
        today,
        pendingRescheduleForMe: pendingForMe,
        checkedIn: (party === 'client' ? r.client_checked_in_at : r.provider_checked_in_at) !== null,
        hasReview: extra.reviewId !== null,
        disputeWindowOpen: await this.disputeOpen(em, r),
        reviewWindowOpen: window.open,
      }),
      createdAt: iso(r.created_at)!,
    };
  }

  // ── writes ────────────────────────────────────────────────────

  /** Loads the booking and refuses somebody else's (403 NOT_OWNER), 404 when it does not exist. */
  private async own(id: string, auth: AuthUser, party: Party): Promise<{ id: string; status: BookingStatus }> {
    const [row] = await this.dataSource.query('SELECT id, status, client_id, provider_id FROM bookings WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!row) throw AppException.of('BOOKING_NOT_FOUND');
    assertOwner(party === 'client' ? row.client_id : row.provider_id, auth.id);
    return { id: row.id, status: row.status };
  }

  /** Cancel, accept, decline or complete — always through `BookingsService.changeStatus`. */
  async changeStatus(
    auth: AuthUser,
    id: string,
    party: Party,
    action: 'cancelled' | 'accepted' | 'declined' | 'completed',
    reason: string | null,
    lang: Lang,
  ): Promise<AppBookingDetailDto> {
    await this.own(id, auth, party);
    if (action === 'accepted') await this.assertLiveProvider(auth);
    await this.bookings.changeStatus(auth, id, {
      status: action,
      reason: reason ?? undefined,
      note: reason ?? `${action} from the mobile app`,
      notify: true,
      cancelledBy: party === 'client' ? PartyRole.Client : PartyRole.Provider,
    });
    return this.detail(auth, id, party, lang);
  }

  /** status-rules §2: a provider only accepts bookings once verified and active. */
  private async assertLiveProvider(auth: AuthUser): Promise<void> {
    const [user] = await this.dataSource.query('SELECT status, verification_status FROM users WHERE id = ? AND deleted_at IS NULL', [auth.id]);
    if (!user) throw AppException.of('USER_NOT_FOUND');
    if (user.status !== UserStatus.Active) throw AppException.of('ACCOUNT_BLOCKED');
    if (user.verification_status !== VerificationStatus.Verified) throw AppException.of('PROVIDER_NOT_VERIFIED', { verificationStatus: user.verification_status });
  }

  async reschedule(auth: AuthUser, id: string, party: Party, dto: AppRescheduleDto, lang: Lang): Promise<AppBookingDetailDto> {
    await this.own(id, auth, party);
    await this.bookings.reschedule(auth, id, { date: dto.date, startTime: dto.startTime, endTime: dto.endTime, reason: dto.reason, force: false });
    return this.detail(auth, id, party, lang);
  }

  async respondToReschedule(auth: AuthUser, id: string, party: Party, rescheduleId: string, action: 'accept' | 'reject', lang: Lang): Promise<AppBookingDetailDto> {
    await this.own(id, auth, party);
    await this.bookings.respondToReschedule(auth, id, rescheduleId, action);
    return this.detail(auth, id, party, lang);
  }

  /** "All good" (status-rules §5). "Report a problem" is a dispute, so it answers 422 with the route to call. */
  async checkIn(auth: AuthUser, id: string, party: Party, answer: 'ok' | 'problem', lang: Lang): Promise<AppBookingDetailDto> {
    await this.own(id, auth, party);
    if (answer === 'problem') {
      throw new AppException(422, 'CHECK_IN_NOT_ALLOWED', { next: `POST ${API_PREFIX}/app/bookings/${id}/disputes` });
    }
    await this.bookings.checkIn(auth, id, party === 'client' ? PartyRole.Client : PartyRole.Provider);
    return this.detail(auth, id, party, lang);
  }

  // ── invoice ───────────────────────────────────────────────────

  /** An invoice only exists from acceptance on; the provider side also refuses other statuses explicitly. */
  private async assertInvoiceReadable(id: string, auth: AuthUser, party: Party): Promise<void> {
    const { status } = await this.own(id, auth, party);
    if (party === 'provider' && status !== BookingStatus.Accepted && status !== BookingStatus.Completed) {
      throw AppException.of('INVOICE_NOT_FOUND', { status });
    }
  }

  async invoice(auth: AuthUser, id: string, party: Party) {
    await this.assertInvoiceReadable(id, auth, party);
    return this.invoices.latest(id);
  }

  async invoicePdf(auth: AuthUser, id: string, party: Party) {
    await this.assertInvoiceReadable(id, auth, party);
    return this.invoices.pdf(id);
  }

  /**
   * The proposer withdraws their own **pending** reschedule proposal (the other
   * party answers with accept / reject instead — answering your own proposal is
   * 403 `NOT_OWNER`, and so is withdrawing somebody else's).
   */
  async withdrawReschedule(auth: AuthUser, id: string, party: Party, rescheduleId: string, lang: Lang): Promise<AppBookingDetailDto> {
    await this.own(id, auth, party);
    const [row] = await this.dataSource.query('SELECT id, proposed_by_id FROM booking_reschedules WHERE id = ? AND booking_id = ? AND deleted_at IS NULL', [rescheduleId, id]);
    if (!row) throw AppException.of('RESCHEDULE_NOT_FOUND');
    if (row.proposed_by_id !== auth.id) throw AppException.of('NOT_OWNER');
    await this.bookings.cancelReschedule(auth, id, rescheduleId);
    return this.detail(auth, id, party, lang);
  }

  /** Total of a booking in cents, for the provider home cards. */
  static totalCents(value: string): number {
    return toCents(value);
  }
}
