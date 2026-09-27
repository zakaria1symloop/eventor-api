import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { Lang } from '../common/i18n/language.js';
import { MailService } from '../mail/mail.service.js';
import { ADMIN_ROOM, MessagingGateway } from '../messaging/messaging.gateway.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { DISPUTE_EVENTS, type DisputeClosedEvent, type DisputeEvent, type DisputeMessageEvent, type DisputeOpenedEvent, type DisputeResolvedEvent } from './disputes.events.js';
import { DisputesService } from './disputes.service.js';

interface Party {
  id: string;
  email: string;
  name: string;
  lang: Lang;
}

const TYPE_LABELS: Record<string, Record<Lang, string>> = {
  provider_no_show: { en: 'provider no-show', ar: 'عدم حضور مقدم الخدمة' },
  client_no_show: { en: 'client no-show', ar: 'عدم حضور العميل' },
  service_not_as_described: { en: 'service not as described', ar: 'الخدمة لا تطابق الوصف' },
  incomplete_or_late: { en: 'incomplete or late service', ar: 'خدمة ناقصة أو متأخرة' },
  price_disagreement: { en: 'price disagreement', ar: 'خلاف حول السعر' },
  cancellation_disagreement: { en: 'cancellation disagreement', ar: 'خلاف حول الإلغاء' },
  damage_or_safety: { en: 'damage or safety', ar: 'ضرر أو سلامة' },
  behaviour: { en: 'behaviour', ar: 'سلوك' },
  other: { en: 'other', ar: 'أخرى' },
};

const OUTCOMES: Record<string, Record<Lang, string>> = {
  completed: { en: 'The booking is marked as completed.', ar: 'تم اعتبار الحجز مكتملًا.' },
  cancelled: { en: 'The booking is cancelled.', ar: 'تم إلغاء الحجز.' },
  unchanged: { en: 'The booking status is unchanged.', ar: 'لم تتغير حالة الحجز.' },
};

/**
 * Dispute notifications (status-rules §6): emails in each party's language,
 * in-app notifications + push, admin notifications and the `dispute:new`
 * socket event on the `/admin` namespace.
 */
@Injectable()
export class DisputesListener {
  private readonly logger = new Logger(DisputesListener.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly gateway: MessagingGateway,
    private readonly disputes: DisputesService,
  ) {}

  private async parties(event: DisputeEvent): Promise<Map<string, Party>> {
    const rows: any[] = await this.dataSource.query('SELECT id, email, full_name, language FROM users WHERE id IN (?) AND deleted_at IS NULL', [[event.clientId, event.providerId]]);
    return new Map(rows.map((r) => [r.id, { id: r.id, email: r.email, name: r.full_name, lang: r.language === 'ar' ? 'ar' : 'en' }]));
  }

  private async email(to: Party | undefined, text: Record<Lang, { subject: string; lines: string[] }>): Promise<void> {
    if (!to?.email) return;
    const t = text[to.lang];
    await this.mail.enqueue({ to: to.email, template: 'case-update', lang: to.lang, data: { name: to.name, subject: t.subject, lines: t.lines } });
  }

  @OnEvent(DISPUTE_EVENTS.opened)
  async onOpened(event: DisputeOpenedEvent): Promise<void> {
    const parties = await this.parties(event);
    const other = parties.get(event.againstUserId);
    const type = TYPE_LABELS[event.type] ?? TYPE_LABELS.other!;
    await this.email(other, {
      en: {
        subject: `Dispute ${event.reference} opened on booking ${event.bookingReference}`,
        lines: [`A dispute (${type.en}) was opened on your booking ${event.bookingReference}.`, 'Eventor support will contact you in the dispute chat. Automatic completion and reviews are paused meanwhile.'],
      },
      ar: {
        subject: `تم فتح النزاع ${event.reference} على الحجز ${event.bookingReference}`,
        lines: [`تم فتح نزاع (${type.ar}) على حجزك ${event.bookingReference}.`, 'سيتواصل معك دعم Eventor في محادثة النزاع. الإتمام التلقائي والتقييمات متوقفة مؤقتًا.'],
      },
    });
    const data = { disputeId: event.disputeId, reference: event.reference, bookingId: event.bookingId, conversationId: event.conversationId };
    await this.notifications.notify([event.againstUserId], { type: 'dispute.opened', title: `Dispute ${event.reference}`, body: `A dispute was opened on booking ${event.bookingReference}.`, data }, { push: true });
    await this.notifications.notifyAdmins({
      type: 'dispute.opened',
      en: { title: `New dispute ${event.reference}`, body: `${type.en} on booking ${event.bookingReference}.` },
      ar: { title: `نزاع جديد ${event.reference}`, body: `${type.ar} على الحجز ${event.bookingReference}.` },
      data: { ...data, href: `/disputes/${event.disputeId}` },
    });
    try {
      const [row] = await this.disputes.fetchRows({ q: event.reference }, undefined, { offset: 0, limit: 1 });
      this.gateway.server?.to(ADMIN_ROOM).emit('dispute:new', row ?? data);
    } catch (error) {
      this.logger.warn(`dispute:new socket event failed: ${(error as Error).message}`);
    }
  }

  @OnEvent(DISPUTE_EVENTS.messageSent)
  async onMessage(event: DisputeMessageEvent): Promise<void> {
    const recipients = event.evidenceRequestedFrom ? [event.evidenceRequestedFrom] : [event.clientId, event.providerId];
    await this.notifications.notify(
      recipients,
      {
        type: event.evidenceRequestedFrom ? 'dispute.evidence_requested' : 'dispute.message',
        title: `Dispute ${event.reference}`,
        body: event.evidenceRequestedFrom ? 'Eventor support asked you for more evidence.' : 'New message from Eventor support.',
        data: { disputeId: event.disputeId, bookingId: event.bookingId, conversationId: event.conversationId, messageId: event.messageId },
      },
      { push: true },
    );
  }

  @OnEvent(DISPUTE_EVENTS.resolved)
  async onResolved(event: DisputeResolvedEvent): Promise<void> {
    const parties = await this.parties(event);
    const outcome = OUTCOMES[event.bookingOutcome]!;
    const text = {
      en: { subject: `Dispute ${event.reference} resolved`, lines: [`The dispute on booking ${event.bookingReference} is resolved.`, outcome.en, `Decision: ${event.decisionNote}`, 'Payment is made in cash; Eventor handles no refunds.'] },
      ar: { subject: `تم حل النزاع ${event.reference}`, lines: [`تم حل النزاع على الحجز ${event.bookingReference}.`, outcome.ar, `القرار: ${event.decisionNote}`, 'الدفع نقدًا؛ لا تتولى Eventor أي استرداد.'] },
    };
    for (const party of parties.values()) await this.email(party, text);
    await this.notifications.notify([event.clientId, event.providerId], { type: 'dispute.resolved', title: `Dispute ${event.reference} resolved`, body: event.decisionNote.slice(0, 500), data: { disputeId: event.disputeId, bookingId: event.bookingId, conversationId: event.conversationId } }, { push: true });
  }

  @OnEvent(DISPUTE_EVENTS.closed)
  async onClosed(event: DisputeClosedEvent): Promise<void> {
    await this.notifications.notify([event.clientId, event.providerId], {
      type: 'dispute.closed',
      title: `Dispute ${event.reference} closed`,
      body: `The dispute on booking ${event.bookingReference} was closed without action; the booking continues normally.`,
      data: { disputeId: event.disputeId, bookingId: event.bookingId, conversationId: event.conversationId },
    });
  }
}
