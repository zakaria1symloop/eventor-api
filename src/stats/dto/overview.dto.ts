import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches, ValidateIf } from 'class-validator';
import { AuditLevel } from '../../common/enums/admin.enums.js';
import { BookingStatus } from '../../common/enums/booking.enums.js';
import { UserRole } from '../../common/enums/user.enums.js';
import { OVERVIEW_RANGES, type OverviewRange } from '../stats.policy.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class OverviewQueryDto {
  @ApiPropertyOptional({ enum: OVERVIEW_RANGES, default: '30d' })
  @IsOptional()
  @IsIn(OVERVIEW_RANGES)
  range?: OverviewRange;

  @ApiPropertyOptional({ example: '2026-08-01', description: 'Required with `range=custom` (Africa/Algiers day).' })
  @ValidateIf((o: OverviewQueryDto) => o.range === 'custom' || o.from !== undefined)
  @Matches(DATE, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31', description: 'Required with `range=custom` (Africa/Algiers day).' })
  @ValidateIf((o: OverviewQueryDto) => o.range === 'custom' || o.to !== undefined)
  @Matches(DATE, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}

export class AttentionDto {
  @ApiProperty({ example: 6, description: 'Providers with documents waiting for review (waiting + resubmitted). VER-01.' }) verificationsWaiting: number;
  @ApiProperty({ type: Number, nullable: true, example: 52, description: 'Hours since the oldest waiting submission.' }) oldestVerificationWaitingHours: number | null;
  @ApiProperty({ example: 3, description: 'Pending bookings past `booking_reply_deadline_hours`. BKG-01 noReply.' }) bookingsNoReply: number;
  @ApiProperty({ example: 2, description: 'Disputes open or in review. DSP-01.' }) disputesOpen: number;
  @ApiProperty({ example: 4, description: 'Academic requests pending. ACR-01.' }) academicRequestsPending: number;
  @ApiProperty({ example: 3, description: 'Reviews with open reports. REV-01 reported.' }) reviewsReported: number;
  @ApiProperty({ example: 1, description: 'Services with open reports. SRV-01.' }) servicesReported: number;
}

export const KPI_KEYS = ['bookings', 'booking_value', 'new_users', 'average_rating'] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

export class KpiDto {
  @ApiProperty({ enum: KPI_KEYS, example: 'bookings', description: 'bookings: created; booking_value: sum of totals of accepted + completed bookings created in the period (DZD); new_users: clients + providers; average_rating: reviews written in the period.' })
  key: KpiKey;
  @ApiProperty({ type: String, nullable: true, example: '184', description: 'Decimal string (money with 2 decimals, rating with 2 decimals); null: no reviews in the period.' }) value: string | null;
  @ApiProperty({ type: String, nullable: true, example: '161' }) previousValue: string | null;
  @ApiProperty({ type: Number, nullable: true, example: 14.3, description: 'Change vs the previous period, one decimal; null when the previous value is 0 or missing.' }) deltaPercent: number | null;
}

export class BookingsPerDayDto {
  @ApiProperty({ example: '2026-09-15' }) date: string;
  @ApiProperty({ example: 7, description: 'Bookings created (requests).' }) requests: number;
  @ApiProperty({ example: 4 }) completed: number;
}

export class OverviewBookingsByStatusDto {
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ example: 89 }) count: number;
  @ApiProperty({ example: 47.3, description: 'Share of all bookings, one decimal.' }) percent: number;
}

export class OverviewPartyDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Amina Benali' }) fullName: string;
}

export class OverviewProviderDto extends OverviewPartyDto {
  @ApiProperty({ type: String, nullable: true, example: 'Studio Lumière' }) businessName: string | null;
}

export class LatestBookingDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EVT-002041' }) reference: string;
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ type: OverviewPartyDto }) client: OverviewPartyDto;
  @ApiProperty({ type: OverviewProviderDto }) provider: OverviewProviderDto;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) titleEn: string;
  @ApiProperty({ example: 'تغطية الأعراس بالصور والفيديو' }) titleAr: string;
  @ApiProperty({ example: '2026-12-20' }) eventDate: string;
  @ApiProperty({ example: '85000.00', description: 'DZD.' }) total: string;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class ActivityActorDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Omar Belaid' }) fullName: string;
  @ApiProperty({ type: String, enum: UserRole, nullable: true }) role: UserRole | null;
}

export class RecentActivityDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'review.redacted' }) action: string;
  @ApiProperty({ type: ActivityActorDto, nullable: true, description: 'Null for system jobs.' }) actor: ActivityActorDto | null;
  @ApiProperty({ example: 'review' }) objectType: string;
  @ApiProperty({ type: String, nullable: true }) objectId: string | null;
  @ApiProperty({ type: String, nullable: true, example: '★1 · Appelez-moi au…' }) objectLabel: string | null;
  @ApiProperty({ type: String, nullable: true, example: '/reviews/7c4a3e1b-1d2f-4a5b-9c8d-0e1f2a3b4c5d', description: 'Dashboard route of the object, when it has a page.' }) href: string | null;
  @ApiProperty({ example: '/activity-log/1b2c…', description: 'LOG-02.' }) logHref: string;
  @ApiProperty({ enum: AuditLevel }) level: AuditLevel;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class OverviewPeriodDto {
  @ApiProperty({ example: '2026-08-18' }) from: string;
  @ApiProperty({ example: '2026-09-16' }) to: string;
}

export class OverviewDto {
  @ApiProperty({ enum: OVERVIEW_RANGES }) range: OverviewRange;
  @ApiProperty({ type: OverviewPeriodDto }) period: OverviewPeriodDto;
  @ApiProperty({ type: OverviewPeriodDto, description: 'Compared period.' }) previousPeriod: OverviewPeriodDto;
  @ApiProperty({ type: AttentionDto }) attention: AttentionDto;
  @ApiProperty({ type: [KpiDto] }) kpis: KpiDto[];
  @ApiProperty({ type: [BookingsPerDayDto], description: 'One entry per day of the period.' }) bookingsPerDay: BookingsPerDayDto[];
  @ApiProperty({ type: [OverviewBookingsByStatusDto], description: 'All time.' }) bookingsByStatus: OverviewBookingsByStatusDto[];
  @ApiProperty({ type: [LatestBookingDto], description: 'The 5 latest bookings of the last 24 h, or the 5 latest when none.' }) latestBookings: LatestBookingDto[];
  @ApiProperty({ type: [RecentActivityDto], description: 'The 8 latest activity log entries.' }) recentActivity: RecentActivityDto[];
  @ApiProperty({ format: 'date-time', description: 'When the figures were computed (cached 60 s).' }) generatedAt: string;
}

export class NavCountsDto {
  @ApiProperty({ example: 6 }) verificationsWaiting: number;
  @ApiProperty({ example: 3 }) bookingsNoReply: number;
  @ApiProperty({ example: 2 }) disputesOpen: number;
  @ApiProperty({ example: 4 }) academicRequestsPending: number;
  @ApiProperty({ example: 3 }) reviewsReported: number;
  @ApiProperty({ example: 2, description: 'Messages with open reports.' }) messagesReported: number;
  @ApiProperty({ example: 5, description: 'Conversations with messages the signed-in admin has not read (as support participant).' }) messagesUnread: number;
}
