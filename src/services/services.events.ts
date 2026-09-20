import type { Lang } from '../common/i18n/language.js';

export const SERVICE_EVENTS = {
  published: 'service.published',
  unpublished: 'service.unpublished',
  /** Admin hid the service; the provider is emailed (🔔📱 later). */
  hidden: 'service.hidden',
  /** Admin showed a hidden service again; the provider is emailed. */
  shown: 'service.shown',
  deleted: 'service.deleted',
  updated: 'service.updated',
} as const;

export interface ServiceRecipient {
  userId: string;
  email: string;
  name: string;
  lang: Lang;
}

export interface ServiceEvent {
  serviceId: string;
  providerId: string;
  titleEn: string;
  titleAr: string;
  provider: ServiceRecipient;
}

export interface ServiceHiddenEvent extends ServiceEvent {
  reason: string;
  message: string | null;
  allowResubmit: boolean;
}
