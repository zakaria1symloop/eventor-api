import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { Lang } from '../common/i18n/language.js';
import { MailService } from '../mail/mail.service.js';
import { NotificationsService, type AppNotificationType } from '../notifications/notifications.service.js';
import {
  BOOKING_EVENTS,
  type BookingCancelledEvent,
  type BookingEvent,
  type BookingPriceChangedEvent,
  type BookingReminderEvent,
  type BookingRescheduledEvent,
  type BookingStatusChangedEvent,
  type InvoiceSentEvent,
} from './bookings.events.js';

interface Party {
  id: string;
  email: string;
  name: string;
  lang: Lang;
  /** Profile · Notifications "Booking emails" (on until the user turns it off). */
  emails: boolean;
}

type Text = Record<Lang, { subject: string; lines: string[] }>;
type Note = Record<Lang, { title: string; body: string }>;

/**
 * Booking emails (✉️) plus a notification row and a push (🔔📱) to the client
 * and / or provider, in their language (EN/AR). Events with `notify: false`
 * (admin unticked "Notify") send nothing. Whoever made the change is not told
 * about it.
 */
@Injectable()
export class BookingsMailListener {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  private async parties(event: BookingEvent): Promise<{ client: Party | null; provider: Party | null; title: Record<Lang, string>; date: string }> {
    const [row] = await this.dataSource.query(
      `SELECT cu.id AS c_id, cu.email AS c_email, cu.full_name AS c_name, cu.language AS c_lang, cu.deleted_at AS c_deleted, COALESCE(cnp.email_bookings, 1) AS c_emails,
              pu.id AS p_id, pu.email AS p_email, pu.full_name AS p_name, pu.language AS p_lang, pu.deleted_at AS p_deleted, COALESCE(pnp.email_bookings, 1) AS p_emails,
              COALESCE(s.title_en, pk.name_en) AS title_en, COALESCE(NULLIF(s.title_ar, ''), NULLIF(pk.name_ar, ''), s.title_en, pk.name_en) AS title_ar, b.event_date
       FROM bookings b JOIN users cu ON cu.id = b.client_id JOIN users pu ON pu.id = b.provider_id
       LEFT JOIN notification_preferences cnp ON cnp.user_id = cu.id LEFT JOIN notification_preferences pnp ON pnp.user_id = pu.id
       LEFT JOIN services s ON s.id = b.service_id LEFT JOIN packs pk ON pk.id = b.pack_id WHERE b.id = ?`,
      [event.bookingId],
    );
    if (!row) return { client: null, provider: null, title: { en: '', ar: '' }, date: '' };
    const party = (prefix: 'c' | 'p'): Party | null =>
      row[`${prefix}_email`] && !row[`${prefix}_deleted`]
        ? { id: row[`${prefix}_id`], email: row[`${prefix}_email`], name: row[`${prefix}_name`], lang: row[`${prefix}_lang`] === 'ar' ? 'ar' : 'en', emails: Number(row[`${prefix}_emails`]) === 1 }
        : null;
    const date = row.event_date instanceof Date ? row.event_date.toISOString().slice(0, 10) : String(row.event_date).slice(0, 10);
    return { client: party('c'), provider: party('p'), title: { en: row.title_en ?? '', ar: row.title_ar ?? '' }, date };
  }

  private async send(to: Party | null, text: Text): Promise<void> {
    if (!to?.emails) return;
    const t = text[to.lang];
    await this.mail.enqueue({ to: to.email, template: 'booking-update', lang: to.lang, data: { name: to.name, subject: t.subject, lines: t.lines } });
  }

  /** 🔔📱 One notification row and a push to one party; the app opens the booking from `data.bookingId`. */
  private async notify(to: Party | null, type: AppNotificationType, note: Note, event: BookingEvent): Promise<void> {
    if (!to) return;
    const t = note[to.lang];
    await this.notifications.notify([to.id], { type, title: t.title, body: t.body, data: { bookingId: event.bookingId, reference: event.reference } }, { push: true });
  }

  @OnEvent(BOOKING_EVENTS.created)
  async onCreated(event: BookingEvent): Promise<void> {
    if (!event.notify) return;
    const { provider, title, date } = await this.parties(event);
    await this.send(provider, {
      en: { subject: `New booking request ${event.reference}`, lines: [`You have a new booking request for "${title.en}" on ${date}.`, 'Please accept or decline it from the app.'] },
      ar: { subject: `طلب حجز جديد ${event.reference}`, lines: [`لديك طلب حجز جديد لـ «${title.ar}» بتاريخ ${date}.`, 'يرجى قبوله أو رفضه من التطبيق.'] },
    });
    await this.notify(provider, 'booking.requested', {
      en: { title: 'New booking request', body: `"${title.en}" on ${date}. Accept or decline it in the app.` },
      ar: { title: 'طلب حجز جديد', body: `«${title.ar}» بتاريخ ${date}. اقبله أو ارفضه من التطبيق.` },
    }, event);
  }

  @OnEvent(BOOKING_EVENTS.accepted)
  async onAccepted(event: BookingStatusChangedEvent): Promise<void> {
    if (!event.notify) return;
    const { client, provider, title, date } = await this.parties(event);
    await this.send(client, {
      en: { subject: `Booking ${event.reference} accepted`, lines: [`Your booking for "${title.en}" on ${date} is confirmed.`, 'Your invoice from Eventor is available in the app. Contact details are now visible in the chat.'] },
      ar: { subject: `تم قبول الحجز ${event.reference}`, lines: [`تم تأكيد حجزك لـ «${title.ar}» بتاريخ ${date}.`, 'فاتورتك من Eventor متاحة في التطبيق، وأصبحت بيانات الاتصال ظاهرة في المحادثة.'] },
    });
    await this.send(provider, {
      en: { subject: `Booking ${event.reference} accepted`, lines: [`The booking for "${title.en}" on ${date} is confirmed.`] },
      ar: { subject: `تم قبول الحجز ${event.reference}`, lines: [`تم تأكيد الحجز لـ «${title.ar}» بتاريخ ${date}.`] },
    });
    await this.notify(client, 'booking.accepted', {
      en: { title: 'Booking confirmed', body: `Your booking for "${title.en}" on ${date} is confirmed.` },
      ar: { title: 'تم تأكيد الحجز', body: `تم تأكيد حجزك لـ «${title.ar}» بتاريخ ${date}.` },
    }, event);
  }

  @OnEvent(BOOKING_EVENTS.declined)
  async onDeclined(event: BookingStatusChangedEvent): Promise<void> {
    if (!event.notify) return;
    const { client, title, date } = await this.parties(event);
    await this.send(client, {
      en: { subject: `Booking ${event.reference} declined`, lines: [`Your booking request for "${title.en}" on ${date} was declined.`, 'You can look for another provider in the app.'] },
      ar: { subject: `تم رفض الحجز ${event.reference}`, lines: [`تم رفض طلب حجزك لـ «${title.ar}» بتاريخ ${date}.`, 'يمكنك البحث عن مقدم خدمة آخر في التطبيق.'] },
    });
    await this.notify(client, 'booking.declined', {
      en: { title: 'Booking declined', body: `Your request for "${title.en}" on ${date} was declined. You can book another provider in the app.` },
      ar: { title: 'تم رفض الحجز', body: `تم رفض طلبك لـ «${title.ar}» بتاريخ ${date}. يمكنك الحجز لدى مقدم خدمة آخر من التطبيق.` },
    }, event);
  }

  @OnEvent(BOOKING_EVENTS.cancelled)
  async onCancelled(event: BookingCancelledEvent): Promise<void> {
    if (!event.notify) return;
    const { client, provider, title, date } = await this.parties(event);
    const text: Text = {
      en: { subject: `Booking ${event.reference} cancelled`, lines: [`The booking for "${title.en}" on ${date} was cancelled.`] },
      ar: { subject: `تم إلغاء الحجز ${event.reference}`, lines: [`تم إلغاء الحجز لـ «${title.ar}» بتاريخ ${date}.`] },
    };
    const note: Note = {
      en: { title: 'Booking cancelled', body: `The booking for "${title.en}" on ${date} was cancelled.` },
      ar: { title: 'تم إلغاء الحجز', body: `تم إلغاء الحجز لـ «${title.ar}» بتاريخ ${date}.` },
    };
    // The party who cancelled, or whose account action caused it, is not told.
    if (event.causedByUserId !== event.clientId && event.cancelledBy !== 'client') {
      await this.send(client, text);
      await this.notify(client, 'booking.cancelled', note, event);
    }
    if (event.causedByUserId !== event.providerId && event.cancelledBy !== 'provider') {
      await this.send(provider, text);
      await this.notify(provider, 'booking.cancelled', note, event);
    }
  }

  @OnEvent(BOOKING_EVENTS.completed)
  async onCompleted(event: BookingStatusChangedEvent): Promise<void> {
    if (!event.notify) return;
    const { client, provider, title } = await this.parties(event);
    const text: Text = {
      en: { subject: `Booking ${event.reference} completed`, lines: [`The booking for "${title.en}" is marked as completed. Thank you for using Eventor.`] },
      ar: { subject: `اكتمل الحجز ${event.reference}`, lines: [`تم تسجيل الحجز لـ «${title.ar}» كمكتمل. شكرًا لاستخدامك Eventor.`] },
    };
    await this.send(client, text);
    await this.send(provider, text);
    const note: Note = {
      en: { title: 'Booking completed', body: `"${title.en}" is marked as completed. Thank you for using Eventor.` },
      ar: { title: 'اكتمل الحجز', body: `تم تسجيل «${title.ar}» كمكتمل. شكرًا لاستخدامك Eventor.` },
    };
    for (const party of [client, provider]) {
      if (party && party.id !== event.actorId) await this.notify(party, 'booking.completed', note, event);
    }
  }

  /** Both parties, minus whoever moved it, proposed it or answered the proposal. */
  private others(parties: (Party | null)[], event: BookingRescheduledEvent): Party[] {
    return parties.filter((p): p is Party => !!p && p.id !== event.actorId);
  }

  @OnEvent(BOOKING_EVENTS.rescheduled)
  async onRescheduled(event: BookingRescheduledEvent): Promise<void> {
    if (!event.notify) return;
    const { client, provider, title } = await this.parties(event);
    for (const party of this.others([client, provider], event)) {
      await this.send(party, {
        en: { subject: `New date for booking ${event.reference}`, lines: [`The booking for "${title.en}" moved from ${event.oldDate} to ${event.newDate}.`] },
        ar: { subject: `تاريخ جديد للحجز ${event.reference}`, lines: [`تم نقل الحجز لـ «${title.ar}» من ${event.oldDate} إلى ${event.newDate}.`] },
      });
      await this.notify(party, 'booking.rescheduled', {
        en: { title: 'New date for your booking', body: `"${title.en}" moved from ${event.oldDate} to ${event.newDate}.` },
        ar: { title: 'تاريخ جديد لحجزك', body: `تم نقل «${title.ar}» من ${event.oldDate} إلى ${event.newDate}.` },
      }, event);
    }
  }

  @OnEvent(BOOKING_EVENTS.rescheduleProposed)
  async onRescheduleProposed(event: BookingRescheduledEvent): Promise<void> {
    if (!event.notify) return;
    const { client, provider, title } = await this.parties(event);
    const by =
      event.actorId === event.clientId ? { en: 'The client', ar: 'العميل' } : event.actorId === event.providerId ? { en: 'The provider', ar: 'مقدم الخدمة' } : { en: 'Eventor', ar: 'Eventor' };
    for (const party of this.others([client, provider], event)) {
      await this.send(party, {
        en: { subject: `New date proposed for booking ${event.reference}`, lines: [`${by.en} proposed to move "${title.en}" from ${event.oldDate} to ${event.newDate}.`, 'Please accept or decline the new date in the app.'] },
        ar: { subject: `اقتراح تاريخ جديد للحجز ${event.reference}`, lines: [`اقترح ${by.ar} نقل «${title.ar}» من ${event.oldDate} إلى ${event.newDate}.`, 'يرجى قبول التاريخ الجديد أو رفضه من التطبيق.'] },
      });
      await this.notify(party, 'booking.reschedule_proposed', {
        en: { title: 'New date proposed', body: `${by.en} proposed to move "${title.en}" from ${event.oldDate} to ${event.newDate}. Accept or decline it in the app.` },
        ar: { title: 'اقتراح تاريخ جديد', body: `اقترح ${by.ar} نقل «${title.ar}» من ${event.oldDate} إلى ${event.newDate}. اقبله أو ارفضه من التطبيق.` },
      }, event);
    }
  }

  @OnEvent(BOOKING_EVENTS.rescheduleRejected)
  async onRescheduleRejected(event: BookingRescheduledEvent): Promise<void> {
    if (!event.notify) return;
    const { client, provider, title } = await this.parties(event);
    for (const party of this.others([client, provider], event)) {
      await this.send(party, {
        en: { subject: `New date declined for booking ${event.reference}`, lines: [`The proposal to move "${title.en}" to ${event.newDate} was declined. The booking stays on ${event.oldDate}.`] },
        ar: { subject: `تم رفض التاريخ الجديد للحجز ${event.reference}`, lines: [`تم رفض اقتراح نقل «${title.ar}» إلى ${event.newDate}. يبقى الحجز بتاريخ ${event.oldDate}.`] },
      });
      await this.notify(party, 'booking.reschedule_rejected', {
        en: { title: 'New date declined', body: `The proposal to move "${title.en}" to ${event.newDate} was declined. The booking stays on ${event.oldDate}.` },
        ar: { title: 'تم رفض التاريخ الجديد', body: `تم رفض اقتراح نقل «${title.ar}» إلى ${event.newDate}. يبقى الحجز بتاريخ ${event.oldDate}.` },
      }, event);
    }
  }

  @OnEvent(BOOKING_EVENTS.priceChanged)
  async onPriceChanged(event: BookingPriceChangedEvent): Promise<void> {
    if (!event.notify) return;
    const { client } = await this.parties(event);
    await this.send(client, {
      en: { subject: `Price updated for booking ${event.reference}`, lines: [`The total changed from ${event.oldTotal} DZD to ${event.newTotal} DZD.`] },
      ar: { subject: `تم تعديل سعر الحجز ${event.reference}`, lines: [`تغير المجموع من ${event.oldTotal} دج إلى ${event.newTotal} دج.`] },
    });
    await this.notify(client, 'booking.price_changed', {
      en: { title: 'Price updated', body: `The total for booking ${event.reference} changed from ${event.oldTotal} DZD to ${event.newTotal} DZD.` },
      ar: { title: 'تم تعديل السعر', body: `تغير مجموع الحجز ${event.reference} من ${event.oldTotal} دج إلى ${event.newTotal} دج.` },
    }, event);
  }

  @OnEvent(BOOKING_EVENTS.reminderSent)
  async onReminder(event: BookingReminderEvent): Promise<void> {
    const { provider, title, date } = await this.parties(event);
    await this.send(provider, {
      en: { subject: `Reminder: booking ${event.reference} is waiting for your reply`, lines: [`A client is waiting for your answer about "${title.en}" on ${date}.`, 'Please accept or decline the request in the app.'] },
      ar: { subject: `تذكير: الحجز ${event.reference} في انتظار ردك`, lines: [`عميل ينتظر ردك بخصوص «${title.ar}» بتاريخ ${date}.`, 'يرجى قبول الطلب أو رفضه من التطبيق.'] },
    });
    await this.notify(provider, 'booking.reminder', {
      en: { title: 'A client is waiting for your reply', body: `Booking ${event.reference}: "${title.en}" on ${date}. Accept or decline it in the app.` },
      ar: { title: 'عميل ينتظر ردك', body: `الحجز ${event.reference}: «${title.ar}» بتاريخ ${date}. اقبله أو ارفضه من التطبيق.` },
    }, event);
  }

  @OnEvent(BOOKING_EVENTS.reviewRequested)
  async onReviewRequested(event: BookingEvent): Promise<void> {
    const { client, title } = await this.parties(event);
    await this.send(client, {
      en: { subject: 'How was your event?', lines: [`Leave a review for "${title.en}" (${event.reference}) in the Eventor app.`] },
      ar: { subject: 'كيف كانت مناسبتك؟', lines: [`اترك تقييمًا لـ «${title.ar}» (${event.reference}) في تطبيق Eventor.`] },
    });
    await this.notify(client, 'booking.review_requested', {
      en: { title: 'How was your event?', body: `Leave a review for "${title.en}".` },
      ar: { title: 'كيف كانت مناسبتك؟', body: `اترك تقييمًا لـ «${title.ar}».` },
    }, event);
  }

  @OnEvent(BOOKING_EVENTS.invoiceSent)
  async onInvoiceSent(event: InvoiceSentEvent): Promise<void> {
    if (!event.client?.email) return;
    await this.mail.enqueue({
      to: event.client.email,
      template: 'invoice',
      lang: event.client.lang,
      data: { name: event.client.name, number: event.number, reference: event.reference, total: event.total },
      attachments: [{ filename: `${event.number}.pdf`, path: event.pdfPath, contentType: 'application/pdf' }],
    });
  }
}
