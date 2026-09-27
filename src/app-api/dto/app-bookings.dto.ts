import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { trim, trimToNull } from '../../common/dto/transforms.js';
import { BookingDisputeStatus, BookingLineKind, BookingStatus, RescheduleStatus } from '../../common/enums/booking.enums.js';
import { EventType } from '../../common/enums/catalog.enums.js';
import { DisputeStatus, DisputeType } from '../../common/enums/moderation.enums.js';
import { PartyRole } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import {
  APP_BOOKING_ACTIONS,
  APP_BOOKING_TIMELINE_TYPES,
  CLIENT_BOOKING_TABS,
  PROVIDER_BOOKING_TABS,
  type AppBookingAction,
  type AppBookingTimelineType,
  type ClientBookingTab,
  type ProviderBookingTab,
} from '../app-bookings.policy.js';
import { AppProviderSummaryDto } from './app-catalog.dto.js';
import { AppCategoryRefDto, AppWilayaRefDto } from './app-me.dto.js';

export { AppProviderSummaryDto, AppWilayaRefDto };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// ── requests ────────────────────────────────────────────────────

export class AppBookingExtraDto {
  @ApiProperty({ format: 'uuid', description: 'An `extras[].id` from `GET /app/services/{id}`.' })
  @IsUUID('all')
  extraId: string;

  @ApiProperty({ example: 1, minimum: 1, maximum: 99 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity: number;
}

/** What screen 12 / 20 sends to price a booking before committing to it. */
export class AppQuoteDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Exactly one of `serviceId` / `packId`.' })
  @IsOptional()
  @IsUUID('all')
  serviceId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  packId?: string;

  @ApiProperty({ example: '2026-11-14', description: '`YYYY-MM-DD`, Africa/Algiers.' })
  @Matches(DATE, { message: 'eventDate must be YYYY-MM-DD' })
  eventDate: string;

  @ApiPropertyOptional({ example: '18:00', description: '`HH:mm`, Africa/Algiers. Drives the quantity of a `per_hour` service.' })
  @IsOptional()
  @Matches(TIME, { message: 'startTime must be HH:mm' })
  startTime?: string;

  @ApiPropertyOptional({ example: '23:00' })
  @IsOptional()
  @Matches(TIME, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ example: 180, description: 'Drives the quantity of a `per_person` service.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  guests?: number;

  @ApiPropertyOptional({ type: [AppBookingExtraDto], description: 'Service bookings only; a pack refuses extras.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AppBookingExtraDto)
  extras?: AppBookingExtraDto[];
}

/** The booking request itself: the quote plus where the event happens. */
export class AppCreateBookingDto extends AppQuoteDto {
  @ApiProperty({ example: 16, description: 'Wilaya code of the event.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(58)
  wilayaCode: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Must belong to `wilayaCode`.' })
  @IsOptional()
  @IsUUID('all')
  communeId?: string;

  @ApiPropertyOptional({ example: 'Salle des fêtes El Djazair, Hydra', maxLength: 255 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Length(1, 255)
  locationText?: string;

  @ApiProperty({ enum: EventType, example: EventType.Wedding })
  @IsEnum(EventType)
  eventType: EventType;

  @ApiPropertyOptional({ example: 'We would like the drone shots included.', maxLength: 2000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Length(1, 2000)
  clientNote?: string;
}

export class AppCancelBookingDto {
  @ApiProperty({ example: 'The venue changed our date.', maxLength: 60 })
  @Transform(trim)
  @IsString()
  @Length(3, 60)
  reason: string;
}

export class AppDeclineBookingDto extends AppCancelBookingDto {}

export class AppRescheduleDto {
  @ApiProperty({ example: '2026-11-21' })
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiPropertyOptional({ example: '18:00' })
  @IsOptional()
  @Matches(TIME, { message: 'startTime must be HH:mm' })
  startTime?: string;

  @ApiPropertyOptional({ example: '23:00' })
  @IsOptional()
  @Matches(TIME, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiProperty({ example: 'The hall is only free the week after.', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @Length(3, 200)
  reason: string;
}

export const CHECK_IN_ANSWERS = ['ok', 'problem'] as const;
export type CheckInAnswer = (typeof CHECK_IN_ANSWERS)[number];

export class AppCheckInDto {
  @ApiProperty({
    enum: CHECK_IN_ANSWERS,
    example: 'ok',
    description: '`ok` is "All good" (status-rules §5); `problem` answers 422 and points at `POST /app/bookings/{id}/disputes`.',
  })
  @IsIn(CHECK_IN_ANSWERS)
  answer: CheckInAnswer;
}

export class AppClientBookingsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CLIENT_BOOKING_TABS, default: 'upcoming' })
  @IsOptional()
  @IsIn(CLIENT_BOOKING_TABS)
  tab: ClientBookingTab = 'upcoming';
}

export class AppProviderBookingsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PROVIDER_BOOKING_TABS, default: 'requests' })
  @IsOptional()
  @IsIn(PROVIDER_BOOKING_TABS)
  tab: ProviderBookingTab = 'requests';
}

// ── responses ───────────────────────────────────────────────────

export class AppBookingLineDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: BookingLineKind, example: BookingLineKind.Service }) kind: BookingLineKind;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) label: string;
  @ApiProperty({ example: 1 }) quantity: number;
  @ApiProperty({ example: '45000.00' }) unitAmount: string;
  @ApiProperty({ example: '45000.00', description: 'Negative on a `discount` line.' }) amount: string;
}

export class AppQuoteResultDto {
  @ApiProperty({ type: [AppBookingLineDto], description: 'Same lines the booking will carry; ids are empty on a quote.' })
  lines: AppBookingLineDto[];

  @ApiProperty({ example: '57000.00' }) subtotal: string;
  @ApiProperty({ example: '0.00' }) discountTotal: string;
  @ApiProperty({ example: '57000.00' }) total: string;

  @ApiProperty({
    example: '8.00',
    description: 'Eventor’s fee percentage on this booking, **informational**: payment is cash between the two parties and the client pays `total`.',
  })
  feePercent: string;

  @ApiProperty({ example: true, description: 'The provider is free that day and takes bookings.' }) available: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'DATE_UNAVAILABLE',
    description: 'Why the date is refused, when `available` is false: `DATE_UNAVAILABLE`, `MIN_NOTICE` or `PROVIDER_NOT_ACCEPTING`.',
  })
  unavailableReason: string | null;

  @ApiProperty({ example: '2026-09-27', description: 'Today + `booking_min_notice_days` (Africa/Algiers).' }) firstBookableDate: string;
  @ApiProperty({ example: 7 }) minNoticeDays: number;
}

/** The other party on a booking. Phones and emails only after acceptance. */
export class AppBookingPartyDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Yasmine Khaled' }) fullName: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Studio Lumière', description: 'Providers only.' }) businessName: string | null;
  @ApiProperty({ type: String, nullable: true, example: '+213551234567', description: 'Null until the booking is accepted (status-rules §10).' }) phone: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Null until the booking is accepted; never filled for a provider.' }) email: string | null;
}

export class AppBookingTimelineEntryDto {
  @ApiProperty({
    enum: APP_BOOKING_TIMELINE_TYPES,
    example: 'accepted',
    description: '`created`, the booking status the entry moved to, or one of the milestones `rescheduled` / `checked_in` / `dispute_opened`.',
  })
  type: AppBookingTimelineType;
  @ApiProperty({ type: String, nullable: true, enum: BookingStatus }) toStatus: BookingStatus | null;
  @ApiProperty({ type: String, nullable: true, example: 'Yasmine K.' }) actorLabel: string | null;
  @ApiProperty({ type: String, nullable: true }) reason: string | null;
  @ApiProperty({ format: 'date-time' }) at: string;
}

export class AppRescheduleRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: RescheduleStatus }) status: RescheduleStatus;
  @ApiProperty({ example: '2026-11-14' }) oldDate: string;
  @ApiProperty({ example: '2026-11-21' }) newDate: string;
  @ApiProperty({ type: String, nullable: true, example: '18:00' }) newStartTime: string | null;
  @ApiProperty({ type: String, nullable: true, example: '23:00' }) newEndTime: string | null;
  @ApiProperty({ example: 'The hall is only free the week after.' }) reason: string | null;
  @ApiProperty({ enum: PartyRole, description: 'Which side proposed it.' }) proposedByRole: PartyRole;
  @ApiProperty({ example: true, description: 'True when it is this caller’s turn to accept or reject.' }) awaitingMe: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppInvoiceSummaryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'INV-000123' }) number: string;
  @ApiProperty({ example: 1 }) version: number;
  @ApiProperty({ example: '57000.00' }) total: string;
  @ApiProperty({ example: false }) voided: boolean;
  @ApiProperty({ example: '/api/v1/app/bookings/…/invoice.pdf' }) pdfPath: string;
  @ApiProperty({ format: 'date-time' }) issuedAt: string;
}

export class AppBookingDisputeSummaryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'DSP-000012' }) reference: string;
  @ApiProperty({ enum: DisputeStatus, example: DisputeStatus.Open }) status: DisputeStatus;
  @ApiProperty({ enum: DisputeType, example: DisputeType.ProviderNoShow }) type: DisputeType;
  @ApiProperty({ example: true, description: 'True when this caller opened it.' }) openedByMe: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppBookingCardDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EVT-000123' }) reference: string;
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ enum: BookingDisputeStatus }) disputeStatus: BookingDisputeStatus;
  @ApiProperty({ enum: EventType }) eventType: EventType;
  @ApiProperty({ example: '2026-11-14', description: 'Africa/Algiers, not a timestamp.' }) eventDate: string;
  @ApiProperty({ type: String, nullable: true, example: '18:00' }) startTime: string | null;
  @ApiProperty({ type: String, nullable: true, example: '23:00' }) endTime: string | null;
  @ApiProperty({ example: 'Wedding photo & video coverage', description: 'The service or pack name, in the caller’s language.' }) title: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) titleEn: string;
  @ApiProperty({ example: 'تغطية تصوير الأعراس' }) titleAr: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) serviceId: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) packId: string | null;
  @ApiProperty({
    type: AppCategoryRefDto,
    nullable: true,
    description: 'The booked service’s category ("Photography · Sat 14 Mar"). Null for a pack booking — use `eventType` there.',
  })
  category: AppCategoryRefDto | null;
  @ApiProperty({ type: String, nullable: true }) coverUrl: string | null;
  @ApiProperty({ type: AppWilayaRefDto, nullable: true }) wilaya: AppWilayaRefDto | null;
  @ApiProperty({ type: Number, nullable: true, example: 180 }) guests: number | null;
  @ApiProperty({ example: '57000.00' }) total: string;
  @ApiProperty({ type: AppBookingPartyDto, description: 'The provider for a client, the client for a provider.' }) counterparty: AppBookingPartyDto;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The direct chat, for the "Message" button.' }) conversationId: string | null;
  @ApiProperty({ enum: APP_BOOKING_ACTIONS, isArray: true, description: 'The buttons to draw; the write endpoints enforce the same rules.' })
  allowedActions: AppBookingAction[];
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppBookingDetailDto extends AppBookingCardDto {
  @ApiProperty({ type: String, nullable: true }) locationText: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Hydra' }) communeName: string | null;
  @ApiProperty({ type: String, nullable: true }) clientNote: string | null;
  @ApiProperty({ type: [AppBookingLineDto] }) lines: AppBookingLineDto[];
  @ApiProperty({ example: '57000.00' }) subtotal: string;
  @ApiProperty({ example: '0.00' }) discountTotal: string;
  @ApiProperty({ example: '8.00', description: 'Informational: Eventor takes no money, payment is cash.' }) feePercent: string;
  @ApiProperty({ type: String, nullable: true, description: 'The service’s cancellation policy text, shown but never enforced (status-rules §3).' })
  cancellationPolicy: string | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason: string | null;
  @ApiProperty({ type: String, nullable: true, enum: PartyRole }) cancelledBy: PartyRole | null;
  @ApiProperty({ type: String, nullable: true }) declineReason: string | null;
  @ApiProperty({ type: AppProviderSummaryDto, nullable: true, description: 'The provider card screen 12 draws; null on a pack whose provider was deleted.' })
  provider: AppProviderSummaryDto | null;
  @ApiProperty({ type: [AppBookingTimelineEntryDto] }) timeline: AppBookingTimelineEntryDto[];
  @ApiProperty({ type: [AppRescheduleRowDto] }) reschedules: AppRescheduleRowDto[];
  @ApiProperty({ type: AppInvoiceSummaryDto, nullable: true, description: 'Issued when the booking is accepted; null before that.' }) invoice: AppInvoiceSummaryDto | null;
  @ApiProperty({ type: AppBookingDisputeSummaryDto, nullable: true }) dispute: AppBookingDisputeSummaryDto | null;
  @ApiProperty({ example: false, description: 'This caller tapped "All good".' }) checkedIn: boolean;
  @ApiProperty({ example: false, description: 'The other party tapped "All good".' }) otherCheckedIn: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The caller’s review of this booking, when there is one.' }) reviewId: string | null;
  @ApiProperty({ example: false, description: 'The review window (24 h → 60 days after completion) is open.' }) reviewWindowOpen: boolean;
  @ApiProperty({ example: false, description: 'A dispute can be opened right now (status-rules §6).' }) disputeWindowOpen: boolean;
}
