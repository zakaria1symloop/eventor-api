import { ApiHideProperty, ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { normaliseEmail } from '../../auth/dto/admin-auth.dto.js';
import { toArray, trim, trimToNull } from '../../common/dto/transforms.js';
import { BookingStatus } from '../../common/enums/booking.enums.js';
import { DocumentStatus, DocumentType } from '../../common/enums/file.enums.js';
import { ReviewStatus } from '../../common/enums/moderation.enums.js';
import { ServiceStatus } from '../../common/enums/catalog.enums.js';
import { Language, UserRole, UserStatus, VerificationStatus } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { PHONE_PATTERN, toPhone } from '../users.policy.js';

export const USER_TABS = ['all', 'clients', 'providers', 'blocked', 'awaiting_verification'] as const;
export type UserTab = (typeof USER_TABS)[number];
export const USER_SORT_FIELDS = ['createdAt', 'fullName', 'lastActiveAt', 'bookingsCount', 'rating'] as const;
export const LAST_ACTIVE_OPTIONS = ['7d', '30d', '90d', 'never'] as const;
export type LastActive = (typeof LAST_ACTIVE_OPTIONS)[number];
export const MANAGED_ROLES = [UserRole.Client, UserRole.Provider] as const;
export type ManagedRole = (typeof MANAGED_ROLES)[number];

const toNumber = ({ value }: { value: unknown }) => (value === '' || value === undefined ? undefined : Number(value));
const toIntArray = ({ value }: { value: unknown }) => {
  const list = toArray({ value });
  return Array.isArray(list) ? list.map((v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v)) : list;
};
const PHONE_MESSAGE = 'phone must be an Algerian number: 0XXXXXXXXX or +213XXXXXXXXX';

// ── shared response pieces ───────────────────────────────────

export class WilayaRefDto {
  @ApiProperty({ example: 16 })
  code: number;

  @ApiProperty({ example: 'Alger' })
  name: string;

  @ApiProperty({ example: 'الجزائر' })
  nameAr: string;
}

export class CategoryRefDto {
  @ApiProperty({ format: 'uuid', example: '7c4a1f0e-2b6d-4e8a-9c3f-1d2e3f4a5b6c' })
  id: string;

  @ApiProperty({ example: 'Photography' })
  nameEn: string;

  @ApiProperty({ example: 'التصوير' })
  nameAr: string;
}

export class PersonRefDto {
  @ApiProperty({ format: 'uuid', example: '3f1c9a2e-8b7d-4c6a-9e5f-2a1b3c4d5e6f' })
  id: string;

  @ApiProperty({ example: 'Sara Meziane' })
  fullName: string;
}

// ── list ─────────────────────────────────────────────────────

export class UserFiltersDto {
  @ApiPropertyOptional({ enum: USER_TABS, default: 'all', description: '`awaiting_verification` = providers whose verification is pending.' })
  @IsOptional()
  @IsIn(USER_TABS)
  tab?: UserTab;

  @ApiPropertyOptional({ example: 'Karim', maxLength: 120, description: 'Full-text search in name and email, plus exact email or phone (any accepted phone format).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ enum: MANAGED_ROLES })
  @IsOptional()
  @IsIn(MANAGED_ROLES)
  role?: ManagedRole;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ enum: VerificationStatus })
  @IsOptional()
  @IsEnum(VerificationStatus)
  verificationStatus?: VerificationStatus;

  @ApiPropertyOptional({ type: [Number], example: [16, 31], description: 'Wilaya codes; repeat for several.' })
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(58, { each: true })
  wilaya?: number[];

  @ApiPropertyOptional({ format: 'uuid', description: "Provider's main category." })
  @IsOptional()
  @IsUUID('all')
  categoryId?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 5, example: 4, description: 'Providers only (average rating ≥).' })
  @IsOptional()
  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  @Max(5)
  minRating?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 5, example: 5, description: 'Providers only (average rating ≤).' })
  @IsOptional()
  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  @Max(5)
  maxRating?: number;

  @ApiPropertyOptional({ format: 'date', example: '2026-01-01', description: 'Joined on or after (UTC day).' })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  joinedFrom?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-09-16', description: 'Joined on or before (UTC day, inclusive).' })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  joinedTo?: string;

  @ApiPropertyOptional({ minimum: 0, example: 1, description: 'Completed bookings ≥ (as client or as provider).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minCompletedBookings?: number;

  @ApiPropertyOptional({ minimum: 0, example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxCompletedBookings?: number;

  @ApiPropertyOptional({ enum: LAST_ACTIVE_OPTIONS, description: 'Active within the last 7/30/90 days, or never active.' })
  @IsOptional()
  @IsIn(LAST_ACTIVE_OPTIONS)
  lastActive?: LastActive;

  @ApiPropertyOptional({ enum: Language })
  @IsOptional()
  @IsEnum(Language)
  language?: Language;
}

export class UsersQueryDto extends IntersectionType(PaginationQueryDto, UserFiltersDto) {}

export class UserTabCountsDto {
  @ApiProperty({ example: 2847 })
  all: number;

  @ApiProperty({ example: 2210 })
  clients: number;

  @ApiProperty({ example: 637 })
  providers: number;

  @ApiProperty({ example: 14 })
  blocked: number;

  @ApiProperty({ example: 23 })
  awaiting_verification: number;
}

export class UserRowDto {
  @ApiProperty({ format: 'uuid', example: '3f1c9a2e-8b7d-4c6a-9e5f-2a1b3c4d5e6f' })
  id: string;

  @ApiProperty({ enum: MANAGED_ROLES, example: UserRole.Provider })
  role: UserRole;

  @ApiProperty({ example: 'Karim Belkacem' })
  fullName: string;

  @ApiProperty({ example: 'karim.belkacem@gmail.com' })
  email: string;

  @ApiProperty({ type: String, nullable: true, example: '+213550123456' })
  phone: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Signed, expiring URL (thumb variant).' })
  avatarUrl: string | null;

  @ApiProperty({ enum: UserStatus, example: UserStatus.Active })
  status: UserStatus;

  @ApiProperty({ enum: VerificationStatus, example: VerificationStatus.Verified })
  verificationStatus: VerificationStatus;

  @ApiProperty({ type: WilayaRefDto, nullable: true })
  wilaya: WilayaRefDto | null;

  @ApiProperty({ type: String, nullable: true, example: 'Studio Lumière', description: 'Providers only.' })
  businessName: string | null;

  @ApiProperty({ type: CategoryRefDto, nullable: true, description: 'Providers only.' })
  category: CategoryRefDto | null;

  @ApiProperty({ type: Number, nullable: true, example: 4.8, description: 'Providers only.' })
  rating: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 126, description: 'Providers only.' })
  ratingCount: number | null;

  @ApiProperty({ example: 142, description: 'Bookings of any status, as client or as provider.' })
  bookingsCount: number;

  @ApiProperty({ type: Number, nullable: true, example: 12, description: 'Services (not deleted); null for clients.' })
  servicesCount: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-09-15T10:00:00.000Z' })
  lastActiveAt: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-03-02T09:00:00.000Z' })
  createdAt: string;
}

// ── create / update ──────────────────────────────────────────

export class CreateUserDto {
  @ApiProperty({ enum: MANAGED_ROLES, example: UserRole.Provider, description: 'Immutable afterwards. Admins are invited from SET-05.' })
  @IsIn(MANAGED_ROLES)
  role: ManagedRole;

  @ApiProperty({ example: 'Karim Belkacem', minLength: 2, maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName: string;

  @ApiProperty({ format: 'email', example: 'karim.belkacem@gmail.com', maxLength: 190 })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email: string;

  @ApiProperty({ example: '0550123456', description: '`0XXXXXXXXX` or `+213XXXXXXXXX`; stored as `+213XXXXXXXXX`.' })
  @Transform(toPhone)
  @IsString()
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone: string;

  @ApiProperty({ enum: Language, example: Language.Ar })
  @IsEnum(Language)
  language: Language;

  @ApiPropertyOptional({ example: 16, minimum: 1, maximum: 58 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(58)
  wilayaCode?: number;

  @ApiPropertyOptional({ example: 'Studio Lumière', maxLength: 150, description: 'Required for providers.' })
  @ValidateIf((o: CreateUserDto) => o.role === UserRole.Provider || o.businessName !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  businessName?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required for providers.' })
  @ValidateIf((o: CreateUserDto) => o.role === UserRole.Provider || o.categoryId !== undefined)
  @IsUUID('all')
  categoryId?: string;

  @ApiPropertyOptional({ type: [Number], example: [16, 9], description: "Provider's default area." })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(58)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(58, { each: true })
  wilayaCodes?: number[];

  @ApiPropertyOptional({ example: false, description: 'Providers: mark as verified without documents.' })
  @IsOptional()
  @IsBoolean()
  skipVerification?: boolean;
}

export class UpdateUserDto {
  /** Present only to answer 400 ROLE_IMMUTABLE instead of a generic unknown-field error. */
  @ApiHideProperty()
  @Allow()
  role?: unknown;

  @ApiPropertyOptional({ example: 'Karim Belkacem', minLength: 2, maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({ format: 'email', example: 'karim.b@gmail.com', description: 'Changing it requires `reason`.' })
  @IsOptional()
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '0661234567', description: 'Changing it requires `reason`; null removes it.' })
  @IsOptional()
  @Transform(toPhone)
  @ValidateIf((o: UpdateUserDto) => o.phone !== null)
  @IsString()
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'The user asked by phone to change their email.', maxLength: 500 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  reason?: string | null;

  @ApiPropertyOptional({ enum: Language })
  @IsOptional()
  @IsEnum(Language)
  language?: Language;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 31 })
  @IsOptional()
  @ValidateIf((o: UpdateUserDto) => o.wilayaCode !== null)
  @IsInt()
  @Min(1)
  @Max(58)
  wilayaCode?: number | null;

  @ApiPropertyOptional({ example: 'Studio Lumière', description: 'Providers only.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  businessName?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Providers only.' })
  @IsOptional()
  @IsUUID('all')
  categoryId?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000, description: 'Providers only.' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(5000)
  bioEn?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000, description: 'Providers only.' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(5000)
  bioAr?: string | null;

  @ApiPropertyOptional({ type: [Number], example: [31, 46], description: 'Providers only; replaces the list.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(58)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(58, { each: true })
  wilayaCodes?: number[];

  @ApiPropertyOptional({ example: true, description: 'Providers only.' })
  @IsOptional()
  @IsBoolean()
  acceptingBookings?: boolean;

  @ApiPropertyOptional({ type: [String], nullable: true, example: ['ar', 'fr'], description: 'Providers only (ISO 639-1 codes).' })
  @IsOptional()
  @ValidateIf((o: UpdateUserDto) => o.languagesSpoken !== null)
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @Matches(/^[a-z]{2}$/, { each: true })
  languagesSpoken?: string[] | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 8, minimum: 0, maximum: 80, description: 'Providers only.' })
  @IsOptional()
  @ValidateIf((o: UpdateUserDto) => o.yearsActive !== null)
  @IsInt()
  @Min(0)
  @Max(80)
  yearsActive?: number | null;
}

// ── account actions ──────────────────────────────────────────

export class BlockUserDto {
  @ApiProperty({ example: 'fraud', maxLength: 60, description: 'Reason code or short label shown in the banner.' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  reason: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, example: '2026-10-16T00:00:00.000Z', description: 'Automatic unblock time (future); omit for indefinite.' })
  @IsOptional()
  @ValidateIf((o: BlockUserDto) => o.until !== null)
  @IsISO8601({ strict: true })
  until?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, example: 'Your account was blocked after several reports.' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  message?: string | null;

  @ApiProperty({ enum: ['cancel', 'keep'], example: 'cancel', description: 'What happens to pending bookings.' })
  @IsIn(['cancel', 'keep'])
  bookings: 'cancel' | 'keep';
}

export class DeleteUserDto {
  @ApiProperty({ example: 'Karim Belkacem', description: "The account's full name, typed to confirm (case-insensitive)." })
  @IsString()
  @MaxLength(120)
  typedName: string;
}

export class PasswordResetDto {
  @ApiProperty({ enum: ['link', 'temporary'], example: 'link' })
  @IsIn(['link', 'temporary'])
  mode: 'link' | 'temporary';

  @ApiPropertyOptional({ example: true, description: 'Default `false`.' })
  @IsOptional()
  @IsBoolean()
  signOutEverywhere?: boolean;
}

export const BULK_ACTIONS = ['block', 'unblock', 'delete'] as const;

export class BulkUsersDto {
  @ApiProperty({ enum: BULK_ACTIONS, example: 'block' })
  @IsIn(BULK_ACTIONS)
  action: (typeof BULK_ACTIONS)[number];

  @ApiProperty({ type: [String], format: 'uuid', example: ['3f1c9a2e-8b7d-4c6a-9e5f-2a1b3c4d5e6f'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids: string[];

  @ApiPropertyOptional({ example: 'spam', maxLength: 60, description: 'Required for block.' })
  @ValidateIf((o: BulkUsersDto) => o.action === 'block' || o.reason !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  reason?: string;

  @ApiPropertyOptional({ enum: ['cancel', 'keep'], description: 'Required for block.' })
  @ValidateIf((o: BulkUsersDto) => o.action === 'block' || o.bookings !== undefined)
  @IsIn(['cancel', 'keep'])
  bookings?: 'cancel' | 'keep';

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, description: 'Block message.' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  message?: string | null;
}

export class BlockImpactDto {
  @ApiProperty({ example: 12, description: 'Published services hidden while blocked (providers).' })
  servicesCount: number;

  @ApiProperty({ example: 2, description: 'Published packs hidden while blocked (providers).' })
  packsCount: number;

  @ApiProperty({ example: 3 })
  pendingBookings: number;

  @ApiProperty({ example: 5, description: 'Accepted bookings from today (kept).' })
  upcomingBookings: number;

  @ApiProperty({ example: 8, description: 'Open conversations that become read-only for the user.' })
  conversations: number;
}

export class BlockResultDto {
  @ApiProperty({ type: UserRowDto })
  user: UserRowDto;

  @ApiProperty({ type: BlockImpactDto })
  impact: BlockImpactDto;

  @ApiProperty({ example: 3 })
  cancelledBookings: number;

  @ApiProperty({ example: 2 })
  sessionsRevoked: number;
}

export class PasswordResetResultDto {
  @ApiProperty({ enum: ['link', 'temporary'] })
  mode: 'link' | 'temporary';

  @ApiProperty({ type: String, nullable: true, example: 'k7Qm2xPa9RtB4n', description: 'Only for `temporary`; shown once, never stored in clear.' })
  temporaryPassword: string | null;

  @ApiProperty({ example: 2 })
  sessionsRevoked: number;
}

export class SessionsRevokedDto {
  @ApiProperty({ example: 3 })
  sessionsRevoked: number;
}

export class BulkItemResultDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ok', enum: ['ok'] })
  result: 'ok';

  @ApiProperty({ example: 1 })
  cancelledBookings: number;

  @ApiProperty({ example: 1 })
  sessionsRevoked: number;
}

export class BulkRefusalDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'USER_ALREADY_BLOCKED' })
  code: string;
}

// ── avatar ───────────────────────────────────────────────────

export class RemoveAvatarDto {
  @ApiPropertyOptional({ example: 'Photo did not show the person.', maxLength: 300, description: 'Kept in the activity log.' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(300)
  note?: string | null;
}

// ── notes ────────────────────────────────────────────────────

export class CreateNoteDto {
  @ApiProperty({ example: 'Called about a late cancellation; will monitor.', maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;
}

export class NoteDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Called about a late cancellation; will monitor.' })
  body: string;

  @ApiProperty({ type: PersonRefDto })
  author: PersonRefDto;

  @ApiProperty({ example: true, description: 'Only the author can delete a note.' })
  canDelete: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

// ── profile ──────────────────────────────────────────────────

export class BookingStatsDto {
  @ApiProperty({ example: 142 }) total: number;
  @ApiProperty({ example: 3 }) pending: number;
  @ApiProperty({ example: 5, description: 'Accepted, event date from today.' }) upcoming: number;
  @ApiProperty({ example: 128 }) completed: number;
  @ApiProperty({ example: 6 }) cancelled: number;
}

export class ServiceStatsDto {
  @ApiProperty({ example: 12 }) total: number;
  @ApiProperty({ example: 10 }) published: number;
  @ApiProperty({ example: 1 }) hidden: number;
}

export class PackStatsDto {
  @ApiProperty({ example: 3 }) total: number;
  @ApiProperty({ example: 2 }) published: number;
}

export class ReviewStatsDto {
  @ApiProperty({ type: Number, nullable: true, example: 4.8 }) avg: number | null;
  @ApiProperty({ example: 126, description: 'Received (providers) or written (clients).' }) count: number;
  @ApiProperty({ example: 1, description: 'Open reports on those reviews.' }) reported: number;
}

export class DisputeStatsDto {
  @ApiProperty({ example: 0, description: 'Open or in review.' }) open: number;
  @ApiProperty({ example: 2 }) total: number;
}

export class UserStatsDto {
  @ApiProperty({ type: BookingStatsDto }) bookings: BookingStatsDto;
  @ApiProperty({ type: ServiceStatsDto, nullable: true, description: 'Providers only.' }) services: ServiceStatsDto | null;
  @ApiProperty({ type: PackStatsDto, nullable: true, description: 'Providers only.' }) packs: PackStatsDto | null;
  @ApiProperty({ type: ReviewStatsDto }) reviews: ReviewStatsDto;
  @ApiProperty({ type: DisputeStatsDto }) disputes: DisputeStatsDto;
  @ApiProperty({ example: '3840000.00', description: 'DZD. Sum of completed booking totals (earned by a provider, spent by a client).' }) earnings: string;
  @ApiProperty({ type: Number, nullable: true, example: 96, description: 'Providers only, percent.' }) replyRate: number | null;
}

export class ProviderProfileDto {
  @ApiProperty({ example: 'Studio Lumière' }) businessName: string;
  @ApiProperty({ type: CategoryRefDto, nullable: true }) category: CategoryRefDto | null;
  @ApiProperty({ type: String, nullable: true }) bioEn: string | null;
  @ApiProperty({ type: String, nullable: true }) bioAr: string | null;
  @ApiProperty({ type: [String], nullable: true, example: ['ar', 'fr'] }) languagesSpoken: string[] | null;
  @ApiProperty({ type: Number, nullable: true, example: 8 }) yearsActive: number | null;
  @ApiProperty({ example: true }) acceptingBookings: boolean;
  @ApiProperty({ example: 4.8 }) avgRating: number;
  @ApiProperty({ example: 126 }) ratingCount: number;
  @ApiProperty({ example: 128 }) completedBookingsCount: number;
  @ApiProperty({ type: Number, nullable: true, example: 96 }) replyRate: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 35 }) avgReplyMinutes: number | null;
  @ApiProperty({ type: [WilayaRefDto] }) wilayas: WilayaRefDto[];
}

export class DocumentSummaryItemDto {
  @ApiProperty({ enum: DocumentType }) type: DocumentType;
  @ApiProperty({ enum: [...Object.values(DocumentStatus), 'missing'], example: 'approved' }) status: DocumentStatus | 'missing';
}

export class DocumentProgressDto {
  @ApiProperty({ example: 2 }) approved: number;
  @ApiProperty({ example: 0 }) rejected: number;
  @ApiProperty({ example: 1 }) waiting: number;
  @ApiProperty({ example: 0 }) missing: number;
}

export class DocumentsSummaryDto {
  @ApiProperty({ enum: VerificationStatus }) verificationStatus: VerificationStatus;
  @ApiProperty({ type: [DocumentSummaryItemDto] }) items: DocumentSummaryItemDto[];
  @ApiProperty({ type: DocumentProgressDto }) progress: DocumentProgressDto;
}

export class BlockInfoDto {
  @ApiProperty({ format: 'date-time' }) blockedAt: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) until: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'fraud' }) reason: string | null;
  @ApiProperty({ type: String, nullable: true }) message: string | null;
  @ApiProperty({ type: PersonRefDto, nullable: true }) blockedBy: PersonRefDto | null;
}

export class RecentBookingDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EVT-000123' }) reference: string;
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ format: 'date', example: '2026-10-12' }) eventDate: string;
  @ApiProperty({ example: '45000.00', description: 'DZD' }) total: string;
  @ApiProperty({ type: String, nullable: true, example: 'Wedding photography' }) title: string | null;
  @ApiProperty({ type: PersonRefDto, description: 'The other party.' }) counterpart: PersonRefDto;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class RecentServiceDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Wedding photography' }) titleEn: string;
  @ApiProperty({ example: 'تصوير الأعراس' }) titleAr: string;
  @ApiProperty({ enum: ServiceStatus }) status: ServiceStatus;
  @ApiProperty({ example: '45000.00', description: 'DZD' }) basePrice: string;
  @ApiProperty({ example: 4.9 }) avgRating: number;
  @ApiProperty({ example: 42 }) bookingsCount: number;
}

export class RecentReviewDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 5 }) rating: number;
  @ApiProperty({ example: 'Great photos, very professional.' }) comment: string;
  @ApiProperty({ enum: ReviewStatus }) status: ReviewStatus;
  @ApiProperty({ type: PersonRefDto }) author: PersonRefDto;
  @ApiProperty({ type: PersonRefDto }) provider: PersonRefDto;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class UserRecentDto {
  @ApiProperty({ type: [RecentBookingDto] }) bookings: RecentBookingDto[];
  @ApiProperty({ type: [RecentServiceDto] }) services: RecentServiceDto[];
  @ApiProperty({ type: [RecentReviewDto] }) reviews: RecentReviewDto[];
  @ApiProperty({ type: [NoteDto] }) notes: NoteDto[];
}

export class UserDetailDto extends UserRowDto {
  @ApiProperty({ enum: Language }) language: Language;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) emailVerifiedAt: string | null;
  @ApiProperty({ type: BlockInfoDto, nullable: true }) block: BlockInfoDto | null;
  @ApiProperty({ type: ProviderProfileDto, nullable: true }) provider: ProviderProfileDto | null;
  @ApiProperty({ type: DocumentsSummaryDto, nullable: true, description: 'Providers only.' }) documents: DocumentsSummaryDto | null;
  @ApiProperty({ type: UserStatsDto }) stats: UserStatsDto;
  @ApiProperty({ type: UserRecentDto }) recent: UserRecentDto;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}
