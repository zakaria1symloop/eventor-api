import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { trim } from '../../common/dto/transforms.js';

export const SEARCH_SCOPES = ['all', 'users', 'services', 'bookings', 'requests', 'disputes', 'pages'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
export const SEARCH_GROUPS = ['users', 'services', 'bookings', 'requests', 'disputes', 'pages'] as const;
export type SearchGroupType = (typeof SEARCH_GROUPS)[number];
export const EXACT_TYPES = ['user', 'booking', 'academic_request', 'dispute', 'invoice'] as const;
export type ExactType = (typeof EXACT_TYPES)[number];

export class SearchQueryDto {
  @ApiProperty({ example: 'EVT-002041', minLength: 1, maxLength: 120, description: 'Name, email, phone (0… or +213…), title or reference (EVT-, ACR-, DSP-, INV-; a leading # is ignored).' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  q: string;

  @ApiPropertyOptional({ enum: SEARCH_SCOPES, default: 'all' })
  @IsOptional()
  @IsIn(SEARCH_SCOPES)
  scope?: SearchScope;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, default: 5, description: 'Items per group.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}

export class SearchItemDto {
  @ApiProperty({ example: '3f1c9a2e-8b7d-4c6a-9e5f-2a1b3c4d5e6f', description: 'Record UUID; page key for `pages`.' }) id: string;
  @ApiProperty({ example: 'Amina Benali', description: 'Pages: English title.' }) title: string;
  @ApiProperty({ type: String, nullable: true, example: 'Client · amina.benali@gmail.com', description: 'Pages: Arabic title.' }) subtitle: string | null;
  @ApiProperty({ example: '/users/3f1c9a2e-8b7d-4c6a-9e5f-2a1b3c4d5e6f', description: 'Dashboard route to open.' }) href: string;
  @ApiProperty({ type: String, nullable: true, example: 'blocked', description: 'Status or role chip.' }) badge: string | null;
}

export class SearchGroupDto {
  @ApiProperty({ enum: SEARCH_GROUPS }) type: SearchGroupType;
  @ApiProperty({ type: [SearchItemDto] }) items: SearchItemDto[];
}

export class ExactMatchDto {
  @ApiProperty({ enum: EXACT_TYPES }) type: ExactType;
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: '/bookings/9b1e…', description: 'Opened on Enter.' }) href: string;
}

export class SearchResultDto {
  @ApiProperty({ example: 'EVT-002041' }) q: string;
  @ApiProperty({ type: ExactMatchDto, nullable: true, description: 'Exact reference, email or phone match.' }) exactMatch: ExactMatchDto | null;
  @ApiProperty({ type: [SearchGroupDto], description: 'Groups in the scope, in a fixed order; empty groups included.' }) groups: SearchGroupDto[];
}
