import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/password.policy.js';
import { toArray, toBoolean, trim, trimToNull } from '../../common/dto/transforms.js';
import { DevicePlatform } from '../../common/enums/messaging.enums.js';
import { DocumentRejectReason, DocumentStatus, DocumentType } from '../../common/enums/file.enums.js';
import { Language, UserRole, UserStatus, VerificationStatus } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { toPhone } from '../../users/users.policy.js';

const PHONE_MESSAGE = 'phone must be an Algerian number: 0XXXXXXXXX or +213XXXXXXXXX';

export class AppWilayaRefDto {
  @ApiProperty({ example: 16 }) code: number;
  @ApiProperty({ example: 'Alger', description: 'In the caller’s language.' }) name: string;
  @ApiProperty({ example: 'Alger' }) nameEn: string;
  @ApiProperty({ example: 'الجزائر' }) nameAr: string;
}

export class AppCategoryRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'photography' }) slug: string;
  @ApiProperty({ example: 'Photography', description: 'In the caller’s language.' }) name: string;
  @ApiProperty({ example: 'Photography' }) nameEn: string;
  @ApiProperty({ example: 'التصوير' }) nameAr: string;
  @ApiProperty({ example: 'camera' }) icon: string;
}

export class AppCategoryDto extends AppCategoryRefDto {
  @ApiProperty({ example: 1 }) position: number;
  @ApiProperty({ example: 42, description: 'Visible services in this category.' }) servicesCount: number;
}

/** Provider-only part of `GET /app/me` (screens 21a, 08d, Profile). */
export class AppProviderProfileDto {
  @ApiProperty({ example: 'Studio Lumière' }) businessName: string;
  @ApiProperty({ type: AppCategoryRefDto, nullable: true }) category: AppCategoryRefDto | null;
  @ApiProperty({ type: String, nullable: true, example: 'We cover weddings across Alger.' }) bio: string | null;
  @ApiProperty({ type: String, nullable: true }) bioEn: string | null;
  @ApiProperty({ type: String, nullable: true }) bioAr: string | null;
  @ApiProperty({ type: [String], nullable: true, example: ['ar', 'fr', 'en'] }) languagesSpoken: string[] | null;
  @ApiProperty({ type: Number, nullable: true, example: 6 }) yearsActive: number | null;
  @ApiProperty({ example: true, description: '"Available for bookings" toggle (screen 21).' }) acceptingBookings: boolean;
  @ApiProperty({ example: '4.80' }) avgRating: string;
  @ApiProperty({ example: 32 }) ratingCount: number;
  @ApiProperty({ example: 48, description: '"Events done" on screen 13.' }) completedBookingsCount: number;
  @ApiProperty({ type: [AppWilayaRefDto] }) wilayas: AppWilayaRefDto[];
}

/** The signed-in account (`GET /app/me`, and the `user` of every auth response). */
export class AppMeDto {
  @ApiProperty({ format: 'uuid', example: '5b0d6c9e-4a51-4c3f-9d0e-2f6b8a7c1e24' }) id: string;
  @ApiProperty({ enum: UserRole, example: UserRole.Client }) role: UserRole;
  @ApiProperty({ enum: UserStatus, example: UserStatus.Active }) status: UserStatus;
  @ApiProperty({ enum: VerificationStatus, example: VerificationStatus.NotRequired }) verificationStatus: VerificationStatus;
  @ApiProperty({ example: 'Amina Benali' }) fullName: string;
  @ApiProperty({ format: 'email', example: 'amina.benali@email.com' }) email: string;
  @ApiProperty({ example: true }) emailVerified: boolean;
  @ApiProperty({ type: String, nullable: true, example: '+213555123456' }) phone: string | null;
  @ApiProperty({ enum: Language, example: Language.En }) language: Language;
  @ApiProperty({ type: AppWilayaRefDto, nullable: true }) wilaya: AppWilayaRefDto | null;
  @ApiProperty({ type: String, nullable: true, description: 'Signed, expiring avatar URL.' }) avatarUrl: string | null;
  @ApiProperty({ type: String, nullable: true, description: '320 px variant.' }) avatarThumbUrl: string | null;
  @ApiProperty({ type: AppProviderProfileDto, nullable: true, description: 'Providers only.' }) provider: AppProviderProfileDto | null;
  @ApiProperty({ example: 0, description: 'Unread notifications, for the bell badge.' }) unreadNotifications: number;
  @ApiProperty({ example: 0, description: 'Conversations with unread messages.' }) unreadConversations: number;
  @ApiProperty({ format: 'date-time', example: '2026-09-01T08:30:00.000Z' }) createdAt: string;
}

export class UpdateAppMeDto {
  @ApiPropertyOptional({ example: 'Amina Benali', maxLength: 120 })
  @IsOptional() @Transform(trim) @IsString() @Length(2, 120)
  fullName?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '0555123456', description: 'Null clears it.' })
  @IsOptional() @Transform(toPhone) @Matches(/^\+213[1-9]\d{8}$/, { message: PHONE_MESSAGE })
  phone?: string | null;

  @ApiPropertyOptional({ enum: Language })
  @IsOptional() @IsEnum(Language)
  language?: Language;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 16, description: 'Null clears it.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(58)
  wilayaCode?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'A file id from `POST /app/me/avatar`; null removes the avatar.' })
  @IsOptional() @IsUUID('4')
  avatarFileId?: string | null;
}

export class AppChangePasswordDto {
  @ApiProperty({ example: 'Sunflower42x', maxLength: PASSWORD_MAX_LENGTH })
  @IsString() @IsNotEmpty() @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword: string;

  @ApiProperty({ example: 'Bluebird99z', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString() @IsNotEmpty() @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword: string;
}

export class DeleteAppMeDto {
  @ApiProperty({ example: 'Sunflower42x', description: 'The account’s current password (confirmation).', maxLength: PASSWORD_MAX_LENGTH })
  @IsString() @IsNotEmpty() @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class AppSessionRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: String, nullable: true, example: 'Chrome on Android' }) deviceLabel: string | null;
  @ApiProperty({ type: String, nullable: true, example: '41.100.12.8' }) ip: string | null;
  @ApiProperty({ example: true, description: 'The session this request is using.' }) current: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastUsedAt: string | null;
  @ApiProperty({ format: 'date-time' }) expiresAt: string;
}

// ── provider documents (screens 08a / 08d) ──────────────────

export class AppDocumentDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Null when nothing was uploaded for this type yet.' }) id: string | null;
  @ApiProperty({ enum: DocumentType, example: DocumentType.NationalId }) type: DocumentType;
  @ApiProperty({ example: 'National ID card', description: 'Label in the caller’s language.' }) label: string;
  @ApiProperty({ enum: [...Object.values(DocumentStatus), 'missing'], example: DocumentStatus.Pending }) status: DocumentStatus | 'missing';
  @ApiProperty({ type: String, nullable: true, description: 'Signed, expiring URL of the uploaded file.' }) fileUrl: string | null;
  @ApiProperty({ enum: DocumentRejectReason, nullable: true, example: DocumentRejectReason.NameMismatch }) rejectReason: DocumentRejectReason | null;
  @ApiProperty({ type: String, nullable: true, example: 'Details do not match the account' }) rejectReasonLabel: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'The name on the NIF card does not match your account name.' }) rejectNote: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) reviewedAt: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) submittedAt: string | null;
  @ApiProperty({ example: false, description: 'True when this version replaces an earlier one.' }) resubmitted: boolean;
}

export class AppDocumentsDto {
  @ApiProperty({ enum: VerificationStatus, example: VerificationStatus.Rejected }) verificationStatus: VerificationStatus;
  @ApiProperty({ example: true, description: 'True while at least one document is missing or rejected (screen 08d "Action needed").' }) actionNeeded: boolean;
  @ApiProperty({ example: 5, description: '`max_document_upload_mb`.' }) maxFileSizeMb: number;
  @ApiProperty({ type: [String], example: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] }) acceptedTypes: string[];
  @ApiProperty({ type: [AppDocumentDto] }) documents: AppDocumentDto[];
  @ApiProperty({ example: { approved: 2, rejected: 1, waiting: 0, missing: 0 } })
  progress: { approved: number; rejected: number; waiting: number; missing: number };
}

export class UploadAppDocumentDto {
  @ApiProperty({ enum: DocumentType, example: DocumentType.TaxCard })
  @IsEnum(DocumentType)
  type: DocumentType;
}

// ── device tokens & notification preferences ────────────────

export class RegisterDeviceTokenDto {
  @ApiProperty({ example: 'fcm-token-eXaMpLe-123', maxLength: 255 })
  @Transform(trim) @IsString() @Length(8, 255)
  token: string;

  @ApiProperty({ enum: DevicePlatform, example: DevicePlatform.Android })
  @IsEnum(DevicePlatform)
  platform: DevicePlatform;
}

export class RevokedSessionsDto {
  @ApiProperty({ example: 2, description: 'Sessions revoked by the call.' }) revoked: number;
}

export class AppDeviceTokenDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'fcm-token-eXaMpLe-123' }) token: string;
  @ApiProperty({ enum: DevicePlatform }) platform: DevicePlatform;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastSeenAt: string | null;
}

export class AppNotificationPreferencesDto {
  @ApiProperty({ example: true }) pushBookings: boolean;
  @ApiProperty({ example: true }) pushMessages: boolean;
  @ApiProperty({ example: true }) pushReviews: boolean;
  @ApiProperty({ example: true }) emailBookings: boolean;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pushBookings?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pushMessages?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pushReviews?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() emailBookings?: boolean;
}

// ── notifications (screen 16) ───────────────────────────────

export class AppNotificationDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'booking.accepted' }) type: string;
  @ApiProperty({ example: 'Booking accepted' }) title: string;
  @ApiProperty({ example: 'Studio Lumière accepted your request for Sat 14 Mar.' }) body: string;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true, example: { bookingId: '…', href: 'booking/…' }, description: 'Deep-link payload.' })
  data: Record<string, unknown> | null;
  @ApiProperty({ enum: ['today', 'this_week', 'earlier'], example: 'today', description: 'The section of screen 16 this row belongs to (Africa/Algiers).' })
  group: 'today' | 'this_week' | 'earlier';
  @ApiProperty({ example: false }) read: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) readAt: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppNotificationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Only unread notifications.' })
  @IsOptional() @Transform(toBoolean) @IsBoolean()
  unread?: boolean;
}

export class MarkNotificationsReadDto {
  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'The notifications to mark read. Ignored when `all` is true.' })
  @IsOptional() @Transform(toArray) @IsUUID('4', { each: true })
  ids?: string[];

  @ApiPropertyOptional({ description: 'Mark every notification of this account read ("Mark all read").' })
  @IsOptional() @IsBoolean()
  all?: boolean;
}

export class UnreadCountDto {
  @ApiProperty({ example: 3 }) unread: number;
}

export class MarkedReadDto {
  @ApiProperty({ example: 3, description: 'Rows changed.' }) marked: number;
  @ApiProperty({ example: 0 }) unread: number;
}

// ── favourites (screen 17) ──────────────────────────────────

export class AppFavouriteDto {
  @ApiProperty({ format: 'uuid', description: 'The favourite row id — pass it to `DELETE /app/me/favourites/:id`.' }) id: string;
  @ApiProperty({ enum: ['service', 'pack'], example: 'service' }) kind: 'service' | 'pack';
  @ApiProperty({ format: 'uuid', description: 'The service or pack id.' }) targetId: string;
  @ApiProperty({ example: 'Wedding photo & video coverage', description: 'In the caller’s language.' }) title: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) titleEn: string;
  @ApiProperty({ example: 'تغطية تصوير الأعراس' }) titleAr: string;
  @ApiProperty({ example: 'Studio Lumière' }) providerName: string;
  @ApiProperty({ type: AppCategoryRefDto, nullable: true }) category: AppCategoryRefDto | null;
  @ApiProperty({ example: '45000.00', description: 'DZD, 2 decimals ("From 45 000 DA").' }) fromPrice: string;
  @ApiProperty({ type: String, nullable: true, description: 'Cover photo, 320 px.' }) coverUrl: string | null;
  @ApiProperty({ example: '4.80' }) avgRating: string;
  @ApiProperty({ example: 32 }) ratingCount: number;
  @ApiProperty({ example: true, description: 'False once the target stops being visible in the app (kept in the list, greyed out).' })
  available: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppFavouritesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Category chip on screen 17. Packs are excluded when set.' })
  @IsOptional() @IsUUID('4')
  categoryId?: string;

  @ApiPropertyOptional({ enum: ['service', 'pack'] })
  @IsOptional() @IsEnum({ service: 'service', pack: 'pack' })
  kind?: 'service' | 'pack';
}

export class CreateFavouriteDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Exactly one of `serviceId` / `packId` (422 FAVOURITE_TARGET_INVALID).' })
  @IsOptional() @IsUUID('4')
  serviceId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID('4')
  packId?: string;
}

// ── budget (screen 18) ──────────────────────────────────────

export class AppBudgetItemDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: AppCategoryRefDto, nullable: true }) category: AppCategoryRefDto | null;
  @ApiProperty({ example: 'Venue' }) label: string;
  @ApiProperty({ example: '120000.00' }) plannedAmount: string;
  @ApiProperty({ example: '110000.00' }) spentAmount: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) bookingId: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'EVT-000123' }) bookingReference: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Salle Yasmine', description: 'Provider of the linked booking, or null ("Not booked yet").' })
  providerName: string | null;
  @ApiProperty({ example: 0 }) position: number;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppBudgetDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Our wedding' }) title: string;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-03-14' }) eventDate: string | null;
  @ApiProperty({ example: '400000.00', description: 'The plan ("of 400 000 DA planned").' }) totalAmount: string;
  @ApiProperty({ example: '380000.00', description: 'Sum of the lines’ planned amounts.' }) plannedTotal: string;
  @ApiProperty({ example: '180000.00' }) spentTotal: string;
  @ApiProperty({ example: '220000.00', description: '`totalAmount` − `spentTotal`; may be negative.' }) remaining: string;
  @ApiProperty({ example: 45 }) spentPercent: number;
  @ApiProperty({ example: 6, description: '"3 of 6 services booked" — the 6.' }) itemsCount: number;
  @ApiProperty({ example: 3, description: 'Lines linked to a booking — the 3.' }) bookedCount: number;
  @ApiProperty({ type: [AppBudgetItemDto] }) items: AppBudgetItemDto[];
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export class PutBudgetDto {
  @ApiProperty({ example: 'Our wedding', maxLength: 160 })
  @Transform(trim) @IsString() @Length(1, 160)
  title: string;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date', example: '2026-03-14' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'eventDate must be YYYY-MM-DD' })
  eventDate?: string | null;

  @ApiProperty({ example: '400000.00', description: 'DZD with 2 decimals.' })
  @Transform(trim) @Matches(/^\d{1,10}(\.\d{1,2})?$/, { message: 'totalAmount must be a positive amount with at most 2 decimals' })
  totalAmount: string;
}

export class CreateBudgetItemDto {
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional() @IsUUID('4')
  categoryId?: string | null;

  @ApiProperty({ example: 'Venue', maxLength: 160 })
  @Transform(trim) @IsString() @Length(1, 160)
  label: string;

  @ApiPropertyOptional({ example: '120000.00', default: '0.00' })
  @IsOptional() @Transform(trim) @Matches(/^\d{1,10}(\.\d{1,2})?$/, { message: 'plannedAmount must be a positive amount with at most 2 decimals' })
  plannedAmount?: string;

  @ApiPropertyOptional({ example: '110000.00', default: '0.00' })
  @IsOptional() @Transform(trim) @Matches(/^\d{1,10}(\.\d{1,2})?$/, { message: 'spentAmount must be a positive amount with at most 2 decimals' })
  spentAmount?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'One of my bookings; 404 BOOKING_NOT_FOUND when it is not.' })
  @IsOptional() @IsUUID('4')
  bookingId?: string | null;
}

export class UpdateBudgetItemDto extends CreateBudgetItemDto {
  @ApiPropertyOptional({ example: 'Venue', maxLength: 160 })
  @IsOptional() @Transform(trim) @IsString() @Length(1, 160)
  declare label: string;
}

export { trimToNull };
