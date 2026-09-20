import { ApiProperty, ApiPropertyOptional, IntersectionType, OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { trim, trimToNull } from '../../common/dto/transforms.js';
import { EventType, PackStatus, PriceType, ServiceStatus } from '../../common/enums/catalog.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { PhotoDto } from '../../files/photo-gallery.js';
import { BookingsByStatusDto, MONEY_MESSAGE, MONEY_PATTERN, ServiceProviderRefDto, toIntArray, toMoney, toNumber } from '../../services/dto/services.dto.js';
import { CategoryRefDto, PersonRefDto, WilayaRefDto } from '../../users/dto/users.dto.js';
import { ATTENTION_REASONS, PACK_MAX_ITEMS, PACK_MIN_ITEMS, PACK_PUBLISH_REQUIREMENTS, PACK_TABS, type AttentionReasonCode, type PackPublishRequirement, type PackTab } from '../packs.policy.js';

export const PACK_SORT_FIELDS = ['createdAt', 'price', 'bookingsCount', 'rating', 'name'] as const;

export class PackFiltersDto {
  @ApiPropertyOptional({ enum: PACK_TABS, default: 'all', description: '`needs_attention`: an item is not published or deleted, or the provider is blocked or unverified.' })
  @IsOptional()
  @IsIn(PACK_TABS)
  tab?: PackTab;

  @ApiPropertyOptional({ example: 'Essentiel', maxLength: 120, description: 'Name EN/AR, provider name or business name contains.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  providerId?: string;

  @ApiPropertyOptional({ enum: EventType })
  @IsOptional()
  @IsEnum(EventType)
  eventType?: EventType;

  @ApiPropertyOptional({ type: [Number], example: [9], description: 'Pack wilaya; repeat for several.' })
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(58, { each: true })
  wilaya?: number[];

  @ApiPropertyOptional({ example: 100000, minimum: 0 })
  @IsOptional()
  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  priceMin?: number;

  @ApiPropertyOptional({ example: 400000, minimum: 0 })
  @IsOptional()
  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  priceMax?: number;
}

export class PacksQueryDto extends IntersectionType(PaginationQueryDto, PackFiltersDto) {}

export class PackTabCountsDto {
  @ApiProperty({ example: 86 }) all: number;
  @ApiProperty({ example: 61 }) published: number;
  @ApiProperty({ example: 14 }) draft: number;
  @ApiProperty({ example: 8 }) unpublished: number;
  @ApiProperty({ example: 3 }) needs_attention: number;
}

export class CategoryNameDto {
  @ApiProperty({ example: 'Venues' }) nameEn: string;
  @ApiProperty({ example: 'قاعات الحفلات' }) nameAr: string;
}

export class PackRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Essentiel Mariage' }) nameEn: string;
  @ApiProperty({ example: 'باقة الزفاف الأساسية' }) nameAr: string;
  @ApiProperty({ type: String, nullable: true }) coverUrl: string | null;
  @ApiProperty({ type: ServiceProviderRefDto }) provider: ServiceProviderRefDto;
  @ApiProperty({ example: 3 }) itemsCount: number;
  @ApiProperty({ type: [CategoryNameDto], description: 'Category of each item, in item order.' }) itemsSummary: CategoryNameDto[];
  @ApiProperty({ example: '380000.00', description: 'DZD' }) price: string;
  @ApiProperty({ example: '425000.00', description: 'Sum of the items’ base prices (deleted items excluded).' }) sumOfItems: string;
  @ApiProperty({ example: '45000.00', description: 'sumOfItems − price (negative when the pack costs more).' }) savings: string;
  @ApiProperty({ example: 10.6 }) savingsPercent: number;
  @ApiProperty({ enum: EventType }) eventType: EventType;
  @ApiProperty({ type: WilayaRefDto }) wilaya: WilayaRefDto;
  @ApiProperty({ example: 4.7 }) rating: number;
  @ApiProperty({ example: 18 }) ratingCount: number;
  @ApiProperty({ example: 21 }) bookingsCount: number;
  @ApiProperty({ enum: PackStatus }) status: PackStatus;
  @ApiProperty({ example: false }) needsAttention: boolean;
  @ApiProperty({ example: true }) visibleInApp: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export const ITEM_AVAILABILITY = ['available', 'not_published', 'hidden', 'deleted'] as const;

export class PackItemServiceDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Grande salle · 150 seats' }) titleEn: string;
  @ApiProperty({ example: 'القاعة الكبرى · 150 مقعدًا' }) titleAr: string;
  @ApiProperty({ type: String, nullable: true }) coverUrl: string | null;
  @ApiProperty({ type: CategoryRefDto }) category: CategoryRefDto;
  @ApiProperty({ enum: ServiceStatus }) status: ServiceStatus;
  @ApiProperty({ enum: PriceType }) priceType: PriceType;
  @ApiProperty({ example: 4.6 }) rating: number;
}

export class PackItemDto {
  @ApiProperty({ example: 0 }) position: number;
  @ApiProperty({ type: PackItemServiceDto }) service: PackItemServiceDto;
  @ApiProperty({ example: '250000.00', description: 'Base price of the service (DZD).' }) price: string;
  @ApiProperty({ enum: ITEM_AVAILABILITY, description: 'Whether the item can be sold in the pack.' }) availability: (typeof ITEM_AVAILABILITY)[number];
}

export class AttentionReasonDto {
  @ApiProperty({ enum: ATTENTION_REASONS }) code: AttentionReasonCode;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) serviceId: string | null;
}

export class PackStatsDto {
  @ApiProperty({ type: BookingsByStatusDto }) bookings: BookingsByStatusDto;
  @ApiProperty({ example: '1520000.00', description: 'Sum of completed booking totals (DZD, informational).' }) revenue: string;
}

export class PackDetailDto extends PackRowDto {
  @ApiProperty({ type: String, nullable: true }) descriptionEn: string | null;
  @ApiProperty({ type: String, nullable: true }) descriptionAr: string | null;
  @ApiProperty({ type: Number, nullable: true, example: 150 }) maxGuests: number | null;
  @ApiProperty({ type: [PackItemDto] }) items: PackItemDto[];
  @ApiProperty({ type: [PhotoDto] }) photos: PhotoDto[];
  @ApiProperty({ type: [AttentionReasonDto], description: 'Why the pack needs attention (empty when healthy).' }) attentionReasons: AttentionReasonDto[];
  @ApiProperty({ enum: PACK_PUBLISH_REQUIREMENTS, isArray: true, description: 'Publish checklist: what is still missing.' }) publishMissing: PackPublishRequirement[];
  @ApiProperty({ type: PackStatsDto }) stats: PackStatsDto;
  @ApiProperty({ type: PersonRefDto, nullable: true }) createdBy: PersonRefDto | null;
}

export class UpdatePackDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Owner; every item must belong to them.' })
  @IsOptional()
  @IsUUID('all')
  providerId?: string;

  @ApiPropertyOptional({ example: 'Essentiel Mariage', maxLength: 160 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  nameEn?: string;

  @ApiPropertyOptional({ example: 'باقة الزفاف الأساسية', maxLength: 160, description: 'May be empty in a draft.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  nameAr?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(5000)
  descriptionEn?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(5000)
  descriptionAr?: string | null;

  @ApiPropertyOptional({ enum: EventType })
  @IsOptional()
  @IsEnum(EventType)
  eventType?: EventType;

  @ApiPropertyOptional({ example: 9, minimum: 1, maximum: 58 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(58)
  wilayaCode?: number;

  @ApiPropertyOptional({ example: '380000.00', description: 'DZD; must be below the sum of the items to publish.' })
  @IsOptional()
  @Transform(toMoney)
  @IsString()
  @Matches(MONEY_PATTERN, { message: `price ${MONEY_MESSAGE}` })
  price?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 150 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  maxGuests?: number | null;

  @ApiPropertyOptional({ type: [String], format: 'uuid', minItems: PACK_MIN_ITEMS, maxItems: PACK_MAX_ITEMS, description: 'Ordered; replaces the items.' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(PACK_MIN_ITEMS)
  @ArrayMaxSize(PACK_MAX_ITEMS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  serviceIds?: string[];
}

export class CreatePackDto extends OmitType(UpdatePackDto, ['providerId', 'nameEn', 'eventType', 'wilayaCode', 'price', 'serviceIds'] as const) {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  providerId: string;

  @ApiProperty({ example: 'Essentiel Mariage', maxLength: 160 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  nameEn: string;

  @ApiProperty({ enum: EventType })
  @IsEnum(EventType)
  eventType: EventType;

  @ApiProperty({ example: 9, minimum: 1, maximum: 58, description: 'Must be open.' })
  @IsInt()
  @Min(1)
  @Max(58)
  wilayaCode: number;

  @ApiProperty({ example: '380000.00', description: 'DZD' })
  @Transform(toMoney)
  @IsString()
  @Matches(MONEY_PATTERN, { message: `price ${MONEY_MESSAGE}` })
  price: string;

  @ApiProperty({ type: [String], format: 'uuid', minItems: PACK_MIN_ITEMS, maxItems: PACK_MAX_ITEMS, description: 'Ordered services of the provider.' })
  @IsArray()
  @ArrayMinSize(PACK_MIN_ITEMS)
  @ArrayMaxSize(PACK_MAX_ITEMS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  serviceIds: string[];
}

export class PackDeletedDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 1 }) cancelledBookings: number;
}
