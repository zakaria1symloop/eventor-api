import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Lang } from '../common/i18n/language.js';
import { MailService } from '../mail/mail.service.js';
import { PACK_EVENTS, type PackNeedsAttentionEvent } from '../packs/packs.events.js';
import { HIDE_REASONS } from './dto/services.dto.js';
import { SERVICE_EVENTS, type ServiceEvent, type ServiceHiddenEvent } from './services.events.js';

const HIDE_REASON_LABELS: Record<(typeof HIDE_REASONS)[number], Record<Lang, string>> = {
  misleading_content: { en: 'misleading content', ar: 'محتوى مضلل' },
  inappropriate_content: { en: 'inappropriate content', ar: 'محتوى غير لائق' },
  wrong_category: { en: 'wrong category', ar: 'فئة خاطئة' },
  duplicate: { en: 'duplicate service', ar: 'خدمة مكررة' },
  reported_by_clients: { en: 'reported by clients', ar: 'تبليغات من العملاء' },
  provider_request: { en: 'at your request', ar: 'بطلب منك' },
  other: { en: 'other reason', ar: 'سبب آخر' },
};

/** Provider emails for service moderation and packs needing attention (EN/AR, the provider's language). */
@Injectable()
export class ServicesMailListener {
  constructor(private readonly mail: MailService) {}

  private title(event: { titleEn: string; titleAr: string }, lang: Lang): string {
    return lang === 'ar' && event.titleAr ? event.titleAr : event.titleEn;
  }

  @OnEvent(SERVICE_EVENTS.hidden)
  async onHidden(event: ServiceHiddenEvent): Promise<void> {
    if (!event.provider.email) return;
    const lang = event.provider.lang;
    await this.mail.enqueue({
      to: event.provider.email,
      template: 'service-hidden',
      lang,
      data: {
        name: event.provider.name,
        title: this.title(event, lang),
        reason: HIDE_REASON_LABELS[event.reason as keyof typeof HIDE_REASON_LABELS]?.[lang] ?? event.reason,
        message: event.message,
        allowResubmit: event.allowResubmit,
      },
    });
  }

  @OnEvent(SERVICE_EVENTS.shown)
  async onShown(event: ServiceEvent): Promise<void> {
    if (!event.provider.email) return;
    await this.mail.enqueue({ to: event.provider.email, template: 'service-shown', lang: event.provider.lang, data: { name: event.provider.name, title: this.title(event, event.provider.lang) } });
  }

  @OnEvent(PACK_EVENTS.needsAttention)
  async onPackNeedsAttention(event: PackNeedsAttentionEvent): Promise<void> {
    if (!event.provider.email) return;
    const lang = event.provider.lang;
    await this.mail.enqueue({
      to: event.provider.email,
      template: 'pack-needs-attention',
      lang,
      data: { name: event.provider.name, pack: lang === 'ar' && event.nameAr ? event.nameAr : event.nameEn },
    });
  }
}
