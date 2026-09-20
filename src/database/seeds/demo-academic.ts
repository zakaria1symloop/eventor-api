/**
 * Demo forms and academic requests (module 10), called by `demo-seed.ts` inside
 * its transaction after bookings.
 *
 * Forms: "Event request" (default, published v3, versions 1–3 kept), "Scientific
 * day / conference" (published v2), "Graduation ceremony" (draft), "Club
 * workshop" (closed, v1). 25 requests ACR-000120…ACR-000144 over the last 60 days
 * in every status (Figma: ACR-000142 Science Day 2026, Université d'Alger 1),
 * answers matching their version, needs, placeholder PDF attachments, proposals
 * with real services, bookings for in-progress and completed requests (requester
 * client accounts created), requested changes and an activity timeline.
 *
 * Idempotent: skipped when the form `event-request` exists.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { FormField, FormSchema } from '../../academic/entities/form-version.entity.js';
import { starterSchema } from '../../academic/form-schema.js';
import { FilePurpose } from '../../common/enums/file.enums.js';
import type { FilesService } from '../../files/files.service.js';

export interface AcademicSeedContext {
  em: EntityManager;
  files: FilesService;
  admin: { id: string; fullName: string } | null;
}

const DAY = 86_400_000;
const uuid = () => crypto.randomUUID();
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY).toISOString().slice(0, 10);

function placeholderPdf(title: string, subtitle: string): Buffer {
  const ascii = (s: string) => s.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, ' ');
  const stream = `BT /F1 20 Tf 60 740 Td (${ascii(title)}) Tj 0 -36 Td /F1 14 Tf (${ascii(subtitle)}) Tj 0 -36 Td /F1 11 Tf (EVENTOR DEMO ATTACHMENT) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
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

// ── schemas ─────────────────────────────────────────────────────

const without = (schema: FormSchema, keys: string[]): FormSchema => ({ fields: schema.fields.filter((f) => !keys.includes(f.key)) });
const withFields = (schema: FormSchema, fields: FormField[]): FormSchema => ({ fields: [...schema.fields, ...fields] });

const PROGRAMME: FormField = {
  key: 'programme',
  type: 'file',
  label_en: 'Programme or invitation (PDF)',
  label_ar: 'البرنامج أو الدعوة (PDF)',
  help_en: 'Optional, one file up to 5 MB.',
  help_ar: 'اختياري، ملف واحد حتى 5 ميغابايت.',
  section: 'event',
  validation: { maxFiles: 1, types: ['pdf'] },
};

const CONSENT: FormField = {
  key: 'consent',
  type: 'consent',
  label_en: 'I agree that Eventor contacts providers on behalf of my institution.',
  label_ar: 'أوافق على أن تتواصل Eventor مع مقدمي الخدمات نيابة عن مؤسستي.',
  required: true,
};

const EVENT_V1 = without(starterSchema(), ['needs', 'budget']);
const EVENT_V2 = starterSchema();
const EVENT_V3 = withFields(starterSchema(), [
  {
    key: 'venue',
    type: 'single_choice',
    label_en: 'Do you already have a venue?',
    label_ar: 'هل لديكم مكان للمناسبة؟',
    section: 'event',
    options: [
      { value: 'yes', label_en: 'Yes, on campus', label_ar: 'نعم، داخل الحرم الجامعي' },
      { value: 'no', label_en: 'No, we need one', label_ar: 'لا، نحتاج إلى مكان' },
    ],
  },
  { key: 'venue_name', type: 'short_text', label_en: 'Venue name', label_ar: 'اسم المكان', required: true, section: 'event', showIf: { field: 'venue', equals: 'yes' } },
  PROGRAMME,
  CONSENT,
]);

const SCIENTIFIC_V1 = withFields(starterSchema(), [
  { key: 'speakers', type: 'number', label_en: 'Number of speakers', label_ar: 'عدد المتدخلين', section: 'event', validation: { min: 1, max: 200, integer: true } },
]);
const SCIENTIFIC_V2 = withFields(SCIENTIFIC_V1, [
  { key: 'schedule', type: 'time_range', label_en: 'Schedule', label_ar: 'التوقيت', section: 'event' },
  {
    key: 'accommodation',
    type: 'dropdown',
    label_en: 'Accommodation for guests',
    label_ar: 'إيواء الضيوف',
    section: 'event',
    options: [
      { value: 'none', label_en: 'Not needed', label_ar: 'غير ضروري' },
      { value: 'hotel', label_en: 'Hotel rooms', label_ar: 'غرف فندقية' },
    ],
  },
  { key: 'nights', type: 'number', label_en: 'Nights', label_ar: 'عدد الليالي', required: true, section: 'event', showIf: { field: 'accommodation', equals: 'hotel' }, validation: { min: 1, max: 10, integer: true } },
  PROGRAMME,
]);

const GRADUATION_DRAFT = withFields(starterSchema(), [
  { key: 'graduates', type: 'number', label_en: 'Number of graduates', label_ar: 'عدد الخريجين', section: 'event', validation: { min: 1, integer: true } },
  { key: 'gowns', type: 'single_choice', label_en: 'Gown rental', label_ar: 'كراء الأثواب', section: 'event', options: [{ value: 'yes', label_en: 'Yes', label_ar: 'نعم' }, { value: 'no', label_en: 'No', label_ar: '' }] },
]);

const CLUB_V1 = without(starterSchema(), ['budget']);

// ── requests ────────────────────────────────────────────────────

type Status = 'pending' | 'changes_requested' | 'approved' | 'in_progress' | 'rejected' | 'completed' | 'cancelled';

interface RequestSeed {
  form: 'event-request' | 'scientific-day' | 'club-workshop';
  version: number;
  status: Status;
  title: string;
  institution: string;
  requester: [name: string, email: string, phone: string];
  wilaya: number;
  attendees: number;
  /** Days from submission to the event. */
  eventInDays: number;
  submittedDaysAgo: number;
  eventType: 'conference' | 'academic' | 'graduation' | 'other';
  needs: string[];
  budget?: [number, number];
  services?: string[];
  attachment?: boolean;
  extra?: Record<string, unknown>;
}

const REQUESTS: RequestSeed[] = [
  { form: 'event-request', version: 1, status: 'completed', title: 'Journée portes ouvertes USTHB', institution: 'USTHB', requester: ['Karim Mansour', 'k.mansour@usthb.dz', '+213661300120'], wilaya: 16, attendees: 800, eventInDays: 12, submittedDaysAgo: 59, eventType: 'academic', needs: ['salles-des-fetes', 'traiteur'], services: ['Corporate lunch boxes'] },
  { form: 'event-request', version: 1, status: 'rejected', title: 'Soirée de gala des étudiants', institution: 'Université de Béjaïa', requester: ['Lynda Hamiche', 'lynda.hamiche@univ-bejaia.dz', '+213770300121'], wilaya: 6, attendees: 1200, eventInDays: 20, submittedDaysAgo: 57, eventType: 'other', needs: ['musique-dj'] },
  { form: 'club-workshop', version: 1, status: 'completed', title: 'Atelier robotique · Club Robotics ENP', institution: 'École Nationale Polytechnique', requester: ['Yanis Belkacemi', 'y.belkacemi@g.enp.edu.dz', '+213555300122'], wilaya: 16, attendees: 60, eventInDays: 10, submittedDaysAgo: 55, eventType: 'other', needs: ['traiteur'], services: ['Corporate lunch boxes'] },
  { form: 'scientific-day', version: 1, status: 'completed', title: 'Colloque national de chimie', institution: 'Université Constantine 1', requester: ['Samia Boudjemaa', 's.boudjemaa@umc.edu.dz', '+213662300123'], wilaya: 25, attendees: 250, eventInDays: 14, submittedDaysAgo: 52, eventType: 'conference', needs: ['traiteur', 'salles-des-fetes'], budget: [200000, 450000], services: ['Chakhchoukha & jwaz menu'], extra: { speakers: 18 } },
  { form: 'event-request', version: 2, status: 'cancelled', title: 'Remise des diplômes Master 2', institution: "Université d'Oran 1", requester: ['Mohamed Kaddour', 'm.kaddour@univ-oran1.dz', '+213771300124'], wilaya: 31, attendees: 400, eventInDays: 25, submittedDaysAgo: 50, eventType: 'graduation', needs: ['photographie', 'gateaux-patisserie'], budget: [150000, 300000] },
  { form: 'club-workshop', version: 1, status: 'rejected', title: 'Hackathon week-end', institution: 'ESI Alger', requester: ['Imane Chaib', 'i.chaib@esi.dz', '+213556300125'], wilaya: 16, attendees: 150, eventInDays: 8, submittedDaysAgo: 46, eventType: 'other', needs: ['traiteur'] },
  { form: 'event-request', version: 2, status: 'in_progress', title: 'Forum entreprises & emploi', institution: 'Université de Blida 1', requester: ['Rachid Ouali', 'r.ouali@univ-blida.dz', '+213663300126'], wilaya: 9, attendees: 900, eventInDays: 55, submittedDaysAgo: 44, eventType: 'conference', needs: ['decoration', 'traiteur'], budget: [300000, 700000], services: ['Corporate event stage', 'Waiters & service team'] },
  { form: 'scientific-day', version: 1, status: 'in_progress', title: "Journée d'étude en droit numérique", institution: "Université d'Alger 1", requester: ['Nadia Hamdi', 'nadia.hamdi@univ-alger.dz', '+213555123456'], wilaya: 16, attendees: 180, eventInDays: 48, submittedDaysAgo: 40, eventType: 'academic', needs: ['photographie', 'traiteur'], budget: [100000, 250000], services: ['Engagement photo session', 'Corporate lunch boxes'], extra: { speakers: 9 } },
  { form: 'event-request', version: 2, status: 'approved', title: 'Semaine culturelle internationale', institution: 'Université de Tlemcen', requester: ['Hichem Benali', 'h.benali@univ-tlemcen.dz', '+213772300128'], wilaya: 13, attendees: 600, eventInDays: 60, submittedDaysAgo: 36, eventType: 'other', needs: ['musique-dj', 'decoration'], budget: [250000, 500000], services: ['Malouf orchestra · full evening'] },
  { form: 'event-request', version: 3, status: 'rejected', title: 'Concert de fin d’année', institution: 'Université de Tizi Ouzou', requester: ['Kahina Aït Ali', 'k.aitali@ummto.dz', '+213557300129'], wilaya: 15, attendees: 2000, eventInDays: 30, submittedDaysAgo: 33, eventType: 'other', needs: ['musique-dj'], budget: [800000, 1500000], extra: { venue: 'no', consent: true } },
  { form: 'scientific-day', version: 2, status: 'in_progress', title: 'Congrès maghrébin de pédiatrie', institution: "Faculté de médecine d'Oran", requester: ['Amel Bensalem', 'a.bensalem@univ-oran1.dz', '+213664300130'], wilaya: 31, attendees: 450, eventInDays: 70, submittedDaysAgo: 30, eventType: 'conference', needs: ['salles-des-fetes', 'traiteur'], budget: [600000, 1200000], services: ['Sea-view wedding hall · 300 guests', 'Seafood dinner menu'], attachment: true, extra: { speakers: 32, schedule: { start: '08:30', end: '18:00' }, accommodation: 'hotel', nights: 2 } },
  { form: 'event-request', version: 3, status: 'approved', title: 'Cérémonie des majors de promotion', institution: 'ENSIA', requester: ['Walid Hadjadj', 'w.hadjadj@ensia.edu.dz', '+213773300131'], wilaya: 16, attendees: 220, eventInDays: 45, submittedDaysAgo: 28, eventType: 'graduation', needs: ['photographie', 'gateaux-patisserie', 'fleurs'], budget: [180000, 350000], services: ['Graduation cupcakes', 'Cinematic wedding film'], attachment: true, extra: { venue: 'yes', venue_name: 'Amphithéâtre A', consent: true } },
  { form: 'scientific-day', version: 2, status: 'changes_requested', title: 'Journées de génie civil', institution: 'Université de Sétif 1', requester: ['Farid Lounis', 'f.lounis@univ-setif.dz', '+213558300132'], wilaya: 19, attendees: 300, eventInDays: 50, submittedDaysAgo: 24, eventType: 'academic', needs: ['traiteur'], budget: [120000, 260000], extra: { speakers: 14, accommodation: 'none' } },
  { form: 'event-request', version: 3, status: 'in_progress', title: 'Salon de l’innovation étudiante', institution: 'Université Mentouri Constantine', requester: ['Selma Rahmani', 's.rahmani@umc.edu.dz', '+213665300133'], wilaya: 25, attendees: 700, eventInDays: 40, submittedDaysAgo: 22, eventType: 'conference', needs: ['decoration', 'photographie'], budget: [200000, 420000], services: ['Stage and table decoration', 'Wedding photography · Constantine'], attachment: true, extra: { venue: 'yes', venue_name: 'Hall du rectorat', consent: true } },
  { form: 'event-request', version: 3, status: 'cancelled', title: 'Tournoi inter-facultés', institution: 'Université de Batna 2', requester: ['Adel Mebarki', 'a.mebarki@univ-batna2.dz', '+213774300134'], wilaya: 5, attendees: 500, eventInDays: 35, submittedDaysAgo: 20, eventType: 'other', needs: ['traiteur'], budget: [90000, 180000], extra: { venue: 'yes', venue_name: 'Complexe sportif', consent: true } },
  { form: 'scientific-day', version: 2, status: 'approved', title: 'Symposium intelligence artificielle', institution: 'ESI Sidi Bel Abbès', requester: ['Riad Benhamou', 'r.benhamou@esi-sba.dz', '+213559300135'], wilaya: 22, attendees: 350, eventInDays: 65, submittedDaysAgo: 17, eventType: 'conference', needs: ['salles-des-fetes', 'photographie'], budget: [300000, 650000], services: ['Grande salle · 150 seats'], attachment: true, extra: { speakers: 20, schedule: { start: '09:00', end: '17:30' }, accommodation: 'none' } },
  { form: 'event-request', version: 3, status: 'changes_requested', title: 'Remise des diplômes Licence', institution: 'Université de Mostaganem', requester: ['Houda Ziani', 'h.ziani@univ-mosta.dz', '+213666300136'], wilaya: 27, attendees: 1000, eventInDays: 58, submittedDaysAgo: 15, eventType: 'graduation', needs: ['photographie', 'decoration'], budget: [250000, 600000], extra: { venue: 'no', consent: true } },
  { form: 'event-request', version: 3, status: 'approved', title: 'Journée de sensibilisation santé', institution: 'Université de Ouargla', requester: ['Sofiane Guerfi', 's.guerfi@univ-ouargla.dz', '+213775300137'], wilaya: 30, attendees: 400, eventInDays: 42, submittedDaysAgo: 13, eventType: 'academic', needs: ['traiteur'], budget: [80000, 160000], services: ['Henna night dinner'], extra: { venue: 'yes', venue_name: 'Auditorium', consent: true } },
  { form: 'scientific-day', version: 2, status: 'rejected', title: 'Séminaire doctoral fermé', institution: 'Université de Djelfa', requester: ['Nabil Saïdi', 'n.saidi@univ-djelfa.dz', '+213560300138'], wilaya: 17, attendees: 40, eventInDays: 18, submittedDaysAgo: 11, eventType: 'academic', needs: ['traiteur'], budget: [20000, 40000], extra: { speakers: 4, accommodation: 'none' } },
  { form: 'event-request', version: 3, status: 'changes_requested', title: 'Festival du film universitaire', institution: 'ENSJSI', requester: ['Meriem Taleb', 'm.taleb@ensjsi.dz', '+213667300139'], wilaya: 16, attendees: 500, eventInDays: 75, submittedDaysAgo: 9, eventType: 'other', needs: ['photographie', 'musique-dj'], budget: [300000, 550000], extra: { venue: 'yes', venue_name: 'Salle Ibn Khaldoun', consent: true } },
  { form: 'event-request', version: 3, status: 'pending', title: 'Cérémonie des doctorants', institution: 'USTO-MB', requester: ['Yasmine Benyahia', 'y.benyahia@univ-usto.dz', '+213776300140'], wilaya: 31, attendees: 260, eventInDays: 52, submittedDaysAgo: 7, eventType: 'graduation', needs: ['gateaux-patisserie', 'fleurs'], budget: [120000, 240000], attachment: true, extra: { venue: 'yes', venue_name: 'Amphi Senouci', consent: true } },
  { form: 'scientific-day', version: 2, status: 'pending', title: 'Conférence énergies renouvelables', institution: 'Université de Béchar', requester: ['Abdelkader Kebir', 'a.kebir@univ-bechar.dz', '+213561300141'], wilaya: 8, attendees: 200, eventInDays: 60, submittedDaysAgo: 5, eventType: 'conference', needs: ['salles-des-fetes', 'traiteur'], budget: [150000, 300000], extra: { speakers: 11, schedule: { start: '09:00', end: '16:00' }, accommodation: 'hotel', nights: 1 } },
  { form: 'event-request', version: 3, status: 'pending', title: 'Science Day 2026', institution: "Université d'Alger 1", requester: ['Nassima Kaci', 'nassima.kaci@univ-alger.dz', '+213555204142'], wilaya: 16, attendees: 350, eventInDays: 57, submittedDaysAgo: 2, eventType: 'academic', needs: ['salles-des-fetes', 'traiteur', 'photographie'], budget: [150000, 400000], attachment: true, extra: { venue: 'yes', venue_name: 'Amphithéâtre Benyoucef Benkhedda', consent: true } },
  { form: 'event-request', version: 3, status: 'pending', title: 'Journée mondiale du diabète', institution: 'CHU Mustapha Pacha', requester: ['Dr Lamia Ferhat', 'l.ferhat@chu-mustapha.dz', '+213668300143'], wilaya: 16, attendees: 150, eventInDays: 45, submittedDaysAgo: 1, eventType: 'academic', needs: ['traiteur'], budget: [60000, 120000], extra: { venue: 'no', consent: true } },
  { form: 'scientific-day', version: 2, status: 'pending', title: 'Rencontre des clubs scientifiques', institution: 'Université de Annaba', requester: ['Bilal Hamidi', 'b.hamidi@univ-annaba.dz', '+213777300144'], wilaya: 23, attendees: 320, eventInDays: 40, submittedDaysAgo: 0, eventType: 'academic', needs: ['decoration', 'musique-dj'], budget: [100000, 220000], extra: { speakers: 6, accommodation: 'none' } },
];

// ── seed ───────────────────────────────────────────────────────

export async function seedAcademic(ctx: AcademicSeedContext): Promise<{ forms: number; academicRequests: number; proposals: number; academicBookings: number }> {
  const { em } = ctx;
  const summary = { forms: 0, academicRequests: 0, proposals: 0, academicBookings: 0 };
  const [exists] = await em.query("SELECT id FROM forms WHERE slug = 'event-request'");
  if (exists) return summary;
  const [adminRow] = ctx.admin ? [ctx.admin] : await em.query("SELECT id, full_name AS fullName FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1");
  if (!adminRow) return summary;
  const adminId: string = adminRow.id;
  const now = new Date();
  const ago = (days: number, hours = 0) => new Date(now.getTime() - days * DAY - hours * 3_600_000);

  const audit = (objectId: string, label: string, action: string, at: Date, changes: Record<string, unknown> | null, note: string | null = null, actor: string | null = adminId) =>
    em.query(
      'INSERT INTO audit_logs (id, created_at, actor_id, actor_role, action, object_type, object_id, object_label, level, changes, note, source) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [at, actor, actor ? 'admin' : null, action, 'academic_request', objectId, label.slice(0, 190), 'normal', changes ? JSON.stringify(changes) : null, note, actor ? 'dashboard' : 'web'],
    );

  // Forms and versions
  const forms = new Map<string, { id: string; versions: Map<number, { id: string; schema: FormSchema }> }>();
  const FORM_SEEDS: { slug: string; nameEn: string; nameAr: string; descriptionEn: string; descriptionAr: string; status: string; isDefault: boolean; limit: number | null; versions: FormSchema[]; draft: FormSchema; createdDaysAgo: number }[] = [
    {
      slug: 'event-request',
      nameEn: 'Event request',
      nameAr: 'طلب تنظيم مناسبة',
      descriptionEn: 'Universities, schools and clubs: tell us about your event and we propose verified providers.',
      descriptionAr: 'الجامعات والمدارس والنوادي: أخبرونا عن مناسبتكم وسنقترح عليكم مقدمي خدمات موثوقين.',
      status: 'published',
      isDefault: true,
      limit: 3,
      versions: [EVENT_V1, EVENT_V2, EVENT_V3],
      draft: EVENT_V3,
      createdDaysAgo: 120,
    },
    {
      slug: 'scientific-day',
      nameEn: 'Scientific day / conference',
      nameAr: 'يوم علمي / مؤتمر',
      descriptionEn: 'Conferences, study days and symposiums: rooms, catering, photography and guest accommodation.',
      descriptionAr: 'المؤتمرات والأيام الدراسية والندوات: القاعات والإطعام والتصوير وإيواء الضيوف.',
      status: 'published',
      isDefault: false,
      limit: null,
      versions: [SCIENTIFIC_V1, SCIENTIFIC_V2],
      draft: SCIENTIFIC_V2,
      createdDaysAgo: 90,
    },
    {
      slug: 'graduation',
      nameEn: 'Graduation ceremony',
      nameAr: 'حفل التخرج',
      descriptionEn: 'Graduation ceremonies: stage, photography, gowns and cakes.',
      descriptionAr: 'حفلات التخرج: المنصة والتصوير والأثواب والحلويات.',
      status: 'draft',
      isDefault: false,
      limit: null,
      versions: [],
      draft: GRADUATION_DRAFT,
      createdDaysAgo: 6,
    },
    {
      slug: 'club-workshop',
      nameEn: 'Club workshop',
      nameAr: 'ورشة النوادي',
      descriptionEn: 'Student club workshops (closed for this semester).',
      descriptionAr: 'ورشات النوادي الطلابية (مغلقة هذا السداسي).',
      status: 'closed',
      isDefault: false,
      limit: 1,
      versions: [CLUB_V1],
      draft: CLUB_V1,
      createdDaysAgo: 100,
    },
  ];
  for (const f of FORM_SEEDS) {
    const id = uuid();
    await em.query(
      `INSERT INTO forms (id, created_at, updated_at, slug, name_en, name_ar, description_en, description_ar, status, is_default, requires_auth, max_submissions_per_email_per_month,
                          confirmation_en, confirmation_ar, live_version_id, draft_schema, created_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 0, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        ago(f.createdDaysAgo),
        ago(Math.min(f.createdDaysAgo, 3)),
        f.slug,
        f.nameEn,
        f.nameAr,
        f.descriptionEn,
        f.descriptionAr,
        f.isDefault ? 1 : 0,
        f.limit,
        'Thank you. Your request was received; we will get back to you by email within 3 working days.',
        'شكرًا. تم استلام طلبكم، وسنعود إليكم عبر البريد الإلكتروني خلال 3 أيام عمل.',
        JSON.stringify(f.draft),
        adminId,
      ],
    );
    const versions = new Map<number, { id: string; schema: FormSchema }>();
    let liveId: string | null = null;
    for (const [index, schema] of f.versions.entries()) {
      const versionId = uuid();
      const version = index + 1;
      await em.query('INSERT INTO form_versions (id, created_at, form_id, version, `schema`, published_by_id, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        versionId,
        ago(f.createdDaysAgo - version * 20 + 20),
        id,
        version,
        JSON.stringify(schema),
        adminId,
        ago(f.createdDaysAgo - version * 20 + 20),
      ]);
      versions.set(version, { id: versionId, schema });
      liveId = versionId;
    }
    await em.query('UPDATE forms SET status = ?, live_version_id = ? WHERE id = ?', [f.status, liveId, id]);
    forms.set(f.slug, { id, versions });
    summary.forms += 1;
  }
  // Exactly one default form.
  await em.query("UPDATE forms SET is_default = (slug = 'event-request') WHERE deleted_at IS NULL");

  const categories = new Map<string, string>((await em.query('SELECT slug, id FROM categories')).map((c: { slug: string; id: string }) => [c.slug, c.id]));
  const services: { id: string; provider_id: string; title_en: string; base_price: string }[] = await em.query("SELECT id, provider_id, title_en, base_price FROM services WHERE deleted_at IS NULL AND status = 'published'");
  const [bookingSeq] = await em.query("SELECT value FROM sequences WHERE name = 'booking'");
  let bookingNumber = Math.max(3000, Number(bookingSeq?.value ?? 0));

  for (const [index, r] of REQUESTS.entries()) {
    const form = forms.get(r.form)!;
    const version = form.versions.get(r.version)!;
    const reference = `ACR-${String(120 + index).padStart(6, '0')}`;
    const requestId = uuid();
    const submittedAt = ago(r.submittedDaysAgo, (index * 5) % 11);
    const eventDate = addDays(submittedAt, r.eventInDays);
    const [name, email, phone] = r.requester;
    const needs = r.needs.map((slug) => categories.get(slug)).filter((id): id is string => !!id);
    const keys = new Set(version.schema.fields.map((f) => f.key));

    let attachmentId: string | null = null;
    if (r.attachment && keys.has('programme')) {
      const file = await ctx.files.store({ buffer: placeholderPdf(r.title, r.institution), originalName: `programme-${reference.toLowerCase()}.pdf`, purpose: FilePurpose.Attachment, ownerId: null }, { em });
      attachmentId = file.id;
    }
    const candidate: Record<string, unknown> = {
      full_name: name,
      phone,
      institution: r.institution,
      title: r.title,
      event_type: r.eventType,
      event_date: eventDate,
      wilaya: r.wilaya,
      attendees: r.attendees,
      needs,
      ...(r.budget ? { budget: { min: r.budget[0], max: r.budget[1] } } : {}),
      ...(attachmentId ? { programme: [attachmentId] } : {}),
      ...r.extra,
    };
    const answers = Object.fromEntries(Object.entries(candidate).filter(([key]) => keys.has(key)));
    const budget = answers.budget as { min: number; max: number } | undefined;

    let requestedChanges: Record<string, unknown> | null = null;
    if (r.status === 'changes_requested') {
      requestedChanges = {
        fields: ['event_date', 'attendees'],
        message: 'Merci de confirmer la date et le nombre de participants attendus.',
        requestedAt: ago(Math.max(0, r.submittedDaysAgo - 2)).toISOString(),
        requestedById: adminId,
        tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        tokenExpiresAt: new Date(now.getTime() + 12 * DAY).toISOString(),
        previousAnswers: answers,
        resubmittedAt: null,
        changedFields: [],
      };
    } else if (r.status === 'pending' && index % 2 === 0) {
      requestedChanges = {
        fields: ['attendees'],
        message: 'Pouvez-vous préciser le nombre de participants ?',
        requestedAt: ago(r.submittedDaysAgo, -2).toISOString(),
        requestedById: adminId,
        tokenHash: null,
        tokenExpiresAt: null,
        previousAnswers: { ...answers, attendees: Math.round(r.attendees / 2) },
        resubmittedAt: ago(Math.max(0, r.submittedDaysAgo - 1)).toISOString(),
        changedFields: ['attendees'],
      };
    }

    const decided = ['approved', 'in_progress', 'completed', 'rejected', 'cancelled'].includes(r.status);
    const requesterId = r.status === 'in_progress' || r.status === 'completed' ? await ensureClient(em, name, email, phone, r.wilaya, submittedAt) : null;
    await em.query(
      `INSERT INTO academic_requests (id, created_at, updated_at, reference, form_id, form_version_id, answers, requester_id, requester_name, requester_email, requester_phone, institution_name, title,
                                      event_type, event_date, wilaya_code, attendees, budget_min, budget_max, status, requested_changes, decision_message, reject_reason, decided_by_id, decided_at,
                                      assigned_admin_id, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        requestId,
        submittedAt,
        ago(Math.max(0, r.submittedDaysAgo - 1)),
        reference,
        form.id,
        version.id,
        JSON.stringify(answers),
        requesterId,
        name,
        email,
        phone,
        keys.has('institution') ? r.institution : null,
        r.title,
        r.eventType,
        eventDate,
        r.wilaya,
        keys.has('attendees') ? r.attendees : null,
        budget ? budget.min.toFixed(2) : null,
        budget ? budget.max.toFixed(2) : null,
        r.status,
        requestedChanges ? JSON.stringify(requestedChanges) : null,
        r.status === 'rejected' ? 'Nous ne pouvons pas accompagner cet événement pour le moment.' : r.status === 'approved' ? 'Voici nos propositions de prestataires.' : null,
        r.status === 'rejected' ? 'out_of_scope' : r.status === 'cancelled' ? 'requester_withdrew' : null,
        decided ? adminId : null,
        decided ? ago(Math.max(0, r.submittedDaysAgo - 3)) : null,
        r.status === 'pending' && index % 3 === 0 ? null : adminId,
        submittedAt,
      ],
    );
    summary.academicRequests += 1;
    const label = `${reference} ${r.title}`;
    await audit(requestId, label, 'academic_request.submitted', submittedAt, { formId: form.id, version: r.version, email, lang: index % 2 ? 'ar' : 'en', linkedAccount: false }, null, null);
    for (const categoryId of keys.has('needs') ? needs : []) {
      await em.query('INSERT INTO academic_request_needs (id, created_at, request_id, category_id, note) VALUES (UUID(), ?, ?, ?, NULL)', [submittedAt, requestId, categoryId]);
    }
    if (attachmentId) {
      await em.query('INSERT INTO academic_request_attachments (id, created_at, request_id, file_id, field_key) VALUES (UUID(), ?, ?, ?, ?)', [submittedAt, requestId, attachmentId, 'programme']);
    }
    if (r.status !== 'pending' || requestedChanges) await audit(requestId, label, 'academic_request.assigned', ago(r.submittedDaysAgo, -1), { assignedAdminId: { from: null, to: adminId } });
    if (requestedChanges) await audit(requestId, label, 'academic_request.changes_requested', new Date(requestedChanges.requestedAt as string), { status: { from: 'pending', to: 'changes_requested' }, fields: requestedChanges.fields }, requestedChanges.message as string);
    if (requestedChanges?.resubmittedAt) {
      await audit(requestId, label, 'academic_request.resubmitted', new Date(requestedChanges.resubmittedAt as string), { status: { from: 'changes_requested', to: 'pending' }, changedFields: ['attendees'] }, null, null);
    }

    // Proposals and bookings
    const decisionAt = ago(Math.max(0, r.submittedDaysAgo - 3));
    if (r.status === 'rejected') await audit(requestId, label, 'academic_request.rejected', decisionAt, { status: { from: 'pending', to: 'rejected' }, reason: 'out_of_scope' });
    if (r.status === 'cancelled') await audit(requestId, label, 'academic_request.cancelled', decisionAt, { status: { from: 'approved', to: 'cancelled' }, reason: 'requester_withdrew' }, 'requester_withdrew');
    if (!['approved', 'in_progress', 'completed'].includes(r.status)) continue;
    await audit(requestId, label, 'academic_request.approved', decisionAt, { status: { from: 'pending', to: 'approved' } });
    for (const [position, title] of (r.services ?? []).entries()) {
      const service = services.find((s) => s.title_en === title);
      if (!service) continue;
      const proposalId = uuid();
      let bookingId: string | null = null;
      if (requesterId && position === 0) {
        bookingId = uuid();
        bookingNumber += 1;
        const completed = r.status === 'completed';
        const bookingDate = completed ? addDays(now, -Math.max(2, r.submittedDaysAgo - r.eventInDays)) : eventDate;
        const created = new Date(decisionAt.getTime() + 3_600_000);
        const total = Number(service.base_price).toFixed(2);
        await em.query(
          `INSERT INTO bookings (id, created_at, updated_at, reference, client_id, provider_id, service_id, pack_id, academic_request_id, status, dispute_status, event_type, event_date, start_time, end_time,
                                 wilaya_code, guests, client_note, subtotal, discount_total, total, fee_percent, responded_at, completed_at, source, created_by_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'none', ?, ?, '09:00:00', '17:00:00', ?, ?, ?, ?, '0.00', ?, '10.00', ?, ?, 'dashboard', ?)`,
          [
            bookingId,
            created,
            created,
            `EVT-${String(bookingNumber).padStart(6, '0')}`,
            requesterId,
            service.provider_id,
            service.id,
            requestId,
            completed ? 'completed' : 'accepted',
            r.eventType,
            bookingDate,
            r.wilaya,
            r.attendees,
            `Academic request ${reference}: ${r.title}`,
            total,
            total,
            new Date(created.getTime() + 6 * 3_600_000),
            completed ? new Date(`${bookingDate}T20:00:00Z`) : null,
            adminId,
          ],
        );
        await em.query("INSERT INTO booking_lines (id, created_at, updated_at, booking_id, kind, service_id, label, quantity, unit_amount, amount, position) VALUES (UUID(), ?, ?, ?, 'service', ?, ?, 1, ?, ?, 0)", [
          created,
          created,
          bookingId,
          service.id,
          service.title_en,
          total,
          total,
        ]);
        await em.query("INSERT INTO booking_status_changes (id, created_at, booking_id, from_status, to_status, actor_id, reason, note, notified) VALUES (UUID(), ?, ?, NULL, 'pending', ?, NULL, NULL, 1)", [created, bookingId, adminId]);
        await em.query("INSERT INTO booking_status_changes (id, created_at, booking_id, from_status, to_status, actor_id, reason, note, notified) VALUES (UUID(), ?, ?, 'pending', 'accepted', ?, NULL, NULL, 1)", [
          new Date(created.getTime() + 6 * 3_600_000),
          bookingId,
          service.provider_id,
        ]);
        if (completed) {
          await em.query("INSERT INTO booking_status_changes (id, created_at, booking_id, from_status, to_status, actor_id, reason, note, notified) VALUES (UUID(), ?, ?, 'accepted', 'completed', NULL, 'auto_completed', NULL, 1)", [
            new Date(`${bookingDate}T20:00:00Z`),
            bookingId,
          ]);
        } else {
          await em.query("INSERT INTO availability_blocks (id, created_at, updated_at, provider_id, service_id, date, start_time, end_time, kind, booking_id, note) VALUES (UUID(), ?, ?, ?, ?, ?, '09:00:00', '17:00:00', 'booked', ?, NULL)", [
            created,
            created,
            service.provider_id,
            service.id,
            bookingDate,
            bookingId,
          ]);
        }
        summary.academicBookings += 1;
        await audit(requestId, label, 'academic_request.booked', created, { status: { from: 'approved', to: 'in_progress' }, proposalId, bookingId, clientId: requesterId });
      }
      await em.query('INSERT INTO academic_request_proposals (id, created_at, updated_at, request_id, service_id, proposed_by_id, note, booking_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        proposalId,
        decisionAt,
        decisionAt,
        requestId,
        service.id,
        adminId,
        position === 0 ? 'Disponible à la date demandée.' : null,
        bookingId,
      ]);
      summary.proposals += 1;
    }
    if (r.status === 'completed') {
      await audit(requestId, label, 'academic_request.completed', ago(Math.max(0, r.submittedDaysAgo - r.eventInDays - 1)), { status: { from: 'in_progress', to: 'completed' } }, null, null);
    }
  }

  await em.query("UPDATE sequences SET value = GREATEST(value, ?) WHERE name = 'academic_request'", [120 + REQUESTS.length - 1]);
  await em.query("UPDATE sequences SET value = GREATEST(value, ?) WHERE name = 'booking'", [bookingNumber]);
  return summary;
}

/** The requester's client account (created for requests that have bookings). */
async function ensureClient(em: EntityManager, name: string, email: string, phone: string, wilaya: number, createdAt: Date): Promise<string> {
  const [existing] = await em.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return existing.id;
  const [phoneTaken] = await em.query('SELECT id FROM users WHERE phone = ?', [phone]);
  const id = uuid();
  await em.query(
    `INSERT INTO users (id, created_at, updated_at, role, status, verification_status, full_name, email, email_verified_at, phone, password_hash, language, wilaya_code)
     VALUES (?, ?, ?, 'client', 'active', 'not_required', ?, ?, ?, ?, NULL, 'en', ?)`,
    [id, createdAt, createdAt, name, email, createdAt, phoneTaken ? null : phone, wilaya],
  );
  return id;
}
