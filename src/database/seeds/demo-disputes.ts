/**
 * Demo disputes (module 9), called by `demo-seed.ts` after the bookings.
 *
 * Eight disputes DSP-000024…DSP-000031 in every status on completed, accepted
 * and cancelled bookings, each with its dispute conversation (client, provider,
 * Eventor support; messages from both sides), the booking chat attached as a
 * snapshot, placeholder image / PDF evidence stored privately through
 * FilesService, timeline events and audit entries. Figma: DSP-000031 Karima Ait
 * vs DJ Amine (provider no-show), Hakim Mansouri vs Douceurs d'Oran (price
 * disagreement), Studio Lumière vs a client (client no-show).
 *
 * Idempotent: skipped when DSP-000031 exists. The `dispute` sequence is moved past 31.
 */
import argon2 from 'argon2';
import sharp from 'sharp';
import type { EntityManager } from 'typeorm';
import { FilePurpose } from '../../common/enums/file.enums.js';
import type { FilesService } from '../../files/files.service.js';
import { maskContacts } from '../../messaging/contact-masking.js';

export interface DisputeSeedContext {
  em: EntityManager;
  files: FilesService;
  admin: { id: string; fullName: string } | null;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const uuid = () => crypto.randomUUID();
const algiersDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function evidenceImage(title: string, lines: string[], color: string): Promise<Buffer> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">
    <rect width="720" height="1280" fill="#f5f5f2"/>
    <rect width="720" height="120" fill="${color}"/>
    <text x="40" y="76" font-family="Arial" font-size="36" font-weight="bold" fill="#fff">${esc(title)}</text>
    ${lines.map((line, i) => `<rect x="40" y="${180 + i * 150}" width="560" height="110" rx="24" fill="${i % 2 ? '#dcefe6' : '#ffffff'}"/><text x="70" y="${245 + i * 150}" font-family="Arial" font-size="26" fill="#1d3b33">${esc(line)}</text>`).join('')}
    <text x="40" y="1240" font-family="Arial" font-size="22" fill="#b3261e">EVENTOR DEMO EVIDENCE · PLACEHOLDER</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function receiptPdf(title: string, rows: string[]): Buffer {
  const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, ' ');
  const text = [`BT /F1 20 Tf 60 760 Td (${ascii(title)}) Tj ET`, ...rows.map((r, i) => `BT /F1 13 Tf 60 ${720 - i * 24} Td (${ascii(r)}) Tj ET`), 'BT /F1 10 Tf 60 80 Td (EVENTOR DEMO EVIDENCE - PLACEHOLDER) Tj ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

type Who = 'c' | 'p' | 'a' | 's';

interface Plan {
  reference: string;
  /** How to find (or create) the booking. */
  booking:
    | { kind: 'existing'; reference: string }
    | { kind: 'pick'; status: 'completed' | 'cancelled'; exclude: string[] }
    | { kind: 'new'; business: string; clientName: string; clientEmail: string; status: 'accepted' | 'completed'; daysAgo: number; title: string };
  openedBy: 'client' | 'provider';
  type: string;
  description: string;
  status: 'open' | 'in_review' | 'resolved' | 'closed';
  openedDaysAgo: number;
  outcome?: 'completed' | 'cancelled' | 'unchanged';
  decision?: string;
  evidence: { who: 'c' | 'p'; name: string; kind: 'png' | 'pdf'; title: string; lines: string[] }[];
  chat: [Who, string, number][];
}

const PLANS: Plan[] = [
  {
    reference: 'DSP-000031',
    booking: { kind: 'existing', reference: 'EVT-002038' },
    openedBy: 'client',
    type: 'provider_no_show',
    description: 'DJ Amine never came to our wedding on 4 September. We waited until 22:30 with 180 guests and he did not answer any of our 14 calls. We had to use a phone speaker for the whole evening.',
    status: 'in_review',
    openedDaysAgo: 9,
    evidence: [
      { who: 'c', name: 'call-log-4-sept.png', kind: 'png', title: 'Call log · 4 Sept', lines: ['DJ Amine · 20:02 · no answer', 'DJ Amine · 20:15 · no answer', 'DJ Amine · 20:41 · no answer', 'DJ Amine · 21:30 · no answer'] },
      { who: 'c', name: 'salle-sans-dj.png', kind: 'png', title: 'Salle des fêtes · 22:10', lines: ['Empty DJ stand', 'Guests waiting', 'No sound system installed'] },
    ],
    chat: [
      ['s', 'Dispute DSP-000031 opened for booking EVT-002038 by the client (provider no show). Eventor support will review it with you here.', 9 * 24],
      ['a', 'Bonjour Karima, bonjour Yacine. Nous examinons ce litige. Yacine, pouvez-vous nous expliquer ce qui s’est passé le 4 septembre ?', 9 * 24 - 2],
      ['c', 'We waited all evening. My brother called him 14 times. Screenshots are attached.', 9 * 24 - 3],
      ['p', 'J’ai eu une panne de voiture sur l’autoroute, je n’avais plus de batterie sur mon téléphone.', 7 * 24],
      ['a', 'Yacine, pouvez-vous envoyer un justificatif (dépanneuse, constat) ?', 6 * 24],
      ['c', 'He could have sent someone else. This ruined our wedding.', 5 * 24],
    ],
  },
  {
    reference: 'DSP-000030',
    booking: { kind: 'new', business: "Douceurs d'Oran", clientName: 'Hakim Mansouri', clientEmail: 'hakim.mansouri@gmail.com', status: 'completed', daysAgo: 4, title: 'Pâtisserie & wedding cake' },
    openedBy: 'client',
    type: 'price_disagreement',
    description: 'The price agreed in the app was 55,000 DZD but on delivery the provider asked for 68,000 DZD in cash, saying the cake was bigger than planned. I paid to avoid problems in front of the guests.',
    status: 'open',
    openedDaysAgo: 1,
    evidence: [{ who: 'c', name: 'recu-douceurs-oran.pdf', kind: 'pdf', title: "Recu Douceurs d'Oran", lines: ['Piece montee 4 etages : 55 000 DA', 'Supplement taille : 13 000 DA', 'Total paye : 68 000 DA'] }],
    chat: [
      ['s', "Dispute DSP-000030 opened for booking by the client (price disagreement). Eventor support will review it with you here.", 24],
      ['c', 'I have the receipt. Nobody asked me before making it bigger.', 23],
    ],
  },
  {
    reference: 'DSP-000029',
    booking: { kind: 'new', business: 'Studio Lumière', clientName: 'Ayoub Slimani', clientEmail: '', status: 'accepted', daysAgo: 1, title: 'Engagement photo session' },
    openedBy: 'provider',
    type: 'client_no_show',
    description: 'We came to the address for the engagement session at 16:00 with two photographers. Nobody was there and the client phone was switched off. We lost the whole afternoon.',
    status: 'open',
    openedDaysAgo: 0,
    evidence: [{ who: 'p', name: 'photo-adresse-16h.png', kind: 'png', title: 'Adresse · 16:05', lines: ['Photo of the closed gate', 'Team of 2 on site', 'Waited until 17:15'] }],
    chat: [['s', 'Dispute DSP-000029 opened by the provider (client no show). Eventor support will review it with you here.', 6]],
  },
  {
    reference: 'DSP-000028',
    booking: { kind: 'pick', status: 'cancelled', exclude: [] },
    openedBy: 'client',
    type: 'cancellation_disagreement',
    description: 'The provider cancelled two days before the event and says it was my fault because I changed the time. I only asked to move from 19:00 to 20:00 and he had agreed in the chat.',
    status: 'in_review',
    openedDaysAgo: 3,
    evidence: [{ who: 'c', name: 'capture-accord-horaire.png', kind: 'png', title: 'Chat screenshot', lines: ['Client: can we start at 20:00?', 'Provider: ok no problem', 'Provider (2 days later): cancelled'] }],
    chat: [
      ['s', 'Dispute DSP-000028 opened by the client (cancellation disagreement). Eventor support will review it with you here.', 72],
      ['a', 'Merci pour la capture. Nous contactons le prestataire.', 70],
      ['p', 'Le changement d’horaire m’obligeait à annuler un autre événement, je l’ai dit par téléphone.', 50],
    ],
  },
  {
    reference: 'DSP-000027',
    booking: { kind: 'pick', status: 'completed', exclude: ['DJ Amine', "Douceurs d'Oran", 'Studio Lumière'] },
    openedBy: 'client',
    type: 'service_not_as_described',
    description: 'The decoration was nothing like the photos of the service: plastic flowers instead of fresh ones, no lighting, and half of the tables were not decorated at all.',
    status: 'resolved',
    openedDaysAgo: 18,
    outcome: 'cancelled',
    decision: 'The provider admitted using a cheaper setup without telling the client. The booking is cancelled; the service listing was reviewed separately.',
    evidence: [
      { who: 'c', name: 'deco-reelle.png', kind: 'png', title: 'Decoration on the day', lines: ['Plastic flowers', 'No lighting', '6 of 12 tables decorated'] },
      { who: 'p', name: 'devis-signe.pdf', kind: 'pdf', title: 'Devis signe', lines: ['Decoration standard', 'Fleurs artificielles incluses'] },
    ],
    chat: [
      ['s', 'Dispute DSP-000027 opened by the client (service not as described). Eventor support will review it with you here.', 18 * 24],
      ['p', 'Le devis mentionne des fleurs artificielles.', 17 * 24],
      ['c', 'The listing photos show fresh roses, not the quote.', 17 * 24 - 5],
    ],
  },
  {
    reference: 'DSP-000026',
    booking: { kind: 'pick', status: 'completed', exclude: ['DJ Amine', "Douceurs d'Oran", 'Studio Lumière'] },
    openedBy: 'client',
    type: 'incomplete_or_late',
    description: 'The caterer arrived one hour late and the main dish was served at 23:00. We sorted it out directly afterwards; I am withdrawing the complaint.',
    status: 'closed',
    openedDaysAgo: 25,
    decision: 'Withdrawn by the client after an agreement with the provider.',
    evidence: [],
    chat: [
      ['s', 'Dispute DSP-000026 opened by the client (incomplete or late). Eventor support will review it with you here.', 25 * 24],
      ['c', 'We found an agreement with the caterer, you can close it.', 24 * 24],
    ],
  },
  {
    reference: 'DSP-000025',
    booking: { kind: 'pick', status: 'completed', exclude: ['DJ Amine', "Douceurs d'Oran"] },
    openedBy: 'provider',
    type: 'damage_or_safety',
    description: 'A guest broke one of our speakers during the party (about 60,000 DZD) and the client refuses to discuss it.',
    status: 'resolved',
    openedDaysAgo: 40,
    outcome: 'unchanged',
    decision: 'Eventor cannot arbitrate damage payments (cash). Both parties were given each other’s contact to settle it; the booking stays completed.',
    evidence: [{ who: 'p', name: 'enceinte-cassee.png', kind: 'png', title: 'Speaker damage', lines: ['JBL PRX 815 · front grille', 'Photo taken at 01:20'] }],
    chat: [
      ['s', 'Dispute DSP-000025 opened by the provider (damage or safety). Eventor support will review it with you here.', 40 * 24],
      ['c', 'Nobody saw who broke it, it was already damaged when they installed it.', 39 * 24],
    ],
  },
  {
    reference: 'DSP-000024',
    booking: { kind: 'pick', status: 'completed', exclude: ['DJ Amine', "Douceurs d'Oran"] },
    openedBy: 'client',
    type: 'behaviour',
    description: 'The photographer was rude with my mother and refused to take the family photos we had listed together before the event.',
    status: 'closed',
    openedDaysAgo: 55,
    decision: 'Both parties had a call with support; no further action needed.',
    evidence: [],
    chat: [['s', 'Dispute DSP-000024 opened by the client (behaviour). Eventor support will review it with you here.', 55 * 24]],
  },
];

export async function seedDisputes(ctx: DisputeSeedContext): Promise<{ disputes: number; disputeEvidenceFiles: number }> {
  const { em, files, admin } = ctx;
  const summary = { disputes: 0, disputeEvidenceFiles: 0 };
  const [done] = await em.query("SELECT id FROM disputes WHERE reference = 'DSP-000031'");
  if (done) return summary;
  const [anyBooking] = await em.query("SELECT id FROM bookings WHERE reference = 'EVT-002038'");
  if (!anyBooking || !admin) return summary;

  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR);
  const used = new Set<string>();
  let newRef = 2090;

  const createBooking = async (plan: Extract<Plan['booking'], { kind: 'new' }>): Promise<string | null> => {
    const [service] = await em.query(
      `SELECT s.id, s.provider_id, s.title_en, s.base_price, COALESCE((SELECT MIN(sw.wilaya_code) FROM service_wilayas sw WHERE sw.service_id = s.id), 16) AS wilaya
       FROM services s JOIN provider_profiles pp ON pp.user_id = s.provider_id WHERE pp.business_name = ? AND s.title_en = ? AND s.deleted_at IS NULL LIMIT 1`,
      [plan.business, plan.title],
    );
    if (!service) return null;
    let clientId: string;
    const [existing] = plan.clientEmail
      ? await em.query('SELECT id FROM users WHERE email = ?', [plan.clientEmail])
      : await em.query("SELECT id FROM users WHERE full_name = ? AND role = 'client' LIMIT 1", [plan.clientName]);
    if (existing) clientId = existing.id;
    else {
      clientId = uuid();
      const email = plan.clientEmail || `${plan.clientName.toLowerCase().replace(/\s+/g, '.')}@gmail.com`;
      await em.query(
        `INSERT INTO users (id, created_at, updated_at, role, status, verification_status, full_name, email, email_verified_at, phone, password_hash, language, wilaya_code, last_active_at)
         VALUES (?, ?, ?, 'client', 'active', 'not_required', ?, ?, ?, ?, ?, 'ar', 31, ?)`,
        [clientId, at(90 * 24), at(1), plan.clientName, email, at(90 * 24), '+213770204130', await argon2.hash(`demo-${email}`, { type: argon2.argon2id }), at(3)],
      );
    }
    const id = uuid();
    let reference = '';
    for (;;) {
      reference = `EVT-${String(newRef++).padStart(6, '0')}`;
      const [taken] = await em.query('SELECT id FROM bookings WHERE reference = ?', [reference]);
      if (!taken) break;
    }
    const eventDate = algiersDate(new Date(now - plan.daysAgo * DAY));
    const created = at((plan.daysAgo + 20) * 24);
    const completedAt = plan.status === 'completed' ? at(Math.max(1, plan.daysAgo * 24 - 72)) : null;
    const price = String(service.base_price);
    await em.query(
      `INSERT INTO bookings (id, created_at, updated_at, reference, client_id, provider_id, service_id, status, dispute_status, event_type, event_date, start_time, end_time, wilaya_code, guests,
         subtotal, discount_total, total, fee_percent, responded_at, completed_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, '16:00:00', '20:00:00', ?, ?, ?, '0.00', ?, '10.00', ?, ?, 'android')`,
      [id, created, at(2), reference, clientId, service.provider_id, service.id, plan.status, plan.title.includes('Engagement') ? 'engagement' : 'wedding', eventDate, service.wilaya, 150, price, price, at((plan.daysAgo + 19) * 24), completedAt],
    );
    await em.query(
      "INSERT INTO booking_lines (id, created_at, updated_at, booking_id, kind, service_id, label, quantity, unit_amount, amount, position) VALUES (UUID(), ?, ?, ?, 'service', ?, ?, 1, ?, ?, 0)",
      [created, created, id, service.id, service.title_en, price, price],
    );
    const statusRow = (when: Date, from: string | null, to: string, actor: string | null, reason: string | null) =>
      em.query('INSERT INTO booking_status_changes (id, created_at, booking_id, from_status, to_status, actor_id, reason, note, notified) VALUES (UUID(), ?, ?, ?, ?, ?, ?, NULL, 1)', [when, id, from, to, actor, reason]);
    await statusRow(created, null, 'pending', clientId, null);
    await statusRow(at((plan.daysAgo + 19) * 24), 'pending', 'accepted', service.provider_id, null);
    if (completedAt) await statusRow(completedAt, 'accepted', 'completed', null, 'auto_completed');
    await em.query("INSERT INTO availability_blocks (id, created_at, updated_at, provider_id, service_id, date, start_time, end_time, kind, booking_id, note) VALUES (UUID(), ?, ?, ?, ?, ?, '16:00:00', '20:00:00', 'booked', ?, NULL)", [
      created,
      created,
      service.provider_id,
      service.id,
      eventDate,
      id,
    ]);
    // Direct chat of the pair.
    const conversationId = uuid();
    await em.query("INSERT INTO conversations (id, created_at, updated_at, kind, booking_id, service_id, status, last_message_at) VALUES (?, ?, ?, 'direct', ?, ?, 'open', ?)", [conversationId, created, created, id, service.id, at(plan.daysAgo * 24 + 5)]);
    await em.query("INSERT INTO conversation_participants (id, created_at, conversation_id, user_id, role, can_write) VALUES (UUID(), ?, ?, ?, 'client', 1), (UUID(), ?, ?, ?, 'provider', 1)", [
      created,
      conversationId,
      clientId,
      created,
      conversationId,
      service.provider_id,
    ]);
    const chat: [string, string, number][] = [
      [clientId, 'Salam, c’est bien confirmé pour la date ?', (plan.daysAgo + 19) * 24],
      [service.provider_id, 'Oui c’est confirmé, à bientôt.', (plan.daysAgo + 19) * 24 - 2],
      [clientId, 'Merci, on vous attend à 16h.', plan.daysAgo * 24 + 5],
    ];
    for (const [sender, body, hours] of chat) {
      await em.query("INSERT INTO messages (id, created_at, updated_at, conversation_id, sender_id, kind, body, body_masked, status) VALUES (UUID(), ?, ?, ?, ?, 'text', ?, ?, 'visible')", [at(hours), at(hours), conversationId, sender, body, maskContacts(body).masked]);
    }
    return id;
  };

  const pickBooking = async (plan: Extract<Plan['booking'], { kind: 'pick' }>): Promise<string | null> => {
    const rows: { id: string; business_name: string; provider_id: string }[] = await em.query(
      `SELECT b.id, pp.business_name, b.provider_id FROM bookings b JOIN provider_profiles pp ON pp.user_id = b.provider_id
       WHERE b.status = ? AND b.dispute_status = 'none' AND b.service_id IS NOT NULL AND b.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = b.id) ${plan.status === 'cancelled' ? "AND b.cancelled_by = 'provider'" : ''}
       ORDER BY b.event_date DESC, b.reference`,
      [plan.status],
    );
    const row = rows.find((r) => !used.has(r.id) && !plan.exclude.includes(r.business_name) && ![...used].some((u) => u === r.provider_id));
    return row?.id ?? rows.find((r) => !used.has(r.id))?.id ?? null;
  };

  for (const plan of PLANS) {
    let bookingId: string | null;
    if (plan.booking.kind === 'existing') {
      const [row] = await em.query('SELECT id FROM bookings WHERE reference = ?', [plan.booking.reference]);
      bookingId = row?.id ?? null;
    } else if (plan.booking.kind === 'new') bookingId = await createBooking(plan.booking);
    else bookingId = await pickBooking(plan.booking);
    if (!bookingId) continue;
    used.add(bookingId);

    const [b] = await em.query(
      `SELECT b.id, b.reference, b.client_id, b.provider_id, b.service_id, b.status, b.event_date, b.updated_at, b.completed_at FROM bookings b WHERE b.id = ?`,
      [bookingId],
    );
    used.add(b.provider_id);
    const openedAt = at(plan.openedDaysAgo * 24 + 2);
    const openerId = plan.openedBy === 'client' ? b.client_id : b.provider_id;
    const againstId = plan.openedBy === 'client' ? b.provider_id : b.client_id;
    const finished = plan.status === 'resolved' || plan.status === 'closed';
    const decidedAt = finished ? at(Math.max(1, (plan.openedDaysAgo - 3) * 24)) : null;
    const conversationClosed = finished && decidedAt!.getTime() < now - 7 * DAY;

    // Dispute chat.
    const conversationId = uuid();
    const disputeId = uuid();
    await em.query(
      `INSERT INTO conversations (id, created_at, updated_at, kind, booking_id, service_id, status, closed_scope, closed_reason, closed_at, last_message_at)
       VALUES (?, ?, ?, 'dispute', ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversationId,
        openedAt,
        openedAt,
        bookingId,
        b.service_id,
        conversationClosed ? 'closed' : 'open',
        conversationClosed ? 'all' : null,
        conversationClosed ? `dispute_${plan.status}` : null,
        conversationClosed ? new Date(decidedAt!.getTime() + 7 * DAY) : null,
        openedAt,
      ],
    );
    await em.query(
      `INSERT INTO conversation_participants (id, created_at, conversation_id, user_id, role, can_write, last_read_at)
       VALUES (UUID(), ?, ?, ?, 'client', ?, NULL), (UUID(), ?, ?, ?, 'provider', ?, NULL), (UUID(), ?, ?, ?, 'support', 1, ?)`,
      [openedAt, conversationId, b.client_id, conversationClosed ? 0 : 1, openedAt, conversationId, b.provider_id, conversationClosed ? 0 : 1, openedAt, conversationId, admin.id, at(2)],
    );
    let lastMessage = openedAt;
    for (const [who, body, hoursAgo] of plan.chat) {
      const sender = who === 'c' ? b.client_id : who === 'p' ? b.provider_id : who === 'a' ? admin.id : null;
      const when = at(Math.min(hoursAgo, plan.openedDaysAgo * 24 + 2));
      const text = who === 's' ? body.replace('for booking by', `for booking ${b.reference} by`) : body;
      await em.query('INSERT INTO messages (id, created_at, updated_at, conversation_id, sender_id, kind, body, body_masked, status) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?)', [
        when,
        when,
        conversationId,
        sender,
        who === 's' ? 'system' : 'text',
        text,
        who === 's' ? null : maskContacts(text).masked,
        'visible',
      ]);
      if (when > lastMessage) lastMessage = when;
    }
    if (finished) {
      const body = plan.status === 'resolved' ? `Dispute ${plan.reference} resolved (booking ${plan.outcome}). Decision: ${plan.decision}` : `Dispute ${plan.reference} closed without action. The booking continues normally.`;
      await em.query("INSERT INTO messages (id, created_at, updated_at, conversation_id, sender_id, kind, body, status) VALUES (UUID(), ?, ?, ?, NULL, 'system', ?, 'visible')", [decidedAt, decidedAt, conversationId, body]);
      lastMessage = decidedAt!;
    }
    await em.query('UPDATE conversations SET last_message_at = ? WHERE id = ?', [lastMessage, conversationId]);

    const assigned = plan.status === 'open' ? null : admin.id;
    await em.query(
      `INSERT INTO disputes (id, created_at, updated_at, reference, booking_id, opened_by_id, opened_by_role, against_user_id, type, description, status, assigned_admin_id, conversation_id,
         booking_outcome, decision_note, resolved_by_id, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        disputeId,
        openedAt,
        decidedAt ?? at(2),
        plan.reference,
        bookingId,
        openerId,
        plan.openedBy,
        againstId,
        plan.type,
        plan.description,
        plan.status,
        assigned,
        conversationId,
        plan.status === 'resolved' ? plan.outcome : null,
        plan.decision ?? null,
        plan.status === 'resolved' ? admin.id : null,
        plan.status === 'resolved' ? decidedAt : null,
      ],
    );
    await em.query('UPDATE conversations SET dispute_id = ? WHERE id = ?', [disputeId, conversationId]);

    // Booking freeze / outcome.
    const bookingDisputeStatus = plan.status === 'open' || plan.status === 'in_review' ? 'open' : plan.status === 'resolved' ? 'resolved' : 'none';
    await em.query('UPDATE bookings SET dispute_status = ? WHERE id = ?', [bookingDisputeStatus, bookingId]);
    if (plan.status === 'resolved' && plan.outcome === 'cancelled' && b.status === 'completed') {
      await em.query("UPDATE bookings SET status = 'cancelled', cancelled_by = 'admin', cancel_reason = 'dispute', completed_at = NULL WHERE id = ?", [bookingId]);
      await em.query('UPDATE services SET bookings_count = GREATEST(bookings_count - 1, 0) WHERE id = ?', [b.service_id]);
      await em.query('UPDATE provider_profiles SET completed_bookings_count = GREATEST(completed_bookings_count - 1, 0) WHERE user_id = ?', [b.provider_id]);
      await em.query("UPDATE availability_blocks SET deleted_at = ? WHERE booking_id = ? AND deleted_at IS NULL", [decidedAt, bookingId]);
      await em.query("UPDATE invoices SET deleted_at = ? WHERE booking_id = ? AND deleted_at IS NULL", [decidedAt, bookingId]);
      for (const [from, to, reason] of [
        ['completed', 'accepted', 'dispute_resolved'],
        ['accepted', 'cancelled', 'dispute'],
      ] as const) {
        await em.query('INSERT INTO booking_status_changes (id, created_at, booking_id, from_status, to_status, actor_id, reason, note, notified) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, 0)', [
          decidedAt,
          bookingId,
          from,
          to,
          admin.id,
          reason,
          `Dispute ${plan.reference}: ${plan.decision}`,
        ]);
      }
    }

    // Evidence: chat snapshot + files.
    const [direct] = await em.query("SELECT c.id, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n FROM conversations c WHERE c.booking_id = ? AND c.kind = 'direct' ORDER BY c.created_at LIMIT 1", [bookingId]);
    if (direct) {
      await em.query("INSERT INTO dispute_evidence (id, created_at, dispute_id, uploaded_by_id, file_id, kind, note) VALUES (UUID(), ?, ?, ?, NULL, 'chat_snapshot', ?)", [
        openedAt,
        disputeId,
        openerId,
        `conversation:${direct.id} (${Number(direct.n)} messages until ${openedAt.toISOString()})`,
      ]);
    }
    const events: [Date, string | null, string, Record<string, unknown> | null][] = [[openedAt, admin.id, 'opened', { onBehalfOf: plan.openedBy, type: plan.type, ignoreWindow: false, note: null, chatSnapshot: direct?.id ?? null }]];
    for (const [i, e] of plan.evidence.entries()) {
      const buffer = e.kind === 'png' ? await evidenceImage(e.title, e.lines, e.who === 'c' ? '#2f6f5e' : '#8a4b2a') : receiptPdf(e.title, e.lines);
      const party = e.who === 'c' ? b.client_id : b.provider_id;
      const file = await files.store({ buffer, originalName: e.name, purpose: FilePurpose.Evidence, ownerId: party }, { em });
      const when = new Date(openedAt.getTime() + (i + 1) * HOUR);
      await em.query("INSERT INTO dispute_evidence (id, created_at, dispute_id, uploaded_by_id, file_id, kind, note) VALUES (UUID(), ?, ?, ?, ?, 'file', NULL)", [when, disputeId, party, file.id]);
      events.push([when, admin.id, 'evidence_added', { fileId: file.id, partyUserId: party, name: e.name, onBehalf: true }]);
      summary.disputeEvidenceFiles += 1;
    }
    if (assigned) events.push([new Date(openedAt.getTime() + 3 * HOUR), admin.id, 'assigned', { adminId: admin.id, adminName: admin.fullName, previousAdminId: null }]);
    if (plan.chat.some(([who]) => who === 'a')) events.push([new Date(openedAt.getTime() + 4 * HOUR), admin.id, 'message_sent', {}]);
    if (plan.status === 'resolved') events.push([decidedAt!, admin.id, 'resolved', { bookingOutcome: plan.outcome, decisionNote: plan.decision }]);
    if (plan.status === 'closed') events.push([decidedAt!, admin.id, 'closed', { note: plan.decision, bookingDisputeStatus: 'none' }]);
    if (conversationClosed) events.push([new Date(decidedAt!.getTime() + 7 * DAY), null, 'conversation_closed', { conversationId, afterDays: 7 }]);
    for (const [when, actor, type, data] of events) {
      await em.query('INSERT INTO dispute_events (id, created_at, dispute_id, actor_id, type, data) VALUES (UUID(), ?, ?, ?, ?, ?)', [when, disputeId, actor, type, data ? JSON.stringify(data) : null]);
      if (type === 'opened' || type === 'resolved' || type === 'closed' || type === 'assigned') {
        await em.query(
          "INSERT INTO audit_logs (id, created_at, actor_id, actor_role, action, object_type, object_id, object_label, level, changes, note, source) VALUES (UUID(), ?, ?, 'admin', ?, 'dispute', ?, ?, ?, ?, ?, 'dashboard')",
          [when, actor, `dispute.${type}`, disputeId, plan.reference, type === 'assigned' ? 'normal' : 'sensitive', JSON.stringify(data), type === 'resolved' || type === 'closed' ? (plan.decision ?? null) : null],
        );
      }
    }
    summary.disputes += 1;
  }

  await em.query("UPDATE sequences SET value = GREATEST(value, 31) WHERE name = 'dispute'");
  return summary;
}
