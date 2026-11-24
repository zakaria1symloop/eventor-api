import type { Lang } from '../common/i18n/language.js';

/**
 * BUG-G2: booking system messages in a chat. Each one is stored with a
 * structured part (`messages.system_event` + `system_data`) so the app can open
 * the booking and render the text itself; `body` is rendered from it in the
 * reader's language (older app builds just print `body`).
 */
export const SYSTEM_EVENTS = [
  'booking_requested',
  'booking_accepted',
  'booking_declined',
  'booking_cancelled',
  'booking_completed',
  'booking_expired',
  'reschedule_proposed',
  'reschedule_accepted',
  'reschedule_declined',
  /** A move applied at once: a pending booking, or an admin forcing it. */
  'booking_rescheduled',
] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

/** Who acted: the app says "The client", "The provider" or "Eventor". */
export type SystemActor = 'client' | 'provider' | 'admin' | 'system';

export interface SystemMessageParams {
  /** Event day (`YYYY-MM-DD`), its last day for a multi-day booking, and the hours (`HH:mm`). */
  date: string;
  endDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** Reschedules: the day before and after the move, and the new hours. */
  oldDate?: string | null;
  newDate?: string | null;
  newStartTime?: string | null;
  newEndTime?: string | null;
  /** Reschedules of a per-hour service (BUG-E3): the total before and with the new hours, when it changes. */
  oldTotal?: string | null;
  newTotal?: string | null;
  titleEn: string;
  titleAr: string;
  actor?: SystemActor | null;
  /** Decline / cancel reason code, as stored. */
  reason?: string | null;
  /** `booking_expired`: which limit ran out (BUG-F1), and the reply deadline then. */
  expiryCause?: 'reply_deadline' | 'event_started' | null;
  replyDeadlineHours?: number | null;
}

export interface SystemMessageData {
  bookingId: string;
  bookingRef: string;
  params: SystemMessageParams;
}

/** "3 December 2026" / "3 ديسمبر 2026" — the date of an event, not a timestamp (no time-zone shift). */
export function humanDate(date: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-DZ' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/** " (18:00–22:00)", the same in both languages. */
const hours = (start: string | null | undefined, end: string | null | undefined, _lang: Lang): string => (start && end ? ` (${start}–${end})` : '');

const ACTORS: Record<SystemActor, Record<Lang, string>> = {
  client: { en: 'The client', ar: 'العميل' },
  provider: { en: 'The provider', ar: 'مقدم الخدمة' },
  admin: { en: 'Eventor', ar: 'Eventor' },
  system: { en: 'Eventor', ar: 'Eventor' },
};

/** The message text in one language, from the stored structured part. */
export function renderSystemMessage(event: SystemEvent, data: SystemMessageData, lang: Lang): string {
  const p = data.params;
  const ref = data.bookingRef;
  const title = lang === 'ar' ? p.titleAr || p.titleEn : p.titleEn || p.titleAr;
  const day = (date: string | null | undefined) => (date ? humanDate(date, lang) : '');
  const span = p.endDate && p.endDate !== p.date ? (lang === 'ar' ? `${day(p.date)} إلى ${day(p.endDate)}` : `${day(p.date)} to ${day(p.endDate)}`) : day(p.date);
  const who = ACTORS[p.actor ?? 'system'][lang];
  const total =
    p.newTotal && p.oldTotal && p.newTotal !== p.oldTotal
      ? lang === 'ar'
        ? ` المجموع الجديد: ${p.newTotal} دج (كان ${p.oldTotal} دج).`
        : ` New total: ${p.newTotal} DZD (was ${p.oldTotal} DZD).`
      : '';
  const moved = `${day(p.newDate)}${hours(p.newStartTime, p.newEndTime, lang)}`;
  const en: Record<SystemEvent, () => string> = {
    booking_requested: () => `Booking ${ref} requested for ${span}${hours(p.startTime, p.endTime, lang)}: ${title}.`,
    booking_accepted: () => `Booking ${ref} accepted. Contact details are now visible to both of you.`,
    booking_declined: () => `${who} declined booking ${ref}.`,
    booking_cancelled: () => `${who} cancelled booking ${ref}.`,
    booking_completed: () => `Booking ${ref} is completed.`,
    booking_expired: () =>
      `Booking request ${ref} expired: ${
        p.expiryCause === 'reply_deadline' ? `no reply within ${p.replyDeadlineHours ?? 48} h` : p.expiryCause === 'event_started' ? 'the event start passed without a reply' : 'no reply in time'
      }. The date is free again.`,
    reschedule_proposed: () => `${who} proposed to move booking ${ref} to ${moved}.${total}`,
    reschedule_accepted: () => `Booking ${ref} moved to ${moved}.${total}`,
    reschedule_declined: () => `The new date for booking ${ref} (${day(p.newDate)}) was declined. The booking stays on ${day(p.oldDate)}.`,
    booking_rescheduled: () => `Booking ${ref} moved to ${moved}.${total}`,
  };
  const ar: Record<SystemEvent, () => string> = {
    booking_requested: () => `تم طلب الحجز ${ref} بتاريخ ${span}${hours(p.startTime, p.endTime, lang)}: ${title}.`,
    booking_accepted: () => `تم قبول الحجز ${ref}. أصبحت بيانات الاتصال مرئية لكليكما.`,
    booking_declined: () => `رفض ${who} الحجز ${ref}.`,
    booking_cancelled: () => `ألغى ${who} الحجز ${ref}.`,
    booking_completed: () => `اكتمل الحجز ${ref}.`,
    booking_expired: () =>
      `انتهت صلاحية طلب الحجز ${ref}: ${
        p.expiryCause === 'reply_deadline' ? `لم يتم الرد خلال ${p.replyDeadlineHours ?? 48} ساعة` : p.expiryCause === 'event_started' ? 'حلّ موعد المناسبة دون رد' : 'لم يتم الرد في الوقت المحدد'
      }. التاريخ متاح من جديد.`,
    reschedule_proposed: () => `اقترح ${who} نقل الحجز ${ref} إلى ${moved}.${total}`,
    reschedule_accepted: () => `تم نقل الحجز ${ref} إلى ${moved}.${total}`,
    reschedule_declined: () => `تم رفض الموعد الجديد للحجز ${ref} (${day(p.newDate)}). يبقى الحجز بتاريخ ${day(p.oldDate)}.`,
    booking_rescheduled: () => `تم نقل الحجز ${ref} إلى ${moved}.${total}`,
  };
  return (lang === 'ar' ? ar : en)[event]();
}

/** The structured part read back from a `messages` row (`system_data` comes as JSON text or an object). */
export function readSystemPart(row: { system_event?: string | null; system_data?: unknown }): { event: SystemEvent; data: SystemMessageData } | null {
  if (!row.system_event || !(SYSTEM_EVENTS as readonly string[]).includes(row.system_event)) return null;
  const data = typeof row.system_data === 'string' ? (JSON.parse(row.system_data) as SystemMessageData) : (row.system_data as SystemMessageData | null);
  return data?.bookingId ? { event: row.system_event as SystemEvent, data } : null;
}
