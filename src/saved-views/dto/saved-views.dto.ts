import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { trim } from '../../common/dto/transforms.js';
import { UserSummaryDto } from '../../settings/dto/admin-settings.dto.js';

const RESOURCE = /^[a-z][a-z0-9-]*$/;

export class SavedViewsQueryDto {
  @ApiPropertyOptional({ example: 'bookings', maxLength: 40, description: 'Only views of this list screen.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(RESOURCE, { message: 'resource must be a kebab-case resource name' })
  resource?: string;
}

export class CreateSavedViewDto {
  @ApiProperty({ example: 'bookings', maxLength: 40 })
  @IsString()
  @MaxLength(40)
  @Matches(RESOURCE, { message: 'resource must be a kebab-case resource name' })
  resource: string;

  @ApiProperty({ example: 'Pending in Alger', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { status: ['pending'], wilaya: [16], sort: 'createdAt:desc' },
    description: 'The list query parameters (filters, sort, columns) as the dashboard stores them.',
  })
  @IsObject()
  query: Record<string, unknown>;

  @ApiPropertyOptional({ example: false, description: 'Visible to every admin (only the owner can change it). Default `false`.' })
  @IsOptional()
  @IsBoolean()
  isShared?: boolean;
}

export class UpdateSavedViewDto {
  @ApiPropertyOptional({ example: 'Pending in Oran', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, example: { status: ['pending'], wilaya: [31] } })
  @IsOptional()
  @IsObject()
  query?: Record<string, unknown>;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isShared?: boolean;
}

export class SavedViewDto {
  @ApiProperty({ format: 'uuid', example: '6a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d' })
  id: string;

  @ApiProperty({ example: 'bookings' })
  resource: string;

  @ApiProperty({ example: 'Pending in Alger' })
  name: string;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { status: ['pending'], wilaya: [16] } })
  query: Record<string, unknown>;

  @ApiProperty({ example: false })
  isShared: boolean;

  @ApiProperty({ type: UserSummaryDto })
  owner: UserSummaryDto;

  @ApiProperty({ example: true, description: 'I can edit and delete it.' })
  isOwner: boolean;

  @ApiProperty({ format: 'date-time', example: '2026-09-15T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-15T10:00:00.000Z' })
  updatedAt: string;
}
