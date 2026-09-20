import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { toArray, trim, trimToNull } from '../../common/dto/transforms.js';
import { WilayaRegion } from '../../common/enums/catalog.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';

// ── wilayas ───────────────────────────────────────────────────

export const WILAYA_TABS = ['all', 'open', 'closed'] as const;
export type WilayaTab = (typeof WILAYA_TABS)[number];
export const WILAYA_SORT_FIELDS = ['code', 'name', 'nameAr'] as const;

export class WilayaFiltersDto {
  @ApiPropertyOptional({ enum: WILAYA_TABS, default: 'all' })
  @IsOptional()
  @IsIn(WILAYA_TABS)
  tab?: WilayaTab;

  @ApiPropertyOptional({ example: 'oran', maxLength: 80, description: 'Search in the name, the Arabic name and the code (exact).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ enum: WilayaRegion, isArray: true, description: 'Repeat for several.' })
  @IsOptional()
  @Transform(toArray)
  @IsEnum(WilayaRegion, { each: true })
  region?: WilayaRegion[];
}

export class WilayasQueryDto extends IntersectionType(PaginationQueryDto, WilayaFiltersDto) {}

export class UpdateWilayaDto {
  @ApiPropertyOptional({ example: false, description: 'Closing needs `confirm: true` (409 WILAYA_CLOSE_CONFIRM_REQUIRED otherwise).' })
  @IsOptional()
  @IsBoolean()
  isOpen?: boolean;

  @ApiPropertyOptional({ example: 'Alger', minLength: 2, maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: 'الجزائر', minLength: 2, maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nameAr?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

export class WilayaDto {
  @ApiProperty({ example: 16 })
  code: number;

  @ApiProperty({ example: 'Alger' })
  name: string;

  @ApiProperty({ example: 'الجزائر' })
  nameAr: string;

  @ApiProperty({ enum: WilayaRegion, example: WilayaRegion.NorthCentre })
  region: WilayaRegion;

  @ApiProperty({ example: true })
  isOpen: boolean;

  @ApiProperty({ example: 57 })
  communesCount: number;

  @ApiProperty({ example: 120, description: 'Providers serving this wilaya (their default area).' })
  providersCount: number;

  @ApiProperty({ example: 310, description: 'Published services offered in this wilaya (hidden from search when it is closed).' })
  servicesCount: number;

  @ApiProperty({ example: 4200, description: 'Clients living in this wilaya.' })
  clientsCount: number;

  @ApiProperty({ format: 'date-time', example: '2026-09-15T10:00:00.000Z' })
  updatedAt: string;
}

export class WilayaTabCountsDto {
  @ApiProperty({ example: 58 })
  all: number;

  @ApiProperty({ example: 48 })
  open: number;

  @ApiProperty({ example: 10 })
  closed: number;
}

// ── communes ──────────────────────────────────────────────────

export const COMMUNE_SORT_FIELDS = ['name', 'nameAr', 'postalCode', 'createdAt'] as const;
const POSTAL_CODE = /^\d{5}$/;

export class CommunesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'bab', maxLength: 120, description: 'Search in the name, the Arabic name and the postal code.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class CreateCommuneDto {
  @ApiProperty({ example: 16, minimum: 1, maximum: 58 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(255)
  wilayaCode: number;

  @ApiProperty({ example: 'Bab El Oued', maxLength: 120, description: 'Unique in the wilaya (case- and accent-insensitive).' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'باب الوادي', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nameAr: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '16009', pattern: '^\\d{5}$' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Matches(POSTAL_CODE, { message: 'postalCode must have 5 digits' })
  postalCode?: string | null;
}

export class UpdateCommuneDto {
  @ApiPropertyOptional({ example: 'Bab El Oued', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'باب الوادي', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nameAr?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '16009', description: 'null (or empty) clears it.' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Matches(POSTAL_CODE, { message: 'postalCode must have 5 digits' })
  postalCode?: string | null;
}

export class CommuneDto {
  @ApiProperty({ format: 'uuid', example: '2d7f6e5a-4b3c-4d2e-9f1a-0b1c2d3e4f5a' })
  id: string;

  @ApiProperty({ example: 16 })
  wilayaCode: number;

  @ApiProperty({ example: 'Bab El Oued' })
  name: string;

  @ApiProperty({ example: 'باب الوادي' })
  nameAr: string;

  @ApiProperty({ type: String, nullable: true, example: '16009' })
  postalCode: string | null;

  @ApiProperty({ example: 0, description: 'Bookings at this commune; a commune in use cannot be deleted.' })
  bookingsCount: number;

  @ApiProperty({ format: 'date-time', example: '2026-09-15T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-15T10:00:00.000Z' })
  updatedAt: string;
}

export class CsvLineErrorDto {
  @ApiProperty({ example: 4, description: 'Line in the file (the header is line 1).' })
  line: number;

  @ApiProperty({ example: 'postal_code must have 5 digits' })
  message: string;
}

export class CommunesImportResultDto {
  @ApiProperty({ example: 40 })
  created: number;

  @ApiProperty({ example: 3, description: 'Existing communes whose Arabic name or postal code changed.' })
  updated: number;

  @ApiProperty({ example: 14, description: 'Rows identical to an existing commune.' })
  skipped: number;

  @ApiProperty({ type: [CsvLineErrorDto] })
  errors: CsvLineErrorDto[];
}
