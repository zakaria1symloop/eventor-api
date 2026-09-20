import type { DataSourceOptions } from 'typeorm';
import { AcademicRequestAttachment } from '../academic/entities/academic-request-attachment.entity.js';
import { AcademicRequestNeed } from '../academic/entities/academic-request-need.entity.js';
import { AcademicRequestSuggestion } from '../academic/entities/academic-request-suggestion.entity.js';
import { AcademicRequest } from '../academic/entities/academic-request.entity.js';
import { AdminInvitation } from '../admin/entities/admin-invitation.entity.js';
import { AuditLog } from '../admin/entities/audit-log.entity.js';
import { Export } from '../admin/entities/export.entity.js';
import { SavedView } from '../admin/entities/saved-view.entity.js';
import { Setting } from '../admin/entities/setting.entity.js';
import { UserNote } from '../admin/entities/user-note.entity.js';
import { AnalyticsEvent } from '../analytics/entities/analytics-event.entity.js';
import { StatsDaily } from '../analytics/entities/stats-daily.entity.js';
import { BookingLine } from '../bookings/entities/booking-line.entity.js';
import { BookingPriceChange } from '../bookings/entities/booking-price-change.entity.js';
import { BookingReschedule } from '../bookings/entities/booking-reschedule.entity.js';
import { BookingStatusChange } from '../bookings/entities/booking-status-change.entity.js';
import { Booking } from '../bookings/entities/booking.entity.js';
import { Invoice } from '../bookings/entities/invoice.entity.js';
import { BudgetItem } from '../budget/entities/budget-item.entity.js';
import { Budget } from '../budget/entities/budget.entity.js';
import { Category } from '../catalog/entities/category.entity.js';
import { Commune } from '../catalog/entities/commune.entity.js';
import { Wilaya } from '../catalog/entities/wilaya.entity.js';
import { FileVariant } from '../files/entities/file-variant.entity.js';
import { StoredFile } from '../files/entities/stored-file.entity.js';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity.js';
import { Conversation } from '../messaging/entities/conversation.entity.js';
import { Message } from '../messaging/entities/message.entity.js';
import { DeviceToken } from '../notifications/entities/device-token.entity.js';
import { UserNotification } from '../notifications/entities/user-notification.entity.js';
import { PackItem } from '../packs/entities/pack-item.entity.js';
import { PackPhoto } from '../packs/entities/pack-photo.entity.js';
import { Pack } from '../packs/entities/pack.entity.js';
import { Report } from '../reviews/entities/report.entity.js';
import { Review } from '../reviews/entities/review.entity.js';
import { AvailabilityBlock } from '../services/entities/availability-block.entity.js';
import { Favourite } from '../services/entities/favourite.entity.js';
import { ServiceExtra } from '../services/entities/service-extra.entity.js';
import { ServicePhoto } from '../services/entities/service-photo.entity.js';
import { ServiceWilaya } from '../services/entities/service-wilaya.entity.js';
import { Service } from '../services/entities/service.entity.js';
import { AcademicProfile } from '../users/entities/academic-profile.entity.js';
import { LoginAttempt } from '../users/entities/login-attempt.entity.js';
import { PasswordReset } from '../users/entities/password-reset.entity.js';
import { ProviderProfile } from '../users/entities/provider-profile.entity.js';
import { ProviderWilaya } from '../users/entities/provider-wilaya.entity.js';
import { Session } from '../users/entities/session.entity.js';
import { User } from '../users/entities/user.entity.js';
import { UserDocument } from '../verification/entities/user-document.entity.js';
import { Sequence } from './sequence.entity.js';

/**
 * Every entity, listed explicitly. Glob patterns are unreliable under ESM and
 * resolve differently from `src` (tsx) and `dist` (node), so each module adds
 * its entities here.
 *
 * Give every `@Column` an explicit `type`: the migration CLI runs through tsx,
 * which does not emit decorator metadata, so inferred column types are
 * invisible to it. Relation properties are typed `Relation<T>` so emitted
 * decorator metadata does not touch classes still being initialised in an
 * ESM import cycle.
 */
export const entities: NonNullable<DataSourceOptions['entities']> = [
  // identity & access
  User,
  ProviderProfile,
  ProviderWilaya,
  AcademicProfile,
  Session,
  PasswordReset,
  LoginAttempt,
  AdminInvitation,
  UserNote,
  // files & verification
  StoredFile,
  FileVariant,
  UserDocument,
  // reference data
  Wilaya,
  Commune,
  Category,
  Sequence,
  // services & availability
  Service,
  ServiceWilaya,
  ServiceExtra,
  ServicePhoto,
  AvailabilityBlock,
  // packs
  Pack,
  PackItem,
  PackPhoto,
  // bookings & invoices
  Booking,
  BookingLine,
  BookingStatusChange,
  BookingReschedule,
  BookingPriceChange,
  Invoice,
  // academic
  AcademicRequest,
  AcademicRequestNeed,
  AcademicRequestAttachment,
  AcademicRequestSuggestion,
  // reviews, reports, favourites, budget
  Review,
  Report,
  Favourite,
  Budget,
  BudgetItem,
  // messaging & notifications
  Conversation,
  ConversationParticipant,
  Message,
  UserNotification,
  DeviceToken,
  // admin, audit & analytics
  Setting,
  AuditLog,
  SavedView,
  Export,
  AnalyticsEvent,
  StatsDaily,
];
