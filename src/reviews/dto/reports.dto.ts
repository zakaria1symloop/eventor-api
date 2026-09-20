import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { toArray, trim } from '../../common/dto/transforms.js';
import { DisputeType, ReportReason, ReportStatus, ReportTargetType } from '../../common/enums/moderation.enums.js';
import { PartyRole } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { PersonRefDto } from '../../users/dto/users.dto.js';
import { REPORT_RESOLVE_ACTIONS, REPORT_TABS, type ReportResolveAction, type ReportTab } from '../reviews.policy.js';

export const REPORT_SORT_FIELDS = ['createdAt'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ReportFiltersDto {
  @ApiPropertyOptional({ enum: REPORT_TABS, default: 'open' })
  @IsOptional()
  @IsIn(REPORT_TABS)
  tab?: ReportTab;

  @ApiPropertyOptional({ enum: ReportTargetType, isArray: true, description: 'Repeat for several.' })
  @IsOptional()
  @Transform(toArray)
  @IsEnum(ReportTargetType, { each: true })
  targetType?: ReportTargetType[];

  @ApiPropertyOptional({ enum: ReportReason, isArray: true, description: 'Repeat for several.' })
  @IsOptional()
  @Transform(toArray)
  @IsEnum(ReportReason, { each: true })
  reason?: ReportReason[];

  @ApiPropertyOptional({ example: '2026-08-01', description: 'Created on or after (UTC day).' }) @IsOptional() @Matches(DATE, { message: 'createdFrom must be YYYY-MM-DD' }) createdFrom?: string;
  @ApiPropertyOptional({ example: '2026-09-16', description: 'Created on or before (UTC day).' }) @IsOptional() @Matches(DATE, { message: 'createdTo must be YYYY-MM-DD' }) createdTo?: string;
}

export class ReportsQueryDto extends IntersectionType(PaginationQueryDto, ReportFiltersDto) {}

export class ReportTabCountsDto {
  @ApiProperty({ example: 7 }) open: number;
  @ApiProperty({ example: 31 }) resolved: number;
  @ApiProperty({ example: 12 }) dismissed: number;
  @ApiProperty({ example: 50 }) all: number;
}

export class ReportTargetDto {
  @ApiProperty({ example: '★1 · Amina Benali on Studio Lumière', description: 'Short human label; "Deleted <type>" when the target is gone.' }) label: string;
  @ApiProperty({ type: String, nullable: true, example: '/reviews/7c4a3e1b-1d2f-4a5b-9c8d-0e1f2a3b4c5d', description: 'Dashboard route to open (REV-02, MSG-01, SRV-04, PCK-02, USR-10/11).' }) href: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'review / review_reply: the review.' }) reviewId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'message: its conversation.' }) conversationId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Booking linked to the target (review, or the conversation of a message): convertible to a dispute.' }) bookingId: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'EVT-002041' }) bookingReference: string | null;
  @ApiProperty({ example: true, description: 'The target still exists (not soft-deleted).' }) exists: boolean;
}

export class ReportRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ReportTargetType }) targetType: ReportTargetType;
  @ApiProperty({ format: 'uuid' }) targetId: string;
  @ApiProperty({ type: ReportTargetDto }) target: ReportTargetDto;
  @ApiProperty({ enum: ReportReason }) reason: ReportReason;
  @ApiProperty({ type: String, nullable: true, example: 'He gave me his WhatsApp to pay outside the app.' }) note: string | null;
  @ApiProperty({ type: PersonRefDto, nullable: true, description: 'Null: automatic report (flag scan on a review or reply).' }) reporter: PersonRefDto | null;
  @ApiProperty({ enum: ReportStatus }) status: ReportStatus;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ type: PersonRefDto, nullable: true }) resolvedBy: PersonRefDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) resolvedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) resolutionNote: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) disputeId: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'DSP-000032' }) disputeReference: string | null;
}

export class ResolveReportDto {
  @ApiProperty({ example: 'Review redacted: phone number removed.', maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note: string;

  @ApiPropertyOptional({ enum: REPORT_RESOLVE_ACTIONS, description: 'What the admin did about the target (recorded in the audit log and shown to the reporter as resolved).' })
  @IsOptional()
  @IsIn(REPORT_RESOLVE_ACTIONS)
  action?: ReportResolveAction;
}

export class DismissReportDto {
  @ApiProperty({ example: 'The review is an honest opinion; nothing to remove.', maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note: string;
}

export class ConvertReportDto {
  @ApiProperty({ enum: DisputeType, example: 'service_not_as_described' })
  @IsEnum(DisputeType)
  type: DisputeType;

  @ApiProperty({ example: 'The client reports the photos were never delivered, as written in the review.', minLength: 30, maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @MinLength(30)
  @MaxLength(5000)
  description: string;

  @ApiProperty({ enum: [PartyRole.Client, PartyRole.Provider], description: 'The party the dispute is opened for.' })
  @IsIn([PartyRole.Client, PartyRole.Provider])
  openedByRole: PartyRole.Client | PartyRole.Provider;
}

export class MessageReportsDismissedDto {
  @ApiProperty({ format: 'uuid' }) messageId: string;
  @ApiProperty({ example: 2, description: 'Open reports dismissed.' }) dismissed: number;
}
