/**
 * Demo services, Ready Packs, photos and availability blocks (modules 6–7),
 * called by `demo-seed.ts` inside its transaction. Idempotent: services are
 * matched by (provider, title EN) and packs by (provider, name EN); existing
 * rows are left untouched. Photos are coloured placeholders rendered with sharp
 * and stored through FilesService; the caller runs the image pipeline on the
 * returned file ids once the transaction has committed.
 */
import sharp from 'sharp';
import type { EntityManager } from 'typeorm';
import { AuditLog } from '../../admin/entities/audit-log.entity.js';
import { Category } from '../../catalog/entities/category.entity.js';
import { AuditLevel } from '../../common/enums/admin.enums.js';
import { AvailabilityKind, EventType, PackStatus, PriceType, ServiceStatus } from '../../common/enums/catalog.enums.js';
import { FilePurpose } from '../../common/enums/file.enums.js';
import { UserRole, UserStatus, VerificationStatus } from '../../common/enums/user.enums.js';
import type { FilesService } from '../../files/files.service.js';
import { PackItem } from '../../packs/entities/pack-item.entity.js';
import { Pack } from '../../packs/entities/pack.entity.js';
import { packAttentionReasons } from '../../packs/packs.policy.js';
import { AvailabilityBlock } from '../../services/entities/availability-block.entity.js';
import { ServiceExtra } from '../../services/entities/service-extra.entity.js';
import { Service, type ServiceFact } from '../../services/entities/service.entity.js';
import type { User } from '../../users/entities/user.entity.js';

export interface ServiceSeedContext {
  em: EntityManager;
  files: FilesService;
  hiddenBy: User | null;
  rand: () => number;
  daysAgo: (days: number, hours?: number) => Date;
  /** Collects work to run after COMMIT (image processing). */
  afterCommit: (callback: () => unknown) => void;
}

export interface ServiceSeedSummary {
  services: number;
  photos: number;
  packs: number;
  availabilityBlocks: number;
}

type Slug = 'salles-des-fetes' | 'photographie' | 'traiteur' | 'musique-dj' | 'decoration' | 'fleurs' | 'gateaux-patisserie' | 'beaute' | 'transport';

interface ServiceSeed {
  business: string;
  category: Slug;
  titleEn: string;
  titleAr: string;
  price: number;
  priceType?: PriceType;
  status?: ServiceStatus;
  featured?: boolean;
  hidden?: { reason: string; message: string; allowResubmit: boolean };
  /** Draft without Arabic content (publish checklist demo). */
  noArabic?: boolean;
  maxGuests?: number;
  maxEventsPerDay?: number;
}

const P = ServiceStatus.Published;
const D = ServiceStatus.Draft;
const H = ServiceStatus.Hidden;

const SERVICES: ServiceSeed[] = [
  // Studio Lumière (photography, Algiers)
  { business: 'Studio Lumière', category: 'photographie', titleEn: 'Wedding photo & video coverage', titleAr: 'تغطية زفاف بالصورة والفيديو', price: 120000, featured: true },
  { business: 'Studio Lumière', category: 'photographie', titleEn: 'Engagement photo session', titleAr: 'جلسة تصوير الخطوبة', price: 35000, featured: true },
  { business: 'Studio Lumière', category: 'photographie', titleEn: 'Cinematic wedding film', titleAr: 'فيلم زفاف سينمائي', price: 90000 },
  { business: 'Studio Lumière', category: 'photographie', titleEn: 'Premium wedding album · 40 pages', titleAr: 'ألبوم زفاف فاخر · 40 صفحة', price: 28000, priceType: PriceType.PerEvent },
  { business: 'Studio Lumière', category: 'photographie', titleEn: 'Drone aerial shots', titleAr: 'لقطات جوية بالدرون', price: 18000, status: D, noArabic: true },
  // Salle Yasmine (venue, Blida)
  { business: 'Salle Yasmine', category: 'salles-des-fetes', titleEn: 'Grande salle · 150 seats', titleAr: 'القاعة الكبرى · 150 مقعدًا', price: 250000, featured: true, maxGuests: 150 },
  { business: 'Salle Yasmine', category: 'salles-des-fetes', titleEn: 'Salle des fêtes · 400 guests', titleAr: 'قاعة الحفلات · 400 ضيف', price: 420000, maxGuests: 400 },
  { business: 'Salle Yasmine', category: 'traiteur', titleEn: 'Menu mariage traditionnel', titleAr: 'قائمة زفاف تقليدية', price: 2800, priceType: PriceType.PerPerson },
  { business: 'Salle Yasmine', category: 'decoration', titleEn: 'Décor floral cérémonie', titleAr: 'ديكور زهور الحفل', price: 65000 },
  { business: 'Salle Yasmine', category: 'decoration', titleEn: 'Bride stage (kosha) setup', titleAr: 'تجهيز منصة العروس', price: 45000, status: D },
  // DJ Amine (music, blocked provider)
  { business: 'DJ Amine', category: 'musique-dj', titleEn: 'DJ set · 5 hours', titleAr: 'حفلة دي جي · 5 ساعات', price: 45000 },
  { business: 'DJ Amine', category: 'musique-dj', titleEn: 'Sound & light system', titleAr: 'نظام الصوت والإضاءة', price: 30000 },
  { business: 'DJ Amine', category: 'musique-dj', titleEn: 'Karaoke night', titleAr: 'سهرة كاريوكي', price: 25000, status: H, hidden: { reason: 'reported_by_clients', message: 'Several clients reported the service was not delivered.', allowResubmit: false } },
  // Douceurs d'Oran (cakes, Oran)
  { business: "Douceurs d'Oran", category: 'gateaux-patisserie', titleEn: 'Pâtisserie & wedding cake', titleAr: 'حلويات وكعكة الزفاف', price: 55000, featured: true },
  { business: "Douceurs d'Oran", category: 'gateaux-patisserie', titleEn: 'Traditional Oranian sweets tray', titleAr: 'صينية حلويات وهرانية تقليدية', price: 12000 },
  { business: "Douceurs d'Oran", category: 'gateaux-patisserie', titleEn: 'Birthday cake · 3 tiers', titleAr: 'كعكة عيد ميلاد · 3 طبقات', price: 15000 },
  { business: "Douceurs d'Oran", category: 'gateaux-patisserie', titleEn: 'Macaron tower', titleAr: 'برج الماكرون', price: 9000, status: D, noArabic: true },
  // Traiteur El Djazair (catering, Algiers)
  { business: 'Traiteur El Djazair', category: 'traiteur', titleEn: 'Algerian wedding buffet', titleAr: 'بوفيه زفاف جزائري', price: 3200, priceType: PriceType.PerPerson, featured: true },
  { business: 'Traiteur El Djazair', category: 'traiteur', titleEn: 'Henna night dinner', titleAr: 'عشاء ليلة الحناء', price: 2200, priceType: PriceType.PerPerson },
  { business: 'Traiteur El Djazair', category: 'traiteur', titleEn: 'Waiters & service team', titleAr: 'فريق النُدُل والخدمة', price: 6000, priceType: PriceType.PerHour },
  { business: 'Traiteur El Djazair', category: 'traiteur', titleEn: 'Corporate lunch boxes', titleAr: 'وجبات غداء للشركات', price: 1200, priceType: PriceType.PerPerson },
  { business: 'Traiteur El Djazair', category: 'traiteur', titleEn: 'Couscous royal for events', titleAr: 'كسكس ملكي للمناسبات', price: 1800, priceType: PriceType.PerPerson, status: H, hidden: { reason: 'misleading_content', message: 'The photos show dishes from another caterer. Please upload your own photos.', allowResubmit: true } },
  // Salle El Bahia (venue, Oran)
  { business: 'Salle El Bahia', category: 'salles-des-fetes', titleEn: 'Sea-view wedding hall · 300 guests', titleAr: 'قاعة أعراس مطلة على البحر · 300 ضيف', price: 380000, maxGuests: 300, featured: true },
  { business: 'Salle El Bahia', category: 'salles-des-fetes', titleEn: 'Terrace for engagements', titleAr: 'تراس لحفلات الخطوبة', price: 150000, maxGuests: 120 },
  { business: 'Salle El Bahia', category: 'traiteur', titleEn: 'Seafood dinner menu', titleAr: 'قائمة عشاء بالمأكولات البحرية', price: 3500, priceType: PriceType.PerPerson },
  { business: 'Salle El Bahia', category: 'decoration', titleEn: 'White & gold hall decoration', titleAr: 'تزيين القاعة بالأبيض والذهبي', price: 70000 },
  // Orchestre Andalou (music, Constantine)
  { business: 'Orchestre Andalou', category: 'musique-dj', titleEn: 'Malouf orchestra · full evening', titleAr: 'جوق المالوف · سهرة كاملة', price: 150000, featured: true },
  { business: 'Orchestre Andalou', category: 'musique-dj', titleEn: 'Zorna & bendir procession', titleAr: 'موكب الزرنة والبندير', price: 40000 },
  { business: 'Orchestre Andalou', category: 'musique-dj', titleEn: 'Solo oud for dinners', titleAr: 'عزف منفرد على العود للعشاء', price: 20000, priceType: PriceType.PerHour },
  // Flora Design (flowers, Algiers)
  { business: 'Flora Design', category: 'fleurs', titleEn: 'Bridal bouquet', titleAr: 'باقة العروس', price: 12000 },
  { business: 'Flora Design', category: 'fleurs', titleEn: 'Ceremony flower arch', titleAr: 'قوس الزهور للحفل', price: 48000 },
  { business: 'Flora Design', category: 'fleurs', titleEn: 'Table centrepieces · 20 tables', titleAr: 'تنسيقات الطاولات · 20 طاولة', price: 60000 },
  { business: 'Flora Design', category: 'fleurs', titleEn: 'Wedding car flowers', titleAr: 'زهور سيارة الزفاف', price: 9000 },
  // Salle Les Oliviers (venue, Tipaza)
  { business: 'Salle Les Oliviers', category: 'salles-des-fetes', titleEn: 'Garden venue among olive trees', titleAr: 'حديقة بين أشجار الزيتون', price: 300000, maxGuests: 250 },
  { business: 'Salle Les Oliviers', category: 'traiteur', titleEn: 'Garden barbecue menu', titleAr: 'قائمة شواء في الحديقة', price: 2600, priceType: PriceType.PerPerson },
  { business: 'Salle Les Oliviers', category: 'decoration', titleEn: 'Fairy lights & lanterns', titleAr: 'أضواء وفوانيس', price: 35000 },
  { business: 'Salle Les Oliviers', category: 'salles-des-fetes', titleEn: 'Outdoor ceremony lawn', titleAr: 'عشب الحفل في الهواء الطلق', price: 120000, status: D },
  // Studio Yasmine Photo (photography, Blida)
  { business: 'Studio Yasmine Photo', category: 'photographie', titleEn: 'Henna night photography (women team)', titleAr: 'تصوير ليلة الحناء (فريق نسائي)', price: 40000 },
  { business: 'Studio Yasmine Photo', category: 'photographie', titleEn: 'Bride getting-ready session', titleAr: 'جلسة تحضير العروس', price: 25000 },
  { business: 'Studio Yasmine Photo', category: 'photographie', titleEn: 'Photo booth with instant prints', titleAr: 'كشك تصوير مع طباعة فورية', price: 30000 },
  // Pâtisserie Meriem (cakes, Algiers)
  { business: 'Pâtisserie Meriem', category: 'gateaux-patisserie', titleEn: 'Baklava & makrout trays', titleAr: 'صواني البقلاوة والمقروط', price: 14000 },
  { business: 'Pâtisserie Meriem', category: 'gateaux-patisserie', titleEn: 'Tiered wedding cake', titleAr: 'كعكة زفاف بطبقات', price: 45000, featured: true },
  { business: 'Pâtisserie Meriem', category: 'gateaux-patisserie', titleEn: 'Dessert table for 100 guests', titleAr: 'طاولة حلويات لـ 100 ضيف', price: 60000 },
  { business: 'Pâtisserie Meriem', category: 'gateaux-patisserie', titleEn: 'Graduation cupcakes', titleAr: 'كب كيك التخرج', price: 6000 },
  // Limousine Prestige (transport: hidden category)
  { business: 'Limousine Prestige', category: 'transport', titleEn: 'Wedding car with driver', titleAr: 'سيارة زفاف مع سائق', price: 35000 },
  { business: 'Limousine Prestige', category: 'transport', titleEn: 'Guest shuttle · 30 seats', titleAr: 'حافلة نقل الضيوف · 30 مقعدًا', price: 25000, priceType: PriceType.PerDay },
  // Rym Events Déco (decoration, Oran)
  { business: 'Rym Events Déco', category: 'decoration', titleEn: 'Balloon decoration for birthdays', titleAr: 'تزيين أعياد الميلاد بالبالونات', price: 15000 },
  { business: 'Rym Events Déco', category: 'decoration', titleEn: 'Engagement table styling', titleAr: 'تنسيق طاولة الخطوبة', price: 28000 },
  { business: 'Rym Events Déco', category: 'decoration', titleEn: 'Corporate event stage', titleAr: 'منصة فعاليات الشركات', price: 90000, priceType: PriceType.OnQuote },
  // Providers still waiting for verification (waiting_approval tab)
  { business: 'Fleurs de Yasmina', category: 'fleurs', titleEn: 'Hall flower decoration', titleAr: 'تزيين القاعة بالزهور', price: 40000 },
  { business: 'Fleurs de Yasmina', category: 'fleurs', titleEn: 'Henna tray flowers', titleAr: 'زهور صينية الحناء', price: 8000 },
  { business: 'Studio Pixel', category: 'photographie', titleEn: 'Wedding photography · Constantine', titleAr: 'تصوير الأعراس · قسنطينة', price: 70000 },
  { business: 'Studio Pixel', category: 'photographie', titleEn: 'Same-day video edit', titleAr: 'مونتاج الفيديو في نفس اليوم', price: 30000, status: D, noArabic: true },
  { business: 'Déco Prestige', category: 'decoration', titleEn: 'Stage and table decoration', titleAr: 'تزيين المنصة والطاولات', price: 55000 },
  { business: 'Traiteur Constantinois', category: 'traiteur', titleEn: 'Chakhchoukha & jwaz menu', titleAr: 'قائمة الشخشوخة والجواز', price: 2400, priceType: PriceType.PerPerson },
  { business: 'DJ Nass', category: 'musique-dj', titleEn: 'Raï DJ set · 4 hours', titleAr: 'حفلة دي جي راي · 4 ساعات', price: 38000 },
  { business: 'Pixel Wedding', category: 'photographie', titleEn: 'Drone wedding film', titleAr: 'فيلم زفاف بالدرون', price: 85000 },
  { business: 'Salle Royal', category: 'salles-des-fetes', titleEn: 'Royal hall · 600 guests', titleAr: 'قاعة رويال · 600 ضيف', price: 500000, maxGuests: 600 },
  { business: 'Traiteur Ferhat', category: 'traiteur', titleEn: 'Circumcision party menu', titleAr: 'قائمة حفل الختان', price: 1900, priceType: PriceType.PerPerson },
  { business: 'Gâteaux Sara', category: 'gateaux-patisserie', titleEn: 'Home-made layer cake', titleAr: 'كعكة منزلية بطبقات', price: 7000, status: D },
];

const CATEGORY_TEXT: Record<Slug, { en: string; ar: string; color: string; facts: ServiceFact[]; extras: [string, string, number][] }> = {
  'salles-des-fetes': {
    en: 'Air-conditioned hall with parking, bridal suite and sound system. Tables, chairs and linens included; security staff on site until the end of the evening.',
    ar: 'قاعة مكيفة مع موقف سيارات وجناح للعروس ونظام صوت. الطاولات والكراسي والمفارش مشمولة، مع أعوان أمن حتى نهاية السهرة.',
    color: '#7a4e9c',
    facts: [
      { label_en: 'Hours', label_ar: 'الساعات', value_en: '14:00 – 01:00', value_ar: '14:00 – 01:00' },
      { label_en: 'Parking', label_ar: 'موقف السيارات', value_en: '80 cars', value_ar: '80 سيارة' },
    ],
    extras: [
      ['Extra hour', 'ساعة إضافية', 20000],
      ['Bridal suite decoration', 'تزيين جناح العروس', 15000],
    ],
  },
  photographie: {
    en: 'Two photographers cover the day from the preparations to the last dance. Edited photos delivered in 3 weeks through a private online gallery.',
    ar: 'مصوران يغطيان اليوم من التحضيرات إلى آخر رقصة. تسليم الصور المعدلة خلال 3 أسابيع عبر معرض خاص على الإنترنت.',
    color: '#2f6f8f',
    facts: [
      { label_en: 'Team', label_ar: 'الفريق', value_en: '2 photographers', value_ar: 'مصوران' },
      { label_en: 'Delivery', label_ar: 'التسليم', value_en: '3 weeks', value_ar: '3 أسابيع' },
    ],
    extras: [
      ['Drone footage', 'تصوير بالدرون', 15000],
      ['Printed album', 'ألبوم مطبوع', 12000],
    ],
  },
  traiteur: {
    en: 'Fresh traditional dishes cooked the same day, served hot by our waiters. Menu tasting available two weeks before the event.',
    ar: 'أطباق تقليدية طازجة تُطهى في اليوم نفسه وتُقدَّم ساخنة من طرف نُدُلنا. تذوق القائمة متاح قبل المناسبة بأسبوعين.',
    color: '#a0522d',
    facts: [
      { label_en: 'Minimum', label_ar: 'الحد الأدنى', value_en: '50 guests', value_ar: '50 ضيفًا' },
      { label_en: 'Tasting', label_ar: 'التذوق', value_en: 'Included', value_ar: 'مشمول' },
    ],
    extras: [
      ['Dessert buffet', 'بوفيه التحلية', 400],
      ['Juice bar', 'ركن العصائر', 250],
    ],
  },
  'musique-dj': {
    en: 'Professional sound and lights, playlist prepared with you: chaabi, raï, andalou and international hits. Set-up one hour before guests arrive.',
    ar: 'صوت وإضاءة احترافيان وقائمة أغاني تُعدّ معك: شعبي، راي، أندلسي وأغاني عالمية. التركيب قبل وصول الضيوف بساعة.',
    color: '#243b6b',
    facts: [
      { label_en: 'Duration', label_ar: 'المدة', value_en: '5 hours', value_ar: '5 ساعات' },
      { label_en: 'Equipment', label_ar: 'المعدات', value_en: 'Sound + lights', value_ar: 'صوت + إضاءة' },
    ],
    extras: [
      ['Extra hour', 'ساعة إضافية', 8000],
      ['Smoke machine', 'آلة الدخان', 5000],
    ],
  },
  decoration: {
    en: 'Complete styling of the hall: stage, tables, lights and entrance. Installation and removal by our team.',
    ar: 'تنسيق كامل للقاعة: المنصة والطاولات والإضاءة والمدخل. التركيب والإزالة من طرف فريقنا.',
    color: '#b5475f',
    facts: [{ label_en: 'Set-up', label_ar: 'التركيب', value_en: '4 hours before', value_ar: 'قبل 4 ساعات' }],
    extras: [['Entrance arch', 'قوس المدخل', 12000]],
  },
  fleurs: {
    en: 'Fresh seasonal flowers arranged the morning of the event and delivered to the venue.',
    ar: 'زهور موسمية طازجة تُنسَّق صباح المناسبة وتُسلَّم إلى القاعة.',
    color: '#4f8a4b',
    facts: [{ label_en: 'Flowers', label_ar: 'الزهور', value_en: 'Roses, peonies, gypsophila', value_ar: 'ورد، فاوانيا، جبسوفيلا' }],
    extras: [['Matching boutonnière', 'زهرة عروة مطابقة', 2000]],
  },
  'gateaux-patisserie': {
    en: 'Hand-made cakes and traditional sweets with natural ingredients. Delivery to the venue and set-up included.',
    ar: 'كعكات وحلويات تقليدية مصنوعة يدويًا بمكونات طبيعية. التوصيل إلى القاعة والتركيب مشمولان.',
    color: '#c27c2c',
    facts: [
      { label_en: 'Order', label_ar: 'الطلب', value_en: '10 days ahead', value_ar: 'قبل 10 أيام' },
      { label_en: 'Delivery', label_ar: 'التوصيل', value_en: 'Included', value_ar: 'مشمول' },
    ],
    extras: [['Personalised topper', 'زينة مخصصة للكعكة', 3000]],
  },
  beaute: { en: 'Make-up and hair at home.', ar: 'مكياج وتسريحة في المنزل.', color: '#9c4f7a', facts: [], extras: [] },
  transport: {
    en: 'Decorated cars with a professional driver, fuel included within the wilaya.',
    ar: 'سيارات مزينة مع سائق محترف، الوقود مشمول داخل الولاية.',
    color: '#555f6b',
    facts: [{ label_en: 'Driver', label_ar: 'السائق', value_en: 'Included', value_ar: 'مشمول' }],
    extras: [['Extra hour', 'ساعة إضافية', 5000]],
  },
};

const POLICY_EN = 'Free cancellation up to 30 days before the event. After that, the deposit paid in cash is not returned. Date changes are possible once, subject to availability.';
const POLICY_AR = 'إلغاء مجاني حتى 30 يومًا قبل المناسبة. بعد ذلك لا يُسترجع العربون المدفوع نقدًا. يمكن تغيير التاريخ مرة واحدة حسب التوفر.';

interface PackSeed {
  business: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  eventType: EventType;
  wilaya: number;
  /** Titles EN of the provider's services, in order. */
  items: string[];
  discount: number;
  status: PackStatus;
  maxGuests?: number;
}

const PACKS: PackSeed[] = [
  { business: 'Salle Yasmine', nameEn: 'Essentiel Mariage', nameAr: 'باقة الزفاف الأساسية', descriptionEn: 'The hall, the traditional menu for 150 guests and the floral décor in one booking.', descriptionAr: 'القاعة والقائمة التقليدية لـ 150 ضيفًا وديكور الزهور في حجز واحد.', eventType: EventType.Wedding, wilaya: 9, items: ['Grande salle · 150 seats', 'Menu mariage traditionnel', 'Décor floral cérémonie'], discount: 0.1, status: PackStatus.Published, maxGuests: 150 },
  { business: 'Salle Yasmine', nameEn: 'Grand Mariage 400', nameAr: 'باقة الزفاف الكبرى 400', descriptionEn: 'The large hall with menu and décor for big families.', descriptionAr: 'القاعة الكبيرة مع القائمة والديكور للعائلات الكبيرة.', eventType: EventType.Wedding, wilaya: 9, items: ['Salle des fêtes · 400 guests', 'Menu mariage traditionnel', 'Décor floral cérémonie'], discount: 0.08, status: PackStatus.Draft, maxGuests: 400 },
  { business: 'Salle El Bahia', nameEn: 'Mariage Vue sur Mer', nameAr: 'زفاف بإطلالة على البحر', descriptionEn: 'Sea-view hall, seafood dinner and white & gold decoration.', descriptionAr: 'قاعة مطلة على البحر وعشاء بالمأكولات البحرية وديكور أبيض وذهبي.', eventType: EventType.Wedding, wilaya: 31, items: ['Sea-view wedding hall · 300 guests', 'Seafood dinner menu', 'White & gold hall decoration'], discount: 0.12, status: PackStatus.Published, maxGuests: 300 },
  { business: 'Salle El Bahia', nameEn: 'Fiançailles Terrasse', nameAr: 'خطوبة على التراس', descriptionEn: 'The terrace and a decorated setting for your engagement.', descriptionAr: 'التراس وديكور مميز لخطوبتك.', eventType: EventType.Engagement, wilaya: 31, items: ['Terrace for engagements', 'White & gold hall decoration'], discount: 0.1, status: PackStatus.Unpublished, maxGuests: 120 },
  { business: 'Salle Les Oliviers', nameEn: 'Fiançailles au Jardin', nameAr: 'خطوبة في الحديقة', descriptionEn: 'Garden venue, barbecue menu and fairy lights.', descriptionAr: 'حديقة وقائمة شواء وأضواء زينة.', eventType: EventType.Engagement, wilaya: 42, items: ['Garden venue among olive trees', 'Garden barbecue menu', 'Fairy lights & lanterns'], discount: 0.1, status: PackStatus.Published, maxGuests: 250 },
  { business: 'Studio Lumière', nameEn: 'Photo + Vidéo Mariage', nameAr: 'باقة صور وفيديو الزفاف', descriptionEn: 'Full-day coverage, cinematic film and a premium album.', descriptionAr: 'تغطية يوم كامل وفيلم سينمائي وألبوم فاخر.', eventType: EventType.Wedding, wilaya: 16, items: ['Wedding photo & video coverage', 'Cinematic wedding film', 'Premium wedding album · 40 pages'], discount: 0.15, status: PackStatus.Published },
  { business: 'Studio Lumière', nameEn: 'Pack Fiançailles Photo', nameAr: 'باقة تصوير الخطوبة', descriptionEn: 'Engagement session and album.', descriptionAr: 'جلسة تصوير الخطوبة مع ألبوم.', eventType: EventType.Engagement, wilaya: 16, items: ['Engagement photo session', 'Premium wedding album · 40 pages'], discount: 0.1, status: PackStatus.Published },
  { business: 'Traiteur El Djazair', nameEn: 'Soirée Henné', nameAr: 'سهرة الحناء', descriptionEn: 'Henna night dinner with the service team.', descriptionAr: 'عشاء ليلة الحناء مع فريق الخدمة.', eventType: EventType.Henna, wilaya: 16, items: ['Henna night dinner', 'Waiters & service team'], discount: 0.05, status: PackStatus.Published },
  { business: 'Pâtisserie Meriem', nameEn: 'Table des Douceurs', nameAr: 'طاولة الحلويات', descriptionEn: 'Tiered wedding cake, dessert table and traditional trays.', descriptionAr: 'كعكة زفاف بطبقات وطاولة حلويات وصواني تقليدية.', eventType: EventType.Wedding, wilaya: 16, items: ['Tiered wedding cake', 'Dessert table for 100 guests', 'Baklava & makrout trays'], discount: 0.1, status: PackStatus.Published },
  { business: 'Orchestre Andalou', nameEn: 'Soirée Malouf', nameAr: 'سهرة المالوف', descriptionEn: 'Zorna procession then the malouf orchestra all evening.', descriptionAr: 'موكب الزرنة ثم جوق المالوف طوال السهرة.', eventType: EventType.Wedding, wilaya: 25, items: ['Zorna & bendir procession', 'Malouf orchestra · full evening'], discount: 0.1, status: PackStatus.Published },
  { business: 'DJ Amine', nameEn: 'Soirée DJ Complète', nameAr: 'سهرة دي جي كاملة', descriptionEn: 'DJ set with sound and lights (the provider is blocked: needs attention).', descriptionAr: 'حفلة دي جي مع الصوت والإضاءة.', eventType: EventType.Birthday, wilaya: 16, items: ['DJ set · 5 hours', 'Sound & light system'], discount: 0.1, status: PackStatus.Published },
  { business: 'Traiteur El Djazair', nameEn: 'Mariage Traditionnel Complet', nameAr: 'زفاف تقليدي كامل', descriptionEn: 'Buffet, couscous royal and service team (the couscous is hidden: needs attention).', descriptionAr: 'بوفيه وكسكس ملكي وفريق خدمة.', eventType: EventType.Wedding, wilaya: 16, items: ['Algerian wedding buffet', 'Couscous royal for events', 'Waiters & service team'], discount: 0.1, status: PackStatus.Published },
];

async function placeholderPhoto(title: string, subtitle: string, color: string, index: number): Promise<Buffer> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  const shades = ['#ffffff22', '#00000022', '#ffffff14', '#0000001a', '#ffffff30'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#1b1b1f"/></linearGradient></defs>
    <rect width="1200" height="800" fill="url(#g)"/>
    <circle cx="${900 - index * 90}" cy="${220 + index * 60}" r="${260 - index * 20}" fill="${shades[index % shades.length]}"/>
    <text x="70" y="600" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="bold" fill="#ffffff">${esc(title)}</text>
    <text x="70" y="670" font-family="Arial, Helvetica, sans-serif" font-size="34" fill="#ffffffcc">${esc(subtitle)}</text>
    <text x="70" y="740" font-family="Arial, Helvetica, sans-serif" font-size="24" fill="#ffffff99">Eventor demo photo ${index + 1}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10);

export async function seedServicesAndPacks(ctx: ServiceSeedContext): Promise<ServiceSeedSummary> {
  const { em, files, rand } = ctx;
  const between = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));
  const summary: ServiceSeedSummary = { services: 0, photos: 0, packs: 0, availabilityBlocks: 0 };

  const providerRows: { id: string; business_name: string; status: UserStatus; verification_status: VerificationStatus; avg_rating: string; profile_id: string; created_at: Date }[] = await em.query(
    `SELECT u.id, pp.business_name, u.status, u.verification_status, pp.avg_rating, pp.id AS profile_id, u.created_at
     FROM users u JOIN provider_profiles pp ON pp.user_id = u.id WHERE u.role = ? AND u.deleted_at IS NULL`,
    [UserRole.Provider],
  );
  const providers = new Map(providerRows.map((p) => [p.business_name, p]));
  const areas = new Map<string, number[]>();
  for (const row of (await em.query('SELECT provider_profile_id, wilaya_code FROM provider_wilayas ORDER BY wilaya_code')) as { provider_profile_id: string; wilaya_code: number }[]) {
    areas.set(row.provider_profile_id, [...(areas.get(row.provider_profile_id) ?? []), Number(row.wilaya_code)]);
  }
  const categories = new Map((await em.getRepository(Category).find()).map((c) => [c.slug, c]));
  const [{ featured }] = await em.query('SELECT COALESCE(MAX(featured_position), 0) AS featured FROM services WHERE is_featured = 1 AND deleted_at IS NULL');
  let featuredPosition = Number(featured);

  const servicesByProvider = new Map<string, Map<string, Service>>();
  const audit = (entry: Partial<AuditLog>) =>
    em.getRepository(AuditLog).save(em.getRepository(AuditLog).create({ actorRole: UserRole.Admin, level: AuditLevel.Normal, source: 'dashboard' as never, ip: '41.105.12.34', ...entry }));

  for (const [index, seed] of SERVICES.entries()) {
    const provider = providers.get(seed.business);
    const category = categories.get(seed.category);
    if (!provider || !category) continue;
    const repository = em.getRepository(Service);
    let service = await repository.findOne({ where: { providerId: provider.id, titleEn: seed.titleEn }, withDeleted: true });
    if (!service) {
      const text = CATEGORY_TEXT[seed.category];
      const status = seed.status ?? P;
      const createdAt = new Date(Math.max(new Date(provider.created_at).getTime() + 86_400_000, ctx.daysAgo(between(5, 180)).getTime()));
      const featuredNow = !!seed.featured && status === P && featuredPosition < 12;
      service = await repository.save(
        repository.create({
          providerId: provider.id,
          categoryId: category.id,
          titleEn: seed.titleEn,
          titleAr: seed.noArabic ? '' : seed.titleAr,
          descriptionEn: `${seed.titleEn}. ${text.en}`,
          descriptionAr: seed.noArabic ? '' : `${seed.titleAr}. ${text.ar}`,
          cancellationPolicyEn: index % 4 === 3 ? null : POLICY_EN,
          cancellationPolicyAr: index % 4 === 3 || seed.noArabic ? null : POLICY_AR,
          facts: text.facts.length ? text.facts : null,
          basePrice: seed.price.toFixed(2),
          priceType: seed.priceType ?? PriceType.PerEvent,
          maxEventsPerDay: seed.maxEventsPerDay ?? (seed.category === 'salles-des-fetes' ? 1 : between(1, 2)),
          maxGuests: seed.maxGuests ?? null,
          status,
          hiddenReason: seed.hidden?.reason ?? null,
          hiddenNote: seed.hidden?.message ?? null,
          hiddenById: seed.hidden ? (ctx.hiddenBy?.id ?? null) : null,
          hiddenAt: seed.hidden ? ctx.daysAgo(between(1, 10)) : null,
          allowResubmit: seed.hidden?.allowResubmit ?? true,
          isFeatured: featuredNow,
          featuredPosition: featuredNow ? ++featuredPosition : null,
          createdAt,
        }),
      );
      summary.services += 1;

      const serviceAreas = (areas.get(provider.profile_id) ?? [16]).slice(0, between(1, 3));
      await em.query(`INSERT INTO service_wilayas (service_id, wilaya_code, created_at) VALUES ${serviceAreas.map(() => '(?, ?, ?)').join(', ')}`, serviceAreas.flatMap((code) => [service!.id, code, createdAt]));

      const extras = text.extras.slice(0, between(0, text.extras.length));
      for (const [position, [nameEn, nameAr, price]] of extras.entries()) {
        await em.getRepository(ServiceExtra).save(em.getRepository(ServiceExtra).create({ serviceId: service.id, nameEn, nameAr: seed.noArabic ? '' : nameAr, price: price.toFixed(2), position }));
      }

      const photoCount = seed.status === D && seed.noArabic ? 0 : between(1, 5);
      for (let i = 0; i < photoCount; i++) {
        const buffer = await placeholderPhoto(seed.titleEn, `${seed.business} · ${category.nameEn}`, text.color, i);
        const stored = await files.store({ buffer, originalName: `${seed.titleEn.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}-${i + 1}.jpg`, purpose: FilePurpose.ServicePhoto, ownerId: provider.id }, { em, afterCommit: ctx.afterCommit });
        await em.query('INSERT INTO service_photos (id, created_at, service_id, file_id, position) VALUES (UUID(), ?, ?, ?, ?)', [createdAt, service.id, stored.id, i]);
        summary.photos += 1;
      }

      if (seed.hidden && ctx.hiddenBy) {
        await audit({
          actorId: ctx.hiddenBy.id,
          action: 'service.hidden',
          objectType: 'service',
          objectId: service.id,
          objectLabel: service.titleEn,
          level: AuditLevel.Sensitive,
          changes: { status: { from: 'published', to: 'hidden' }, reason: seed.hidden.reason, allowResubmit: seed.hidden.allowResubmit },
          note: seed.hidden.message,
          createdAt: service.hiddenAt!,
        });
      }
    }
    servicesByProvider.set(provider.id, (servicesByProvider.get(provider.id) ?? new Map()).set(service.titleEn, service));
  }

  // Ready Packs
  for (const seed of PACKS) {
    const provider = providers.get(seed.business);
    if (!provider) continue;
    const repository = em.getRepository(Pack);
    if (await repository.exists({ where: { providerId: provider.id, nameEn: seed.nameEn }, withDeleted: true })) continue;
    const owned = servicesByProvider.get(provider.id) ?? new Map<string, Service>();
    const items = seed.items.map((title) => owned.get(title)).filter((s): s is Service => !!s);
    if (items.length < 2) continue;
    // Publish rule: the pack wilaya must be covered by every item's wilaya set,
    // so make sure each seeded item covers `seed.wilaya` (no demo pack may
    // violate 422 PACK_WILAYA_NOT_COVERED).
    for (const item of items) {
      await em.query('INSERT IGNORE INTO service_wilayas (service_id, wilaya_code, created_at) VALUES (?, ?, NOW(6))', [item.id, seed.wilaya]);
    }
    // Below the sum of the items' base prices (status-rules §4), rounded to 1,000 DZD.
    const itemSum = items.reduce((total, s) => total + Number(s.basePrice), 0);
    const price = Math.max(1000, Math.floor((itemSum * (1 - seed.discount)) / 1000) * 1000);
    const reasons = packAttentionReasons(
      items.map((s) => ({ serviceId: s.id, status: s.status, deleted: s.deletedAt !== null, basePrice: s.basePrice })),
      { status: provider.status, verificationStatus: provider.verification_status, deleted: false },
    );
    const pack = await repository.save(
      repository.create({
        providerId: provider.id,
        nameEn: seed.nameEn,
        nameAr: seed.nameAr,
        descriptionEn: seed.descriptionEn,
        descriptionAr: seed.descriptionAr,
        eventType: seed.eventType,
        wilayaCode: seed.wilaya,
        price: price.toFixed(2),
        maxGuests: seed.maxGuests ?? null,
        status: seed.status,
        needsAttention: reasons.length > 0,
        createdById: ctx.hiddenBy?.id ?? provider.id,
        createdAt: ctx.daysAgo(between(3, 60)),
      }),
    );
    await em.getRepository(PackItem).insert(items.map((s, position) => ({ packId: pack.id, serviceId: s.id, position, createdAt: new Date() })));
    const firstSlug = ([...categories.values()].find((c) => c.id === items[0]!.categoryId)?.slug ?? 'decoration') as Slug;
    const cover = await placeholderPhoto(seed.nameEn, `${seed.business} · Ready Pack`, CATEGORY_TEXT[firstSlug]?.color ?? '#555f6b', 1);
    const stored = await files.store({ buffer: cover, originalName: `${seed.nameEn.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}.jpg`, purpose: FilePurpose.PackPhoto, ownerId: provider.id }, { em, afterCommit: ctx.afterCommit });
    await em.query('INSERT INTO pack_photos (id, created_at, pack_id, file_id, position) VALUES (UUID(), NOW(6), ?, ?, 0)', [pack.id, stored.id]);
    summary.photos += 1;
    summary.packs += 1;
  }

  // Repair databases seeded before the coverage rule: every pack item must
  // cover its pack's wilaya (status-rules §4, 422 PACK_WILAYA_NOT_COVERED).
  await em.query(
    `INSERT IGNORE INTO service_wilayas (service_id, wilaya_code, created_at)
     SELECT pi.service_id, p.wilaya_code, NOW(6) FROM pack_items pi JOIN packs p ON p.id = pi.pack_id WHERE p.deleted_at IS NULL`,
  );

  // Availability blocks for verified providers (next 6 weeks)
  const today = new Date();
  for (const provider of providerRows.filter((p) => p.verification_status === VerificationStatus.Verified && p.status === UserStatus.Active)) {
    if (await em.getRepository(AvailabilityBlock).exists({ where: { providerId: provider.id, kind: AvailabilityKind.Blocked }, withDeleted: true })) continue;
    const owned = [...(servicesByProvider.get(provider.id)?.values() ?? [])];
    const count = between(2, 4);
    for (let i = 0; i < count; i++) {
      const partial = i % 3 === 1;
      const oneService = i % 3 === 2 && owned.length > 0;
      await em.getRepository(AvailabilityBlock).save(
        em.getRepository(AvailabilityBlock).create({
          providerId: provider.id,
          serviceId: oneService ? owned[between(0, owned.length - 1)]!.id : null,
          date: addDays(today, between(2, 42)),
          startTime: partial ? '09:00:00' : null,
          endTime: partial ? '13:00:00' : null,
          kind: AvailabilityKind.Blocked,
          bookingId: null,
          note: partial ? 'Morning shooting elsewhere' : oneService ? 'Equipment in maintenance' : 'Family event',
        }),
      );
      summary.availabilityBlocks += 1;
    }
  }

  await recomputeCachedCounters(em);
  return summary;
}

/**
 * Cached counters from the rows that actually exist (reviews, bookings, favourites),
 * so the demo never shows ratings or bookings nobody made. Also repairs databases
 * seeded before this rule. Modules 8 and 12 seed bookings and reviews; this then
 * yields real values.
 */
export async function recomputeCachedCounters(em: EntityManager): Promise<void> {
  await em.query(
    `UPDATE services s SET
       avg_rating = COALESCE((SELECT ROUND(AVG(r.rating), 2) FROM reviews r WHERE r.service_id = s.id AND r.status IN ('published', 'redacted') AND r.deleted_at IS NULL), 0),
       rating_count = (SELECT COUNT(*) FROM reviews r WHERE r.service_id = s.id AND r.status IN ('published', 'redacted') AND r.deleted_at IS NULL),
       bookings_count = (SELECT COUNT(*) FROM bookings b WHERE b.service_id = s.id AND b.status = 'completed' AND b.deleted_at IS NULL),
       favourites_count = (SELECT COUNT(*) FROM favourites f WHERE f.service_id = s.id AND f.deleted_at IS NULL)`,
  );
  await em.query(
    `UPDATE packs p SET
       avg_rating = COALESCE((SELECT ROUND(AVG(r.rating), 2) FROM reviews r WHERE r.pack_id = p.id AND r.status IN ('published', 'redacted') AND r.deleted_at IS NULL), 0),
       rating_count = (SELECT COUNT(*) FROM reviews r WHERE r.pack_id = p.id AND r.status IN ('published', 'redacted') AND r.deleted_at IS NULL),
       bookings_count = (SELECT COUNT(*) FROM bookings b WHERE b.pack_id = p.id AND b.status = 'completed' AND b.deleted_at IS NULL)`,
  );
  await em.query(
    `UPDATE provider_profiles pp SET
       avg_rating = COALESCE((SELECT ROUND(AVG(r.rating), 2) FROM reviews r WHERE r.provider_id = pp.user_id AND r.status IN ('published', 'redacted') AND r.deleted_at IS NULL), 0),
       rating_count = (SELECT COUNT(*) FROM reviews r WHERE r.provider_id = pp.user_id AND r.status IN ('published', 'redacted') AND r.deleted_at IS NULL),
       completed_bookings_count = (SELECT COUNT(*) FROM bookings b WHERE b.provider_id = pp.user_id AND b.status = 'completed' AND b.deleted_at IS NULL),
       reply_rate = IF(EXISTS (SELECT 1 FROM messages m WHERE m.sender_id = pp.user_id), reply_rate, NULL),
       avg_reply_minutes = IF(EXISTS (SELECT 1 FROM messages m WHERE m.sender_id = pp.user_id), avg_reply_minutes, NULL)`,
  );
}
