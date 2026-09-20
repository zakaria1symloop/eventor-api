import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { trim, trimToNull } from '../../common/dto/transforms.js';
import { AcademicRequestStatus } from '../../common/enums/academic.enums.js';
import { BookingStatus } from '../../common/enums/booking.enums.js';
import { EventType } from '../../common/enums/catalog.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { toIntArray } from '../../services/dto/services.dto.js';
import { CategoryRefDto, PersonRefDto, WilayaRefDto } from '../../users/dto/users.dto.js';
import { REQUEST_TABS, type RequestAction, type RequestTab } from '../academic.policy.js';

export const ACADEMIC_REQUEST_SORT_FIELDS = ['submittedAt', 'eventDate', 'reference'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// ── list ─────────────────────────────────────────────────────

export class AcademicRequestFiltersDto {
  @ApiPropertyOptional({ enum: REQUEST_TABS, description: 'Default `all`.' })
  @IsOptional()
  @IsIn(REQUEST_TABS)
  tab?: RequestTab;

  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('all') formId?: string;

  @ApiPropertyOptional({ type: [Number], example: [16], description: 'Repeat for several.' })
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(58, { each: true })
  wilaya?: number[];

  @ApiPropertyOptional({ example: '2026-10-01' }) @IsOptional() @Matches(DATE, { message: 'eventDateFrom must be YYYY-MM-DD' }) eventDateFrom?: string;
  @ApiPropertyOptional({ example: '2026-12-31' }) @IsOptional() @Matches(DATE, { message: 'eventDateTo must be YYYY-MM-DD' }) eventDateTo?: string;

  @ApiPropertyOptional({ example: 'me', description: 'Admin UUID, `me` or `unassigned`.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== 'me' && v !== 'unassigned')
  @IsUUID('all')
  assignedAdminId?: string;

  @ApiPropertyOptional({ example: 'Science Day', maxLength: 120, description: 'Exact reference (ACR-000142), or requester name / email, institution or title contains.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class AcademicRequestsQueryDto extends IntersectionType(PaginationQueryDto, AcademicRequestFiltersDto) {}

export class AcademicRequestTabCountsDto {
  @ApiProperty({ example: 25 }) all: number;
  @ApiProperty({ example: 6 }) pending: number;
  @ApiProperty({ example: 3 }) changes_requested: number;
  @ApiProperty({ example: 4 }) approved: number;
  @ApiProperty({ example: 4 }) in_progress: number;
  @ApiProperty({ example: 3 }) rejected: number;
  @ApiProperty({ example: 3 }) completed: number;
  @ApiProperty({ example: 2 }) cancelled: number;
}

export class RequesterDto {
  @ApiProperty({ example: 'Nadia Hamdi' }) name: string;
  @ApiProperty({ example: 'nadia.hamdi@univ-alger.dz' }) email: string;
  @ApiProperty({ example: '+213555123456' }) phone: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Linked client account (USR-11).' }) userId: string | null;
}

export class RequestFormRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Event request' }) nameEn: string;
  @ApiProperty({ example: 'طلب مناسبة' }) nameAr: string;
  @ApiProperty({ example: 'event-request' }) slug: string;
  @ApiProperty({ format: 'uuid' }) versionId: string;
  @ApiProperty({ example: 3 }) version: number;
}

export class AcademicRequestRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'ACR-000142' }) reference: string;
  @ApiProperty({ example: 'Science Day 2026' }) title: string;
  @ApiProperty({ type: String, nullable: true, example: "Université d'Alger 1" }) institutionName: string | null;
  @ApiProperty({ type: RequesterDto }) requester: RequesterDto;
  @ApiProperty({ enum: EventType, nullable: true }) eventType: EventType | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-11-12' }) eventDate: string | null;
  @ApiProperty({ type: WilayaRefDto, nullable: true }) wilaya: WilayaRefDto | null;
  @ApiProperty({ type: Number, nullable: true, example: 350 }) attendees: number | null;
  @ApiProperty({ type: String, nullable: true, example: '150000.00' }) budgetMin: string | null;
  @ApiProperty({ type: String, nullable: true, example: '400000.00' }) budgetMax: string | null;
  @ApiProperty({ type: RequestFormRefDto }) form: RequestFormRefDto;
  @ApiProperty({ enum: AcademicRequestStatus }) status: AcademicRequestStatus;
  @ApiProperty({ type: PersonRefDto, nullable: true }) assignedAdmin: PersonRefDto | null;
  @ApiProperty({ example: 2 }) proposalsCount: number;
  @ApiProperty({ example: 1 }) bookingsCount: number;
  @ApiProperty({ example: '2026-09-10T08:30:00.000Z' }) submittedAt: string;
}

// ── detail ───────────────────────────────────────────────────

export class RenderedAnswerDto {
  @ApiProperty({ example: 'attendees' }) key: string;
  @ApiProperty({ example: 'number' }) type: string;
  @ApiProperty({ example: 'Expected attendees' }) labelEn: string;
  @ApiProperty({ example: 'عدد الحضور المتوقع' }) labelAr: string;
  @ApiProperty({ type: String, nullable: true, example: 'event' }) section: string | null;
  @ApiProperty({ description: 'Raw stored value (null when unanswered or hidden).', nullable: true, example: 350 }) value: unknown;
  @ApiProperty({ type: String, nullable: true, example: '350', description: 'Human text (EN): option labels, wilaya name, category names, file names, ranges.' }) displayValue: string | null;
  @ApiProperty({ example: false, description: 'Changed at the last resubmission.' }) changed: boolean;
}

export class AttachmentDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) fileId: string;
  @ApiProperty({ example: 'programme' }) fieldKey: string;
  @ApiProperty({ example: 'programme-science-day.pdf' }) fileName: string;
  @ApiProperty({ example: 'application/pdf' }) mimeType: string;
  @ApiProperty({ example: 184233 }) sizeBytes: number;
  @ApiProperty({ description: 'Signed, expiring URL.' }) url: string;
}

export class NeedDto {
  @ApiProperty({ type: CategoryRefDto }) category: CategoryRefDto;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
}

export class ProposalServiceDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Sound & light system' }) titleEn: string;
  @ApiProperty({ example: 'نظام الصوت والإضاءة' }) titleAr: string;
  @ApiProperty({ example: '30000.00' }) basePrice: string;
  @ApiProperty({ example: 'per_event' }) priceType: string;
  @ApiProperty({ example: 'published' }) status: string;
  @ApiProperty({ type: PersonRefDto }) provider: PersonRefDto;
  @ApiProperty({ type: String, nullable: true, example: 'Studio Lumière' }) businessName: string | null;
  @ApiProperty({ type: CategoryRefDto }) category: CategoryRefDto;
}

export class RequestBookingRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EVT-002101' }) reference: string;
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ example: '2026-11-12' }) eventDate: string;
  @ApiProperty({ example: '30000.00' }) total: string;
  @ApiProperty({ type: String, nullable: true, example: 'Sound & light system' }) titleEn: string | null;
  @ApiProperty({ type: PersonRefDto }) provider: PersonRefDto;
}

export class ProposalDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: ProposalServiceDto }) service: ProposalServiceDto;
  @ApiProperty({ type: String, nullable: true, example: 'Covers the amphitheatre and the hall.' }) note: string | null;
  @ApiProperty({ type: PersonRefDto, nullable: true }) proposedBy: PersonRefDto | null;
  @ApiProperty({ type: RequestBookingRefDto, nullable: true }) booking: RequestBookingRefDto | null;
  @ApiProperty() createdAt: string;
}

export class RequestChangesInfoDto {
  @ApiProperty({ type: [String], example: ['event_date'] }) fields: string[];
  @ApiProperty({ example: 'Please confirm the date.' }) message: string;
  @ApiProperty() requestedAt: string;
  @ApiProperty({ type: PersonRefDto, nullable: true }) requestedBy: PersonRefDto | null;
  @ApiProperty({ type: String, nullable: true, description: 'Edit link expiry (null once used).' }) linkExpiresAt: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'When the requester resubmitted.' }) resubmittedAt: string | null;
}

export class RequestTimelineEntryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'academic_request.approved' }) action: string;
  @ApiProperty({ type: PersonRefDto, nullable: true }) actor: PersonRefDto | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true }) changes: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty() createdAt: string;
}

export class AcademicRequestDetailDto extends AcademicRequestRowDto {
  @ApiProperty({ type: [RenderedAnswerDto] }) answers: RenderedAnswerDto[];
  @ApiProperty({ type: [AttachmentDto] }) attachments: AttachmentDto[];
  @ApiProperty({ type: [NeedDto] }) needs: NeedDto[];
  @ApiProperty({ type: [ProposalDto] }) proposals: ProposalDto[];
  @ApiProperty({ type: [RequestBookingRefDto] }) bookings: RequestBookingRefDto[];
  @ApiProperty({ type: RequestChangesInfoDto, nullable: true }) requestedChanges: RequestChangesInfoDto | null;
  @ApiProperty({ type: [String], example: ['event_date'], description: 'Fields changed since the last changes request.' }) changedFields: string[];
  @ApiProperty({ type: String, nullable: true }) decisionMessage: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'out_of_scope' }) rejectReason: string | null;
  @ApiProperty({ type: PersonRefDto, nullable: true }) decidedBy: PersonRefDto | null;
  @ApiProperty({ type: String, nullable: true }) decidedAt: string | null;
  @ApiProperty({ type: [String], example: ['assign', 'approve', 'reject', 'cancel', 'propose'] }) allowedActions: RequestAction[];
  @ApiProperty({ type: [RequestTimelineEntryDto] }) timeline: RequestTimelineEntryDto[];
  @ApiProperty() updatedAt: string;
}

// ── actions ──────────────────────────────────────────────────

export class AssignRequestDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Defaults to the current admin.' }) @IsOptional() @IsUUID('all') adminId?: string;
}

export class RequestChangesDto {
  @ApiProperty({ type: [String], example: ['event_date', 'attendees'], description: 'Field keys of the request’s form version.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  fields: string[];

  @ApiProperty({ example: 'Please confirm the date and the number of attendees.', maxLength: 2000 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) message: string;
}

export class ApproveRequestDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: 'We propose two providers for your Science Day.', maxLength: 2000 })
  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  message?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'Services to propose at the same time.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  serviceIds?: string[];
}

export class RejectRequestDto {
  @ApiProperty({ example: 'out_of_scope', maxLength: 60 }) @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) reason: string;
  @ApiProperty({ example: 'We cannot support events outside Algeria.', maxLength: 2000 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) message: string;
}

export class CancelRequestDto {
  @ApiProperty({ example: 'requester_withdrew', maxLength: 60 }) @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) reason: string;
}

export class CreateProposalDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('all') serviceId: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000, example: 'Covers the amphitheatre and the hall.' })
  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class BookProposalDto {
  @ApiPropertyOptional({ example: '2026-11-12', description: 'Defaults to the request event date.' }) @IsOptional() @Matches(DATE, { message: 'eventDate must be YYYY-MM-DD' }) eventDate?: string;
  @ApiPropertyOptional({ example: '09:00' }) @IsOptional() @Matches(TIME, { message: 'startTime must be HH:mm' }) startTime?: string;
  @ApiPropertyOptional({ example: '17:00' }) @IsOptional() @Matches(TIME, { message: 'endTime must be HH:mm' }) endTime?: string;
  @ApiPropertyOptional({ example: 350, description: 'Defaults to the request attendees.' }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) guests?: number;
  @ApiPropertyOptional({ example: 'Amphitheatre A, set-up from 08:00.', maxLength: 2000 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) notes?: string;
}
