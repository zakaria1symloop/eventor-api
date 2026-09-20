import { randomBytes, randomUUID } from 'node:crypto';
import type { DataSource, DeepPartial, EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { AcademicRequest } from '../../src/academic/entities/academic-request.entity.js';
import { FormVersion } from '../../src/academic/entities/form-version.entity.js';
import { Form } from '../../src/academic/entities/form.entity.js';
import { AuditLog } from '../../src/admin/entities/audit-log.entity.js';
import { Session } from '../../src/auth/entities/session.entity.js';
import { Booking } from '../../src/bookings/entities/booking.entity.js';
import { Invoice } from '../../src/bookings/entities/invoice.entity.js';
import { Category } from '../../src/catalog/entities/category.entity.js';
import { Commune } from '../../src/catalog/entities/commune.entity.js';
import { AcademicRequestStatus, FormStatus } from '../../src/common/enums/academic.enums.js';
import { AuditLevel, AuditSource } from '../../src/common/enums/admin.enums.js';
import { SessionAudience } from '../../src/common/enums/auth.enums.js';
import { BookingSource, BookingStatus } from '../../src/common/enums/booking.enums.js';
import {
  EventType,
  PackStatus,
  PriceType,
  ServiceStatus,
} from '../../src/common/enums/catalog.enums.js';
import {
  DocumentType,
  FileProcessingStatus,
  FilePurpose,
} from '../../src/common/enums/file.enums.js';
import { ConversationKind } from '../../src/common/enums/messaging.enums.js';
import {
  DisputeType,
  ReportReason,
  ReportTargetType,
} from '../../src/common/enums/moderation.enums.js';
import {
  Language,
  PartyRole,
  UserRole,
  UserStatus,
  VerificationStatus,
} from '../../src/common/enums/user.enums.js';
import { Dispute } from '../../src/disputes/entities/dispute.entity.js';
import { StoredFile } from '../../src/files/entities/stored-file.entity.js';
import { Conversation } from '../../src/messaging/entities/conversation.entity.js';
import { Message } from '../../src/messaging/entities/message.entity.js';
import { Notification } from '../../src/notifications/entities/notification.entity.js';
import { Pack } from '../../src/packs/entities/pack.entity.js';
import { Report } from '../../src/reviews/entities/report.entity.js';
import { Review } from '../../src/reviews/entities/review.entity.js';
import { Service } from '../../src/services/entities/service.entity.js';
import { ProviderProfile } from '../../src/users/entities/provider-profile.entity.js';
import { User } from '../../src/users/entities/user.entity.js';
import { UserDocument } from '../../src/verification/entities/user-document.entity.js';
import { MessageKind } from '../../src/common/enums/messaging.enums.js';

type Db = DataSource | EntityManager;

/** Short unique suffix, so suites sharing the test database never collide. */
export const uid = (bytes = 4): string => randomBytes(bytes).toString('hex');

const ALGIERS = 16;

async function insert<T extends ObjectLiteral>(
  db: Db,
  target: EntityTarget<T>,
  values: DeepPartial<T>,
): Promise<T> {
  const repository = db.getRepository(target);
  return repository.save(repository.create(values));
}

// ── identity ────────────────────────────────────────────────

export function makeUser(db: Db, overrides: DeepPartial<User> = {}): Promise<User> {
  const role = (overrides.role as UserRole | undefined) ?? UserRole.Client;
  const suffix = uid();
  return insert(db, User, {
    role,
    status: UserStatus.Active,
    verificationStatus:
      role === UserRole.Provider ? VerificationStatus.Verified : VerificationStatus.NotRequired,
    fullName: `Test ${role} ${suffix}`,
    email: `${role}.${suffix}@test.eventor.dz`,
    emailVerifiedAt: new Date(),
    phone: null,
    passwordHash: null,
    language: Language.En,
    wilayaCode: ALGIERS,
    ...overrides,
  });
}

export async function makeProvider(
  db: Db,
  overrides: { user?: DeepPartial<User>; profile?: DeepPartial<ProviderProfile> } = {},
): Promise<{ user: User; profile: ProviderProfile }> {
  const user = await makeUser(db, { role: UserRole.Provider, ...overrides.user });
  const categoryId = overrides.profile?.categoryId ?? (await makeCategory(db)).id;
  const profile = await insert(db, ProviderProfile, {
    userId: user.id,
    businessName: `${user.fullName} Events`,
    categoryId,
    acceptingBookings: true,
    ...overrides.profile,
  });
  return { user, profile };
}

export function makeSession(db: Db, overrides: DeepPartial<Session> = {}): Promise<Session> {
  return insert(db, Session, {
    tokenHash: uid(32),
    audience: SessionAudience.Dashboard,
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    ...overrides,
  });
}

// ── catalogue & files ───────────────────────────────────────

export function makeCategory(db: Db, overrides: DeepPartial<Category> = {}): Promise<Category> {
  const suffix = uid();
  return insert(db, Category, {
    slug: `category-${suffix}`,
    nameEn: `Category ${suffix}`,
    nameAr: `فئة ${suffix}`,
    icon: 'sparkles',
    position: 0,
    isVisible: true,
    ...overrides,
  });
}

export function makeCommune(db: Db, overrides: DeepPartial<Commune> = {}): Promise<Commune> {
  const suffix = uid();
  return insert(db, Commune, {
    wilayaCode: ALGIERS,
    name: `Commune ${suffix}`,
    nameAr: `بلدية ${suffix}`,
    ...overrides,
  });
}

export function makeFile(db: Db, overrides: DeepPartial<StoredFile> = {}): Promise<StoredFile> {
  const id = randomUUID();
  return insert(db, StoredFile, {
    id,
    purpose: FilePurpose.Document,
    storagePath: `private/document/test/${id}.pdf`,
    originalName: 'document.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    processingStatus: FileProcessingStatus.Ready,
    checksum: uid(32),
    isPrivate: true,
    ...overrides,
  });
}

export async function makeUserDocument(
  db: Db,
  overrides: DeepPartial<UserDocument> = {},
): Promise<UserDocument> {
  const userId = overrides.userId ?? (await makeProvider(db)).user.id;
  const fileId = overrides.fileId ?? (await makeFile(db, { ownerId: userId as string })).id;
  return insert(db, UserDocument, {
    type: DocumentType.NationalId,
    ...overrides,
    userId,
    fileId,
  });
}

// ── services, packs, bookings ───────────────────────────────

export async function makeService(db: Db, overrides: DeepPartial<Service> = {}): Promise<Service> {
  const providerId = overrides.providerId ?? (await makeProvider(db)).user.id;
  const categoryId = overrides.categoryId ?? (await makeCategory(db)).id;
  const suffix = uid();
  return insert(db, Service, {
    titleEn: `Service ${suffix}`,
    titleAr: `خدمة ${suffix}`,
    descriptionEn: 'A test service.',
    descriptionAr: 'خدمة تجريبية.',
    basePrice: '45000.00',
    priceType: PriceType.PerEvent,
    status: ServiceStatus.Published,
    ...overrides,
    providerId,
    categoryId,
  });
}

export async function makePack(db: Db, overrides: DeepPartial<Pack> = {}): Promise<Pack> {
  const providerId = overrides.providerId ?? (await makeProvider(db)).user.id;
  const suffix = uid();
  return insert(db, Pack, {
    nameEn: `Pack ${suffix}`,
    nameAr: `باقة ${suffix}`,
    eventType: EventType.Wedding,
    wilayaCode: ALGIERS,
    price: '120000.00',
    status: PackStatus.Draft,
    createdById: providerId,
    ...overrides,
    providerId,
  });
}

let bookingCounter = 0;

export async function makeBooking(db: Db, overrides: DeepPartial<Booking> = {}): Promise<Booking> {
  const service =
    overrides.serviceId || overrides.packId ? null : await makeService(db);
  const clientId = overrides.clientId ?? (await makeUser(db)).id;
  bookingCounter += 1;
  return insert(db, Booking, {
    reference: `TST-${uid(3)}${bookingCounter % 10}`,
    status: BookingStatus.Pending,
    eventType: EventType.Wedding,
    eventDate: '2026-12-20',
    wilayaCode: ALGIERS,
    subtotal: '45000.00',
    discountTotal: '0.00',
    total: '45000.00',
    feePercent: '10.00',
    source: BookingSource.Dashboard,
    serviceId: service?.id ?? null,
    providerId: service?.providerId,
    ...overrides,
    clientId,
  });
}

export async function makeInvoice(db: Db, overrides: DeepPartial<Invoice> = {}): Promise<Invoice> {
  const bookingId = overrides.bookingId ?? (await makeBooking(db)).id;
  return insert(db, Invoice, {
    number: `INV-T-${uid(4)}`,
    issuedAt: new Date(),
    subtotal: '45000.00',
    discountTotal: '0.00',
    total: '45000.00',
    feePercent: '10.00',
    feeAmount: '4500.00',
    providerAmount: '40500.00',
    issuer: { name: 'Eventor' },
    snapshot: {},
    ...overrides,
    bookingId,
  });
}

// ── academic ────────────────────────────────────────────────

export async function makeForm(
  db: Db,
  overrides: DeepPartial<Form> = {},
): Promise<{ form: Form; version: FormVersion }> {
  const createdById = overrides.createdById ?? (await makeUser(db, { role: UserRole.Admin })).id;
  const suffix = uid();
  const form = await insert(db, Form, {
    slug: `form-${suffix}`,
    nameEn: `Form ${suffix}`,
    nameAr: `نموذج ${suffix}`,
    status: FormStatus.Published,
    confirmationEn: 'Thank you.',
    confirmationAr: 'شكرًا.',
    ...overrides,
    createdById,
  });
  const version = await insert(db, FormVersion, {
    formId: form.id,
    version: 1,
    schema: {
      fields: [{ key: 'title', type: 'short_text', label_en: 'Title', label_ar: 'العنوان', required: true, maps_to: 'title' }],
    },
    publishedById: createdById as string,
    publishedAt: new Date(),
  });
  form.liveVersionId = version.id;
  await db.getRepository(Form).update(form.id, { liveVersionId: version.id });
  return { form, version };
}

export async function makeAcademicRequest(
  db: Db,
  overrides: DeepPartial<AcademicRequest> = {},
): Promise<AcademicRequest> {
  const { form, version } = overrides.formId
    ? { form: { id: overrides.formId as string }, version: { id: overrides.formVersionId as string } }
    : await makeForm(db);
  const suffix = uid();
  return insert(db, AcademicRequest, {
    reference: `TSR-${uid(3)}`,
    answers: { title: `Conference ${suffix}` },
    requesterName: `Requester ${suffix}`,
    requesterEmail: `requester.${suffix}@univ.test`,
    requesterPhone: '+213555000000',
    title: `Conference ${suffix}`,
    status: AcademicRequestStatus.Pending,
    submittedAt: new Date(),
    ...overrides,
    formId: form.id,
    formVersionId: version.id,
  });
}

// ── messaging, disputes, reviews ────────────────────────────

export function makeConversation(
  db: Db,
  overrides: DeepPartial<Conversation> = {},
): Promise<Conversation> {
  return insert(db, Conversation, { kind: ConversationKind.Direct, ...overrides });
}

export async function makeMessage(db: Db, overrides: DeepPartial<Message> = {}): Promise<Message> {
  const conversationId = overrides.conversationId ?? (await makeConversation(db)).id;
  return insert(db, Message, {
    kind: MessageKind.Text,
    body: 'Hello',
    ...overrides,
    conversationId,
  });
}

export async function makeDispute(db: Db, overrides: DeepPartial<Dispute> = {}): Promise<Dispute> {
  const booking = overrides.bookingId
    ? await db.getRepository(Booking).findOneByOrFail({ id: overrides.bookingId as string })
    : await makeBooking(db, { status: BookingStatus.Accepted });
  const conversationId =
    overrides.conversationId ??
    (await makeConversation(db, { kind: ConversationKind.Dispute, bookingId: booking.id })).id;
  return insert(db, Dispute, {
    reference: `TSD-${uid(3)}`,
    openedById: booking.clientId,
    openedByRole: PartyRole.Client,
    againstUserId: booking.providerId,
    type: DisputeType.ProviderNoShow,
    description: 'The provider did not come.',
    ...overrides,
    bookingId: booking.id,
    conversationId,
  });
}

export async function makeReview(db: Db, overrides: DeepPartial<Review> = {}): Promise<Review> {
  const booking = overrides.bookingId
    ? await db.getRepository(Booking).findOneByOrFail({ id: overrides.bookingId as string })
    : await makeBooking(db, { status: BookingStatus.Completed, completedAt: new Date() });
  return insert(db, Review, {
    authorId: booking.clientId,
    providerId: booking.providerId,
    serviceId: booking.serviceId,
    packId: booking.packId,
    rating: 5,
    comment: 'Great service.',
    ...overrides,
    bookingId: booking.id,
  });
}

export async function makeReport(db: Db, overrides: DeepPartial<Report> = {}): Promise<Report> {
  const reporterId = overrides.reporterId ?? (await makeUser(db)).id;
  const targetId = overrides.targetId ?? (await makeReview(db)).id;
  return insert(db, Report, {
    targetType: ReportTargetType.Review,
    reason: ReportReason.Spam,
    ...overrides,
    reporterId,
    targetId,
  });
}

// ── notifications & admin ───────────────────────────────────

export async function makeNotification(
  db: Db,
  overrides: DeepPartial<Notification> = {},
): Promise<Notification> {
  const userId = overrides.userId ?? (await makeUser(db)).id;
  return insert(db, Notification, {
    type: 'test.notification',
    title: 'Test',
    body: 'Test notification',
    ...overrides,
    userId,
  });
}

export function makeAuditLog(db: Db, overrides: DeepPartial<AuditLog> = {}): Promise<AuditLog> {
  return insert(db, AuditLog, {
    action: 'test.action',
    objectType: 'test',
    level: AuditLevel.Info,
    source: AuditSource.System,
    ...overrides,
  });
}
