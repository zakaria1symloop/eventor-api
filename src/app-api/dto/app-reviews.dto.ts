import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { trim, trimToNull } from '../../common/dto/transforms.js';
import { MESSAGE_MAX_LENGTH } from '../../common/enums/messaging.enums.js';
import { DisputeStatus, DisputeType, ReviewStatus } from '../../common/enums/moderation.enums.js';
import { PartyRole } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';

export class AppCreateReviewDto {
  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiProperty({
    example: 'Wonderful team, the photos arrived in two weeks.',
    minLength: 10,
    maxLength: 2000,
    description: 'Scanned for phone numbers, emails, links and insults; a flagged comment is still published and opens an automatic report (status-rules §8).',
  })
  @Transform(trim)
  @IsString()
  @Length(10, 2000)
  comment: string;
}

export class AppEditReviewDto {
  @ApiPropertyOptional({ example: 4, minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ example: 'Updated: the album arrived after all.', minLength: 10, maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(10, 2000)
  comment?: string;
}

export class AppOpenDisputeDto {
  @ApiProperty({ enum: DisputeType, example: DisputeType.ProviderNoShow })
  @IsEnum(DisputeType)
  type: DisputeType;

  @ApiProperty({ example: 'The photographer never came to the wedding and did not answer our calls that evening.', minLength: 30, maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @Length(30, 5000)
  description: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Files you already uploaded (evidence or chat images), at most `max_dispute_evidence_files`.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  evidenceFileIds?: string[];
}

export class AppDisputeMessageDto {
  @ApiProperty({ example: 'Here is the call log from that evening.', maxLength: MESSAGE_MAX_LENGTH, description: 'The limit is `limits.messageMaxLength` from `GET /app/config`.' })
  @Transform(trim)
  @IsString()
  @Length(1, MESSAGE_MAX_LENGTH)
  @MaxLength(MESSAGE_MAX_LENGTH)
  body: string;
}

export class AppDisputeEvidenceDto {
  @ApiPropertyOptional({ example: 'Call log screenshot.', maxLength: 500 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class AppWithdrawDisputeDto {
  @ApiProperty({ example: 'We settled it directly with the provider.', maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(3, 2000)
  note: string;
}

export class AppDisputesQueryDto extends PaginationQueryDto {}

export class AppMyReviewsQueryDto extends PaginationQueryDto {}

// ── responses ───────────────────────────────────────────────────

export class AppMyReviewDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) bookingId: string;
  @ApiProperty({ example: 'EVT-000123' }) bookingReference: string;
  @ApiProperty({ example: 5 }) rating: number;
  @ApiProperty({ example: 'Wonderful team.' }) comment: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) serviceId: string | null;
  @ApiProperty({ type: String, nullable: true }) serviceTitle: string | null;
  @ApiProperty({ example: 'Studio Lumière' }) providerName: string;
  @ApiProperty({ enum: ReviewStatus, example: ReviewStatus.Published, description: 'A review an admin hid or redacted keeps its row and says so here.' }) status: ReviewStatus;
  @ApiProperty({ type: String, nullable: true, example: 'Thank you Yasmine!' }) reply: string | null;
  @ApiProperty({ example: true, description: 'Still inside the 48-hour edit window (status-rules §8).' }) editable: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppDisputeRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'DSP-000012' }) reference: string;
  @ApiProperty({ enum: DisputeStatus }) status: DisputeStatus;
  @ApiProperty({ enum: DisputeType }) type: DisputeType;
  @ApiProperty({ format: 'uuid' }) bookingId: string;
  @ApiProperty({ example: 'EVT-000123' }) bookingReference: string;
  @ApiProperty({ example: '2026-11-14' }) eventDate: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) title: string;
  @ApiProperty({ enum: [PartyRole.Client, PartyRole.Provider] }) openedByRole: PartyRole;
  @ApiProperty({ example: true, description: 'You opened it, so you may withdraw it while it is open.' }) openedByMe: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The dispute chat: client + provider + Eventor.' }) conversationId: string | null;
  @ApiProperty({ example: 2 }) evidenceCount: number;
  @ApiProperty({ type: String, nullable: true, description: 'The admin’s decision note once the dispute is resolved or closed.' }) decisionNote: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppDisputeEvidenceRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'file', enum: ['file', 'chat_snapshot', 'note'] }) kind: string;
  @ApiProperty({ type: String, nullable: true, description: 'Signed URL; evidence is private to the parties and admins.' }) url: string | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ example: true, description: 'You uploaded it.' }) mine: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppDisputeDetailDto extends AppDisputeRowDto {
  @ApiProperty({ example: 'The photographer never came…' }) description: string;
  @ApiProperty({ type: [AppDisputeEvidenceRowDto] }) evidence: AppDisputeEvidenceRowDto[];
  @ApiProperty({ example: 10, description: '`max_dispute_evidence_files`: how many files **you** may attach in total.' }) evidenceMax: number;
  @ApiProperty({ example: true, description: 'The dispute is open or in review, so you can still write and add evidence.' }) active: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) resolvedAt: string | null;
}
