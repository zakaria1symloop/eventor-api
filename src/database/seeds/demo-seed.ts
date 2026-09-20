/**
 * Demo data for the dashboard (`pnpm seed:demo`): categories, communes, clients,
 * providers with profiles, verification documents in every state (placeholder
 * PDFs/PNGs stored through FilesService), notes, audit entries and a second
 * admin. Idempotent: rows are matched by slug / email / (wilaya, name) and
 * existing ones are left untouched. Refuses to run with NODE_ENV=production.
 *
 * Module 6–7 data (services, photos, packs, availability) comes from
 * `demo-services.ts`; its photos go through the WebP pipeline after COMMIT.
 * Module 8 and 11 data (bookings, invoices, conversations) comes from `demo-bookings.ts`;
 * module 9 disputes from `demo-disputes.ts`, module 10 forms / academic requests from `demo-academic.ts`,
 * modules 12–13 reviews, replies, reports and admin notifications from `demo-reviews.ts`; `stats_daily`
 * is backfilled for 120 days after COMMIT.
 */
import 'reflect-metadata';
import argon2 from 'argon2';
import sharp from 'sharp';
import { DataSource, type EntityManager } from 'typeorm';
import { AuditLog } from '../../admin/entities/audit-log.entity.js';
import { Category } from '../../catalog/entities/category.entity.js';
import { Commune } from '../../catalog/entities/commune.entity.js';
import { AuditLevel, AuditSource } from '../../common/enums/admin.enums.js';
import { DocumentRejectReason, DocumentStatus, DocumentType, FilePurpose } from '../../common/enums/file.enums.js';
import { Language, UserRole, UserStatus, VerificationStatus } from '../../common/enums/user.enums.js';
import { NodeEnv, validateEnv } from '../../config/env.js';
import { FileVariant } from '../../files/entities/file-variant.entity.js';
import { StoredFile } from '../../files/entities/stored-file.entity.js';
import { FilesService } from '../../files/files.service.js';
import { SETTINGS_DEFAULTS, type SettingKey } from '../../settings/settings.defaults.js';
import { ProviderProfile } from '../../users/entities/provider-profile.entity.js';
import { ProviderWilaya } from '../../users/entities/provider-wilaya.entity.js';
import { UserNote } from '../../users/entities/user-note.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { UserDocument } from '../../verification/entities/user-document.entity.js';
import { deriveVerificationStatus, REQUIRED_DOCUMENT_TYPES } from '../../verification/verification.policy.js';
import { buildDataSourceOptions } from '../database.options.js';
import { algiersDay } from '../../stats/stats.policy.js';
import { rollupStats } from '../../stats/stats.rollup.js';
import { addDays } from '../../bookings/bookings.policy.js';
import { seedAcademic } from './demo-academic.js';
import { seedAppData } from './demo-app.js';
import { seedBookings, type BookingSeedSummary } from './demo-bookings.js';
import { seedDisputes } from './demo-disputes.js';
import { seedAdminNotifications, seedReviews } from './demo-reviews.js';
import { recomputeCachedCounters, seedServicesAndPacks, type ServiceSeedSummary } from './demo-services.js';

try {
  process.loadEnvFile();
} catch {
  // Variables come from the environment.
}

const DAY = 86_400_000;
const NOW = Date.now();
const daysAgo = (days: number, hours = 0) => new Date(NOW - days * DAY - hours * 3_600_000);

/** Deterministic PRNG so every run produces the same data. */
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
const rand = prng(20260916);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const between = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));

// ── reference data ────────────────────────────────────────────

const CATEGORIES = [
  { slug: 'salles-des-fetes', nameEn: 'Venues', nameAr: 'قاعات الحفلات', icon: 'building', isVisible: true, descriptionEn: 'Wedding halls and event venues.', descriptionAr: 'قاعات الأعراس وأماكن المناسبات.' },
  { slug: 'photographie', nameEn: 'Photography', nameAr: 'التصوير', icon: 'camera', isVisible: true, descriptionEn: 'Photographers and videographers.', descriptionAr: 'مصورون فوتوغرافيون ومصورو فيديو.' },
  { slug: 'traiteur', nameEn: 'Catering', nameAr: 'الإطعام', icon: 'utensils', isVisible: true, descriptionEn: 'Caterers and traditional dishes.', descriptionAr: 'ممونو الحفلات والأطباق التقليدية.' },
  { slug: 'musique-dj', nameEn: 'Music & DJ', nameAr: 'الموسيقى', icon: 'music', isVisible: true, descriptionEn: 'DJs, orchestras and singers.', descriptionAr: 'منسقو الموسيقى والفرق والمطربون.' },
  { slug: 'decoration', nameEn: 'Decoration', nameAr: 'الديكور', icon: 'sparkles', isVisible: true, descriptionEn: 'Stage, table and hall decoration.', descriptionAr: 'تزيين المنصات والطاولات والقاعات.' },
  { slug: 'fleurs', nameEn: 'Flowers', nameAr: 'الزهور', icon: 'flower', isVisible: true, descriptionEn: 'Bouquets and floral arrangements.', descriptionAr: 'باقات وتنسيقات الزهور.' },
  { slug: 'gateaux-patisserie', nameEn: 'Cakes & pastry', nameAr: 'الحلويات', icon: 'cake', isVisible: true, descriptionEn: 'Wedding cakes and traditional sweets.', descriptionAr: 'كعكات الأعراس والحلويات التقليدية.' },
  { slug: 'beaute', nameEn: 'Beauty', nameAr: '', icon: 'brush', isVisible: true, descriptionEn: 'Make-up artists and hairdressers.', descriptionAr: null },
  { slug: 'transport', nameEn: 'Transport', nameAr: 'النقل', icon: 'car', isVisible: false, descriptionEn: 'Wedding cars and guest shuttles.', descriptionAr: 'سيارات الأعراس ونقل الضيوف.' },
] as const;

type CategorySlug = (typeof CATEGORIES)[number]['slug'];

const COMMUNES: [wilaya: number, name: string, nameAr: string, postal: string | null][] = [
  [16, 'Alger Centre', 'الجزائر الوسطى', '16000'],
  [16, 'Bab Ezzouar', 'باب الزوار', '16111'],
  [16, 'Hydra', 'حيدرة', '16035'],
  [16, 'Chéraga', 'الشراقة', '16014'],
  [16, 'Kouba', 'القبة', '16050'],
  [16, 'Dely Ibrahim', 'دالي إبراهيم', '16320'],
  [31, 'Oran', 'وهران', '31000'],
  [31, 'Bir El Djir', 'بئر الجير', '31130'],
  [31, 'Es Senia', 'السانية', '31100'],
  [31, 'Arzew', 'أرزيو', '31200'],
  [25, 'Constantine', 'قسنطينة', '25000'],
  [25, 'El Khroub', 'الخروب', '25100'],
  [25, 'Hamma Bouziane', 'حامة بوزيان', '25200'],
  [9, 'Blida', 'البليدة', '09000'],
  [9, 'Boufarik', 'بوفاريك', '09400'],
  [9, 'Ouled Yaïch', 'أولاد يعيش', '09100'],
  [42, 'Tipaza', 'تيبازة', '42000'],
  [42, 'Cherchell', 'شرشال', '42200'],
  [42, 'Koléa', 'القليعة', '42300'],
];

// ── people ────────────────────────────────────────────────────

type DocPlan =
  | 'verified'
  | 'waiting'
  | 'waiting_partial'
  | 'resubmitted_id'
  | 'resubmitted_tax'
  | 'rejected_tax'
  | 'rejected_name'
  | 'incomplete_id_only'
  | 'none';

interface ProviderSeed {
  fullName: string;
  business: string;
  category: CategorySlug;
  wilaya: number;
  areas: number[];
  plan: DocPlan;
  /**
   * TODO(modules 8 & 12): target rating / review count / completed bookings for the
   * bookings and reviews seeds. Not written to the cached counters: those are
   * recomputed from real rows at the end of the seed (0 until bookings and reviews exist).
   */
  rating: number;
  ratings: number;
  completed: number;
  language: Language;
  blocked?: { reason: string; message: string; days: number };
  bioEn: string;
  bioAr: string;
}

const PROVIDERS: ProviderSeed[] = [
  { fullName: 'Karim Belkacem', business: 'Studio Lumière', category: 'photographie', wilaya: 16, areas: [16, 9, 42], plan: 'verified', rating: 4.8, ratings: 126, completed: 142, language: Language.En, bioEn: 'Wedding and engagement photography in Algiers since 2014.', bioAr: 'تصوير الأعراس والخطوبة في الجزائر العاصمة منذ 2014.' },
  { fullName: 'Farid Ouali', business: 'Salle Yasmine', category: 'salles-des-fetes', wilaya: 9, areas: [9, 16], plan: 'verified', rating: 4.6, ratings: 88, completed: 97, language: Language.Ar, bioEn: 'A 400-guest wedding hall with parking in Blida.', bioAr: 'قاعة أعراس تتسع لـ 400 ضيف مع موقف سيارات في البليدة.' },
  { fullName: 'Yacine Meddour', business: 'DJ Amine', category: 'musique-dj', wilaya: 16, areas: [16], plan: 'verified', rating: 3.9, ratings: 41, completed: 52, language: Language.Ar, blocked: { reason: 'repeated_no_show', message: 'Your account is blocked after several client reports of missed events.', days: 3 }, bioEn: 'DJ and sound system for weddings.', bioAr: 'منسق موسيقى ونظام صوت للأعراس.' },
  { fullName: 'Fatima Hadj', business: 'Fleurs de Yasmina', category: 'fleurs', wilaya: 31, areas: [31], plan: 'resubmitted_id', rating: 4.7, ratings: 19, completed: 23, language: Language.Ar, bioEn: 'Bridal bouquets and hall flowers in Oran.', bioAr: 'باقات العروس وتزيين القاعات بالزهور في وهران.' },
  { fullName: 'Walid Saadi', business: 'Studio Pixel', category: 'photographie', wilaya: 25, areas: [25], plan: 'waiting', rating: 0, ratings: 0, completed: 0, language: Language.En, bioEn: 'Photo and video for weddings in Constantine.', bioAr: 'تصوير فوتوغرافي وفيديو للأعراس في قسنطينة.' },
  { fullName: 'Samira Belaid', business: "Douceurs d'Oran", category: 'gateaux-patisserie', wilaya: 31, areas: [31, 27], plan: 'verified', rating: 4.9, ratings: 64, completed: 71, language: Language.Ar, bioEn: 'Wedding cakes and traditional Oranian sweets.', bioAr: 'كعكات الأعراس والحلويات الوهرانية التقليدية.' },
  { fullName: 'Nadia Khelifi', business: 'Traiteur El Djazair', category: 'traiteur', wilaya: 16, areas: [16, 9, 35], plan: 'verified', rating: 4.5, ratings: 102, completed: 118, language: Language.Ar, bioEn: 'Algerian cuisine for up to 800 guests.', bioAr: 'مأكولات جزائرية لغاية 800 ضيف.' },
  { fullName: 'Sofiane Brahimi', business: 'Déco Prestige', category: 'decoration', wilaya: 42, areas: [42, 16], plan: 'waiting_partial', rating: 0, ratings: 0, completed: 0, language: Language.En, bioEn: 'Stage and table decoration.', bioAr: 'تزيين المنصة والطاولات.' },
  { fullName: 'Amina Zerrouki', business: 'Beauty by Amina', category: 'beaute', wilaya: 16, areas: [16], plan: 'rejected_tax', rating: 0, ratings: 0, completed: 0, language: Language.Ar, bioEn: 'Bridal make-up at home.', bioAr: 'مكياج العروس في المنزل.' },
  { fullName: 'Mourad Taleb', business: 'Salle El Bahia', category: 'salles-des-fetes', wilaya: 31, areas: [31], plan: 'verified', rating: 4.4, ratings: 57, completed: 66, language: Language.Ar, bioEn: 'Sea-view wedding hall in Oran.', bioAr: 'قاعة أعراس مطلة على البحر في وهران.' },
  { fullName: 'Lamia Cherif', business: 'Lamia Makeup', category: 'beaute', wilaya: 9, areas: [9], plan: 'incomplete_id_only', rating: 0, ratings: 0, completed: 0, language: Language.Ar, bioEn: 'Make-up and hairstyles for brides.', bioAr: 'مكياج وتسريحات للعرائس.' },
  { fullName: 'Hichem Bouzid', business: 'Orchestre Andalou', category: 'musique-dj', wilaya: 25, areas: [25, 19], plan: 'verified', rating: 4.8, ratings: 45, completed: 49, language: Language.Ar, bioEn: 'Andalusian malouf orchestra.', bioAr: 'جوق المالوف الأندلسي.' },
  { fullName: 'Rachid Mansouri', business: 'Traiteur Constantinois', category: 'traiteur', wilaya: 25, areas: [25], plan: 'waiting', rating: 0, ratings: 0, completed: 0, language: Language.Ar, bioEn: 'Traditional Constantine dishes.', bioAr: 'أطباق قسنطينية تقليدية.' },
  { fullName: 'Imene Djebbar', business: 'Flora Design', category: 'fleurs', wilaya: 16, areas: [16, 42], plan: 'verified', rating: 4.6, ratings: 33, completed: 38, language: Language.En, bioEn: 'Modern floral design for events.', bioAr: 'تنسيق زهور عصري للمناسبات.' },
  { fullName: 'Bilal Haddad', business: 'Pixel Wedding', category: 'photographie', wilaya: 31, areas: [31], plan: 'resubmitted_tax', rating: 0, ratings: 0, completed: 0, language: Language.En, bioEn: 'Drone and cinematic wedding films.', bioAr: 'أفلام أعراس سينمائية بالدرون.' },
  { fullName: 'Sara Lounis', business: 'Gâteaux Sara', category: 'gateaux-patisserie', wilaya: 42, areas: [42], plan: 'none', rating: 0, ratings: 0, completed: 0, language: Language.Ar, bioEn: 'Home-made cakes to order.', bioAr: 'كعكات منزلية حسب الطلب.' },
  { fullName: 'Kamel Ait Ali', business: 'Salle Les Oliviers', category: 'salles-des-fetes', wilaya: 42, areas: [42, 9], plan: 'verified', rating: 4.3, ratings: 29, completed: 35, language: Language.Ar, bioEn: 'Garden venue among olive trees.', bioAr: 'قاعة وحديقة بين أشجار الزيتون.' },
  { fullName: 'Nassim Rahmani', business: 'DJ Nass', category: 'musique-dj', wilaya: 31, areas: [31], plan: 'waiting', rating: 0, ratings: 0, completed: 0, language: Language.En, bioEn: 'Raï and modern mixes.', bioAr: 'موسيقى الراي والمزج العصري.' },
  { fullName: 'Houda Benali', business: 'Déco Mariage Houda', category: 'decoration', wilaya: 16, areas: [16], plan: 'rejected_name', rating: 0, ratings: 0, completed: 0, language: Language.Ar, bioEn: 'Traditional wedding decoration.', bioAr: 'ديكور الأعراس التقليدية.' },
  { fullName: 'Yasmine Amrani', business: 'Studio Yasmine Photo', category: 'photographie', wilaya: 9, areas: [9, 16], plan: 'verified', rating: 4.7, ratings: 52, completed: 60, language: Language.En, bioEn: 'Women photographer for henna and weddings.', bioAr: 'مصورة للحنة والأعراس.' },
  { fullName: 'Tarek Ferhat', business: 'Traiteur Ferhat', category: 'traiteur', wilaya: 9, areas: [9], plan: 'waiting', rating: 0, ratings: 0, completed: 0, language: Language.Ar, bioEn: 'Catering for weddings and circumcisions.', bioAr: 'إطعام الأعراس والختان.' },
  { fullName: 'Meriem Saidi', business: 'Pâtisserie Meriem', category: 'gateaux-patisserie', wilaya: 16, areas: [16], plan: 'verified', rating: 4.9, ratings: 91, completed: 104, language: Language.Ar, bioEn: 'Baklava, makrout and tiered cakes.', bioAr: 'بقلاوة ومقروط وكعكات طبقات.' },
  { fullName: 'Adel Boukhari', business: 'Limousine Prestige', category: 'transport', wilaya: 16, areas: [16, 9, 42], plan: 'verified', rating: 4.2, ratings: 17, completed: 21, language: Language.En, bioEn: 'Wedding cars with driver.', bioAr: 'سيارات أعراس مع سائق.' },
  { fullName: 'Khaled Mebarki', business: 'Salle Royal', category: 'salles-des-fetes', wilaya: 25, areas: [25], plan: 'waiting_partial', rating: 0, ratings: 0, completed: 0, language: Language.Ar, bioEn: 'Royal hall for 600 guests.', bioAr: 'قاعة رويال تتسع لـ 600 ضيف.' },
  { fullName: 'Rym Hamidi', business: 'Rym Events Déco', category: 'decoration', wilaya: 31, areas: [31], plan: 'verified', rating: 4.5, ratings: 26, completed: 30, language: Language.En, bioEn: 'Event styling and balloon decoration.', bioAr: 'تنسيق المناسبات وتزيين البالونات.' },
];

const CLIENT_FIRST = ['Amel', 'Sofia', 'Rania', 'Ines', 'Lina', 'Nour', 'Salma', 'Yousra', 'Hana', 'Kenza', 'Mehdi', 'Anis', 'Ryad', 'Islam', 'Ayoub', 'Zakaria', 'Hamza', 'Omar', 'Riad', 'Nabil'];
const CLIENT_LAST = ['Benamar', 'Bouaziz', 'Kaci', 'Belhadj', 'Mokrani', 'Ziani', 'Hamdi', 'Guerfi', 'Messaoudi', 'Laib', 'Boudiaf', 'Toumi', 'Saci', 'Kherbache', 'Djellal', 'Ouchene', 'Benkhaled', 'Rezig', 'Slimani', 'Aouadi'];
const CLIENT_WILAYAS = [16, 16, 16, 31, 31, 25, 9, 42, 19, 6, 15, 23, null];

const ascii = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');

// ── placeholder files ─────────────────────────────────────────

const DOC_LABELS: Record<DocumentType, string> = {
  [DocumentType.NationalId]: "Carte nationale d'identité",
  [DocumentType.CommercialRegisterOrArtisanCard]: 'Registre du commerce',
  [DocumentType.TaxCard]: "Carte fiscale (NIF)",
};

function placeholderPdf(title: string, name: string): Buffer {
  const clean = (s: string) => ascii(s).replace(/\./g, ' ').toUpperCase();
  const stream = `BT /F1 22 Tf 60 740 Td (${clean(title)}) Tj 0 -40 Td /F1 16 Tf (${clean(name)}) Tj 0 -40 Td /F1 12 Tf (EVENTOR DEMO DOCUMENT - NOT A REAL ID) Tj ET`;
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

async function placeholderPng(title: string, name: string): Promise<Buffer> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="856" height="540">
    <rect width="856" height="540" rx="28" fill="#eef4f1"/>
    <rect x="32" y="120" width="190" height="240" rx="12" fill="#c9d8d1"/>
    <text x="256" y="92" font-family="Arial" font-size="34" font-weight="bold" fill="#1d3b33">${esc(title)}</text>
    <text x="256" y="190" font-family="Arial" font-size="30" fill="#1d3b33">${esc(name)}</text>
    <text x="256" y="250" font-family="Arial" font-size="22" fill="#5b716a">N° DEMO-${Math.floor(rand() * 1e8)}</text>
    <text x="32" y="500" font-family="Arial" font-size="20" fill="#b3261e">EVENTOR DEMO DOCUMENT · NOT A REAL ID</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ── main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = validateEnv(process.env);
  if (env.NODE_ENV === NodeEnv.Production) {
    console.error('seed:demo refuses to run with NODE_ENV=production.');
    process.exit(1);
  }

  const dataSource = new DataSource({ ...buildDataSourceOptions(env), logging: ['error'] });
  await dataSource.initialize();
  const settingsStub = {
    getMany: async (keys: readonly SettingKey[]) => Object.fromEntries(keys.map((k) => [k, SETTINGS_DEFAULTS[k]])),
    get: async (key: SettingKey) => SETTINGS_DEFAULTS[key],
  };
  const noop = { add: async () => undefined, registerHandler: () => undefined, emit: async () => undefined };
  /** Image jobs queued by FilesService.store, run once the transaction has committed. */
  const imageJobs: string[] = [];
  const queueStub = { add: async (_name: string, data: { fileId: string }) => void imageJobs.push(data.fileId), registerHandler: () => undefined };
  const afterCommitCallbacks: (() => unknown)[] = [];
  const files = new FilesService(
    env,
    dataSource.getRepository(StoredFile),
    dataSource.getRepository(FileVariant),
    settingsStub as never,
    queueStub as never,
    noop as never,
  );
  let catalogue: ServiceSeedSummary | null = null;
  let bookings: BookingSeedSummary | null = null;
  const extra: Record<string, number> = {};
  const summary = { categories: 0, communes: 0, admins: 0, clients: 0, providers: 0, documents: 0, notes: 0, auditEntries: 0 };

  try {
    await dataSource.transaction(async (em) => {
      const users = em.getRepository(User);

      // Admins
      const sara = await users.findOne({ where: { email: env.SEED_ADMIN_EMAIL || 'admin@eventor.dz' } });
      let omar = await users.findOne({ where: { email: 'omar.belaid@eventor.dz' }, withDeleted: true });
      if (!omar) {
        omar = await users.save(
          users.create({
            role: UserRole.Admin,
            status: UserStatus.Active,
            verificationStatus: VerificationStatus.NotRequired,
            fullName: 'Omar Belaid',
            email: 'omar.belaid@eventor.dz',
            emailVerifiedAt: daysAgo(120),
            passwordHash: await argon2.hash(process.env.SEED_DEMO_ADMIN_PASSWORD || 'Eventor-demo-2026', { type: argon2.argon2id }),
            language: Language.Ar,
            lastActiveAt: daysAgo(0, 2),
            createdAt: daysAgo(120),
          }),
        );
        summary.admins += 1;
      }
      const reviewers = [sara, omar].filter((u): u is User => !!u);

      // Categories
      const categories = new Map<string, Category>();
      for (const [position, c] of CATEGORIES.entries()) {
        let category = await em.getRepository(Category).findOne({ where: { slug: c.slug }, withDeleted: true });
        if (!category) {
          category = await em.getRepository(Category).save(em.getRepository(Category).create({ ...c, position }));
          summary.categories += 1;
        }
        categories.set(c.slug, category);
      }

      // Communes
      for (const [wilayaCode, name, nameAr, postalCode] of COMMUNES) {
        if (!(await em.getRepository(Commune).exists({ where: { wilayaCode, name }, withDeleted: true }))) {
          await em.getRepository(Commune).save(em.getRepository(Commune).create({ wilayaCode, name, nameAr, postalCode }));
          summary.communes += 1;
        }
      }

      const audit = async (entry: Partial<AuditLog> & { action: string; objectType: string }) => {
        await em.getRepository(AuditLog).save(
          em.getRepository(AuditLog).create({
            actorId: null,
            actorRole: null,
            objectId: null,
            objectLabel: null,
            level: AuditLevel.Normal,
            changes: null,
            note: null,
            source: AuditSource.Dashboard,
            ip: '41.105.12.34',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0',
            requestId: null,
            ...entry,
          }),
        );
        summary.auditEntries += 1;
      };

      // Clients
      for (let i = 0; i < 40; i++) {
        const first = CLIENT_FIRST[i % CLIENT_FIRST.length]!;
        // (i, 7i) for the first 20 and (i, 3i + 1) after: 4k ≡ 1 (mod 20) has no solution, so every name is unique.
        const last = CLIENT_LAST[(i < 20 ? i * 7 : i * 3 + 1) % CLIENT_LAST.length]!;
        const fullName = `${first} ${last}`;
        const email = `${ascii(first)}.${ascii(last)}${i >= 20 ? i : ''}@gmail.com`;
        if (i >= 20) {
          // Earlier runs reused the first 20 names; rename those rows in place.
          const legacyLast = CLIENT_LAST[(i * 7) % CLIENT_LAST.length]!;
          const legacyEmail = `${ascii(first)}.${ascii(legacyLast)}${i}@gmail.com`;
          if (legacyEmail !== email && !(await users.exists({ where: { email }, withDeleted: true }))) {
            await users.update({ email: legacyEmail }, { fullName, email });
          }
        }
        if (await users.exists({ where: { email }, withDeleted: true })) continue;
        const joined = between(2, 240);
        const blocked = i === 11 || i === 27;
        const client = await users.save(
          users.create({
            role: UserRole.Client,
            status: blocked ? UserStatus.Blocked : UserStatus.Active,
            verificationStatus: VerificationStatus.NotRequired,
            fullName,
            email,
            emailVerifiedAt: i % 9 === 4 ? null : daysAgo(joined),
            phone: `+2135${String(50_100_000 + i * 137).padStart(8, '0')}`,
            language: i % 3 === 0 ? Language.En : Language.Ar,
            wilayaCode: pick(CLIENT_WILAYAS),
            lastActiveAt: i % 8 === 5 ? null : daysAgo(Math.min(joined, between(0, 100))),
            createdAt: daysAgo(joined),
            ...(blocked
              ? {
                  blockedAt: daysAgo(between(1, 20)),
                  blockedUntil: i === 11 ? new Date(NOW + 14 * DAY) : null,
                  blockedReason: i === 11 ? 'abusive_messages' : 'fake_account',
                  blockedMessage: i === 11 ? 'Your account is suspended for 14 days after abusive messages.' : null,
                  blockedById: omar.id,
                }
              : {}),
          }),
        );
        summary.clients += 1;
        if (blocked) {
          await audit({
            actorId: omar.id,
            actorRole: UserRole.Admin,
            action: 'user.blocked',
            objectType: 'user',
            objectId: client.id,
            objectLabel: client.fullName,
            level: AuditLevel.Sensitive,
            changes: { status: { from: 'active', to: 'blocked' }, reason: client.blockedReason, until: client.blockedUntil?.toISOString() ?? null },
            createdAt: client.blockedAt!,
          });
        }
      }

      // Providers
      for (const [index, p] of PROVIDERS.entries()) {
        const email = `${ascii(p.fullName)}@${index % 3 === 0 ? 'gmail.com' : index % 3 === 1 ? 'yahoo.fr' : 'outlook.com'}`;
        if (await users.exists({ where: { email }, withDeleted: true })) continue;
        const joined = between(20, 300);
        const provider = await users.save(
          users.create({
            role: UserRole.Provider,
            status: UserStatus.Active,
            verificationStatus: VerificationStatus.Pending,
            fullName: p.fullName,
            email,
            emailVerifiedAt: daysAgo(joined),
            phone: `+2136${String(61_200_000 + index * 911).padStart(8, '0')}`,
            language: p.language,
            wilayaCode: p.wilaya,
            lastActiveAt: daysAgo(between(0, 12), between(0, 20)),
            createdAt: daysAgo(joined),
          }),
        );
        const profile = await em.getRepository(ProviderProfile).save(
          em.getRepository(ProviderProfile).create({
            userId: provider.id,
            businessName: p.business,
            categoryId: categories.get(p.category)!.id,
            bioEn: p.bioEn,
            bioAr: p.bioAr,
            languagesSpoken: p.language === Language.En ? ['ar', 'fr', 'en'] : ['ar', 'fr'],
            yearsActive: between(1, 15),
            acceptingBookings: !p.blocked,
            // Cached counters stay empty until bookings, reviews and messages are seeded (modules 8, 10, 12).
            avgRating: '0.00',
            ratingCount: 0,
            completedBookingsCount: 0,
            replyRate: null,
            avgReplyMinutes: null,
            createdAt: daysAgo(joined),
          }),
        );
        await em.getRepository(ProviderWilaya).insert(p.areas.map((wilayaCode) => ({ providerProfileId: profile.id, wilayaCode, createdAt: daysAgo(joined) })));
        await audit({
          actorId: provider.id,
          actorRole: UserRole.Provider,
          action: 'user.registered',
          objectType: 'user',
          objectId: provider.id,
          objectLabel: provider.fullName,
          level: AuditLevel.Info,
          source: index % 2 === 0 ? AuditSource.Android : AuditSource.Ios,
          createdAt: daysAgo(joined),
        });

        // Documents
        const submittedDaysAgo = Math.max(0, Math.min(joined - 1, between(0, 9)));
        const reviewer = reviewers[index % reviewers.length] ?? null;
        const addDocument = async (
          type: DocumentType,
          status: DocumentStatus,
          options: { isCurrent?: boolean; daysAgo?: number; reject?: [DocumentRejectReason, string] } = {},
        ) => {
          const title = DOC_LABELS[type];
          const asPng = type === DocumentType.NationalId;
          const buffer = asPng ? await placeholderPng(title, p.fullName) : placeholderPdf(title, p.fullName);
          const stored = await files.store(
            { buffer, originalName: `${ascii(title)}-${ascii(p.fullName)}.${asPng ? 'png' : 'pdf'}`, purpose: FilePurpose.Document, ownerId: provider.id },
            { em },
          );
          const uploadedAt = daysAgo(options.daysAgo ?? submittedDaysAgo, between(1, 10));
          await em.getRepository(StoredFile).update(stored.id, { createdAt: uploadedAt });
          const reviewed = status !== DocumentStatus.Pending && reviewer;
          const doc = await em.getRepository(UserDocument).save(
            em.getRepository(UserDocument).create({
              userId: provider.id,
              type,
              fileId: stored.id,
              status,
              isCurrent: options.isCurrent ?? true,
              rejectReason: options.reject?.[0] ?? null,
              rejectNote: options.reject?.[1] ?? null,
              reviewedById: reviewed ? reviewer.id : null,
              reviewedAt: reviewed ? new Date(uploadedAt.getTime() + 20 * 3_600_000) : null,
              createdAt: uploadedAt,
            }),
          );
          summary.documents += 1;
          if (reviewed) {
            await audit({
              actorId: reviewer.id,
              actorRole: UserRole.Admin,
              action: status === DocumentStatus.Approved ? 'document.approved' : 'document.rejected',
              objectType: 'user_document',
              objectId: doc.id,
              objectLabel: `${p.fullName} · ${type}`,
              level: status === DocumentStatus.Approved ? AuditLevel.Normal : AuditLevel.Sensitive,
              changes: { userId: provider.id, status: { from: 'pending', to: status }, ...(options.reject ? { reasonCode: options.reject[0] } : {}) },
              note: options.reject?.[1] ?? null,
              createdAt: doc.reviewedAt!,
            });
          }
        };

        const [id, register, tax] = REQUIRED_DOCUMENT_TYPES as [DocumentType, DocumentType, DocumentType];
        const A = DocumentStatus.Approved;
        const P = DocumentStatus.Pending;
        const R = DocumentStatus.Rejected;
        switch (p.plan) {
          case 'verified':
            for (const type of [id, register, tax]) await addDocument(type, A, { daysAgo: Math.max(1, joined - 2) });
            break;
          case 'waiting':
            for (const type of [id, register, tax]) await addDocument(type, P);
            break;
          case 'waiting_partial':
            await addDocument(id, A, { daysAgo: submittedDaysAgo + 3 });
            await addDocument(register, P);
            await addDocument(tax, P);
            break;
          case 'resubmitted_id':
            await addDocument(id, R, { isCurrent: false, daysAgo: submittedDaysAgo + 6, reject: [DocumentRejectReason.Expired, "The national ID card expired in 2025. Please upload your new card."] });
            await addDocument(id, P);
            await addDocument(register, A, { daysAgo: submittedDaysAgo + 6 });
            await addDocument(tax, A, { daysAgo: submittedDaysAgo + 6 });
            break;
          case 'resubmitted_tax':
            await addDocument(id, A, { daysAgo: submittedDaysAgo + 5 });
            await addDocument(register, P, { daysAgo: submittedDaysAgo + 5 });
            await addDocument(tax, R, { isCurrent: false, daysAgo: submittedDaysAgo + 5, reject: [DocumentRejectReason.Unreadable, 'The scan is blurry; the NIF number cannot be read.'] });
            await addDocument(tax, P);
            break;
          case 'rejected_tax':
            await addDocument(id, A);
            await addDocument(register, A);
            await addDocument(tax, R, { reject: [DocumentRejectReason.Unreadable, 'The tax card photo is too dark to read. Please upload a clear scan.'] });
            break;
          case 'rejected_name':
            await addDocument(id, R, { reject: [DocumentRejectReason.NameMismatch, 'The name on the ID card does not match the account name.'] });
            await addDocument(register, P);
            await addDocument(tax, P);
            break;
          case 'incomplete_id_only':
            await addDocument(id, A);
            break;
          case 'none':
            break;
        }

        const current = await em.getRepository(UserDocument).find({ where: { userId: provider.id, isCurrent: true } });
        const verificationStatus = deriveVerificationStatus(current);
        await users.update(provider.id, {
          verificationStatus,
          ...(p.blocked
            ? {
                status: UserStatus.Blocked,
                blockedAt: daysAgo(p.blocked.days),
                blockedUntil: null,
                blockedReason: p.blocked.reason,
                blockedMessage: p.blocked.message,
                blockedById: omar.id,
              }
            : {}),
        });
        if (p.blocked) {
          await audit({
            actorId: omar.id,
            actorRole: UserRole.Admin,
            action: 'user.blocked',
            objectType: 'user',
            objectId: provider.id,
            objectLabel: provider.fullName,
            level: AuditLevel.Sensitive,
            changes: { status: { from: 'active', to: 'blocked' }, reason: p.blocked.reason, pendingBookings: 'cancel' },
            note: p.blocked.message,
            createdAt: daysAgo(p.blocked.days),
          });
        }
        summary.providers += 1;

        // Notes
        const notes: [string, User | null, number][] =
          p.fullName === 'Yacine Meddour'
            ? [
                ['Three clients reported that DJ Amine did not show up (EVT-000412, EVT-000437, EVT-000455).', omar, 5],
                ['Called Yacine: no answer. Blocking until he explains the missed events.', omar, 3],
              ]
            : p.fullName === 'Fatima Hadj'
              ? [['New ID card promised by phone; she will re-upload this week.', sara, 4]]
              : p.fullName === 'Karim Belkacem'
                ? [['Top photographer in Algiers; candidate for the featured list.', sara, 20]]
                : p.fullName === 'Walid Saadi'
                  ? [['Documents look complete; check the register number against the CNRC site.', omar, 1]]
                  : [];
        for (const [body, author, ago] of notes) {
          if (!author) continue;
          await em.getRepository(UserNote).save(em.getRepository(UserNote).create({ userId: provider.id, authorId: author.id, body, createdAt: daysAgo(ago) }));
          summary.notes += 1;
        }
      }

      await seedAdminLogins(em, reviewers, audit);

      catalogue = await seedServicesAndPacks({
        em,
        files,
        hiddenBy: omar,
        rand,
        daysAgo,
        afterCommit: (callback) => void afterCommitCallbacks.push(callback),
      });

      bookings = await seedBookings({ em, admin: omar });
      Object.assign(extra, await seedDisputes({ em, files, admin: omar }));
      Object.assign(extra, await seedAcademic({ em, files, admin: omar }));
      Object.assign(extra, await seedReviews({ em, admin: omar, rand }));
      Object.assign(extra, await seedAdminNotifications(em));
      // Mobile-only rows (favourites, budget, devices): nothing else creates them.
      Object.assign(extra, await seedAppData(em));
      await recomputeCachedCounters(em);
    });
    for (const callback of afterCommitCallbacks) await callback();
    for (const fileId of imageJobs) await files.processImageJob(fileId);
    // Module 13: stats_daily for the last 120 days (same as `pnpm stats:backfill --days 120`).
    const today = algiersDay(new Date());
    extra.statsDailyRows = await rollupStats(dataSource, addDays(today, -120), addDays(today, -1));
  } finally {
    await dataSource.destroy();
  }

  console.log('seed:demo done (created now):', { ...summary, ...(catalogue as ServiceSeedSummary | null), ...(bookings as BookingSeedSummary | null), ...extra, photosProcessed: imageJobs.length });
}

/** A few sign-in entries so the activity log is not empty on a fresh database. */
async function seedAdminLogins(
  em: EntityManager,
  admins: User[],
  audit: (entry: Partial<AuditLog> & { action: string; objectType: string }) => Promise<void>,
): Promise<void> {
  const exists = await em.getRepository(AuditLog).exists({ where: { action: 'auth.login', note: 'demo' } });
  if (exists) return;
  for (const [i, admin] of admins.entries()) {
    await audit({
      actorId: admin.id,
      actorRole: UserRole.Admin,
      action: 'auth.login',
      objectType: 'session',
      objectLabel: admin.email,
      level: AuditLevel.Security,
      note: 'demo',
      createdAt: daysAgo(i + 1),
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
