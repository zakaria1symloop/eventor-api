import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DocumentRejectReason, DocumentType } from '../common/enums/file.enums.js';
import type { Lang } from '../common/i18n/language.js';
import { MailService } from '../mail/mail.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { VERIFICATION_EVENTS, type DocumentRejectedEvent, type ProviderVerifiedEvent } from './verification.events.js';

const DOCUMENT_LABELS: Record<DocumentType, Record<Lang, string>> = {
  [DocumentType.NationalId]: { en: 'National ID card', ar: 'بطاقة التعريف الوطنية' },
  [DocumentType.CommercialRegisterOrArtisanCard]: { en: 'Commercial register or artisan card', ar: 'السجل التجاري أو بطاقة الحرفي' },
  [DocumentType.TaxCard]: { en: 'Tax card (NIF)', ar: 'البطاقة الجبائية (NIF)' },
};

const REASON_LABELS: Record<DocumentRejectReason, Record<Lang, string>> = {
  [DocumentRejectReason.Unreadable]: { en: 'unreadable', ar: 'غير مقروءة' },
  [DocumentRejectReason.Expired]: { en: 'expired', ar: 'منتهية الصلاحية' },
  [DocumentRejectReason.NameMismatch]: { en: 'name does not match the account', ar: 'الاسم لا يطابق الحساب' },
  [DocumentRejectReason.WrongDocument]: { en: 'wrong document', ar: 'وثيقة خاطئة' },
  [DocumentRejectReason.Other]: { en: 'other reason', ar: 'سبب آخر' },
};

/**
 * Verification emails (EN/AR, the provider's language) plus the in-app
 * notification rows (🔔📱, status-rules §2). Writing the row makes the `/app`
 * gateway emit `notification:new` to the provider's sockets; the push itself is
 * still the logging stub until Firebase credentials are configured.
 */
@Injectable()
export class VerificationMailListener {
  constructor(
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(VERIFICATION_EVENTS.verified)
  async onVerified(event: ProviderVerifiedEvent): Promise<void> {
    await this.mail.enqueue({ to: event.email, template: 'provider-verified', lang: event.lang, data: { name: event.name } });
    const ar = event.lang === 'ar';
    await this.notifications.notify(
      [event.userId],
      {
        type: 'verification.approved',
        title: ar ? 'تم توثيق ملفك' : 'Profile approved',
        body: ar ? 'تم توثيق حسابك كمقدم خدمة. خدماتك المنشورة أصبحت ظاهرة في التطبيق.' : 'Your provider profile is verified. Your published services are now visible in the app.',
        data: {},
      },
      { push: true },
    );
  }

  @OnEvent(VERIFICATION_EVENTS.documentRejected)
  async onRejected(event: DocumentRejectedEvent): Promise<void> {
    const ar = event.lang === 'ar';
    await this.notifications.notify(
      [event.userId],
      {
        type: 'verification.rejected',
        title: ar ? 'وثيقة مرفوضة' : 'Document rejected',
        body: ar
          ? `تم رفض وثيقة «${DOCUMENT_LABELS[event.type].ar}» (${REASON_LABELS[event.reasonCode].ar}). ${event.message}`
          : `Your "${DOCUMENT_LABELS[event.type].en}" was rejected (${REASON_LABELS[event.reasonCode].en}). ${event.message}`,
        data: { documentType: event.type },
      },
      { push: true },
    );
    await this.mail.enqueue({
      to: event.email,
      template: 'document-rejected',
      lang: event.lang,
      data: {
        name: event.name,
        document: DOCUMENT_LABELS[event.type][event.lang],
        reason: REASON_LABELS[event.reasonCode][event.lang],
        message: event.message,
      },
    });
  }
}
