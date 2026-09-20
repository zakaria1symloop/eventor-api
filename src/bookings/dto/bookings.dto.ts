import { ApiProperty, ApiPropertyOptional, IntersectionType, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
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
  ValidateNested,
} from 'class-validator';
import { toBoolean, trim, trimToNull } from '../../common/dto/transforms.js';
import { AuditLevel } from '../../common/enums/admin.enums.js';
import { BookingDisputeStatus, BookingLineKind, BookingSource, BookingStatus, RescheduleStatus } from '../../common/enums/booking.enums.js';
import { EventType } from '../../common/enums/catalog.enums.js';
import { ConversationKind, MessageKind, MessageStatus } from '../../common/enums/messaging.enums.js';
import { DisputeStatus, DisputeType } from '../../common/enums/moderation.enums.js';
import { PartyRole } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { toIntArray, toNumber } from '../../services/dto/services.dto.js';
import { PersonRefDto, WilayaRefDto } from '../../users/dto/users.dto.js';
import { BOOKING_TABS, STATUS_ACTIONS, type BookingTab, type StatusAction } from '../bookings.policy.js';

export const BOOKING_SORT_FIELDS = ['eventDate', 'createdAt', 'total'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const SIGNED_MONEY = /^-?\d{1,10}(\.\d{1,2})?$/;
const toMoneyString = ({ value }: { value: unknown }) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : typeof value === 'string' ? value.trim() : value);

// ── list ─────────────────────────────────────────────────────

export class BookingFiltersDto {
  @ApiPropertyOptional({ enum: BOOKING_TABS, default: 'all', description: '`disputed`: a dispute is open on the booking.' })
  @IsOptional()
  @IsIn(BOOKING_TABS)
  tab?: BookingTab;

  @ApiPropertyOptional({ type: Boolean, description: 'Pending for longer than `booking_reply_deadline_hours` (Overview "without a reply").' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  noReply?: boolean;

  @ApiPropertyOptional({ example: 'EVT-002041', maxLength: 120, description: 'Exact reference (with or without #), or client / provider / business name, service title or pack name contains.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') clientId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') providerId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') serviceId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') packId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Category of the booked service (or of any pack item).' }) @IsOptional() @IsUUID('all') categoryId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') academicRequestId?: string;

  @ApiPropertyOptional({ type: [Number], example: [16], description: 'Event wilaya; repeat for several.' })
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(58, { each: true })
  wilaya?: number[];

  @ApiPropertyOptional({ example: '2026-09-01' }) @IsOptional() @Matches(DATE, { message: 'eventDateFrom must be YYYY-MM-DD' }) eventDateFrom?: string;
  @ApiPropertyOptional({ example: '2026-12-31' }) @IsOptional() @Matches(DATE, { message: 'eventDateTo must be YYYY-MM-DD' }) eventDateTo?: string;
  @ApiPropertyOptional({ example: '2026-08-01', description: 'Created on or after (UTC day).' }) @IsOptional() @Matches(DATE, { message: 'createdFrom must be YYYY-MM-DD' }) createdFrom?: string;
  @ApiPropertyOptional({ example: '2026-09-16', description: 'Created on or before (UTC day).' }) @IsOptional() @Matches(DATE, { message: 'createdTo must be YYYY-MM-DD' }) createdTo?: string;

  @ApiPropertyOptional({ example: 20000, minimum: 0 }) @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) amountMin?: number;
  @ApiPropertyOptional({ example: 400000, minimum: 0 }) @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) amountMax?: number;

  @ApiPropertyOptional({ enum: BookingSource }) @IsOptional() @IsEnum(BookingSource) source?: BookingSource;
  @ApiPropertyOptional({ enum: BookingDisputeStatus }) @IsOptional() @IsEnum(BookingDisputeStatus) disputeStatus?: BookingDisputeStatus;
}

export class BookingsQueryDto extends IntersectionType(PaginationQueryDto, BookingFiltersDto) {}

export class BookingTabCountsDto {
  @ApiProperty({ example: 184 }) all: number;
  @ApiProperty({ example: 23 }) pending: number;
  @ApiProperty({ example: 41 }) accepted: number;
  @ApiProperty({ example: 88 }) completed: number;
  @ApiProperty({ example: 12 }) declined: number;
  @ApiProperty({ example: 20 }) cancelled: number;
  @ApiProperty({ example: 2 }) disputed: number;
  @ApiProperty({ example: 6, description: 'Pending past the reply deadline.' }) noReply: number;
}

export class BookingServiceRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) titleEn: string;
  @ApiProperty({ example: 'تغطية الزفاف بالصور والفيديو' }) titleAr: string;
}

export class BookingPackRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Photo + Vidéo Mariage' }) nameEn: string;
  @ApiProperty({ example: 'باقة صور وفيديو الزفاف' }) nameAr: string;
}

export class BookingClientRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Amina Benali' }) fullName: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
}

export class BookingProviderRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Karim Belkacem' }) fullName: string;
  @ApiProperty({ type: String, nullable: true, example: 'Studio Lumière' }) businessName: string | null;
}

export class BookingRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EVT-002041' }) reference: string;
  @ApiProperty({ type: BookingServiceRefDto, nullable: true }) service: BookingServiceRefDto | null;
  @ApiProperty({ type: BookingPackRefDto, nullable: true }) pack: BookingPackRefDto | null;
  @ApiProperty({ type: BookingClientRefDto }) client: BookingClientRefDto;
  @ApiProperty({ type: BookingProviderRefDto }) provider: BookingProviderRefDto;
  @ApiProperty({ example: '2026-12-20' }) eventDate: string;
  @ApiProperty({ type: String, nullable: true, example: '18:00' }) startTime: string | null;
  @ApiProperty({ type: String, nullable: true, example: '23:30' }) endTime: string | null;
  @ApiProperty({ enum: EventType }) eventType: EventType;
  @ApiProperty({ type: WilayaRefDto }) wilaya: WilayaRefDto;
  @ApiProperty({ type: Number, nullable: true, example: 150 }) guests: number | null;
  @ApiProperty({ example: '45000.00', description: 'DZD, informational (cash).' }) total: string;
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ enum: BookingDisputeStatus }) disputeStatus: BookingDisputeStatus;
  @ApiProperty({ example: false, description: 'Pending past `booking_reply_deadline_hours`.' }) noReply: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) respondedAt: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ enum: BookingSource }) source: BookingSource;
}

// ── detail ───────────────────────────────────────────────────

export class BookingClientCardDto extends BookingClientRefDto {
  @ApiProperty({ example: 'amina.benali@gmail.com' }) email: string;
  @ApiProperty({ type: String, nullable: true, example: '+213555123456' }) phone: string | null;
  @ApiProperty({ example: 4, description: 'All bookings of this client.' }) bookingsCount: number;
  @ApiProperty({ example: 'active' }) status: string;
}

export class BookingProviderCardDto extends BookingProviderRefDto {
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
  @ApiProperty({ example: 'karim.belkacem@gmail.com' }) email: string;
  @ApiProperty({ type: String, nullable: true }) phone: string | null;
  @ApiProperty({ example: 4.8 }) rating: number;
  @ApiProperty({ example: 126 }) ratingCount: number;
  @ApiProperty({ type: Number, nullable: true, example: 35, description: 'Average reply time in minutes (cached).' }) avgReplyMinutes: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 96 }) replyRate: number | null;
  @ApiProperty({ example: 142 }) completedBookingsCount: number;
  @ApiProperty({ example: true }) acceptingBookings: boolean;
  @ApiProperty({ example: 'active' }) status: string;
}

export class BookingOfferDto {
  @ApiProperty({ enum: ['service', 'pack'] }) kind: 'service' | 'pack';
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) titleEn: string;
  @ApiProperty({ example: 'تغطية الزفاف بالصور والفيديو' }) titleAr: string;
  @ApiProperty({ type: String, nullable: true }) coverUrl: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'per_event' }) priceType: string | null;
  @ApiProperty({ example: '45000.00' }) basePrice: string;
  @ApiProperty({ type: String, nullable: true }) cancellationPolicyEn: string | null;
  @ApiProperty({ type: String, nullable: true }) cancellationPolicyAr: string | null;
}

export class BookingCommuneDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Hydra' }) name: string;
  @ApiProperty({ example: 'حيدرة' }) nameAr: string;
}

export class BookingLineDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: BookingLineKind }) kind: BookingLineKind;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) label: string;
  @ApiProperty({ example: 1 }) quantity: number;
  @ApiProperty({ example: '45000.00' }) unitAmount: string;
  @ApiProperty({ example: '45000.00', description: 'Negative for discounts.' }) amount: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) serviceId: string | null;
  @ApiProperty({ example: 0 }) position: number;
}

export class BookingTimelineEntryDto {
  @ApiProperty({ enum: ['status', 'reschedule', 'price'] }) type: 'status' | 'reschedule' | 'price';
  @ApiProperty({ format: 'date-time' }) at: string;
  @ApiProperty({ type: PersonRefDto, nullable: true, description: 'Null for the system (jobs).' }) actor: PersonRefDto | null;
  @ApiProperty({ type: String, nullable: true, enum: BookingStatus }) fromStatus: BookingStatus | null;
  @ApiProperty({ type: String, nullable: true, enum: BookingStatus }) toStatus: BookingStatus | null;
  @ApiProperty({ type: String, nullable: true }) reason: string | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) notified: boolean | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-12-20' }) oldDate: string | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-12-27' }) newDate: string | null;
  @ApiProperty({ type: String, nullable: true, enum: RescheduleStatus }) rescheduleStatus: RescheduleStatus | null;
  @ApiProperty({ type: String, nullable: true, example: '45000.00' }) oldTotal: string | null;
  @ApiProperty({ type: String, nullable: true, example: '52000.00' }) newTotal: string | null;
}

export class RescheduleDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: '2026-12-20' }) oldDate: string;
  @ApiProperty({ type: String, nullable: true }) oldStart: string | null;
  @ApiProperty({ type: String, nullable: true }) oldEnd: string | null;
  @ApiProperty({ example: '2026-12-27' }) newDate: string;
  @ApiProperty({ type: String, nullable: true }) newStart: string | null;
  @ApiProperty({ type: String, nullable: true }) newEnd: string | null;
  @ApiProperty({ type: PersonRefDto }) proposedBy: PersonRefDto;
  @ApiProperty({ type: String, nullable: true }) reason: string | null;
  @ApiProperty({ example: false }) forced: boolean;
  @ApiProperty({ enum: RescheduleStatus }) status: RescheduleStatus;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) resolvedAt: string | null;
}

export class InvoiceSummaryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'INV-2026-0318' }) number: string;
  @ApiProperty({ example: 1 }) version: number;
  @ApiProperty({ format: 'date-time' }) issuedAt: string;
  @ApiProperty({ example: '45000.00' }) total: string;
  @ApiProperty({ example: true }) pdfReady: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) sentToClientAt: string | null;
}

export class BookingMessageDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: MessageKind }) kind: MessageKind;
  @ApiProperty({ example: 'Amina Benali' }) senderLabel: string;
  @ApiProperty({ type: String, nullable: true, description: 'Original text (admin view).' }) body: string | null;
  @ApiProperty({ type: String, nullable: true }) bodyMasked: string | null;
  @ApiProperty({ enum: MessageStatus }) status: MessageStatus;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class BookingConversationDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ConversationKind }) kind: ConversationKind;
  @ApiProperty({ type: [BookingMessageDto], description: 'Last 3 messages, oldest first.' }) lastMessages: BookingMessageDto[];
}

export class BookingDisputeSummaryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'DSP-000031' }) reference: string;
  @ApiProperty({ enum: DisputeStatus }) status: DisputeStatus;
  @ApiProperty({ enum: DisputeType }) type: DisputeType;
  @ApiProperty({ enum: PartyRole }) openedByRole: PartyRole;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AllowedTransitionDto {
  @ApiProperty({ enum: STATUS_ACTIONS }) action: StatusAction;
  @ApiProperty({ enum: BookingStatus }) to: BookingStatus;
  @ApiProperty({ example: true }) reasonRequired: boolean;
  @ApiProperty({ type: String, nullable: true, enum: ['event_not_passed', 'dispute_open'] }) warning: 'event_not_passed' | 'dispute_open' | null;
}

export class BookingHistoryEntryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'booking.status_changed' }) action: string;
  @ApiProperty({ type: PersonRefDto, nullable: true }) actor: PersonRefDto | null;
  @ApiProperty({ enum: AuditLevel }) level: AuditLevel;
  @ApiProperty({ type: Object, nullable: true }) changes: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class BookingAcademicRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'ACR-000142' }) reference: string;
  @ApiProperty({ example: 'International conference on AI' }) title: string;
}

export class BookingDetailDto extends OmitType(BookingRowDto, ['client', 'provider'] as const) {
  @ApiProperty({ type: BookingClientCardDto }) client: BookingClientCardDto;
  @ApiProperty({ type: BookingProviderCardDto }) provider: BookingProviderCardDto;
  @ApiProperty({ type: BookingOfferDto }) offer: BookingOfferDto;
  @ApiProperty({ type: String, nullable: true }) locationText: string | null;
  @ApiProperty({ type: BookingCommuneDto, nullable: true }) commune: BookingCommuneDto | null;
  @ApiProperty({ type: String, nullable: true }) clientNote: string | null;
  @ApiProperty({ type: [BookingLineDto] }) lines: BookingLineDto[];
  @ApiProperty({ example: '45000.00' }) subtotal: string;
  @ApiProperty({ example: '0.00' }) discountTotal: string;
  @ApiProperty({ example: '10.00', description: 'Fee percent snapshot.' }) feePercent: string;
  @ApiProperty({ example: '4500.00' }) feeAmount: string;
  @ApiProperty({ example: '40500.00' }) providerAmount: string;
  @ApiProperty({ type: String, nullable: true }) declineReason: string | null;
  @ApiProperty({ type: String, nullable: true, enum: PartyRole }) cancelledBy: PartyRole | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) reminderSentAt: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) completedAt: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) reviewRequestedAt: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the booking becomes "no reply" (pending only).' }) replyDeadlineAt: string | null;
  @ApiProperty({ type: PersonRefDto, nullable: true }) createdBy: PersonRefDto | null;
  @ApiProperty({ type: BookingAcademicRefDto, nullable: true }) academicRequest: BookingAcademicRefDto | null;
  @ApiProperty({ type: [BookingTimelineEntryDto] }) timeline: BookingTimelineEntryDto[];
  @ApiProperty({ type: RescheduleDto, nullable: true, description: 'Pending proposal ("New date waiting for confirmation").' }) pendingReschedule: RescheduleDto | null;
  @ApiProperty({ type: InvoiceSummaryDto, nullable: true }) invoice: InvoiceSummaryDto | null;
  @ApiProperty({ type: BookingConversationDto, nullable: true }) conversation: BookingConversationDto | null;
  @ApiProperty({ type: BookingDisputeSummaryDto, nullable: true }) dispute: BookingDisputeSummaryDto | null;
  @ApiProperty({ type: [AllowedTransitionDto] }) allowedTransitions: AllowedTransitionDto[];
  @ApiProperty({ type: [BookingHistoryEntryDto], description: 'Latest 50 activity log entries for this booking.' }) history: BookingHistoryEntryDto[];
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

// ── writes ───────────────────────────────────────────────────

export class BookingExtraInputDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('all') extraId: string;
  @ApiProperty({ example: 1, minimum: 1, maximum: 1000 }) @IsInt() @Min(1) @Max(1000) quantity: number;
}

export class CreateBookingDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('all') clientId: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Exactly one of serviceId / packId.' })
  @ValidateIf((o: CreateBookingDto) => o.packId === undefined || o.serviceId !== undefined)
  @IsUUID('all')
  serviceId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((o: CreateBookingDto) => o.serviceId === undefined || o.packId !== undefined)
  @IsUUID('all')
  packId?: string;

  @ApiProperty({ example: '2026-12-20' }) @Matches(DATE, { message: 'eventDate must be YYYY-MM-DD' }) eventDate: string;
  @ApiPropertyOptional({ example: '18:00' }) @IsOptional() @Matches(TIME, { message: 'startTime must be HH:mm' }) startTime?: string;
  @ApiPropertyOptional({ example: '23:30' }) @IsOptional() @Matches(TIME, { message: 'endTime must be HH:mm' }) endTime?: string;
  @ApiProperty({ enum: EventType }) @IsEnum(EventType) eventType: EventType;
  @ApiProperty({ example: 16, minimum: 1, maximum: 58 }) @IsInt() @Min(1) @Max(58) wilayaCode: number;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') communeId?: string;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'Salle Yasmine, Hydra', maxLength: 255 }) @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(255) locationText?: string | null;
  @ApiPropertyOptional({ example: 150, minimum: 1, maximum: 100000 }) @IsOptional() @IsInt() @Min(1) @Max(100000) guests?: number;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'Photos at the hall entrance at 18:00.', maxLength: 2000 }) @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(2000) clientNote?: string | null;

  @ApiPropertyOptional({ type: [BookingExtraInputDto], description: 'Service bookings only.' })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => BookingExtraInputDto)
  @ArrayMaxSize(20)
  extras?: BookingExtraInputDto[];

  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') academicRequestId?: string;
}

export class ChangeStatusDto {
  @ApiProperty({ enum: STATUS_ACTIONS, description: '`reopen` moves completed → accepted.' })
  @IsIn(STATUS_ACTIONS)
  status: StatusAction;

  @ApiPropertyOptional({ example: 'provider_unavailable', maxLength: 60, description: 'Required except for `accepted`.' })
  @ValidateIf((o: ChangeStatusDto) => o.status !== 'accepted' || o.reason !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  reason?: string;

  @ApiProperty({ example: 'Called the provider: the studio is closed that week.', maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note: string;

  @ApiProperty({ example: true, description: 'Email the client and the provider.' })
  @IsBoolean()
  notify: boolean;

  @ApiPropertyOptional({ enum: PartyRole, description: 'Who asked for the cancellation. Default `admin`.' })
  @IsOptional()
  @IsEnum(PartyRole)
  cancelledBy?: PartyRole;
}

export class RescheduleBookingDto {
  @ApiProperty({ example: '2026-12-27' }) @Matches(DATE, { message: 'date must be YYYY-MM-DD' }) date: string;
  @ApiPropertyOptional({ type: String, nullable: true, example: '18:00' }) @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(TIME, { message: 'startTime must be HH:mm' }) startTime?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, example: '23:30' }) @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(TIME, { message: 'endTime must be HH:mm' }) endTime?: string | null;
  @ApiProperty({ example: 'Hall double-booked', maxLength: 255 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(255) reason: string;
  @ApiPropertyOptional({ description: '"Book anyway": skip the availability check; on an accepted booking apply without waiting for confirmation. Default `false`.' })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class PriceLineInputDto {
  @ApiProperty({ enum: BookingLineKind }) @IsEnum(BookingLineKind) kind: BookingLineKind;
  @ApiProperty({ example: 'Drone footage', maxLength: 190 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(190) label: string;
  @ApiProperty({ example: 1, minimum: 1, maximum: 100000 }) @IsInt() @Min(1) @Max(100000) quantity: number;
  @ApiProperty({ example: '7500.00', description: 'DZD. Discounts always reduce the total; adjustments may be negative.' })
  @Transform(toMoneyString)
  @IsString()
  @Matches(SIGNED_MONEY, { message: 'unitAmount must be an amount in DZD with up to 2 decimals, e.g. "45000.00"' })
  unitAmount: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') serviceId?: string;
}

export class ChangePriceDto {
  @ApiProperty({ type: [PriceLineInputDto] })
  @ValidateNested({ each: true })
  @Type(() => PriceLineInputDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  lines: PriceLineInputDto[];

  @ApiProperty({ example: 'Client added drone footage', maxLength: 255 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(255) reason: string;
}

export class UpdateBookingDto {
  @ApiPropertyOptional({ description: 'Not accepted: use POST /admin/bookings/:id/reschedule (422 USE_RESCHEDULE).', example: '2026-12-27' })
  @IsOptional()
  @IsString()
  eventDate?: string;

  @ApiPropertyOptional({ enum: EventType }) @IsOptional() @IsEnum(EventType) eventType?: EventType;
  @ApiPropertyOptional({ type: String, nullable: true, example: '18:00' }) @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(TIME, { message: 'startTime must be HH:mm' }) startTime?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, example: '23:30' }) @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(TIME, { message: 'endTime must be HH:mm' }) endTime?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 255 }) @IsOptional() @Transform(trimToNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(255) locationText?: string | null;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID('all') communeId?: string | null;
  @ApiPropertyOptional({ example: 16, minimum: 1, maximum: 58 }) @IsOptional() @IsInt() @Min(1) @Max(58) wilayaCode?: number;
  @ApiPropertyOptional({ type: Number, nullable: true, example: 150 }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(100000) guests?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @IsOptional() @Transform(trimToNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) clientNote?: string | null;
}

export class InvoiceLineDto {
  @ApiProperty({ enum: BookingLineKind }) kind: BookingLineKind;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) label: string;
  @ApiProperty({ example: 1 }) quantity: number;
  @ApiProperty({ example: '45000.00' }) unitAmount: string;
  @ApiProperty({ example: '45000.00' }) amount: string;
}

export class InvoiceIssuerDto {
  @ApiProperty({ example: 'Eventor (Symloop SARL)' }) name: string;
  @ApiProperty({ example: 'Cité 1er Novembre, Bab Ezzouar, Alger' }) address: string;
  @ApiProperty({ example: '001216099999999' }) nif: string;
  @ApiProperty({ example: '16/00-1234567B21' }) rc: string;
  @ApiProperty({ example: 'billing@eventor.dz' }) email: string;
  @ApiProperty({ example: '+213 23 00 00 00' }) phone: string;
}

export class InvoicePartyDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Amina Benali' }) name: string;
  @ApiProperty({ type: String, nullable: true, example: 'Studio Lumière' }) businessName: string | null;
  @ApiProperty({ type: String, nullable: true }) email: string | null;
  @ApiProperty({ type: String, nullable: true }) phone: string | null;
}

export class InvoiceDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) bookingId: string;
  @ApiProperty({ example: 'EVT-002041' }) bookingReference: string;
  @ApiProperty({ example: 'INV-2026-0318' }) number: string;
  @ApiProperty({ example: 1 }) version: number;
  @ApiProperty({ format: 'date-time' }) issuedAt: string;
  @ApiProperty({ example: 'DZD' }) currency: string;
  @ApiProperty({ type: InvoiceIssuerDto }) issuer: InvoiceIssuerDto;
  @ApiProperty({ type: InvoicePartyDto }) client: InvoicePartyDto;
  @ApiProperty({ type: InvoicePartyDto }) provider: InvoicePartyDto;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) titleEn: string;
  @ApiProperty({ example: 'تغطية الزفاف بالصور والفيديو' }) titleAr: string;
  @ApiProperty({ example: '2026-12-20' }) eventDate: string;
  @ApiProperty({ enum: EventType }) eventType: EventType;
  @ApiProperty({ type: [InvoiceLineDto] }) lines: InvoiceLineDto[];
  @ApiProperty({ example: '45000.00' }) subtotal: string;
  @ApiProperty({ example: '0.00' }) discountTotal: string;
  @ApiProperty({ example: '45000.00' }) total: string;
  @ApiProperty({ example: '10.00' }) feePercent: string;
  @ApiProperty({ example: '4500.00' }) feeAmount: string;
  @ApiProperty({ example: '40500.00' }) providerAmount: string;
  @ApiProperty({ example: true }) pdfReady: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) sentToClientAt: string | null;
  @ApiProperty({ type: [Number], example: [1], description: 'Versions issued so far (voided ones included).' }) versions: number[];
}

export class RemindResultDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'date-time' }) reminderSentAt: string;
  @ApiProperty({ format: 'date-time', description: 'Next manual reminder allowed at.' }) nextReminderAt: string;
}
