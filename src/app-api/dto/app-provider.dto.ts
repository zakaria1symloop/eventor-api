import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { trim, trimToNull } from '../../common/dto/transforms.js';
import { ServiceStatus } from '../../common/enums/catalog.enums.js';
import { VerificationStatus } from '../../common/enums/user.enums.js';
import { CreatePackDto, UpdatePackDto } from '../../packs/dto/packs.dto.js';
import { CreateServiceDto, UpdateServiceDto } from '../../services/dto/services.dto.js';
import { VERIFICATION_STEPS, type ProviderHomeState, type VerificationStep } from '../app-provider.policy.js';
import { AppBookingCardDto } from './app-bookings.dto.js';
import { AppDocumentsDto, AppWilayaRefDto } from './app-me.dto.js';

export { AppBookingCardDto, AppDocumentsDto, AppWilayaRefDto };

/**
 * The provider's own service form. Exactly the admin DTO minus the two fields
 * only an admin may set: `providerId` (a provider owns their services and
 * cannot move one) and `status` (publishing is the `/publish` action, so the
 * checklist runs and the event fires).
 */
export class AppCreateServiceDto extends OmitType(CreateServiceDto, ['providerId', 'status'] as const) {}
export class AppUpdateServiceDto extends OmitType(UpdateServiceDto, ['providerId', 'status'] as const) {}

/** The provider's own pack form; `providerId` is always the caller. */
export class AppCreatePackDto extends OmitType(CreatePackDto, ['providerId'] as const) {}
export class AppUpdatePackDto extends OmitType(UpdatePackDto, ['providerId'] as const) {}

export class AppPhotoOrderDto {
  @ApiProperty({ type: [String], format: 'uuid', description: 'Every photo id of the service or pack, in the new order.' })
  @IsArray()
  @ArrayMaxSize(24)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids: string[];
}

export class AppAvailabilityMonthQueryDto {
  @ApiProperty({ example: '2026-11', description: '`YYYY-MM`; one month per call.' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month: string;
}

export class AppCreateBlockDto {
  @ApiProperty({ example: '2026-11-21', description: '`YYYY-MM-DD`, today or later.' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiPropertyOptional({ example: '14:00', description: 'Send `startTime` and `endTime` together, or neither for the whole day.' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'startTime must be HH:mm' })
  startTime?: string;

  @ApiPropertyOptional({ example: '18:00' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Block one of your services only; omit to block every service that day.' })
  @IsOptional()
  @IsUUID('all')
  serviceId?: string;

  @ApiPropertyOptional({ example: 'Family wedding', maxLength: 255 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Length(1, 255)
  note?: string;
}

/** Screen 21 header and the Profile tab of a provider. */
export class AppUpdateProviderProfileDto {
  @ApiPropertyOptional({ example: 'Studio Lumière', maxLength: 150 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 150)
  businessName?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Must be a visible category.' })
  @IsOptional()
  @IsUUID('all')
  categoryId?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Length(1, 5000)
  bioEn?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Length(1, 5000)
  bioAr?: string | null;

  @ApiPropertyOptional({ type: [Number], example: [16, 9], description: 'Replaces the set; every added wilaya must be open.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(58)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(58, { each: true })
  wilayaCodes?: number[];

  @ApiPropertyOptional({ type: [String], example: ['ar', 'fr', 'en'], description: 'Replaces the list ("العربية والفرنسية والإنجليزية" on screen 13).' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsString({ each: true })
  languagesSpoken?: string[];

  @ApiPropertyOptional({ type: Number, nullable: true, example: 8, minimum: 0, maximum: 80 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(80)
  yearsActive?: number | null;

  @ApiPropertyOptional({ example: true, description: 'The "Available for bookings" toggle on screen 21. Off keeps services visible and refuses new bookings.' })
  @IsOptional()
  @IsBoolean()
  acceptingBookings?: boolean;
}

export class AppReviewReplyDto {
  @ApiProperty({ example: 'Thank you Yasmine, it was a pleasure!', maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(2, 2000)
  body: string;
}

// ── responses ───────────────────────────────────────────────────

export class AppVerificationStepDto {
  @ApiProperty({ enum: VERIFICATION_STEPS }) key: VerificationStep;
  @ApiProperty({ example: true }) done: boolean;
  @ApiProperty({ example: false, description: 'The step the spinner sits on; at most one is `current`.' }) current: boolean;
}

export class AppProviderServiceRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) title: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) titleEn: string;
  @ApiProperty({ example: 'تغطية تصوير الأعراس' }) titleAr: string;
  @ApiProperty({ enum: ServiceStatus }) status: ServiceStatus;
  @ApiProperty({ example: true, description: 'Visible in the app right now (published, provider verified, an open wilaya).' }) visibleInApp: boolean;
  @ApiProperty({ example: '45000.00' }) basePrice: string;
  @ApiProperty({ example: '4.80' }) avgRating: string;
  @ApiProperty({ example: 32 }) ratingCount: number;
  @ApiProperty({ example: 12 }) bookingsCount: number;
  @ApiProperty({ example: 3 }) photosCount: number;
  @ApiProperty({ type: String, nullable: true }) coverUrl: string | null;
  @ApiProperty({ type: [AppWilayaRefDto] }) wilayas: AppWilayaRefDto[];
}

export class AppProviderCountsDto {
  @ApiProperty({ example: 3, description: 'Pending booking requests.' }) requests: number;
  @ApiProperty({ example: 5, description: 'Accepted bookings from today on.' }) upcoming: number;
  @ApiProperty({ example: 7, description: 'Services that are not deleted.' }) services: number;
  @ApiProperty({ example: 2 }) unreadMessages: number;
  @ApiProperty({ example: 4 }) unreadNotifications: number;
}

/** Screens 21 Home · Provider and 21a Home · Provider · Pending, in one call. */
export class AppProviderHomeDto {
  @ApiProperty({ enum: ['verified', 'pending', 'rejected', 'blocked'], description: '`verified` draws screen 21; anything else draws 21a.' })
  state: ProviderHomeState;

  @ApiProperty({ example: 'Studio Lumière' }) businessName: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
  @ApiProperty({ enum: VerificationStatus }) verificationStatus: VerificationStatus;

  @ApiProperty({ type: [AppVerificationStepDto], description: 'The "Profile under review" steps on screen 21a.' })
  verificationSteps: AppVerificationStepDto[];

  @ApiProperty({ type: AppDocumentsDto, nullable: true, description: 'Only while the account is not verified — the same payload as `GET /app/me/documents`.' })
  documents: AppDocumentsDto | null;

  @ApiProperty({ example: true, description: 'The "Available for bookings" toggle.' }) acceptingBookings: boolean;
  @ApiProperty({ example: '4.80' }) avgRating: string;
  @ApiProperty({ example: 32 }) ratingCount: number;
  @ApiProperty({ example: 48 }) completedBookingsCount: number;

  @ApiProperty({ type: AppProviderCountsDto }) counts: AppProviderCountsDto;
  @ApiProperty({ type: [AppBookingCardDto], description: 'The pending requests, newest first, with Accept / Decline in `allowedActions`. Empty while pending verification.' })
  requests: AppBookingCardDto[];
  @ApiProperty({ type: [AppBookingCardDto], description: 'The next accepted bookings.' }) upcoming: AppBookingCardDto[];
  @ApiProperty({ type: [AppProviderServiceRowDto], description: '"Your services", with the availability each one has.' }) services: AppProviderServiceRowDto[];
}

export class AppProviderReviewDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 5 }) rating: number;
  @ApiProperty({ example: 'Wonderful team.', description: 'The redacted text when an admin redacted it.' }) comment: string;
  @ApiProperty({ example: 'Yasmine K.', description: 'Never a full name (mobile-api §7).' }) authorName: string;
  @ApiProperty({ type: String, nullable: true }) authorAvatarUrl: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) serviceId: string | null;
  @ApiProperty({ type: String, nullable: true }) serviceTitle: string | null;
  @ApiProperty({ example: 'EVT-000123' }) bookingReference: string;
  @ApiProperty({ example: false, description: 'A label on the review (status-rules §6).' }) hadDispute: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) replyId: string | null;
  @ApiProperty({ type: String, nullable: true }) reply: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) repliedAt: string | null;
  @ApiProperty({ example: true, description: 'The reply can still be edited or deleted (48 h, status-rules §8).' }) replyEditable: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}
