import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { envConfig, type Env } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import { ADMIN_ROOM, MessagingGateway } from '../messaging/messaging.gateway.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  ACADEMIC_EVENTS,
  type FormCodeSentEvent,
  type RequestBookedEvent,
  type RequestChangesRequestedEvent,
  type RequestDecisionEvent,
  type RequestResubmittedEvent,
  type RequestSubmittedEvent,
} from './academic.events.js';

/** Academic request events → requester emails (EN/AR), admin notifications and `/admin` socket events. */
@Injectable()
export class AcademicMailListener {
  constructor(
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly gateway: MessagingGateway,
    @Inject(envConfig.KEY) private readonly env: Env,
  ) {}

  private adminUrl(path: string): string {
    return `${this.env.ADMIN_URL.replace(/\/$/, '')}${path}`;
  }

  private async toAdmins(type: string, en: { title: string; body: string }, ar: { title: string; body: string }, event: { requestId: string; reference: string }): Promise<void> {
    await this.notifications.notifyAdmins({ type, en, ar, data: { href: `/academic-requests/${event.requestId}`, academicRequestId: event.requestId, reference: event.reference } });
  }

  @OnEvent(ACADEMIC_EVENTS.formCodeSent)
  async onCode(event: FormCodeSentEvent): Promise<void> {
    await this.mail.enqueue({ to: event.email, template: 'verification-code', lang: event.lang, data: { name: event.email.split('@')[0]!, code: event.code, minutes: event.minutes } });
  }

  @OnEvent(ACADEMIC_EVENTS.submitted)
  async onSubmitted(event: RequestSubmittedEvent): Promise<void> {
    const ar = event.lang === 'ar';
    await this.mail.enqueue({
      to: event.requester.email,
      template: 'case-update',
      lang: event.lang,
      data: {
        name: event.requester.name,
        subject: ar ? `تم إرسال طلبك ${event.reference}` : `Request ${event.reference} sent`,
        lines: [ar ? `استلمنا طلبك «${event.title}».` : `We received your request "${event.title}".`, event.confirmation],
      },
    });
    await this.toAdmins(
      'academic_request.new',
      { title: `New academic request ${event.reference}`, body: `${event.title} · ${event.requester.name}` },
      { title: `طلب أكاديمي جديد ${event.reference}`, body: `${event.title} · ${event.requester.name}` },
      event,
    );
    this.gateway.server?.to(ADMIN_ROOM).emit('academic_request:new', {
      id: event.requestId,
      reference: event.reference,
      title: event.title,
      formSlug: event.formSlug,
      requesterName: event.requester.name,
      submittedAt: event.submittedAt,
    });
  }

  @OnEvent(ACADEMIC_EVENTS.resubmitted)
  async onResubmitted(event: RequestResubmittedEvent): Promise<void> {
    await this.toAdmins(
      'academic_request.resubmitted',
      { title: `${event.reference} was updated`, body: `Changed: ${event.changedFields.join(', ') || 'nothing'}` },
      { title: `تم تعديل ${event.reference}`, body: `الحقول المعدلة: ${event.changedFields.join('، ') || 'لا شيء'}` },
      event,
    );
    this.gateway.server?.to(ADMIN_ROOM).emit('academic_request:updated', { id: event.requestId, reference: event.reference, status: 'pending', changedFields: event.changedFields });
  }

  @OnEvent(ACADEMIC_EVENTS.changesRequested)
  async onChangesRequested(event: RequestChangesRequestedEvent): Promise<void> {
    const ar = event.lang === 'ar';
    await this.mail.enqueue({
      to: event.requester.email,
      template: 'case-update',
      lang: event.lang,
      data: {
        name: event.requester.name,
        subject: ar ? `تعديلات مطلوبة على طلبك ${event.reference}` : `Changes needed on your request ${event.reference}`,
        lines: [event.message, ar ? `الرابط صالح حتى ${event.expiresAt.slice(0, 10)}.` : `The link is valid until ${event.expiresAt.slice(0, 10)}.`],
        url: this.adminUrl(`/f/${event.formSlug}/edit?token=${encodeURIComponent(event.token)}`),
        urlLabel: ar ? 'تعديل إجاباتي' : 'Edit my answers',
      },
    });
  }

  @OnEvent(ACADEMIC_EVENTS.approved)
  async onApproved(event: RequestDecisionEvent): Promise<void> {
    const ar = event.lang === 'ar';
    await this.mail.enqueue({
      to: event.requester.email,
      template: 'case-update',
      lang: event.lang,
      data: {
        name: event.requester.name,
        subject: ar ? `تمت الموافقة على طلبك ${event.reference}` : `Your request ${event.reference} is approved`,
        lines: [
          ...(event.message ? [event.message] : []),
          ...(event.proposals.length ? [ar ? 'الخدمات المقترحة:' : 'Proposed services:', ...event.proposals.map((p) => `• ${p}`)] : []),
          ar ? 'سنتواصل معك لتأكيد الحجوزات.' : 'We will contact you to confirm the bookings.',
        ],
      },
    });
  }

  @OnEvent(ACADEMIC_EVENTS.rejected)
  async onRejected(event: RequestDecisionEvent): Promise<void> {
    const ar = event.lang === 'ar';
    await this.mail.enqueue({
      to: event.requester.email,
      template: 'case-update',
      lang: event.lang,
      data: {
        name: event.requester.name,
        subject: ar ? `بخصوص طلبك ${event.reference}` : `About your request ${event.reference}`,
        lines: [ar ? 'للأسف لا يمكننا متابعة طلبك.' : 'Unfortunately we cannot follow up on your request.', ...(event.message ? [event.message] : [])],
      },
    });
  }

  @OnEvent(ACADEMIC_EVENTS.cancelled)
  async onCancelled(event: RequestDecisionEvent): Promise<void> {
    const ar = event.lang === 'ar';
    await this.mail.enqueue({
      to: event.requester.email,
      template: 'case-update',
      lang: event.lang,
      data: {
        name: event.requester.name,
        subject: ar ? `تم إلغاء طلبك ${event.reference}` : `Your request ${event.reference} was cancelled`,
        lines: [ar ? `تم إلغاء الطلب «${event.title}».` : `The request "${event.title}" was cancelled.`],
      },
    });
    await this.notifications.notify(
      event.providerIds,
      { type: 'academic_request.cancelled', title: `Academic request ${event.reference} cancelled`, body: 'The related pending booking was cancelled.', data: { reference: event.reference } },
      { push: true },
    );
  }

  @OnEvent(ACADEMIC_EVENTS.booked)
  async onBooked(event: RequestBookedEvent): Promise<void> {
    const ar = event.lang === 'ar';
    await this.mail.enqueue({
      to: event.requester.email,
      template: 'case-update',
      lang: event.lang,
      data: {
        name: event.requester.name,
        subject: ar ? `حجز جديد لطلبك ${event.reference}` : `A booking was created for ${event.reference}`,
        lines: [
          ar ? `أنشأنا الحجز ${event.bookingReference} لمناسبتك «${event.title}».` : `We created booking ${event.bookingReference} for "${event.title}".`,
          ...(event.clientCreated ? [ar ? 'أنشأنا لك حساب عميل؛ ستصلك رسالة لتعيين كلمة المرور.' : 'We created a client account for you; a separate email lets you set your password.'] : []),
        ],
      },
    });
  }
}
