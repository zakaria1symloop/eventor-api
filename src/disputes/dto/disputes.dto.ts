import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { toArray, trim } from '../../common/dto/transforms.js';
import { BookingDisputeStatus, BookingStatus } from '../../common/enums/booking.enums.js';
import { DisputeBookingOutcome, DisputeEvidenceKind, DisputeStatus, DisputeType } from '../../common/enums/moderation.enums.js';
import { PartyRole, UserStatus } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { PersonRefDto } from '../../users/dto/users.dto.js';
import { DISPUTE_ACTIONS, DISPUTE_TABS, type DisputeAction, type DisputeTab } from '../disputes.policy.js';

export const DISPUTE_SORT_FIELDS = ['createdAt', 'lastActivityAt'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ASSIGNEE = /^(me|unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// ── list ─────────────────────────────────────────────────────

export class DisputeFiltersDto {
  @ApiPropertyOptional({ enum: DISPUTE_TABS, default: 'all' })
  @IsOptional()
  @IsIn(DISPUTE_TABS)
  tab?: DisputeTab;

  @ApiPropertyOptional({ enum: DisputeType, isArray: true, description: 'Repeat for several.' })
  @IsOptional()
  @Transform(toArray)
  @IsEnum(DisputeType, { each: true })
  type?: DisputeType[];

  @ApiPropertyOptional({ enum: PartyRole })
  @IsOptional()
  @IsEnum(PartyRole)
  openedByRole?: PartyRole;

  @ApiPropertyOptional({ example: 'me', description: 'An admin UUID, `me` or `unassigned`.' })
  @IsOptional()
  @Matches(ASSIGNEE, { message: 'assignedAdminId must be a UUID, me or unassigned' })
  assignedAdminId?: string;

  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') bookingId?: string;

  @ApiPropertyOptional({ enum: BookingStatus, isArray: true, description: 'Status of the disputed booking; repeat for several.' })
  @IsOptional()
  @Transform(toArray)
  @IsEnum(BookingStatus, { each: true })
  bookingStatus?: BookingStatus[];

  @ApiPropertyOptional({ format: 'uuid', description: 'Opened by or against this user.' }) @IsOptional() @IsUUID('all') userId?: string;

  @ApiPropertyOptional({ example: '2026-08-01', description: 'Created on or after (UTC day).' }) @IsOptional() @Matches(DATE, { message: 'createdFrom must be YYYY-MM-DD' }) createdFrom?: string;
  @ApiPropertyOptional({ example: '2026-09-16', description: 'Created on or before (UTC day).' }) @IsOptional() @Matches(DATE, { message: 'createdTo must be YYYY-MM-DD' }) createdTo?: string;

  @ApiPropertyOptional({ example: 'DSP-000031', maxLength: 120, description: 'Dispute or booking reference, or opener / other party name contains.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class DisputesQueryDto extends IntersectionType(PaginationQueryDto, DisputeFiltersDto) {}

export class DisputeTabCountsDto {
  @ApiProperty({ example: 4 }) open: number;
  @ApiProperty({ example: 2 }) inReview: number;
  @ApiProperty({ example: 11 }) resolved: number;
  @ApiProperty({ example: 3 }) closed: number;
  @ApiProperty({ example: 20 }) all: number;
  @ApiProperty({ example: 5, description: 'Resolved in the last 30 days (by `resolvedAt`).' }) resolved30d: number;
  @ApiProperty({ example: 1, description: 'Closed in the last 30 days (by `resolvedAt`, the decision time).' }) closed30d: number;
}

export class DisputePartyRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Karima Ait' }) fullName: string;
  @ApiProperty({ enum: PartyRole, example: 'client' }) role: PartyRole;
}

export class DisputeBookingRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EVT-002038' }) reference: string;
  @ApiProperty({ example: 'DJ set · 5 hours', description: 'Service title or pack name (EN).' }) titleEn: string;
  @ApiProperty({ example: 'حفلة دي جي · 5 ساعات' }) titleAr: string;
  @ApiProperty({ example: '2026-09-04' }) eventDate: string;
}

export class DisputeRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'DSP-000031' }) reference: string;
  @ApiProperty({ enum: DisputeType, example: 'provider_no_show' }) type: DisputeType;
  @ApiProperty({ type: DisputeBookingRefDto }) booking: DisputeBookingRefDto;
  @ApiProperty({ type: DisputePartyRefDto }) openedBy: DisputePartyRefDto;
  @ApiProperty({ type: DisputePartyRefDto }) against: DisputePartyRefDto;
  @ApiProperty({ type: PersonRefDto, nullable: true }) assignedAdmin: PersonRefDto | null;
  @ApiProperty({ enum: DisputeStatus }) status: DisputeStatus;
  @ApiProperty({ example: 3 }) evidenceCount: number;
  @ApiProperty({ example: '2026-09-15T09:12:00.000Z', description: 'Latest of the dispute update, dispute chat message and timeline event.' }) lastActivityAt: string;
  @ApiProperty({ example: '2026-09-05T08:30:00.000Z' }) createdAt: string;
}

// ── detail ───────────────────────────────────────────────────

export class DisputePartyHistoryDto {
  @ApiProperty({ example: 2, description: 'Disputes opened by or against the user (this one included).' }) disputesCount: number;
  @ApiProperty({ example: 1, description: 'Bookings the user cancelled (as client or provider).' }) cancellationsCount: number;
  @ApiProperty({ type: Number, nullable: true, example: 3.9, description: 'Provider rating; null for clients.' }) ratingAvg: number | null;
}

export class DisputeResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'I waited until 22:00 and nobody came.' }) body: string;
  @ApiProperty({ example: '2026-09-05T09:00:00.000Z' }) createdAt: string;
}

export class DisputeSideDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Karima Ait' }) fullName: string;
  @ApiProperty({ enum: PartyRole }) role: PartyRole;
  @ApiProperty({ example: 'karima.ait@gmail.com' }) email: string;
  @ApiProperty({ type: String, nullable: true, example: '+213661204102' }) phone: string | null;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
  @ApiProperty({ enum: UserStatus }) status: UserStatus;
  @ApiProperty({ type: String, nullable: true, example: 'DJ Amine' }) businessName: string | null;
  @ApiProperty({ example: true, description: 'This side opened the dispute.' }) isOpener: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'The opening description (opener only).' }) description: string | null;
  @ApiProperty({ type: [DisputeResponseDto], description: 'Messages this party wrote in the dispute chat.' }) responses: DisputeResponseDto[];
  @ApiProperty({ example: 2 }) evidenceCount: number;
  @ApiProperty({ type: DisputePartyHistoryDto }) history: DisputePartyHistoryDto;
}

export class DisputeSidesDto {
  @ApiProperty({ type: DisputeSideDto }) client: DisputeSideDto;
  @ApiProperty({ type: DisputeSideDto }) provider: DisputeSideDto;
}

export class EvidenceFileDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'screenshot.png' }) name: string;
  @ApiProperty({ example: 'image/png' }) mimeType: string;
  @ApiProperty({ example: 184233 }) sizeBytes: number;
  @ApiProperty({ description: 'Signed, expiring URL.' }) url: string;
}

export class DisputeEvidenceDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: DisputeEvidenceKind }) kind: DisputeEvidenceKind;
  @ApiProperty({ type: DisputePartyRefDto, description: 'Party the evidence belongs to.' }) uploadedBy: DisputePartyRefDto;
  @ApiProperty({ type: EvidenceFileDto, nullable: true }) file: EvidenceFileDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'chat_snapshot: the booking conversation attached.' }) conversationId: string | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty() createdAt: string;
}

export class DisputeBookingCardDto extends DisputeBookingRefDto {
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ enum: BookingDisputeStatus }) disputeStatus: BookingDisputeStatus;
  @ApiProperty({ enum: ['service', 'pack'] }) kind: 'service' | 'pack';
  @ApiProperty({ type: String, nullable: true, example: '20:00' }) startTime: string | null;
  @ApiProperty({ type: String, nullable: true, example: '01:00' }) endTime: string | null;
  @ApiProperty({ example: '45000.00' }) subtotal: string;
  @ApiProperty({ example: '0.00' }) discountTotal: string;
  @ApiProperty({ example: '45000.00', description: 'DZD, paid in cash.' }) total: string;
  @ApiProperty({ type: String, nullable: true, example: 'INV-2026-0312' }) invoiceNumber: string | null;
  @ApiProperty({ type: String, nullable: true, enum: PartyRole }) cancelledBy: PartyRole | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason: string | null;
  @ApiProperty({ type: String, nullable: true }) completedAt: string | null;
}

export class DisputeTimelineEntryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'opened', description: 'opened, assigned, evidence_added, message_sent, evidence_requested, resolved, closed, conversation_closed.' }) type: string;
  @ApiProperty({ type: PersonRefDto, nullable: true }) actor: PersonRefDto | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true }) data: Record<string, unknown> | null;
  @ApiProperty() createdAt: string;
}

export class DisputeDetailDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'DSP-000031' }) reference: string;
  @ApiProperty({ enum: DisputeType }) type: DisputeType;
  @ApiProperty({ enum: DisputeStatus }) status: DisputeStatus;
  @ApiProperty({ example: 'The DJ never came to the wedding and did not answer calls.' }) description: string;
  @ApiProperty({ type: DisputePartyRefDto }) openedBy: DisputePartyRefDto;
  @ApiProperty({ type: DisputePartyRefDto }) against: DisputePartyRefDto;
  @ApiProperty({ type: DisputeSidesDto }) sides: DisputeSidesDto;
  @ApiProperty({ type: [DisputeEvidenceDto] }) evidence: DisputeEvidenceDto[];
  @ApiProperty({ type: DisputeBookingCardDto }) booking: DisputeBookingCardDto;
  @ApiProperty({ type: PersonRefDto, nullable: true }) assignedAdmin: PersonRefDto | null;
  @ApiProperty({ format: 'uuid' }) conversationId: string;
  @ApiProperty({ enum: ['open', 'closed'] }) conversationStatus: 'open' | 'closed';
  @ApiProperty({ type: String, nullable: true, enum: DisputeBookingOutcome }) bookingOutcome: DisputeBookingOutcome | null;
  @ApiProperty({ type: String, nullable: true }) decisionNote: string | null;
  @ApiProperty({ type: PersonRefDto, nullable: true }) resolvedBy: PersonRefDto | null;
  @ApiProperty({ type: String, nullable: true }) resolvedAt: string | null;
  @ApiProperty({ type: [DisputeTimelineEntryDto] }) timeline: DisputeTimelineEntryDto[];
  @ApiProperty({ enum: DISPUTE_ACTIONS, isArray: true }) allowedActions: DisputeAction[];
  @ApiProperty() lastActivityAt: string;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}

// ── actions ──────────────────────────────────────────────────

export class OpenDisputeDto {
  @ApiProperty({ example: 'EVT-002038', description: 'Booking UUID or reference.' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  bookingId: string;

  @ApiProperty({ enum: [PartyRole.Client, PartyRole.Provider], description: 'The party the admin opens the dispute for.' })
  @IsIn([PartyRole.Client, PartyRole.Provider])
  openedByRole: PartyRole.Client | PartyRole.Provider;

  @ApiProperty({ enum: DisputeType, example: 'provider_no_show' })
  @IsEnum(DisputeType)
  type: DisputeType;

  @ApiProperty({ example: 'The DJ never came to the wedding and did not answer our calls that evening.', minLength: 30, maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @MinLength(30)
  @MaxLength(5000)
  description: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Private files already uploaded (evidence, attachment, message).' })
  @IsOptional()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  evidenceFileIds?: string[];

  @ApiPropertyOptional({ description: 'Open outside the dispute window (requires `note`). Default `false`.' })
  @IsOptional()
  @IsBoolean()
  ignoreWindow?: boolean;

  @ApiPropertyOptional({ example: 'Client called support 10 days after the event; checked with the provider.', maxLength: 2000 })
  @ValidateIf((o: OpenDisputeDto) => o.ignoreWindow === true || o.note !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note?: string;
}

export class AssignDisputeDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Defaults to the signed-in admin.' })
  @IsOptional()
  @IsUUID('all')
  adminId?: string;
}

export class DisputeMessageDto {
  @ApiProperty({ example: 'Hello both, we are looking into this booking. Please share any proof you have.', maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;
}

export class RequestEvidenceDto {
  @ApiProperty({ format: 'uuid', description: 'The party asked for evidence.' })
  @IsUUID('all')
  fromUserId: string;

  @ApiProperty({ example: 'Could you send a photo of the venue at 21:00 and your call log?', maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  message: string;
}

export class AddEvidenceDto {
  @ApiProperty({ format: 'uuid', description: 'The party the file is added for (client or provider of the booking).' })
  @IsUUID('all')
  partyUserId: string;

  @ApiPropertyOptional({ example: 'Call log sent by WhatsApp to support.', maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ResolveDisputeDto {
  @ApiProperty({ enum: DisputeBookingOutcome, example: 'cancelled' })
  @IsEnum(DisputeBookingOutcome)
  bookingOutcome: DisputeBookingOutcome;

  @ApiProperty({ example: 'The provider did not attend and could not show any proof. The booking is cancelled.', maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  decisionNote: string;
}

export class CloseDisputeDto {
  @ApiProperty({ example: 'Both parties agreed after a call; no action needed.', maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note: string;
}

