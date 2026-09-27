import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { toArray, toBoolean, trim } from '../../common/dto/transforms.js';
import { BookingStatus } from '../../common/enums/booking.enums.js';
import { EventType, PriceType } from '../../common/enums/catalog.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { DAY_STATES, type DayState } from '../app.policy.js';
import { AppCategoryDto, AppCategoryRefDto, AppWilayaRefDto } from './app-me.dto.js';

// Re-exported so the app-catalog controller and service have one DTO import.
export { AppCategoryDto, AppCategoryRefDto, AppWilayaRefDto };

export const APP_SERVICE_SORTS = ['relevance', 'price_asc', 'price_desc', 'rating', 'popular', 'newest'] as const;
export type AppServiceSort = (typeof APP_SERVICE_SORTS)[number];

export class AppPhotoDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ description: '320 px WebP.' }) thumbUrl: string;
  @ApiProperty({ description: '800 px WebP.' }) mediumUrl: string;
  @ApiProperty({ description: 'Full-size WebP (capped at `photo_max_dimension_px`).' }) largeUrl: string;
  @ApiProperty({ type: Number, nullable: true, example: 1920 }) width: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 1280 }) height: number | null;
}

/** The provider strip on screens 11, 12 and 19. Never carries a phone or an email. */
export class AppProviderSummaryDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'The provider’s **user id** — the same id `GET /app/providers/{id}` takes and `POST /app/conversations` accepts as `userId` for the "Message" button.',
  })
  id: string;
  @ApiProperty({ example: 'Studio Lumière' }) businessName: string;
  @ApiProperty({ type: AppCategoryRefDto, nullable: true }) category: AppCategoryRefDto | null;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
  @ApiProperty({ example: true, description: '"Verified provider" badge.' }) verified: boolean;
  @ApiProperty({ example: '4.80' }) avgRating: string;
  @ApiProperty({ example: 32 }) ratingCount: number;
  @ApiProperty({ example: 48, description: '"events done".' }) completedBookingsCount: number;
  @ApiProperty({ type: Number, nullable: true, example: 6, description: '"6 years on Eventor".' }) yearsActive: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 120, description: 'Average first reply, in minutes.' }) avgReplyMinutes: number | null;
  @ApiProperty({ type: String, nullable: true, example: '2 h', description: '"Usually replies in 2 h".' }) replyTime: string | null;
  @ApiProperty({ example: true, description: 'False hides the booking CTA (provider paused bookings).' }) acceptingBookings: boolean;
}

/** A card in a list: screens 11 "Providers near you", search results, 13 "Services". */
export class AppServiceCardDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Wedding photo & video coverage', description: 'In the caller’s language.' }) title: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) titleEn: string;
  @ApiProperty({ example: 'تغطية تصوير الأعراس' }) titleAr: string;
  @ApiProperty({ type: AppCategoryRefDto, nullable: true }) category: AppCategoryRefDto | null;
  @ApiProperty({ example: '45000.00', description: 'DZD, 2 decimals.' }) basePrice: string;
  @ApiProperty({ enum: PriceType, example: PriceType.PerDay }) priceType: PriceType;
  @ApiProperty({ example: 'per day', description: 'Price type in the caller’s language.' }) priceTypeLabel: string;
  @ApiProperty({ example: '4.80' }) avgRating: string;
  @ApiProperty({ example: 32 }) ratingCount: number;
  @ApiProperty({ example: 12 }) bookingsCount: number;
  @ApiProperty({ type: String, nullable: true }) coverUrl: string | null;
  @ApiProperty({ type: [AppWilayaRefDto], description: 'Open wilayas the service covers.' }) wilayas: AppWilayaRefDto[];
  @ApiProperty({ type: AppProviderSummaryDto }) provider: AppProviderSummaryDto;
  @ApiProperty({ example: false, description: 'Always false for anonymous callers.' }) isFavourite: boolean;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The caller’s favourite row over this service (null when not saved, or anonymous). Un-save with `DELETE /app/me/favourites/{favouriteId}` — or by target with `DELETE /app/me/favourites?serviceId=`.',
  })
  favouriteId: string | null;
}

export class AppServiceExtraDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Pre-wedding session' }) name: string;
  @ApiProperty({ example: 'Pre-wedding session' }) nameEn: string;
  @ApiProperty({ example: 'جلسة ما قبل الزفاف' }) nameAr: string;
  @ApiProperty({ example: '12000.00' }) price: string;
}

export class AppServiceFactDto {
  @ApiProperty({ example: 'Duration' }) label: string;
  @ApiProperty({ example: '10 h' }) value: string;
  @ApiProperty({ example: 'Duration' }) labelEn: string;
  @ApiProperty({ example: '10 h' }) valueEn: string;
  @ApiProperty({ example: 'المدة' }) labelAr: string;
  @ApiProperty({ example: '10 ساعات' }) valueAr: string;
}

export class AppRatingBucketDto {
  @ApiProperty({ example: 5 }) stars: number;
  @ApiProperty({ example: 24 }) count: number;
  @ApiProperty({ example: 75 }) percent: number;
}

export class AppReviewDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Yasmine K.', description: 'The author’s first name plus an initial — never the full name, email or phone.' })
  authorName: string;
  @ApiProperty({ type: String, nullable: true }) authorAvatarUrl: string | null;
  @ApiProperty({ example: 5 }) rating: number;
  @ApiProperty({ example: 'Wonderful team, the photos arrived in two weeks.', description: 'The redacted text when an admin redacted the review.' })
  comment: string;
  @ApiProperty({ example: false, description: 'True when an admin removed contact details from the text.' }) redacted: boolean;
  @ApiProperty({ type: String, nullable: true, example: 'Thank you Yasmine!', description: 'The provider’s published reply.' }) reply: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) repliedAt: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppPackCardDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Essentiel Mariage' }) name: string;
  @ApiProperty({ example: 'Essentiel Mariage' }) nameEn: string;
  @ApiProperty({ example: 'أساسيات الزفاف' }) nameAr: string;
  @ApiProperty({ enum: EventType, example: EventType.Wedding }) eventType: EventType;
  @ApiProperty({ type: AppWilayaRefDto }) wilaya: AppWilayaRefDto;
  @ApiProperty({ example: '320000.00' }) price: string;
  @ApiProperty({ example: '365000.00', description: 'Sum of the items’ base prices ("versus booking separately").' }) sumOfItems: string;
  @ApiProperty({ example: '45000.00', description: '"Save 45 000 DA".' }) savings: string;
  @ApiProperty({ example: 12.3 }) savingsPercent: number;
  @ApiProperty({ example: 4 }) itemsCount: number;
  @ApiProperty({ type: [String], example: ['Venue', 'Photography', 'Catering'], description: 'Category names, in order ("Venue · Photo · Catering").' })
  categoryNames: string[];
  @ApiProperty({ type: String, nullable: true }) coverUrl: string | null;
  @ApiProperty({ example: 4.9, type: Number, description: 'A number (0–5, 2 decimals), like every pack rating.' }) avgRating: number;
  @ApiProperty({ example: 18 }) ratingCount: number;
  @ApiProperty({ example: 12, description: '"booked 12 times this year".' }) bookingsCount: number;
  @ApiProperty({ type: AppProviderSummaryDto }) provider: AppProviderSummaryDto;
  @ApiProperty({ example: false }) isFavourite: boolean;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The caller’s favourite row over this pack (null when not saved, or anonymous). Un-save with `DELETE /app/me/favourites/{favouriteId}` — or by target with `DELETE /app/me/favourites?packId=`.',
  })
  favouriteId: string | null;
}

export class AppPackItemDto {
  @ApiProperty({ format: 'uuid' }) serviceId: string;
  @ApiProperty({ example: 'Grande salle' }) title: string;
  @ApiProperty({ example: 'Grande salle' }) titleEn: string;
  @ApiProperty({ example: 'القاعة الكبرى' }) titleAr: string;
  @ApiProperty({ type: AppCategoryRefDto, nullable: true }) category: AppCategoryRefDto | null;
  @ApiProperty({ example: '200000.00' }) price: string;
  @ApiProperty({ enum: PriceType }) priceType: PriceType;
  @ApiProperty({ type: String, nullable: true }) coverUrl: string | null;
  @ApiProperty({ example: 0 }) position: number;
}

export class AppPackDetailDto extends AppPackCardDto {
  @ApiProperty({ type: String, nullable: true, example: 'Everything for a 150-guest wedding in Alger.' }) description: string | null;
  @ApiProperty({ type: String, nullable: true }) descriptionEn: string | null;
  @ApiProperty({ type: String, nullable: true }) descriptionAr: string | null;
  @ApiProperty({ type: Number, nullable: true, example: 150 }) maxGuests: number | null;
  @ApiProperty({ type: [AppPhotoDto] }) photos: AppPhotoDto[];
  @ApiProperty({ type: [AppPackItemDto] }) items: AppPackItemDto[];
  @ApiProperty({ type: [AppWilayaRefDto], description: 'Wilayas every item covers (the intersection).' }) wilayas: AppWilayaRefDto[];
  @ApiProperty({ type: [AppReviewDto] }) recentReviews: AppReviewDto[];
}

export class AppServiceDetailDto extends AppServiceCardDto {
  @ApiProperty({ example: 'We cover the whole day…' }) description: string;
  @ApiProperty({ example: 'We cover the whole day…' }) descriptionEn: string;
  @ApiProperty({ example: 'نغطي اليوم بأكمله…' }) descriptionAr: string;
  @ApiProperty({ type: String, nullable: true, example: 'Free cancellation up to 30 days before.', description: '"Good to know" / cancellation policy.' })
  cancellationPolicy: string | null;
  @ApiProperty({ type: String, nullable: true }) cancellationPolicyEn: string | null;
  @ApiProperty({ type: String, nullable: true }) cancellationPolicyAr: string | null;
  @ApiProperty({ type: [AppServiceFactDto], description: 'Key facts (duration, team, deliverables).' }) facts: AppServiceFactDto[];
  @ApiProperty({ type: [AppServiceExtraDto], description: '"What’s included" / paid add-ons.' }) extras: AppServiceExtraDto[];
  @ApiProperty({ type: [AppPhotoDto] }) photos: AppPhotoDto[];
  @ApiProperty({ type: Number, nullable: true, example: 300 }) maxGuests: number | null;
  @ApiProperty({ example: 1, description: 'Events the provider takes per day for this service.' }) maxEventsPerDay: number;
  @ApiProperty({ type: [AppRatingBucketDto] }) ratingBreakdown: AppRatingBucketDto[];
  @ApiProperty({ type: [AppReviewDto] }) recentReviews: AppReviewDto[];
  @ApiProperty({ type: [AppPackCardDto], description: '"Packs from this provider".' }) providerPacks: AppPackCardDto[];
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export class AppProviderCheckDto {
  @ApiProperty({ example: 'identity' }) code: string;
  @ApiProperty({ example: 'Identity verified' }) title: string;
  @ApiProperty({ example: 'National ID checked by Eventor' }) detail: string;
  @ApiProperty({ example: true }) passed: boolean;
}

export class AppProviderDetailDto extends AppProviderSummaryDto {
  @ApiProperty({ type: String, nullable: true }) bio: string | null;
  @ApiProperty({ type: String, nullable: true }) bioEn: string | null;
  @ApiProperty({ type: String, nullable: true }) bioAr: string | null;
  @ApiProperty({ type: [String], nullable: true, example: ['ar', 'fr', 'en'] }) languagesSpoken: string[] | null;
  @ApiProperty({ type: [AppWilayaRefDto], description: '"Where they work".' }) wilayas: AppWilayaRefDto[];
  @ApiProperty({ type: [AppProviderCheckDto], description: '"What we checked".' }) checks: AppProviderCheckDto[];
  @ApiProperty({ example: 5 }) servicesCount: number;
  @ApiProperty({ type: [AppServiceCardDto] }) services: AppServiceCardDto[];
  @ApiProperty({ type: [AppPackCardDto] }) packs: AppPackCardDto[];
  @ApiProperty({ type: [AppRatingBucketDto] }) ratingBreakdown: AppRatingBucketDto[];
  @ApiProperty({ type: [AppReviewDto] }) recentReviews: AppReviewDto[];
  @ApiProperty({ format: 'date-time', description: 'Account creation ("on Eventor since").' }) memberSince: string;
}

/** One row of `GET /app/wilayas`: the wilaya plus how many services it holds. */
export class AppWilayaListDto extends AppWilayaRefDto {
  @ApiProperty({ example: 42, description: 'Services visible in the app that cover this wilaya. The list is ordered by this count (highest first) — there is no separate `position`.' })
  servicesCount: number;
}

/** A commune of a wilaya (`GET /app/wilayas/{code}/communes`), for the booking address picker. */
export class AppCommuneDto {
  @ApiProperty({ format: 'uuid', description: 'Send it as `communeId` on `POST /app/bookings`.' }) id: string;
  @ApiProperty({ example: 16 }) wilayaCode: number;
  @ApiProperty({ example: 'Hydra', description: 'In the caller’s language.' }) name: string;
  @ApiProperty({ example: 'Hydra' }) nameEn: string;
  @ApiProperty({ example: 'حيدرة' }) nameAr: string;
  @ApiProperty({ type: String, nullable: true, example: '16035' }) postalCode: string | null;
}

export class AppCommunesQueryDto {
  @ApiPropertyOptional({ example: 'hyd', description: 'Filter on the commune name (EN or AR) or postal code.' })
  @IsOptional() @Transform(trim) @IsString() @Length(1, 80)
  q?: string;
}

// ── availability (screens 12 / 20) ──────────────────────────

export class AppAvailabilityDayDto {
  @ApiProperty({ format: 'date', example: '2026-03-14' }) date: string;
  @ApiProperty({ enum: DAY_STATES, example: 'available' }) state: DayState;
}

export class AppAvailabilityDto {
  @ApiProperty({ example: '2026-03' }) month: string;
  @ApiProperty({ example: 1, description: 'Events accepted per day (the smallest among a pack’s items).' }) maxEventsPerDay: number;
  @ApiProperty({ example: 0, description: '`booking_min_notice_days`: days before which nothing can be booked.' }) minNoticeDays: number;
  @ApiProperty({ format: 'date', example: '2026-03-01', description: 'First bookable day (Africa/Algiers).' }) firstBookableDate: string;
  @ApiProperty({ type: [AppAvailabilityDayDto] }) days: AppAvailabilityDayDto[];
}

// ── queries ─────────────────────────────────────────────────

export class AppServicesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'photo', description: 'Free text over service titles and provider names.' })
  @IsOptional() @Transform(trim) @IsString() @Length(1, 120)
  q?: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Category chip (screen 11). Repeat the parameter to search several categories at once, like `wilaya`.' })
  @IsOptional() @Transform(toArray) @IsUUID('4', { each: true })
  categoryId?: string[];

  @ApiPropertyOptional({ type: [Number], example: [16], description: 'Repeat for several wilayas.' })
  @IsOptional() @Transform(toArray) @Type(() => Number) @IsInt({ each: true }) @Min(1, { each: true }) @Max(58, { each: true })
  wilaya?: number[];

  @ApiPropertyOptional({ example: 10000, description: 'DZD.' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  priceMin?: number;

  @ApiPropertyOptional({ example: 200000 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  priceMax?: number;

  @ApiPropertyOptional({ example: 4, minimum: 1, maximum: 5, description: 'Minimum average rating.' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(5)
  rating?: number;

  @ApiPropertyOptional({ format: 'date', example: '2026-03-14', description: 'Keep only services free on that day.' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'eventDate must be YYYY-MM-DD' })
  eventDate?: string;

  @ApiPropertyOptional({ enum: EventType, description: 'Matches the categories used by packs of that event type.' })
  @IsOptional() @IsEnum(EventType)
  eventType?: EventType;

  @ApiPropertyOptional({ description: 'Only services I marked as favourite (needs a token).' })
  @IsOptional() @Transform(toBoolean) @IsBoolean()
  favourite?: boolean;

  @ApiPropertyOptional({
    enum: APP_SERVICE_SORTS,
    default: 'relevance',
    description: '`relevance` (search score, then rating), `price_asc`, `price_desc`, `rating`, `popular`, `newest`.',
  })
  @IsOptional() @IsEnum(Object.fromEntries(APP_SERVICE_SORTS.map((s) => [s, s])))
  order?: AppServiceSort;

  /** `sort=field:dir` is not used by the app search; `order` replaces it. */
  declare sort?: string;
}

export class AppPacksQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: EventType, description: 'Event-type tab (screen 19).' })
  @IsOptional() @IsEnum(EventType)
  eventType?: EventType;

  @ApiPropertyOptional({ type: [Number], example: [16] })
  @IsOptional() @Transform(toArray) @Type(() => Number) @IsInt({ each: true }) @Min(1, { each: true }) @Max(58, { each: true })
  wilaya?: number[];

  @ApiPropertyOptional({ example: 500000 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  priceMax?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only packs led by this provider.' })
  @IsOptional() @IsUUID('4')
  providerId?: string;

  @ApiPropertyOptional({ enum: ['savings', 'price_asc', 'price_desc', 'rating', 'popular'], default: 'savings' })
  @IsOptional() @IsEnum({ savings: 'savings', price_asc: 'price_asc', price_desc: 'price_desc', rating: 'rating', popular: 'popular' })
  order?: 'savings' | 'price_asc' | 'price_desc' | 'rating' | 'popular';

  declare sort?: string;
}

export class AppReviewsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Only reviews with this star rating.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5)
  rating?: number;
}

export class AppAvailabilityQueryDto {
  @ApiProperty({ example: '2026-03', description: '`YYYY-MM` (400 MONTH_INVALID otherwise).' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month: string;
}

// ── home (screen 11) ────────────────────────────────────────

export class AppHomeBookingDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EVT-000123' }) reference: string;
  @ApiProperty({ example: 'Studio Lumière' }) providerName: string;
  @ApiProperty({ type: String, nullable: true }) providerAvatarUrl: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Wedding photo & video coverage' }) title: string | null;
  @ApiProperty({ type: AppCategoryRefDto, nullable: true }) category: AppCategoryRefDto | null;
  @ApiProperty({ format: 'date', example: '2026-03-14' }) eventDate: string;
  @ApiProperty({ type: String, nullable: true, example: '13:00' }) startTime: string | null;
  @ApiProperty({ enum: BookingStatus, example: BookingStatus.Accepted }) status: BookingStatus;
  @ApiProperty({ type: String, nullable: true }) coverUrl: string | null;
}

export class AppHomeBudgetDto {
  @ApiProperty({ example: true, description: 'False when the client has no budget yet (the card offers to create one).' }) exists: boolean;
  @ApiProperty({ example: '180000.00' }) spentTotal: string;
  @ApiProperty({ example: '400000.00' }) totalAmount: string;
  @ApiProperty({ example: 45 }) spentPercent: number;
  @ApiProperty({ example: 3 }) bookedCount: number;
  @ApiProperty({ example: 6 }) itemsCount: number;
}

export class AppHomeDto {
  @ApiProperty({ example: 'Amina Benali' }) fullName: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
  @ApiProperty({ type: AppWilayaRefDto, nullable: true, description: 'The city selector at the top of screen 11.' }) wilaya: AppWilayaRefDto | null;
  @ApiProperty({ example: 2 }) unreadNotifications: number;
  @ApiProperty({ example: 1 }) unreadConversations: number;
  @ApiProperty({ type: [AppCategoryDto] }) categories: AppCategoryDto[];
  @ApiProperty({ type: [AppHomeBookingDto], description: 'The next 2 bookings ("Your bookings").' }) upcomingBookings: AppHomeBookingDto[];
  @ApiProperty({ type: AppHomeBudgetDto }) budget: AppHomeBudgetDto;
  @ApiProperty({ type: [AppPackCardDto], description: '"Ready Packs".' }) packs: AppPackCardDto[];
  @ApiProperty({ type: [AppServiceCardDto], description: '"Providers near you": services in my wilaya, best rated first.' })
  nearbyServices: AppServiceCardDto[];
}

// ── analytics stub ──────────────────────────────────────────

export enum AppEventType {
  ServiceView = 'service_view',
  Search = 'search',
}

export class TrackEventDto {
  @ApiProperty({ enum: AppEventType, example: AppEventType.ServiceView })
  @IsEnum(AppEventType)
  type: AppEventType;

  @ApiPropertyOptional({ format: 'uuid', description: 'The service opened (`service_view`).' })
  @IsOptional() @IsUUID('4')
  serviceId?: string;

  @ApiPropertyOptional({ example: 'photographe mariage', description: 'The text typed (`search`).' })
  @IsOptional() @Transform(trim) @IsString() @Length(1, 120)
  query?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID('4')
  categoryId?: string;

  @ApiPropertyOptional({ example: 16 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(58)
  wilaya?: number;
}

// ── public config ───────────────────────────────────────────

export class AppConfigLimitsDto {
  @ApiProperty({ example: 60, description: 'Maximum budget lines per client (`422 BUDGET_ITEM_LIMIT` past it, with `details.max`).' }) budgetItemsMax: number;
  @ApiProperty({ example: 12, description: '`max_photos_per_service` (422 `PHOTO_LIMIT_REACHED`).' }) photosPerService: number;
  @ApiProperty({ example: 6, description: '`max_photos_per_pack`.' }) photosPerPack: number;
  @ApiProperty({ example: 5, description: '`max_document_upload_mb` — verification documents and dispute evidence.' }) documentMaxMb: number;
  @ApiProperty({ example: 10, description: '`max_photo_upload_mb`.' }) photoMaxMb: number;
  @ApiProperty({ example: 10, description: 'Evidence files each party may attach to a dispute (422 `DISPUTE_EVIDENCE_LIMIT`).' }) disputeEvidenceMax: number;
  @ApiProperty({ example: 4000, description: 'Maximum length of a message body, everywhere a message can be sent.' }) messageMaxLength: number;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'event-request',
    description: 'Slug of the default published academic-request form — open `{APP_PUBLIC_URL}/f/{slug}` in a WebView. Null while no form is published.',
  })
  eventRequestFormSlug: string | null;
  @ApiProperty({
    type: [String],
    example: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
    description: 'MIME types accepted for documents — what the server sniffs from the bytes.',
  })
  documentAcceptedMimeTypes: string[];
  @ApiProperty({
    type: [String],
    example: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'],
    description: 'File extensions matching those MIME types — what a file picker filters on. Match pickers on these; the server still decides from the bytes.',
  })
  documentAcceptedExtensions: string[];
}

export class AppConfigDto {
  @ApiProperty({ example: '1.0.0', description: 'Below this the app must ask the user to update.' }) minAppVersion: string;
  @ApiProperty({ example: false }) maintenanceMode: boolean;
  @ApiProperty({ type: String, nullable: true, example: 'Eventor is back at 18:00.', description: 'In the caller’s language.' })
  maintenanceMessage: string | null;
  @ApiProperty({ type: String, nullable: true }) maintenanceMessageEn: string | null;
  @ApiProperty({ type: String, nullable: true }) maintenanceMessageAr: string | null;
  @ApiProperty({ type: [String], example: ['en', 'ar'] }) languages: string[];
  @ApiProperty({ example: 'en' }) defaultLanguage: string;
  @ApiProperty({ example: 'DZD' }) currency: string;
  @ApiProperty({ type: String, nullable: true, format: 'email', example: 'support@eventor.dz' }) supportEmail: string | null;
  @ApiProperty({ type: String, nullable: true, example: '+213555000000' }) supportPhone: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'https://eventor.dz/terms' }) termsUrl: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'https://eventor.dz/privacy' }) privacyUrl: string | null;
  @ApiProperty({
    example: { maxPhotoMb: 8, maxDocumentMb: 5, maxPhotosPerService: 12, imageTypes: ['jpeg', 'png', 'webp'] },
    description: 'Upload limits, so the app can refuse a file before sending it.',
  })
  uploads: { maxPhotoMb: number; maxDocumentMb: number; maxPhotosPerService: number; imageTypes: string[] };
  @ApiProperty({ type: AppConfigLimitsDto, description: 'Business limits the app should enforce locally before the server refuses.' })
  limits: AppConfigLimitsDto;
  @ApiProperty({ example: { minLength: 10, needsLetterAndDigit: true } }) passwordPolicy: { minLength: number; needsLetterAndDigit: boolean };
  @ApiProperty({ example: { minNoticeDays: 2, replyDeadlineHours: 48, cancellationWindowHours: 48 } })
  booking: { minNoticeDays: number; replyDeadlineHours: number; cancellationWindowHours: number };
}
