import { ApiProperty, ApiPropertyOptional, IntersectionType, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { toArray, toBoolean, trim, trimToNull } from '../../common/dto/transforms.js';
import { PriceType, ServiceStatus } from '../../common/enums/catalog.enums.js';
import { UserStatus, VerificationStatus } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { PhotoDto } from '../../files/photo-gallery.js';
import { CategoryRefDto, PersonRefDto, WilayaRefDto } from '../../users/dto/users.dto.js';
import { PUBLISH_REQUIREMENTS, SERVICE_TABS, VISIBILITY_REASONS, type PublishRequirement, type ServiceTab, type VisibilityReason } from '../services.policy.js';

export const SERVICE_SORT_FIELDS = ['createdAt', 'bookingsCount', 'rating', 'price', 'title'] as const;

export const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
export const MONEY_MESSAGE = 'must be an amount in DZD with up to 2 decimals, e.g. "45000.00"';

/** Accepts numbers or strings, returns a 2-decimal string (or the raw value for the validator). */
export const toMoney = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value.toFixed(2);
  if (typeof value === 'string' && MONEY_PATTERN.test(value.trim())) return Number(value.trim()).toFixed(2);
  return value;
};

export const toNumber = ({ value }: { value: unknown }) => (value === '' || value === undefined ? undefined : Number(value));

export const toIntArray = ({ value }: { value: unknown }) => {
  const list = toArray({ value });
  return Array.isArray(list) ? list.map((v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v)) : list;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── list ─────────────────────────────────────────────────────

export class ServiceFiltersDto {
  @ApiPropertyOptional({
    enum: SERVICE_TABS,
    default: 'all',
    description: '`waiting_approval` = provider not verified yet; `reported` = has an open report.',
  })
  @IsOptional()
  @IsIn(SERVICE_TABS)
  tab?: ServiceTab;

  @ApiPropertyOptional({ example: 'mariage', maxLength: 120, description: 'Full-text on EN/AR titles (words of 3+ letters, prefix), title contains, provider name or business name contains.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  categoryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  providerId?: string;

  @ApiPropertyOptional({ type: [Number], example: [16, 9], description: 'Offered in any of these wilayas; repeat for several.' })
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(58, { each: true })
  wilaya?: number[];

  @ApiPropertyOptional({ example: 20000, minimum: 0, description: 'Base price ≥ (DZD).' })
  @IsOptional()
  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  priceMin?: number;

  @ApiPropertyOptional({ example: 150000, minimum: 0, description: 'Base price ≤ (DZD).' })
  @IsOptional()
  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  priceMax?: number;

  @ApiPropertyOptional({ enum: PriceType })
  @IsOptional()
  @IsEnum(PriceType)
  priceType?: PriceType;

  @ApiPropertyOptional({ minimum: 0, maximum: 5, example: 4 })
  @IsOptional()
  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  @Max(5)
  ratingMin?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 5, example: 5 })
  @IsOptional()
  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  @Max(5)
  ratingMax?: number;

  @ApiPropertyOptional({ enum: ServiceStatus })
  @IsOptional()
  @IsEnum(ServiceStatus)
  status?: ServiceStatus;

  @ApiPropertyOptional({ type: Boolean, example: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  featured?: boolean;

  @ApiPropertyOptional({ enum: UserStatus, description: 'Provider account status.' })
  @IsOptional()
  @IsEnum(UserStatus)
  providerStatus?: UserStatus;

  @ApiPropertyOptional({ format: 'date', example: '2026-01-01', description: 'Created on or after (UTC day).' })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(DATE)
  createdFrom?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-09-16', description: 'Created on or before (UTC day, inclusive).' })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(DATE)
  createdTo?: string;
}

export class ServicesQueryDto extends IntersectionType(PaginationQueryDto, ServiceFiltersDto) {}

export class ServiceTabCountsDto {
  @ApiProperty({ example: 1240 }) all: number;
  @ApiProperty({ example: 1012 }) published: number;
  @ApiProperty({ example: 148 }) draft: number;
  @ApiProperty({ example: 80 }) hidden: number;
  @ApiProperty({ example: 37 }) waiting_approval: number;
  @ApiProperty({ example: 6 }) reported: number;
}

export class ServiceProviderRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Karim Belkacem' }) fullName: string;
  @ApiProperty({ type: String, nullable: true, example: 'Studio Lumière' }) businessName: string | null;
  @ApiProperty({ enum: UserStatus }) status: UserStatus;
  @ApiProperty({ enum: VerificationStatus }) verificationStatus: VerificationStatus;
}

export class ServiceRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) titleEn: string;
  @ApiProperty({ example: 'تغطية زفاف بالصورة والفيديو' }) titleAr: string;
  @ApiProperty({ type: String, nullable: true, description: 'Signed URL of the cover thumb.' }) coverUrl: string | null;
  @ApiProperty({ type: CategoryRefDto }) category: CategoryRefDto;
  @ApiProperty({ type: ServiceProviderRefDto }) provider: ServiceProviderRefDto;
  @ApiProperty({ example: '45000.00', description: 'DZD' }) basePrice: string;
  @ApiProperty({ enum: PriceType }) priceType: PriceType;
  @ApiProperty({ example: 4.8 }) rating: number;
  @ApiProperty({ example: 126 }) ratingCount: number;
  @ApiProperty({ example: 142 }) bookingsCount: number;
  @ApiProperty({ enum: ServiceStatus }) status: ServiceStatus;
  @ApiProperty({ example: false }) isFeatured: boolean;
  @ApiProperty({ example: true, description: 'Published, provider active and verified, at least one open wilaya.' }) visibleInApp: boolean;
  @ApiProperty({ type: [WilayaRefDto] }) wilayas: WilayaRefDto[];
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

// ── detail ───────────────────────────────────────────────────

export class ServiceFactDto {
  @ApiProperty({ example: 'Duration', maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  label_en: string;

  @ApiProperty({ example: 'المدة', maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  label_ar: string;

  @ApiProperty({ example: '10 hours', maxLength: 160 })
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  value_en: string;

  @ApiProperty({ example: '10 ساعات', maxLength: 160 })
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  value_ar: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One bookable range of a weekday (ISO 1 = Monday … 7 = Sunday). An end at or before the start runs past midnight. */
export class ServiceHourDto {
  @ApiProperty({ example: 5, minimum: 1, maximum: 7, description: '1 = Monday … 7 = Sunday.' })
  @IsInt()
  @Min(1)
  @Max(7)
  weekday: number;

  @ApiProperty({ example: '20:00', description: '`HH:mm`, Africa/Algiers.' })
  @Matches(TIME, { message: 'startTime must be HH:mm' })
  startTime: string;

  @ApiProperty({ example: '00:00', description: '`HH:mm`; at or before `startTime` = past midnight. Must differ from it.' })
  @Matches(TIME, { message: 'endTime must be HH:mm' })
  endTime: string;
}

export class ServiceExtraInputDto {
  @ApiProperty({ example: 'Drone footage', maxLength: 160 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  nameEn: string;

  @ApiProperty({ example: 'تصوير بالدرون', maxLength: 160, description: 'May be empty in a draft.' })
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  nameAr: string;

  @ApiProperty({ example: '15000.00', description: 'DZD' })
  @Transform(toMoney)
  @IsString()
  @Matches(MONEY_PATTERN, { message: `price ${MONEY_MESSAGE}` })
  price: string;
}

export class ServiceExtraDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Drone footage' }) nameEn: string;
  @ApiProperty({ example: 'تصوير بالدرون' }) nameAr: string;
  @ApiProperty({ example: '15000.00' }) price: string;
  @ApiProperty({ example: 0 }) position: number;
}

export class ServiceWilayaDto extends WilayaRefDto {
  @ApiProperty({ example: true }) isOpen: boolean;
}

export class HiddenInfoDto {
  @ApiProperty({ example: 'misleading_content' }) reason: string;
  @ApiProperty({ type: String, nullable: true }) message: string | null;
  @ApiProperty({ example: true }) allowResubmit: boolean;
  @ApiProperty({ type: PersonRefDto, nullable: true }) hiddenBy: PersonRefDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) hiddenAt: string | null;
}

export class BookingsByStatusDto {
  @ApiProperty({ example: 3 }) pending: number;
  @ApiProperty({ example: 5 }) accepted: number;
  @ApiProperty({ example: 1 }) declined: number;
  @ApiProperty({ example: 2 }) cancelled: number;
  @ApiProperty({ example: 131 }) completed: number;
  @ApiProperty({ example: 142 }) total: number;
}

export class RatingBreakdownDto {
  @ApiProperty({ example: 98, name: '5' }) 5: number;
  @ApiProperty({ example: 20, name: '4' }) 4: number;
  @ApiProperty({ example: 5, name: '3' }) 3: number;
  @ApiProperty({ example: 2, name: '2' }) 2: number;
  @ApiProperty({ example: 1, name: '1' }) 1: number;
}

export class PackRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Essentiel Mariage' }) nameEn: string;
  @ApiProperty({ example: 'باقة الزفاف الأساسية' }) nameAr: string;
  @ApiProperty({ example: 'published' }) status: string;
  @ApiProperty({ example: false }) needsAttention: boolean;
}

export class ServiceStatsDetailDto {
  @ApiProperty({ type: BookingsByStatusDto }) bookings: BookingsByStatusDto;
  @ApiProperty({ example: '6390000.00', description: 'Sum of completed booking totals (DZD, informational).' }) revenue: string;
  @ApiProperty({ type: RatingBreakdownDto, description: 'Published reviews per star.' }) ratingBreakdown: RatingBreakdownDto;
  @ApiProperty({ example: 57 }) favourites: number;
  @ApiProperty({ example: 2 }) packsCount: number;
  @ApiProperty({ type: [PackRefDto] }) packs: PackRefDto[];
}

export class ServiceProviderCardDto extends ServiceProviderRefDto {
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
  @ApiProperty({ type: String, nullable: true, example: '+213550123456' }) phone: string | null;
  @ApiProperty({ example: 'karim.belkacem@gmail.com' }) email: string;
  @ApiProperty({ example: 4.8 }) rating: number;
  @ApiProperty({ example: 126 }) ratingCount: number;
  @ApiProperty({ example: true }) acceptingBookings: boolean;
  @ApiProperty({ example: 12 }) servicesCount: number;
  @ApiProperty({ example: 2 }) packsCount: number;
  @ApiProperty({ example: 142 }) bookingsCount: number;
  @ApiProperty({ example: 131 }) completedBookingsCount: number;
}

export class ServiceDetailDto extends ServiceRowDto {
  @ApiProperty({ example: 'Full-day coverage of your wedding…' }) descriptionEn: string;
  @ApiProperty({ example: 'تغطية كاملة ليوم زفافك…' }) descriptionAr: string;
  @ApiProperty({ type: String, nullable: true }) cancellationPolicyEn: string | null;
  @ApiProperty({ type: String, nullable: true }) cancellationPolicyAr: string | null;
  @ApiProperty({ type: [ServiceFactDto] }) facts: ServiceFactDto[];
  @ApiProperty({ example: true, description: '"Only one booking per day" is ticked.' }) onePerDay: boolean;
  @ApiProperty({ type: Number, nullable: true, example: 1, description: '1 when `onePerDay`; null = no daily limit.' }) maxEventsPerDay: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 400 }) maxGuests: number | null;
  @ApiProperty({ example: false, description: '"Allow several clients at the same time" is ticked.' }) allowSimultaneous: boolean;
  @ApiProperty({ type: Number, nullable: true, example: 1, description: '1 = one client per time slot; null when `allowSimultaneous`.' }) concurrentClients: number | null;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-03-01', description: 'First event date it can be booked for.' }) availableFrom: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-03-31', description: 'Last event date; hidden from the catalog after it.' }) availableUntil: string | null;
  @ApiProperty({ type: [ServiceHourDto], description: 'Bookable hours per weekday; empty = any time. When set, bookings need times inside them.' }) hours: ServiceHourDto[];
  @ApiProperty({ type: Number, nullable: true, example: 3 }) featuredPosition: number | null;
  @ApiProperty({ example: 57 }) favouritesCount: number;
  @ApiProperty({ type: [ServiceExtraDto] }) extras: ServiceExtraDto[];
  @ApiProperty({ type: [PhotoDto] }) photos: PhotoDto[];
  @ApiProperty({ type: [ServiceWilayaDto] }) wilayaDetails: ServiceWilayaDto[];
  @ApiProperty({ type: HiddenInfoDto, nullable: true }) hidden: HiddenInfoDto | null;
  @ApiProperty({ enum: VISIBILITY_REASONS, isArray: true, description: 'Why the service is not visible in the app (empty when visible).' })
  visibilityReasons: VisibilityReason[];
  @ApiProperty({ enum: PUBLISH_REQUIREMENTS, isArray: true, description: 'Publish checklist: what is still missing.' }) publishMissing: PublishRequirement[];
  @ApiProperty({ type: ServiceStatsDetailDto }) stats: ServiceStatsDetailDto;
  @ApiProperty({ type: ServiceProviderCardDto }) providerCard: ServiceProviderCardDto;
}

// ── create / update ──────────────────────────────────────────

export const WRITABLE_SERVICE_STATUSES = [ServiceStatus.Draft, ServiceStatus.Published] as const;

export class UpdateServiceDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Must be a provider account (moves the service).' })
  @IsOptional()
  @IsUUID('all')
  providerId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Must be visible when it changes.' })
  @IsOptional()
  @IsUUID('all')
  categoryId?: string;

  @ApiPropertyOptional({ example: 'Wedding photo & video coverage', maxLength: 160 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  titleEn?: string;

  @ApiPropertyOptional({ example: 'تغطية زفاف بالصورة والفيديو', maxLength: 160, description: 'May be empty in a draft; required to publish.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  titleAr?: string;

  @ApiPropertyOptional({ example: 'Full-day photo and video coverage, from the preparations to the last dance.', maxLength: 5000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(5000)
  descriptionEn?: string;

  @ApiPropertyOptional({ example: 'تغطية كاملة بالصورة والفيديو من التحضيرات إلى آخر رقصة.', maxLength: 5000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(5000)
  descriptionAr?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000, example: 'Free cancellation up to 30 days before the event.' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(5000)
  cancellationPolicyEn?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000, example: 'إلغاء مجاني حتى 30 يومًا قبل المناسبة.' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(5000)
  cancellationPolicyAr?: string | null;

  @ApiPropertyOptional({ type: [ServiceFactDto], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ServiceFactDto)
  facts?: ServiceFactDto[] | null;

  @ApiPropertyOptional({ example: '45000.00', description: 'DZD' })
  @IsOptional()
  @Transform(toMoney)
  @IsString()
  @Matches(MONEY_PATTERN, { message: `basePrice ${MONEY_MESSAGE}` })
  basePrice?: string;

  @ApiPropertyOptional({ enum: PriceType })
  @IsOptional()
  @IsEnum(PriceType)
  priceType?: PriceType;

  @ApiPropertyOptional({
    example: true,
    description:
      'The provider\'s checkbox "Only one booking per day": true = 1 booking a day, false = no daily limit (only the hours and `allowSimultaneous` limit bookings). Wins over `maxEventsPerDay`.',
  })
  @IsOptional()
  @IsBoolean()
  onePerDay?: boolean;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 1,
    minimum: 1,
    maximum: 20,
    deprecated: true,
    description: 'Deprecated: send `onePerDay`. null = no daily limit.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxEventsPerDay?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 400, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  maxGuests?: number | null;

  @ApiPropertyOptional({
    example: false,
    description:
      'The provider\'s checkbox "Allow several clients at the same time": true = any number of different clients can book the same hours, false = one client per time slot (409 `SLOT_UNAVAILABLE` for the next). Default false. Wins over `concurrentClients`.',
  })
  @IsOptional()
  @IsBoolean()
  allowSimultaneous?: boolean;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 1,
    minimum: 1,
    maximum: 50,
    deprecated: true,
    description: 'Deprecated: send `allowSimultaneous`. null = no limit.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  concurrentClients?: number | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2027-03-01', description: 'First event date it can be booked for; null = no limit.' })
  @IsOptional()
  @Matches(DATE, { message: 'availableFrom must be YYYY-MM-DD' })
  availableFrom?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2027-03-31', description: 'Last event date; the service leaves the catalog after it. Not before `availableFrom`.' })
  @IsOptional()
  @Matches(DATE, { message: 'availableUntil must be YYYY-MM-DD' })
  availableUntil?: string | null;

  @ApiPropertyOptional({ type: [ServiceHourDto], description: 'Replaces the set. Empty = bookable at any hour. Ranges of one weekday must not overlap.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => ServiceHourDto)
  hours?: ServiceHourDto[];

  @ApiPropertyOptional({ type: [Number], example: [16, 9], description: 'Replaces the set; added wilayas must be open.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(58)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(58, { each: true })
  wilayaCodes?: number[];

  @ApiPropertyOptional({ type: [ServiceExtraInputDto], description: 'Replaces the set, in this order.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ServiceExtraInputDto)
  extras?: ServiceExtraInputDto[];

  @ApiPropertyOptional({ enum: WRITABLE_SERVICE_STATUSES, description: '`published` runs the publish guard; `draft` unpublishes. Hidden services use /show.' })
  @IsOptional()
  @IsIn(WRITABLE_SERVICE_STATUSES)
  status?: (typeof WRITABLE_SERVICE_STATUSES)[number];
}

export class CreateServiceDto extends OmitType(UpdateServiceDto, ['providerId', 'categoryId', 'titleEn', 'basePrice', 'priceType'] as const) {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  providerId: string;

  @ApiProperty({ format: 'uuid', description: 'Must be visible (422 CATEGORY_HIDDEN).' })
  @IsUUID('all')
  categoryId: string;

  @ApiProperty({ example: 'Wedding photo & video coverage', maxLength: 160 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  titleEn: string;

  @ApiProperty({ example: '45000.00', description: 'DZD' })
  @Transform(toMoney)
  @IsString()
  @Matches(MONEY_PATTERN, { message: `basePrice ${MONEY_MESSAGE}` })
  basePrice: string;

  @ApiProperty({ enum: PriceType })
  @IsEnum(PriceType)
  priceType: PriceType;
}

// ── actions ──────────────────────────────────────────────────

export const HIDE_REASONS = ['misleading_content', 'inappropriate_content', 'wrong_category', 'duplicate', 'reported_by_clients', 'provider_request', 'other'] as const;

export class HideServiceDto {
  @ApiProperty({ enum: HIDE_REASONS, example: 'misleading_content' })
  @IsIn(HIDE_REASONS)
  reason: (typeof HIDE_REASONS)[number];

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, example: 'The photos are not of your own work. Please replace them.' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(2000)
  message?: string | null;

  @ApiProperty({ example: true, description: 'Whether the provider may edit and ask for publication again.' })
  @IsBoolean()
  allowResubmit: boolean;
}

export class DeleteServiceQueryDto {
  @ApiPropertyOptional({ type: Boolean, default: false, description: 'Admin override: delete even with accepted upcoming bookings (they are kept).' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  force?: boolean;
}

export class ServiceDeletedDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 2 }) cancelledBookings: number;
  @ApiProperty({ example: 0, description: 'Accepted upcoming bookings kept by `force`.' }) keptUpcomingBookings: number;
  @ApiProperty({ example: 1, description: 'Packs that now need attention.' }) packsNeedingAttention: number;
}

export class PhotoOrderDto {
  @ApiProperty({ type: [String], format: 'uuid', description: 'Every photo id once; the first becomes the cover.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  ids: string[];
}
