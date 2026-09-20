import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';
import { trimToNull } from '../../common/dto/transforms.js';
import { AvailabilityKind } from '../../common/enums/catalog.enums.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class AvailabilityQueryDto {
  @ApiProperty({ example: '2026-10', description: 'Month `YYYY-MM` (dates are Africa/Algiers local dates).' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must look like YYYY-MM' })
  month: string;
}

export class CreateAvailabilityBlockDto {
  @ApiProperty({ format: 'date', example: '2026-10-17' })
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string;

  @ApiPropertyOptional({ example: '14:00', description: '`HH:mm`; omit both times to block the whole day.' })
  @ValidateIf((o: CreateAvailabilityBlockDto) => o.startTime !== undefined || o.endTime !== undefined)
  @IsString()
  @Matches(TIME, { message: 'startTime must look like HH:mm' })
  startTime?: string;

  @ApiPropertyOptional({ example: '23:00', description: '`HH:mm`, after startTime.' })
  @ValidateIf((o: CreateAvailabilityBlockDto) => o.startTime !== undefined || o.endTime !== undefined)
  @IsString()
  @Matches(TIME, { message: 'endTime must look like HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Block only this service of the provider; omit for every service.' })
  @IsOptional()
  @IsUUID('all')
  serviceId?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 255, example: 'Family event' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(255)
  note?: string | null;
}

export class AvailabilityServiceRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) titleEn: string;
  @ApiProperty({ example: 'تغطية زفاف بالصورة والفيديو' }) titleAr: string;
}

export class AvailabilityBookingRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EVT-000123' }) reference: string;
  @ApiProperty({ example: 'accepted' }) status: string;
}

export class AvailabilityBlockDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'null for a booking without an availability row.' }) id: string | null;
  @ApiProperty({ enum: AvailabilityKind }) kind: AvailabilityKind;
  @ApiProperty({ format: 'date', example: '2026-10-17' }) date: string;
  @ApiProperty({ type: String, nullable: true, example: '14:00' }) startTime: string | null;
  @ApiProperty({ type: String, nullable: true, example: '23:00' }) endTime: string | null;
  @ApiProperty({ type: AvailabilityServiceRefDto, nullable: true }) service: AvailabilityServiceRefDto | null;
  @ApiProperty({ type: AvailabilityBookingRefDto, nullable: true }) booking: AvailabilityBookingRefDto | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ example: true, description: 'Manual blocks only.' }) removable: boolean;
}

export const DAY_STATUSES = ['free', 'partial', 'blocked', 'held', 'booked'] as const;

export class AvailabilityDayDto {
  @ApiProperty({ format: 'date', example: '2026-10-17' }) date: string;
  @ApiProperty({ enum: DAY_STATUSES, description: 'booked > held > blocked (whole day) > partial (time ranges or one service) > free.' })
  status: (typeof DAY_STATUSES)[number];
  @ApiProperty({ type: [AvailabilityBlockDto] }) items: AvailabilityBlockDto[];
}

export class AvailabilityMonthDto {
  @ApiProperty({ format: 'uuid' }) providerId: string;
  @ApiProperty({ example: '2026-10' }) month: string;
  @ApiProperty({ example: 1, description: 'Max events per day of the provider’s services (highest).' }) maxEventsPerDay: number;
  @ApiProperty({ type: [AvailabilityDayDto], description: 'Every day of the month.' }) days: AvailabilityDayDto[];
}
