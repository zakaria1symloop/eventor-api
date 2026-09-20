/**
 * Demo bookings, invoices and conversations (modules 8 and 11), called by
 * `demo-seed.ts` inside its transaction after the services and packs.
 *
 * About 180 bookings from 90 days ago to 60 days ahead with realistic statuses
 * (pending, some past the 48 h reply deadline; accepted upcoming; completed;
 * declined; cancelled; disputes come with module 10), lines and totals, status history,
 * reschedules and price changes, invoices for accepted and completed bookings
 * (PDFs are rendered on first download), held / booked availability, one
 * direct conversation per client ↔ provider pair (3–15 FR / EN / AR messages,
 * some with phone numbers that get masked), a few support conversations and
 * reported messages. Figma examples: EVT-002041 Amina Benali ↔ Studio Lumière,
 * Karima Ait ↔ DJ Amine.
 *
 * Idempotent: skipped when EVT-002041 exists. References EVT-001900… and the
 * invoice numbers are written directly; the sequences are moved past them.
 */
import argon2 from 'argon2';
import type { EntityManager } from 'typeorm';
import { computeFee, computeLines, computeTotals, packLines, serviceQuantity, type LineInput } from '../../bookings/bookings.policy.js';
import { BookingLineKind } from '../../common/enums/booking.enums.js';
import type { PriceType } from '../../common/enums/catalog.enums.js';
import { Language, UserRole, UserStatus, VerificationStatus } from '../../common/enums/user.enums.js';
import { maskContacts } from '../../messaging/contact-masking.js';
import { SETTINGS_DEFAULTS } from '../../settings/settings.defaults.js';

export interface BookingSeedContext {
  em: EntityManager;
  /** Admin who acts on bookings and writes support messages. */
  admin: { id: string; fullName: string } | null;
}

export interface BookingSeedSummary {
  bookings: number;
  invoices: number;
  conversations: number;
  messages: number;
  reschedules: number;
  priceChanges: number;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const uuid = () => crypto.randomUUID();
const algiersDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** Local Algiers wall time to a UTC instant (UTC+1, no DST). */
const localToUtc = (date: string, time: string) => new Date(`${date}T${time}:00+01:00`);

const EVENT_TYPES_BY_CATEGORY: Record<string, string[]> = {
  'salles-des-fetes': ['wedding', 'wedding', 'engagement', 'corporate'],
  photographie: ['wedding', 'engagement', 'birthday', 'graduation'],
  traiteur: ['wedding', 'henna', 'circumcision', 'corporate'],
  'musique-dj': ['wedding', 'birthday', 'engagement'],
  decoration: ['wedding', 'engagement', 'birthday'],
  fleurs: ['wedding', 'engagement'],
  'gateaux-patisserie': ['wedding', 'birthday', 'engagement', 'graduation'],
  beaute: ['wedding', 'henna'],
  transport: ['wedding'],
};

const SLOTS: [string, string][] = [
  ['18:00', '23:30'],
  ['14:00', '19:00'],
  ['19:00', '01:00'],
  ['10:00', '16:00'],
  ['17:00', '22:00'],
];

const NOTES = [
  'Merci de venir 1 h avant le début.',
  'The hall is on the first floor, there is a lift.',
  'نرجو الالتزام بالوقت من فضلكم.',
  null,
  'Possibilité de prévoir un menu enfant ?',
  null,
  'Please bring an extra battery for the evening.',
];

const DECLINE_REASONS = ['date_unavailable', 'outside_service_area', 'guest_count_too_high', 'other'];
const CANCEL_REASONS = ['client_changed_plans', 'event_postponed', 'provider_unavailable', 'found_another_provider', 'duplicate_booking'];

/** Chat lines: [sender, text]. `c` = client, `p` = provider. {phone}/{email} are replaced per pair. */
const CHAT_SCRIPTS: ['c' | 'p', string][][] = [
  [
    ['c', 'Bonjour, vous êtes disponible le {date} ?'],
    ['p', 'Bonjour ! Oui, la date est encore libre. Combien d’invités ?'],
    ['c', 'Environ {guests} personnes.'],
    ['p', 'Parfait, je vous envoie les détails de la prestation.'],
    ['c', 'Vous pouvez m’appeler au {phone} pour en parler ?'],
    ['p', 'Je préfère qu’on reste sur Eventor jusqu’à la confirmation, merci de votre compréhension.'],
    ['c', 'D’accord, pas de souci.'],
    ['p', 'La réservation est confirmée de mon côté.'],
    ['c', 'Merci beaucoup !'],
  ],
  [
    ['c', 'Hello, is the price per event or per hour?'],
    ['p', 'Hello, the price is for the whole event.'],
    ['c', 'Great. Can we add a second photographer?'],
    ['p', 'Yes, I can adjust the price for that.'],
    ['c', 'Send me the quote at {email} please.'],
    ['p', 'I will share it here in the chat.'],
    ['c', 'Perfect, thanks.'],
  ],
  [
    ['c', 'السلام عليكم، هل التاريخ {date} متاح؟'],
    ['p', 'وعليكم السلام، نعم متاح بإذن الله.'],
    ['c', 'كم عدد الساعات المشمولة؟'],
    ['p', 'خمس ساعات مع إمكانية التمديد.'],
    ['c', 'ممتاز، هذا رقمي {phone} للتواصل.'],
    ['p', 'شكرًا، سنتواصل هنا حتى تأكيد الحجز.'],
    ['c', 'تمام، في انتظار ردكم.'],
    ['p', 'تم قبول الحجز، مبروك مسبقًا!'],
    ['c', 'الله يبارك فيك.'],
    ['p', 'نلتقي يوم المناسبة إن شاء الله.'],
  ],
  [
    ['c', 'Salam, c’est possible de décaler l’heure de début à 19h ?'],
    ['p', 'Oui, pas de problème pour 19h.'],
    ['c', 'Et pour le parking des invités ?'],
    ['p', 'Il y a un parking gratuit juste à côté de la salle.'],
    ['c', 'Top, on se voit le {date} alors.'],
  ],
  [
    ['c', 'Hi! We are {guests} guests, is that ok?'],
    ['p', 'Yes, that works for us.'],
    ['c', 'Do you need a deposit?'],
    ['p', 'Payment is in cash on the day, no deposit needed through the app.'],
    ['c', 'Ok. My WhatsApp is {phone} if needed.'],
    ['p', 'Noted, but let’s keep the conversation here for now.'],
    ['c', 'Sure.'],
    ['p', 'See you soon!'],
  ],
  [
    ['c', 'Bonsoir, la décoration inclut les fleurs naturelles ?'],
    ['p', 'Bonsoir, oui les compositions sont en fleurs naturelles.'],
    ['c', 'Super. Et le montage se fait à quelle heure ?'],
    ['p', 'On arrive 3 heures avant le début.'],
    ['c', 'Très bien, merci.'],
    ['p', 'Avec plaisir. Voici notre page : instagram.com/decoprestige'],
    ['c', 'Merci, je regarde.'],
  ],
];

const SUPPORT_THREADS: { email?: string; role: UserRole; lines: ['u' | 'a', string][] }[] = [
  {
    role: UserRole.Client,
    lines: [
      ['u', 'Bonjour, le prestataire ne répond pas depuis 3 jours à ma demande.'],
      ['a', 'Bonjour, merci pour votre message. Nous avons relancé le prestataire et revenons vers vous sous 24 h.'],
      ['u', 'Merci beaucoup.'],
    ],
  },
  {
    role: UserRole.Provider,
    lines: [
      ['u', 'Hello, how do I change the date of an accepted booking?'],
      ['a', 'Hello, open the booking and use "Propose a new date"; the client confirms it in the app.'],
    ],
  },
  {
    role: UserRole.Client,
    lines: [
      ['u', 'مرحبًا، أريد إلغاء حجزي، هل هناك رسوم؟'],
      ['a', 'مرحبًا، لا توجد رسوم إلغاء عبر التطبيق. يمكنك الإلغاء من صفحة الحجز.'],
      ['u', 'شكرًا جزيلًا.'],
      ['a', 'على الرحب والسعة.'],
    ],
  },
  {
    role: UserRole.Provider,
    lines: [['a', 'Bonjour, nous avons reçu un signalement concernant le partage de numéros de téléphone dans vos conversations. Merci de rester sur Eventor jusqu’à la confirmation des réservations.']],
  },
];

interface OfferRow {
  kind: 'service' | 'pack';
  id: string;
  provider_id: string;
  provider_name: string;
  business_name: string;
  provider_status: UserStatus;
  title_en: string;
  title_ar: string;
  price: string;
  price_type: PriceType | null;
  slug: string;
  wilaya: number;
}

type Status = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'completed';

export async function seedBookings(ctx: BookingSeedContext): Promise<BookingSeedSummary> {
  const { em } = ctx;
  const summary: BookingSeedSummary = { bookings: 0, invoices: 0, conversations: 0, messages: 0, reschedules: 0, priceChanges: 0 };
  const rand = prng(8_2041);
  const between = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const chance = (p: number) => rand() < p;

  // Figma clients
  for (const [fullName, email, phone, lang] of [
    ['Amina Benali', 'amina.benali@gmail.com', '+213555204101', Language.Ar],
    ['Karima Ait', 'karima.ait@gmail.com', '+213661204102', Language.En],
  ] as const) {
    const [exists] = await em.query('SELECT id FROM users WHERE email = ?', [email]);
    if (exists) continue;
    await em.query(
      `INSERT INTO users (id, created_at, updated_at, role, status, verification_status, full_name, email, email_verified_at, phone, password_hash, language, wilaya_code, last_active_at)
       VALUES (UUID(), ?, ?, 'client', 'active', 'not_required', ?, ?, ?, ?, ?, ?, 16, ?)`,
      [new Date(Date.now() - 150 * DAY), new Date(), fullName, email, new Date(Date.now() - 150 * DAY), phone, await argon2.hash(`demo-${email}`, { type: argon2.argon2id }), lang, new Date(Date.now() - 2 * HOUR)],
    );
  }

  const [done] = await em.query("SELECT id FROM bookings WHERE reference = 'EVT-002041'");
  if (done) return summary;

  const now = new Date();
  const today = algiersDate(now);
  const clients: { id: string; full_name: string; email: string; phone: string | null }[] = await em.query(
    "SELECT id, full_name, email, phone FROM users WHERE role = 'client' AND deleted_at IS NULL AND status = 'active' ORDER BY created_at, email",
  );
  const offers: OfferRow[] = [
    ...(await em.query(
      `SELECT 'service' AS kind, s.id, s.provider_id, u.full_name AS provider_name, pp.business_name, u.status AS provider_status, s.title_en, s.title_ar, s.base_price AS price, s.price_type,
              c.slug, COALESCE((SELECT MIN(sw.wilaya_code) FROM service_wilayas sw WHERE sw.service_id = s.id), u.wilaya_code, 16) AS wilaya
       FROM services s JOIN users u ON u.id = s.provider_id JOIN provider_profiles pp ON pp.user_id = u.id JOIN categories c ON c.id = s.category_id
       WHERE s.deleted_at IS NULL AND s.status IN ('published', 'hidden') AND u.verification_status = ? ORDER BY pp.business_name, s.title_en`,
      [VerificationStatus.Verified],
    )),
    ...(await em.query(
      `SELECT 'pack' AS kind, p.id, p.provider_id, u.full_name AS provider_name, pp.business_name, u.status AS provider_status, p.name_en AS title_en, p.name_ar AS title_ar, p.price, NULL AS price_type,
              'salles-des-fetes' AS slug, p.wilaya_code AS wilaya
       FROM packs p JOIN users u ON u.id = p.provider_id JOIN provider_profiles pp ON pp.user_id = u.id
       WHERE p.deleted_at IS NULL AND p.status = 'published' AND u.verification_status = ? ORDER BY pp.business_name, p.name_en`,
      [VerificationStatus.Verified],
    )),
  ];
  if (clients.length === 0 || offers.length === 0) return summary;
  const serviceOffers = offers.filter((o) => o.kind === 'service');
  const packOffers = offers.filter((o) => o.kind === 'pack');
  const activeServiceOffers = serviceOffers.filter((o) => o.provider_status === UserStatus.Active);
  const extrasByService = new Map<string, { id: string; name_en: string; price: string }[]>();
  for (const row of (await em.query('SELECT id, service_id, name_en, price FROM service_extras WHERE deleted_at IS NULL ORDER BY position')) as any[]) {
    extrasByService.set(row.service_id, [...(extrasByService.get(row.service_id) ?? []), row]);
  }
  const packItems = new Map<string, { serviceId: string; titleEn: string; basePrice: string }[]>();
  for (const row of (await em.query('SELECT pi.pack_id, s.id, s.title_en, s.base_price FROM pack_items pi JOIN services s ON s.id = pi.service_id ORDER BY pi.position')) as any[]) {
    packItems.set(row.pack_id, [...(packItems.get(row.pack_id) ?? []), { serviceId: row.id, titleEn: row.title_en, basePrice: String(row.base_price) }]);
  }
  const communes: { id: string; wilaya_code: number; name: string }[] = await em.query('SELECT id, wilaya_code, name FROM communes WHERE deleted_at IS NULL');
  const admin = ctx.admin;
  const fee = { service: Number(SETTINGS_DEFAULTS.platform_fee_percent).toFixed(2), pack: Number(SETTINGS_DEFAULTS.pack_fee_percent).toFixed(2) };

  const [invoiceSeq] = await em.query("SELECT value FROM sequences WHERE name = 'invoice_2026'");
  let invoiceNumber = Math.max(300, Number(invoiceSeq?.value ?? 0));
  const invoiceYear = now.getUTCFullYear();

  const conversations = new Map<string, { id: string; clientId: string; providerId: string; bookings: { id: string; status: Status; createdAt: Date; eventDate: string; guests: number | null }[] }>();

  const TOTAL = 180;
  const FIRST_REF = 1900;
  for (let i = 0; i < TOTAL; i++) {
    const reference = `EVT-${String(FIRST_REF + i).padStart(6, '0')}`;
    const figmaAmina = reference === 'EVT-002041';
    const figmaKarima = reference === 'EVT-002038';

    let offer: OfferRow;
    let client: (typeof clients)[number];
    let dayOffset: number;
    if (figmaAmina) {
      offer = serviceOffers.find((o) => o.business_name === 'Studio Lumière' && o.title_en === 'Wedding photo & video coverage') ?? pick(activeServiceOffers);
      client = clients.find((c) => c.email === 'amina.benali@gmail.com') ?? pick(clients);
      dayOffset = 32;
    } else if (figmaKarima) {
      offer = serviceOffers.find((o) => o.business_name === 'DJ Amine' && o.title_en === 'DJ set · 5 hours') ?? pick(serviceOffers);
      client = clients.find((c) => c.email === 'karima.ait@gmail.com') ?? pick(clients);
      dayOffset = -12;
    } else {
      offer = packOffers.length && chance(0.15) ? pick(packOffers) : pick(activeServiceOffers.length ? activeServiceOffers : serviceOffers);
      client = pick(clients);
      dayOffset = between(-90, 60);
    }
    // A blocked provider only has past bookings.
    if (offer.provider_status === UserStatus.Blocked && dayOffset >= 0) dayOffset = -between(5, 60);

    const eventDate = addDays(today, dayOffset);
    const [start, end] = pick(SLOTS);
    const eventStart = localToUtc(eventDate, start);
    const leadDays = between(4, 45);
    const createdAt = new Date(Math.min(now.getTime() - between(2, 70) * HOUR, eventStart.getTime() - leadDays * DAY));
    const eventType = figmaAmina ? 'wedding' : pick(EVENT_TYPES_BY_CATEGORY[offer.slug] ?? ['wedding']);
    const guests = offer.slug === 'salles-des-fetes' || offer.slug === 'traiteur' || offer.kind === 'pack' ? between(8, 40) * 10 : chance(0.5) ? between(3, 30) * 10 : null;

    let status: Status;
    if (figmaAmina) status = 'accepted';
    else if (figmaKarima) status = 'completed';
    else if (dayOffset < 0) {
      const r = rand();
      status = r < 0.7 ? 'completed' : r < 0.82 ? 'cancelled' : r < 0.9 ? 'declined' : 'accepted';
      if (status === 'accepted' && dayOffset < -3) status = 'completed';
    } else {
      const r = rand();
      status = r < 0.3 ? 'pending' : r < 0.8 ? 'accepted' : r < 0.88 ? 'declined' : 'cancelled';
    }
    // Pending bookings: about half past the 48 h reply deadline.
    const createdFinal = status === 'pending' ? new Date(now.getTime() - (chance(0.5) ? between(50, 200) : between(1, 40)) * HOUR) : createdAt;

    // Lines
    let lines: LineInput[];
    if (offer.kind === 'pack') {
      lines = packLines({ price: String(offer.price), nameEn: offer.title_en }, packItems.get(offer.id) ?? []);
    } else {
      lines = [{ kind: BookingLineKind.Service, label: offer.title_en, quantity: serviceQuantity(offer.price_type!, { guests, startTime: start, endTime: end }), unitAmount: String(offer.price), serviceId: offer.id }];
      const extras = extrasByService.get(offer.id) ?? [];
      if (extras.length && chance(0.4)) {
        const extra = pick(extras);
        lines.push({ kind: BookingLineKind.Extra, label: extra.name_en, quantity: 1, unitAmount: String(extra.price), serviceId: offer.id });
      }
    }
    let computed = computeLines(lines);
    let totals = computeTotals(computed);
    const feePercent = offer.kind === 'pack' ? fee.pack : fee.service;

    const id = uuid();
    const respondedAt = status === 'pending' ? null : new Date(Math.min(createdFinal.getTime() + between(1, 40) * HOUR, now.getTime() - HOUR));
    const completedAt = status === 'completed' ? new Date(Math.min(localToUtc(eventDate, end).getTime() + (end < start ? DAY : 0) + 72 * HOUR, now.getTime() - HOUR)) : null;
    const cancelledBy = status === 'cancelled' ? pick(['client', 'client', 'provider', 'admin'] as const) : null;
    const commune = communes.filter((c) => Number(c.wilaya_code) === Number(offer.wilaya));
    const communeRow = commune.length && chance(0.7) ? pick(commune) : null;
    const reminderSentAt = status === 'pending' && now.getTime() - createdFinal.getTime() > 36 * HOUR ? new Date(createdFinal.getTime() + 36 * HOUR) : null;

    await em.query(
      `INSERT INTO bookings (id, created_at, updated_at, reference, client_id, provider_id, service_id, pack_id, academic_request_id, status, dispute_status, event_type, event_date,
         start_time, end_time, location_text, commune_id, wilaya_code, guests, client_note, subtotal, discount_total, total, fee_percent, responded_at, reminder_sent_at,
         decline_reason, cancelled_by, cancel_reason, completed_at, review_requested_at, source, created_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        createdFinal,
        respondedAt ?? createdFinal,
        reference,
        client.id,
        offer.provider_id,
        offer.kind === 'service' ? offer.id : null,
        offer.kind === 'pack' ? offer.id : null,
        status,
        'none',
        eventType,
        eventDate,
        `${start}:00`,
        `${end}:00`,
        communeRow ? `${pick(['Salle', 'Villa', 'Domicile', 'Hôtel'])} · ${communeRow.name}` : null,
        communeRow?.id ?? null,
        offer.wilaya,
        guests,
        pick(NOTES),
        totals.subtotal,
        totals.discountTotal,
        totals.total,
        feePercent,
        respondedAt,
        reminderSentAt,
        status === 'declined' ? pick(DECLINE_REASONS) : null,
        cancelledBy,
        status === 'cancelled' ? pick(CANCEL_REASONS) : null,
        completedAt,
        completedAt && now.getTime() - completedAt.getTime() > 24 * HOUR ? new Date(completedAt.getTime() + 24 * HOUR) : null,
        figmaAmina || chance(0.15) ? 'dashboard' : pick(['android', 'android', 'ios', 'web']),
        null,
      ],
    );
    const insertLines = async (rows: ReturnType<typeof computeLines>) => {
      await em.query('DELETE FROM booking_lines WHERE booking_id = ?', [id]);
      for (const l of rows) {
        await em.query(
          'INSERT INTO booking_lines (id, created_at, updated_at, booking_id, kind, service_id, label, quantity, unit_amount, amount, position) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [createdFinal, createdFinal, id, l.kind, l.serviceId, l.label, l.quantity, l.unitAmount, l.amount, l.position],
        );
      }
    };
    await insertLines(computed);

    // Status history
    const statusRow = (at: Date, from: Status | null, to: Status, actorId: string | null, reason: string | null, note: string | null) =>
      em.query('INSERT INTO booking_status_changes (id, created_at, booking_id, from_status, to_status, actor_id, reason, note, notified) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, 1)', [at, id, from, to, actorId, reason, note]);
    await statusRow(createdFinal, null, 'pending', client.id, null, null);
    if (status === 'accepted' || status === 'completed') await statusRow(respondedAt!, 'pending', 'accepted', offer.provider_id, null, null);
    if (status === 'declined') await statusRow(respondedAt!, 'pending', 'declined', offer.provider_id, 'date_unavailable', null);
    if (status === 'cancelled') {
      const actor = cancelledBy === 'client' ? client.id : cancelledBy === 'provider' ? offer.provider_id : (admin?.id ?? null);
      await statusRow(respondedAt!, chance(0.5) ? 'pending' : 'accepted', 'cancelled', actor, pick(CANCEL_REASONS), cancelledBy === 'admin' ? 'Cancelled by support at the client’s request (phone call).' : null);
    }
    if (status === 'completed') await statusRow(completedAt!, 'accepted', 'completed', null, 'auto_completed', 'Completed automatically 72 h after the event.');

    // Availability
    if (status === 'pending' || status === 'accepted' || status === 'completed') {
      await em.query(
        'INSERT INTO availability_blocks (id, created_at, updated_at, provider_id, service_id, date, start_time, end_time, kind, booking_id, note) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
        [createdFinal, createdFinal, offer.provider_id, offer.kind === 'service' ? offer.id : null, eventDate, `${start}:00`, `${end}:00`, status === 'pending' ? 'held' : 'booked', id],
      );
    }

    // Reschedules: applied on some pending, proposals on some upcoming accepted bookings.
    if ((status === 'pending' && chance(0.12)) || (status === 'accepted' && dayOffset > 7 && chance(0.12)) || figmaAmina) {
      const proposal = status === 'accepted' && !figmaAmina;
      const newDate = addDays(eventDate, proposal ? between(1, 14) : 0);
      const oldDate = proposal ? eventDate : addDays(eventDate, -between(2, 10));
      await em.query(
        `INSERT INTO booking_reschedules (id, created_at, updated_at, booking_id, old_date, old_start, old_end, new_date, new_start, new_end, proposed_by_id, reason, forced, status, resolved_at)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          new Date(createdFinal.getTime() + 6 * HOUR),
          new Date(createdFinal.getTime() + 6 * HOUR),
          id,
          oldDate,
          `${start}:00`,
          `${end}:00`,
          newDate,
          `${start}:00`,
          `${end}:00`,
          proposal ? offer.provider_id : client.id,
          proposal ? 'Équipe indisponible ce jour-là' : 'La salle a changé la date',
          proposal ? 'pending' : 'accepted',
          proposal ? null : new Date(createdFinal.getTime() + 7 * HOUR),
        ],
      );
      summary.reschedules += 1;
    }

    // Price changes (the invoice below is then version 2)
    let priceChanged = false;
    if ((status === 'accepted' || status === 'completed' || status === 'pending') && (chance(0.07) || figmaAmina)) {
      const before = computed;
      computed = computeLines([...lines, { kind: BookingLineKind.Adjustment, label: figmaAmina ? 'Second photographer' : 'Travel costs', quantity: 1, unitAmount: figmaAmina ? '15000.00' : `${between(3, 12) * 1000}.00`, serviceId: null }]);
      const newTotals = computeTotals(computed);
      await insertLines(computed);
      await em.query('UPDATE bookings SET subtotal = ?, discount_total = ?, total = ? WHERE id = ?', [newTotals.subtotal, newTotals.discountTotal, newTotals.total, id]);
      await em.query('INSERT INTO booking_price_changes (id, created_at, booking_id, old_total, new_total, lines_before, lines_after, reason, actor_id) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?)', [
        new Date(createdFinal.getTime() + 3 * HOUR),
        id,
        totals.total,
        newTotals.total,
        JSON.stringify(before.map(({ position: _p, ...l }) => l)),
        JSON.stringify(computed.map(({ position: _p, ...l }) => l)),
        figmaAmina ? 'Client added a second photographer' : 'Travel outside the wilaya',
        admin?.id ?? offer.provider_id,
      ]);
      totals = newTotals;
      priceChanged = true;
      summary.priceChanges += 1;
    }

    // Invoices
    if (status === 'accepted' || status === 'completed') {
      const [parties] = await em.query(
        'SELECT cu.full_name AS cn, cu.email AS ce, cu.phone AS cp, pu.full_name AS pn, pu.email AS pe, pu.phone AS pph FROM users cu, users pu WHERE cu.id = ? AND pu.id = ?',
        [client.id, offer.provider_id],
      );
      const versions = priceChanged && status === 'accepted' ? 2 : 1;
      for (let version = 1; version <= versions; version++) {
        const snapshotLines = version === versions ? computed : computeLines(lines);
        const t = computeTotals(snapshotLines);
        const f = computeFee(t.total, feePercent);
        invoiceNumber += 1;
        const issuedAt = new Date(respondedAt!.getTime() + (version - 1) * 4 * HOUR);
        await em.query(
          `INSERT INTO invoices (id, created_at, updated_at, deleted_at, booking_id, version, number, issued_at, currency, subtotal, discount_total, total, fee_percent, fee_amount, provider_amount, issuer, snapshot, pdf_file_id, sent_to_client_at)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, 'DZD', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          [
            issuedAt,
            issuedAt,
            version < versions ? new Date(issuedAt.getTime() + 4 * HOUR) : null,
            id,
            version,
            `INV-${invoiceYear}-${String(invoiceNumber).padStart(4, '0')}`,
            issuedAt,
            t.subtotal,
            t.discountTotal,
            t.total,
            feePercent,
            f.feeAmount,
            f.providerAmount,
            JSON.stringify({
              name: 'Eventor (Symloop SARL)',
              address: 'Cité 1er Novembre, Bab Ezzouar, Alger',
              nif: '001216099999999',
              rc: '16/00-1234567B21',
              email: 'billing@eventor.dz',
              phone: '+213 23 00 00 00',
            }),
            JSON.stringify({
              bookingReference: reference,
              eventDate,
              eventType,
              titleEn: offer.title_en,
              titleAr: offer.title_ar,
              client: { id: client.id, name: parties.cn, businessName: null, email: parties.ce, phone: parties.cp },
              provider: { id: offer.provider_id, name: parties.pn, businessName: offer.business_name, email: parties.pe, phone: parties.pph },
              lines: snapshotLines.map((l) => ({ kind: l.kind, label: l.label, quantity: l.quantity, unitAmount: l.unitAmount, amount: l.amount })),
            }),
            version === versions && chance(0.4) ? new Date(issuedAt.getTime() + HOUR) : null,
          ],
        );
        summary.invoices += 1;
      }
    }

    // Conversation per pair
    const pairKey = `${client.id}|${offer.provider_id}`;
    const pair = conversations.get(pairKey) ?? { id: uuid(), clientId: client.id, providerId: offer.provider_id, bookings: [] };
    pair.bookings.push({ id, status, createdAt: createdFinal, eventDate, guests });
    conversations.set(pairKey, pair);
    summary.bookings += 1;
  }

  // Direct conversations
  const insertMessage = async (conversationId: string, senderId: string | null, body: string, at: Date, kind = 'text') => {
    const masked = kind === 'system' ? null : maskContacts(body).masked;
    const messageId = uuid();
    await em.query(
      "INSERT INTO messages (id, created_at, updated_at, conversation_id, sender_id, kind, body, body_masked, file_id, status, moderated_by_id, moderated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'visible', NULL, NULL)",
      [messageId, at, at, conversationId, senderId, kind, body, masked],
    );
    summary.messages += 1;
    return { messageId, masked: masked !== null };
  };
  let scriptIndex = 0;
  let reported = 0;
  for (const pair of conversations.values()) {
    const latest = pair.bookings.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    const first = pair.bookings.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
    const [client] = await em.query('SELECT full_name, email, phone FROM users WHERE id = ?', [pair.clientId]);
    const isAmina = client.email === 'amina.benali@gmail.com';
    const script = isAmina ? CHAT_SCRIPTS[0]! : CHAT_SCRIPTS[scriptIndex++ % CHAT_SCRIPTS.length]!;
    const count = Math.min(script.length, isAmina ? script.length : between(3, 15));
    const lines = script.slice(0, count);
    const phone = (client.phone ?? '+213555000000').replace(/^\+213(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/, '0$1$2 $3 $4 $5');
    await em.query("INSERT INTO conversations (id, created_at, updated_at, kind, booking_id, service_id, dispute_id, academic_request_id, status, last_message_at) VALUES (?, ?, ?, 'direct', ?, NULL, NULL, NULL, 'open', NULL)", [
      pair.id,
      first.createdAt,
      first.createdAt,
      latest.id,
    ]);
    await em.query("INSERT INTO conversation_participants (id, created_at, conversation_id, user_id, role, can_write, last_read_at) VALUES (UUID(), ?, ?, ?, 'client', 1, ?), (UUID(), ?, ?, ?, 'provider', 1, ?)", [
      first.createdAt,
      pair.id,
      pair.clientId,
      now,
      first.createdAt,
      pair.id,
      pair.providerId,
      new Date(now.getTime() - 6 * HOUR),
    ]);
    summary.conversations += 1;
    let at = new Date(first.createdAt.getTime() + 5 * 60_000);
    await insertMessage(pair.id, null, 'Booking request created.', first.createdAt, 'system');
    const span = Math.max(HOUR, Math.min(now.getTime(), new Date(`${latest.eventDate}T12:00:00Z`).getTime()) - at.getTime());
    for (const [index, [who, template]] of lines.entries()) {
      at = new Date(Math.min(now.getTime() - 60_000, at.getTime() + Math.max(2 * 60_000, Math.floor(span / (count + 1)) * (0.5 + rand()))));
      const body = template
        .replace('{date}', latest.eventDate)
        .replace('{guests}', String(latest.guests ?? 120))
        .replace('{phone}', phone)
        .replace('{email}', client.email);
      const message = await insertMessage(pair.id, who === 'c' ? pair.clientId : pair.providerId, body, at);
      if (message.masked && reported < 3 && index > 0) {
        await em.query("INSERT INTO reports (id, created_at, updated_at, reporter_id, target_type, target_id, reason, note, status) VALUES (UUID(), ?, ?, ?, 'message', ?, 'contact_outside', ?, 'open')", [
          new Date(at.getTime() + HOUR),
          new Date(at.getTime() + HOUR),
          who === 'c' ? pair.providerId : pair.clientId,
          message.messageId,
          'Shares a phone number before the booking is confirmed.',
        ]);
        reported += 1;
      }
    }
    if (pair.bookings.some((b) => b.status === 'accepted' || b.status === 'completed')) {
      await insertMessage(pair.id, null, 'Booking accepted. Contact details are now visible to both of you.', new Date(Math.min(now.getTime() - 30_000, at.getTime() + 60_000)), 'system');
    }
    await em.query('UPDATE conversations SET last_message_at = (SELECT MAX(created_at) FROM messages WHERE conversation_id = ?) WHERE id = ?', [pair.id, pair.id]);
  }

  // Support conversations
  if (admin) {
    const users: { id: string; role: UserRole }[] = await em.query(
      "SELECT id, role FROM users WHERE role IN ('client', 'provider') AND status = 'active' AND deleted_at IS NULL ORDER BY email LIMIT 30",
    );
    for (const [index, thread] of SUPPORT_THREADS.entries()) {
      const user = users.filter((u) => u.role === thread.role)[index] ?? users[index];
      if (!user) continue;
      const conversationId = uuid();
      const startAt = new Date(now.getTime() - (index * 3 + 1) * DAY);
      await em.query("INSERT INTO conversations (id, created_at, updated_at, kind, status, last_message_at) VALUES (?, ?, ?, 'support', 'open', NULL)", [conversationId, startAt, startAt]);
      await em.query(
        "INSERT INTO conversation_participants (id, created_at, conversation_id, user_id, role, can_write, last_read_at) VALUES (UUID(), ?, ?, ?, ?, 1, NULL), (UUID(), ?, ?, ?, 'support', 1, ?)",
        [startAt, conversationId, user.id, user.role === UserRole.Provider ? 'provider' : 'client', startAt, conversationId, admin.id, index === 0 ? startAt : now],
      );
      let at = startAt;
      for (const [who, body] of thread.lines) {
        at = new Date(at.getTime() + between(20, 300) * 60_000);
        await insertMessage(conversationId, who === 'a' ? admin.id : user.id, body, at);
      }
      await em.query('UPDATE conversations SET last_message_at = ? WHERE id = ?', [at, conversationId]);
      summary.conversations += 1;
    }
  }

  // Move the sequences past the written references.
  await em.query("UPDATE sequences SET value = GREATEST(value, ?) WHERE name = 'booking'", [FIRST_REF + TOTAL + 100]);
  await em.query('INSERT INTO sequences (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = GREATEST(value, VALUES(value))', [`invoice_${invoiceYear}`, invoiceNumber]);
  return summary;
}
