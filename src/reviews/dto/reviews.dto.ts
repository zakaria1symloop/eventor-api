import { ApiProperty, ApiPropertyOptional, IntersectionType, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { toArray, toBoolean, trim } from '../../common/dto/transforms.js';
import { BookingDisputeStatus, BookingStatus } from '../../common/enums/booking.enums.js';
import { DisputeStatus, ReportReason, ReportStatus, ReportTargetType, ReviewReplyStatus, ReviewStatus } from '../../common/enums/moderation.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { PersonRefDto } from '../../users/dto/users.dto.js';
import { REVIEW_FLAGS, type ReviewFlag } from '../flag-detection.js';
import { MODERATION_ACTIONS, REVIEW_ACTIONS, REVIEW_TABS, type ModerationAction, type ReviewAction, type ReviewTab } from '../reviews.policy.js';

export const REVIEW_SORT_FIELDS = ['createdAt', 'rating'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── list ─────────────────────────────────────────────────────

export class ReviewFiltersDto {
  @ApiPropertyOptional({ enum: REVIEW_TABS, default: 'all', description: '`reported`: reviews with at least one open report (on the review), whatever their status.' })
  @IsOptional()
  @IsIn(REVIEW_TABS)
  tab?: ReviewTab;

  @ApiPropertyOptional({ type: [Number], minimum: 1, maximum: 5, description: 'Exact stars; repeat for several (`rating=1&rating=2`).' })
  @IsOptional()
  @Transform(toArray)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(5, { each: true })
  rating?: number[];

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Range lower bound (inclusive).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  ratingMin?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Range upper bound (inclusive).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  ratingMax?: number;

  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') providerId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') serviceId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') packId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'The client who wrote it.' }) @IsOptional() @IsUUID('all') authorId?: string;

  @ApiPropertyOptional({ description: 'Label "had dispute".' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hadDispute?: boolean;

  @ApiPropertyOptional({ description: '`true`: detected flags present (phone, email, link, handle, insult).' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  flagged?: boolean;

  @ApiPropertyOptional({ example: '2026-08-01', description: 'Created on or after (UTC day).' }) @IsOptional() @Matches(DATE, { message: 'createdFrom must be YYYY-MM-DD' }) createdFrom?: string;
  @ApiPropertyOptional({ example: '2026-09-16', description: 'Created on or before (UTC day).' }) @IsOptional() @Matches(DATE, { message: 'createdTo must be YYYY-MM-DD' }) createdTo?: string;

  @ApiPropertyOptional({ example: 'Lumière', maxLength: 120, description: 'Comment text, author name, provider name or business name contains.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class ReviewsQueryDto extends IntersectionType(PaginationQueryDto, ReviewFiltersDto) {}

export class ReviewTabCountsDto {
  @ApiProperty({ example: 312 }) all: number;
  @ApiProperty({ example: 290 }) published: number;
  @ApiProperty({ example: 4 }) reported: number;
  @ApiProperty({ example: 12 }) hidden: number;
  @ApiProperty({ example: 6 }) redacted: number;
}

export class ReviewProviderRefDto extends PersonRefDto {
  @ApiProperty({ type: String, nullable: true, example: 'Studio Lumière' }) businessName: string | null;
}

export class ReviewServiceRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) titleEn: string;
  @ApiProperty({ example: 'تغطية الأعراس بالصور والفيديو' }) titleAr: string;
}

export class ReviewPackRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Complete wedding pack' }) nameEn: string;
  @ApiProperty({ example: 'باقة العرس الكاملة' }) nameAr: string;
}

export class ReviewBookingRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EVT-002041' }) reference: string;
}

export class ReviewReplyRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Merci Amina, ce fut un plaisir !' }) body: string;
  @ApiProperty({ enum: ReviewReplyStatus }) status: ReviewReplyStatus;
}

export class ReviewRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 5, minimum: 1, maximum: 5 }) rating: number;
  @ApiProperty({ example: 'Photos magnifiques, équipe très professionnelle. Appelez-moi au 0661 20 41 02…', description: 'Original text, one line, 200 chars.' }) comment: string;
  @ApiProperty({ type: String, nullable: true, example: 'Photos magnifiques, équipe très professionnelle. Appelez-moi au [phone hidden]' }) redactedComment: string | null;
  @ApiProperty({ enum: ReviewStatus }) status: ReviewStatus;
  @ApiProperty({ type: PersonRefDto }) author: PersonRefDto;
  @ApiProperty({ type: ReviewProviderRefDto }) provider: ReviewProviderRefDto;
  @ApiProperty({ type: ReviewServiceRefDto, nullable: true }) service: ReviewServiceRefDto | null;
  @ApiProperty({ type: ReviewPackRefDto, nullable: true }) pack: ReviewPackRefDto | null;
  @ApiProperty({ type: ReviewBookingRefDto }) booking: ReviewBookingRefDto;
  @ApiProperty({ example: false }) hadDispute: boolean;
  @ApiProperty({ enum: REVIEW_FLAGS, isArray: true, example: ['phone'] }) detectedFlags: ReviewFlag[];
  @ApiProperty({ example: 1, description: 'Open reports on the review.' }) reportsOpen: number;
  @ApiProperty({ type: ReviewReplyRefDto, nullable: true }) reply: ReviewReplyRefDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Last edit by the author.' }) editedAt: string | null;
}

// ── detail ───────────────────────────────────────────────────

export class ReviewReportDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: [ReportTargetType.Review, ReportTargetType.ReviewReply], description: 'On the review or on its reply.' }) targetType: ReportTargetType;
  @ApiProperty({ enum: ReportReason }) reason: ReportReason;
  @ApiProperty({ type: String, nullable: true, example: 'Automatic: phone detected.' }) note: string | null;
  @ApiProperty({ enum: ReportStatus }) status: ReportStatus;
  @ApiProperty({ type: PersonRefDto, nullable: true, description: 'Null: automatic report (flag scan).' }) reporter: PersonRefDto | null;
  @ApiProperty({ type: PersonRefDto, nullable: true }) resolvedBy: PersonRefDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) resolvedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) resolutionNote: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Set when converted to a dispute.' }) disputeId: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class ReviewReplyDetailDto extends ReviewReplyRefDto {
  @ApiProperty({ type: PersonRefDto }) provider: PersonRefDto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) editedAt: string | null;
  @ApiProperty({ type: PersonRefDto, nullable: true }) moderatedBy: PersonRefDto | null;
  @ApiProperty({ example: 0 }) reportsOpen: number;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class ReviewBookingCardDto extends ReviewBookingRefDto {
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ enum: BookingDisputeStatus }) disputeStatus: BookingDisputeStatus;
  @ApiProperty({ example: '2026-08-20' }) eventDate: string;
  @ApiProperty({ example: '85000.00', description: 'DZD.' }) total: string;
}

export class ReviewDisputeRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'DSP-000031' }) reference: string;
  @ApiProperty({ enum: DisputeStatus }) status: DisputeStatus;
}

export class ReviewDetailDto extends OmitType(ReviewRowDto, ['comment', 'reply', 'booking'] as const) {
  @ApiProperty({ example: 'Photos magnifiques, équipe très professionnelle. Appelez-moi au 0661 20 41 02 pour un prix.', description: 'Full original text.' }) comment: string;
  @ApiProperty({ type: ReviewReplyDetailDto, nullable: true }) reply: ReviewReplyDetailDto | null;
  @ApiProperty({ type: ReviewBookingCardDto }) booking: ReviewBookingCardDto;
  @ApiProperty({ type: [ReviewDisputeRefDto], description: 'Disputes on the booking.' }) disputes: ReviewDisputeRefDto[];
  @ApiProperty({ type: [ReviewReportDto], description: 'Reports on the review and on its reply, newest first, every status.' }) reports: ReviewReportDto[];
  @ApiProperty({ type: PersonRefDto, nullable: true }) moderatedBy: PersonRefDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) moderatedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) moderationNote: string | null;
  @ApiProperty({ enum: REVIEW_ACTIONS, isArray: true }) allowedActions: ReviewAction[];
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

// ── actions ──────────────────────────────────────────────────

export class ModerateReviewDto {
  @ApiProperty({ enum: MODERATION_ACTIONS, example: 'redact' })
  @IsIn(MODERATION_ACTIONS)
  action: ModerationAction;

  @ApiPropertyOptional({ example: 'Photos magnifiques, équipe très professionnelle. Appelez-moi au [phone hidden] pour un prix.', maxLength: 5000, description: 'Required for `redact`: the text shown publicly.' })
  @ValidateIf((o: ModerateReviewDto) => o.action === 'redact' || o.redactedComment !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  redactedComment?: string;

  @ApiPropertyOptional({ example: 'Phone number removed, rest of the review kept.', maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ description: 'Notify the author (hide / show / redact); true when omitted. Ignored for `dismiss_reports`.' })
  @IsOptional()
  @IsBoolean()
  notifyAuthor?: boolean;
}

export class EditReviewDto {
  @ApiProperty({ example: 'Photos magnifiques, équipe très professionnelle.', maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  comment: string;

  @ApiProperty({ example: 'Author asked support to remove a family name.', maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class DeleteReviewDto {
  @ApiProperty({ example: 'Fake review written by a competitor.', maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class ReviewDeletedDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'date-time' }) deletedAt: string;
  @ApiProperty({ example: 2, description: 'Open reports resolved by the deletion.' }) reportsResolved: number;
}

export class ModerateReplyDto {
  @ApiPropertyOptional({ example: 'The reply insulted the client.', maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class ReplyDeletedDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) reviewId: string;
  @ApiProperty({ format: 'date-time' }) deletedAt: string;
}
