import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsEnum, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { toArray, trim } from '../../common/dto/transforms.js';
import { AuditLevel, AuditSource } from '../../common/enums/admin.enums.js';
import { UserRole } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';

export const ACTIVITY_LOG_SORT_FIELDS = ['createdAt'] as const;

/** Filters shared by the list (LOG-01) and the activity-log export (STA-05). */
export class ActivityLogFiltersDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Who did it.' })
  @IsOptional()
  @IsUUID('all')
  actorId?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['settings.updated'],
    description: 'Exact action names; repeat the parameter for several (`?action=a&action=b`).',
  })
  @IsOptional()
  @Transform(toArray)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  action?: string[];

  @ApiPropertyOptional({ example: 'category', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  objectType?: string;

  @ApiPropertyOptional({ example: '7c4a1f0e-2b6d-4e8a-9c3f-1d2e3f4a5b6c', maxLength: 36, description: 'Use with `objectType` (history of one object).' })
  @IsOptional()
  @IsString()
  @MaxLength(36)
  objectId?: string;

  @ApiPropertyOptional({ enum: AuditLevel, isArray: true, description: 'Repeat for several.' })
  @IsOptional()
  @Transform(toArray)
  @IsEnum(AuditLevel, { each: true })
  level?: AuditLevel[];

  @ApiPropertyOptional({ enum: AuditSource, isArray: true, description: 'Repeat for several.' })
  @IsOptional()
  @Transform(toArray)
  @IsEnum(AuditSource, { each: true })
  source?: AuditSource[];

  @ApiPropertyOptional({ format: 'date-time', example: '2026-09-01T00:00:00.000Z', description: 'Inclusive lower bound on createdAt.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', example: '2026-09-30T23:59:59.999Z', description: 'Inclusive upper bound on createdAt.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({ example: 'Photographie', maxLength: 100, description: 'Search in action, object label, note and request id.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class ActivityLogQueryDto extends IntersectionType(PaginationQueryDto, ActivityLogFiltersDto) {}

export class ActorSummaryDto {
  @ApiProperty({ format: 'uuid', example: '5b0d6c9e-4a51-4c3f-9d0e-2f6b8a7c1e24' })
  id: string;

  @ApiProperty({ example: 'Sara Meziane' })
  fullName: string;

  @ApiProperty({ example: 'sara.meziane@eventor.dz' })
  email: string;

  @ApiProperty({ enum: UserRole, example: UserRole.Admin })
  role: UserRole;

  @ApiProperty({ example: false, description: 'The account was removed since.' })
  isDeleted: boolean;
}

export class ActivityLogItemDto {
  @ApiProperty({ format: 'uuid', example: '0b8e1c52-7a44-4f0e-9d7b-3c2a1f6e5d40' })
  id: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-15T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: 'category.updated' })
  action: string;

  @ApiProperty({ example: 'category' })
  objectType: string;

  @ApiProperty({ type: String, nullable: true, example: '7c4a1f0e-2b6d-4e8a-9c3f-1d2e3f4a5b6c' })
  objectId: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Photographie' })
  objectLabel: string | null;

  @ApiProperty({ enum: AuditLevel, example: AuditLevel.Normal })
  level: AuditLevel;

  @ApiProperty({ enum: AuditSource, example: AuditSource.Dashboard })
  source: AuditSource;

  @ApiProperty({ type: ActorSummaryDto, nullable: true, description: 'null for system jobs.' })
  actor: ActorSummaryDto | null;

  @ApiProperty({ type: String, nullable: true, enum: UserRole, example: UserRole.Admin })
  actorRole: UserRole | null;

  @ApiProperty({ type: String, nullable: true, example: '41.111.24.8' })
  ip: string | null;

  @ApiProperty({ example: true, description: 'The entry has old → new changes (see LOG-02).' })
  hasChanges: boolean;

  @ApiProperty({ example: false })
  hasNote: boolean;
}

export class ObjectLinkDto {
  @ApiProperty({ example: 'category' })
  type: string;

  @ApiProperty({ type: String, nullable: true, example: '7c4a1f0e-2b6d-4e8a-9c3f-1d2e3f4a5b6c' })
  id: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Photographie' })
  label: string | null;
}

export class ActivityLogDetailDto extends ActivityLogItemDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { nameEn: { from: 'Photo', to: 'Photography' } },
    description: 'Usually `{ field: { from, to } }`.',
  })
  changes: Record<string, unknown> | null;

  @ApiProperty({ type: String, nullable: true, example: 'Renamed after review.' })
  note: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) …' })
  userAgent: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'req_9f2a71c0' })
  requestId: string | null;

  @ApiProperty({ type: ObjectLinkDto, description: 'Hint for the dashboard to link the object (route chosen client-side by `type`).' })
  object: ObjectLinkDto;
}

