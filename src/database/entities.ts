import type { DataSourceOptions } from 'typeorm';
import { AcademicRequestAttachment } from '../academic/entities/academic-request-attachment.entity.js';
import { AcademicRequestNeed } from '../academic/entities/academic-request-need.entity.js';
import { AcademicRequestProposal } from '../academic/entities/academic-request-proposal.entity.js';
import { AcademicRequest } from '../academic/entities/academic-request.entity.js';
import { FormVersion } from '../academic/entities/form-version.entity.js';
import { Form } from '../academic/entities/form.entity.js';
import { AuditLog } from '../admin/entities/audit-log.entity.js';
import { Export } from '../admin/entities/export.entity.js';
import { SavedView } from '../admin/entities/saved-view.entity.js';
import { Setting } from '../admin/entities/setting.entity.js';
import { AdminInvitation } from '../auth/entities/admin-invitation.entity.js';
import { LoginAttempt } from '../auth/entities/login-attempt.entity.js';
import { Session } from '../auth/entities/session.entity.js';
import { VerificationCode } from '../auth/entities/verification-code.entity.js';
import { BookingLine } from '../bookings/entities/booking-line.entity.js';
import { BookingPriceChange } from '../bookings/entities/booking-price-change.entity.js';
import { BookingReschedule } from '../bookings/entities/booking-reschedule.entity.js';
import { BookingStatusChange } from '../bookings/entities/booking-status-change.entity.js';
import { Booking } from '../bookings/entities/booking.entity.js';
import { BudgetItem } from '../bookings/entities/budget-item.entity.js';
import { Budget } from '../bookings/entities/budget.entity.js';
import { Invoice } from '../bookings/entities/invoice.entity.js';
import { Category } from '../catalog/entities/category.entity.js';
import { Commune } from '../catalog/entities/commune.entity.js';
import { Sequence } from '../catalog/entities/sequence.entity.js';
import { Wilaya } from '../catalog/entities/wilaya.entity.js';
import { DisputeEvent } from '../disputes/entities/dispute-event.entity.js';
import { DisputeEvidence } from '../disputes/entities/dispute-evidence.entity.js';
import { Dispute } from '../disputes/entities/dispute.entity.js';
import { FileVariant } from '../files/entities/file-variant.entity.js';
import { StoredFile } from '../files/entities/stored-file.entity.js';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity.js';
import { Conversation } from '../messaging/entities/conversation.entity.js';
import { Message } from '../messaging/entities/message.entity.js';
import { DeviceToken } from '../notifications/entities/device-token.entity.js';
import { NotificationPreference } from '../notifications/entities/notification-preference.entity.js';
import { Notification } from '../notifications/entities/notification.entity.js';
import { PackItem } from '../packs/entities/pack-item.entity.js';
import { PackPhoto } from '../packs/entities/pack-photo.entity.js';
import { Pack } from '../packs/entities/pack.entity.js';
import { Report } from '../reviews/entities/report.entity.js';
import { ReviewReply } from '../reviews/entities/review-reply.entity.js';
import { Review } from '../reviews/entities/review.entity.js';
import { AvailabilityBlock } from '../services/entities/availability-block.entity.js';
import { Favourite } from '../services/entities/favourite.entity.js';
import { ServiceExtra } from '../services/entities/service-extra.entity.js';
import { ServicePhoto } from '../services/entities/service-photo.entity.js';
import { ServiceWilaya } from '../services/entities/service-wilaya.entity.js';
import { Service } from '../services/entities/service.entity.js';
import { StatsDaily } from '../stats/entities/stats-daily.entity.js';
import { UserDocument } from '../verification/entities/user-document.entity.js';
import { ProviderProfile } from '../users/entities/provider-profile.entity.js';
import { ProviderWilaya } from '../users/entities/provider-wilaya.entity.js';
import { UserNote } from '../users/entities/user-note.entity.js';
import { User } from '../users/entities/user.entity.js';

/**
 * Every entity (schema v1, docs/db-schema.md), listed explicitly. Glob patterns
 * resolve differently under ESM from `src` (tsx) and `dist` (node).
 *
 * Give every `@Column` an explicit `type`: the migration CLI runs through tsx,
 * which does not emit decorator metadata. Relation properties are typed
 * `Relation<T>` so decorator metadata never touches a class still being
 * initialised in an ESM import cycle.
 */
export const entities: NonNullable<DataSourceOptions['entities']> = [
  // 1. identity & access
  User,
  ProviderProfile,
  ProviderWilaya,
  Session,
  VerificationCode,
  LoginAttempt,
  AdminInvitation,
  UserNote,
  NotificationPreference,
  // 2. files & provider verification
  StoredFile,
  FileVariant,
  UserDocument,
  // 3. reference data
  Wilaya,
  Commune,
  Category,
  Sequence,
  // 4. services & availability
  Service,
  ServiceWilaya,
  ServiceExtra,
  ServicePhoto,
  AvailabilityBlock,
  // 5. packs
  Pack,
  PackItem,
  PackPhoto,
  // 6. bookings & invoices
  Booking,
  BookingLine,
  BookingStatusChange,
  BookingReschedule,
  BookingPriceChange,
  Invoice,
  // 7. academic requests & forms
  Form,
  FormVersion,
  AcademicRequest,
  AcademicRequestNeed,
  AcademicRequestAttachment,
  AcademicRequestProposal,
  // 8. disputes
  Dispute,
  DisputeEvidence,
  DisputeEvent,
  // 9. reviews & reports
  Review,
  ReviewReply,
  Report,
  // 10. messaging & notifications
  Conversation,
  ConversationParticipant,
  Message,
  Notification,
  DeviceToken,
  Favourite,
  Budget,
  BudgetItem,
  // 11. admin, audit & analytics
  Setting,
  AuditLog,
  SavedView,
  Export,
  StatsDaily,
];
