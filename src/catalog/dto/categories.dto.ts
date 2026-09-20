import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { trim, trimToNull } from '../../common/dto/transforms.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../catalog.policy.js';

export const CATEGORY_TABS = ['all', 'shown', 'hidden'] as const;
export type CategoryTab = (typeof CATEGORY_TABS)[number];
export const CATEGORY_SORT_FIELDS = ['position', 'nameEn', 'nameAr', 'createdAt'] as const;

export class CategoryFiltersDto {
  @ApiPropertyOptional({ enum: CATEGORY_TABS, default: 'all', description: '`shown` = visible in the app, `hidden` = not selectable for new services.' })
  @IsOptional()
  @IsIn(CATEGORY_TABS)
  tab?: CategoryTab;

  @ApiPropertyOptional({ example: 'photo', maxLength: 100, description: 'Search in the EN and AR names and the slug.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class CategoriesQueryDto extends IntersectionType(PaginationQueryDto, CategoryFiltersDto) {}

const ICON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateCategoryDto {
  @ApiPropertyOptional({ example: 'photographie', maxLength: SLUG_MAX_LENGTH, description: 'Lowercase kebab-case; generated from `nameEn` when omitted.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  @Matches(SLUG_PATTERN, { message: 'slug must be lowercase kebab-case (a-z, 0-9, -)' })
  slug?: string;

  @ApiProperty({ example: 'Photography', maxLength: 120, description: 'EN and AR names: at least one; an empty one shows "Missing translation".' })
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  nameEn: string;

  @ApiProperty({ example: 'تصوير', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  nameAr: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Photographers and videographers for your events.', maxLength: 2000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  descriptionEn?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'مصورون لمناسباتكم.', maxLength: 2000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  descriptionAr?: string | null;

  @ApiProperty({ example: 'camera', maxLength: 40, description: 'Icon name from the dashboard icon set (kebab-case).' })
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  @Matches(ICON, { message: 'icon must be a kebab-case icon name' })
  icon: string;

  @ApiPropertyOptional({ example: true, description: 'Shown in app. Hidden categories are not selectable for new services. Default `true`.' })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional({ example: 'photographie', maxLength: SLUG_MAX_LENGTH })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  @Matches(SLUG_PATTERN, { message: 'slug must be lowercase kebab-case (a-z, 0-9, -)' })
  slug?: string;

  @ApiPropertyOptional({ example: 'Photography', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @ApiPropertyOptional({ example: 'تصوير', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  nameAr?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  descriptionEn?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  descriptionAr?: string | null;

  @ApiPropertyOptional({ example: 'camera', maxLength: 40 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  @Matches(ICON, { message: 'icon must be a kebab-case icon name' })
  icon?: string;

  @ApiPropertyOptional({ example: false, description: 'The "Shown in app" toggle.' })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;
}

export class ReorderCategoriesDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    example: ['7c4a1f0e-2b6d-4e8a-9c3f-1d2e3f4a5b6c', '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'],
    description: 'Category ids in their new order. May be the whole list or one tab: the ids take the position slots they already occupy.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids: string[];
}

export class DeleteCategoryQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Move the services and providers of the category here first.' })
  @IsOptional()
  @IsUUID('all')
  moveTo?: string;
}

export class CategoryDto {
  @ApiProperty({ format: 'uuid', example: '7c4a1f0e-2b6d-4e8a-9c3f-1d2e3f4a5b6c' })
  id: string;

  @ApiProperty({ example: 'photographie' })
  slug: string;

  @ApiProperty({ example: 'Photography' })
  nameEn: string;

  @ApiProperty({ example: 'تصوير' })
  nameAr: string;

  @ApiProperty({ type: String, nullable: true, example: 'Photographers and videographers for your events.' })
  descriptionEn: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'مصورون لمناسباتكم.' })
  descriptionAr: string | null;

  @ApiProperty({ example: 'camera' })
  icon: string;

  @ApiProperty({ example: 3 })
  position: number;

  @ApiProperty({ example: true })
  isVisible: boolean;

  @ApiProperty({ example: 42, description: 'Services in the category (any status, not deleted).' })
  servicesCount: number;

  @ApiProperty({ example: 17, description: 'Providers whose main category it is.' })
  providersCount: number;

  @ApiProperty({ example: 9, description: 'Bookings of its services created in the last 30 days.' })
  bookings30dCount: number;

  @ApiProperty({ example: false, description: 'A name, or one of the descriptions, is missing in EN or AR.' })
  missingTranslation: boolean;

  @ApiProperty({ format: 'date-time', example: '2026-09-01T09:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-15T10:00:00.000Z' })
  updatedAt: string;
}

export class CategoryTabCountsDto {
  @ApiProperty({ example: 12 })
  all: number;

  @ApiProperty({ example: 10 })
  shown: number;

  @ApiProperty({ example: 2 })
  hidden: number;
}

export class CategoryPositionDto {
  @ApiProperty({ format: 'uuid', example: '7c4a1f0e-2b6d-4e8a-9c3f-1d2e3f4a5b6c' })
  id: string;

  @ApiProperty({ example: 0 })
  position: number;
}
