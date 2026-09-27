import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { AppException } from '../common/errors/app.exception.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ReqLang } from '../common/i18n/lang.decorator.js';
import type { Lang } from '../common/i18n/language.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { AppCatalogService } from './app-catalog.service.js';
import {
  AppAvailabilityDto,
  AppAvailabilityQueryDto,
  AppCategoryDto,
  AppCommuneDto,
  AppCommunesQueryDto,
  AppWilayaListDto,
  AppHomeDto,
  AppPackCardDto,
  AppPackDetailDto,
  AppPacksQueryDto,
  AppProviderDetailDto,
  AppReviewDto,
  AppReviewsQueryDto,
  AppServiceCardDto,
  AppServiceDetailDto,
  AppServicesQueryDto,
  TrackEventDto,
} from './dto/app-catalog.dto.js';

const LANGUAGE_NOTE =
  'Text comes back in the caller’s language: `Accept-Language: ar|en`, then the signed-in account’s `language`, then `en`. ' +
  'The `*En` / `*Ar` fields are always present too, for screens that show both.';

const VISIBILITY_NOTE =
  'Only services visible in the app: published, provider active **and** verified, and at least one open wilaya. ' +
  'Anything else answers 404 rather than admitting it exists.';

/**
 * Browsing, for clients and for visitors without an account. The routes that
 * personalise something (`isFavourite`, `/app/home`) need a token; the rest are
 * `@Public()` and rate-limited per IP.
 */
@ApiTags('app-catalog')
@ApiHeader({ name: 'Accept-Language', required: false, description: '`en` or `ar`. Falls back to the account’s language, then `en`.' })
@Controller('app')
export class AppCatalogController {
  constructor(private readonly catalog: AppCatalogService) {}

  /** The caller when there is one; browsing without a token is allowed. */
  private viewer(req: Request & { user?: AuthUser }): AuthUser | null {
    return req.user ?? null;
  }

  @Get('home')
  @Roles(UserRole.Client, UserRole.Provider)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Everything screen 11 Home · Client needs, in one call',
    description:
      `Screen 11 Home · Client. One round trip instead of six: greeting and wilaya, the category chips, the next ` +
      `${'`2`'} bookings, the budget summary, the best-saving Ready Packs and the top-rated services in the user’s wilaya ` +
      `(all services when they have not set one), plus the unread counters. ${LANGUAGE_NOTE}`,
  })
  @ApiDataResponse(AppHomeDto)
  @ApiErrorResponses('AUTH_TOKEN_MISSING', 'FORBIDDEN_AUDIENCE', 'USER_NOT_FOUND')
  async home(@CurrentUser() auth: AuthUser, @ReqLang() lang: Lang) {
    return { data: await this.catalog.home(auth, lang) };
  }

  @Get('categories')
  @Public()
  @ApiOperation({
    summary: 'Category chips',
    description: `Public. Screen 11 Home and 11a Filters. Visible categories in their configured order, each with how many visible services it holds. ${LANGUAGE_NOTE}`,
  })
  @ApiDataResponse(AppCategoryDto, { isArray: true })
  @ApiErrorResponses('RATE_LIMITED')
  async categories(@ReqLang() lang: Lang) {
    return { data: await this.catalog.categories(lang) };
  }

  @Get('wilayas')
  @Public()
  @ApiOperation({
    summary: 'Open wilayas',
    description:
      `Public. The city selector on screen 11 and the wilaya filter on 11a. Only wilayas open for bookings, each with ` +
      `\`servicesCount\` (services visible in the app that cover it). The list is ordered by that count, highest first — ` +
      `use the top rows as "top wilayas"; there is no separate \`position\`. ${LANGUAGE_NOTE}`,
  })
  @ApiDataResponse(AppWilayaListDto, { isArray: true })
  @ApiErrorResponses('RATE_LIMITED')
  async wilayas(@ReqLang() lang: Lang) {
    return { data: await this.catalog.wilayas(lang) };
  }

  @Get('wilayas/:code/communes')
  @Public()
  @ApiOperation({
    summary: 'Communes of a wilaya',
    description:
      `Public. The commune picker of the booking sheet: \`POST /app/bookings\` takes one of these ids as \`communeId\` ` +
      `(it must belong to the booking's \`wilayaCode\`, 422 \`COMMUNE_WILAYA_MISMATCH\` otherwise). Sorted by name; ` +
      `\`q\` filters on the name (EN or AR) or postal code. ${LANGUAGE_NOTE}`,
  })
  @ApiParam({ name: 'code', example: 16, description: 'Wilaya code (1–58).' })
  @ApiDataResponse(AppCommuneDto, { isArray: true })
  @ApiErrorResponses('VALIDATION_FAILED', 'WILAYA_NOT_FOUND', 'RATE_LIMITED')
  async communes(@Param('code') code: string, @Query() query: AppCommunesQueryDto, @ReqLang() lang: Lang) {
    const parsed = Number(code);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 58) throw AppException.of('WILAYA_NOT_FOUND', { code });
    return { data: await this.catalog.communes(parsed, query.q, lang) };
  }

  @Get('services')
  @Public()
  @ApiOperation({
    summary: 'Search services',
    description:
      `Public (a token adds ${'`isFavourite`'} and enables ${'`favourite=true`'}). The Search tab and screen 11a Filters. ` +
      `${VISIBILITY_NOTE} ${'`eventDate`'} keeps only providers with a free slot that day — no manual block and capacity ` +
      `left after held and booked events. Sort with ${'`order`'}, not ${'`sort`'}. ${LANGUAGE_NOTE}`,
  })
  @ApiPaginatedResponse(AppServiceCardDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'AUTH_TOKEN_MISSING', 'RATE_LIMITED')
  async services(@Query() query: AppServicesQueryDto, @ReqLang() lang: Lang, @Req() req: Request) {
    return this.catalog.services(query, lang, this.viewer(req));
  }

  @Get('services/:id')
  @Public()
  @ApiOperation({
    summary: 'Service detail',
    description:
      `Public (a token fills ${'`isFavourite`'}). Screen 12 Service detail: the photo carousel, key facts, description, ` +
      `"good to know", extras, covered wilayas, the provider strip with its reply time and verified badge, the rating ` +
      `breakdown, the three most recent reviews and the provider’s other packs. ${VISIBILITY_NOTE} ${LANGUAGE_NOTE} ` +
      `The provider’s phone and email are never included — the client messages them through the chat.`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppServiceDetailDto)
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'RATE_LIMITED')
  async service(@Param('id', uuidParam('SERVICE_NOT_FOUND')) id: string, @ReqLang() lang: Lang, @Req() req: Request) {
    return { data: await this.catalog.service(id, lang, this.viewer(req)) };
  }

  @Get('services/:id/availability')
  @Public()
  @ApiOperation({
    summary: 'A month of availability',
    description:
      'Public. The calendar on screen 12. Every day of the month as `available`, `busy` (the provider already has as many ' +
      'events that day as the service allows) or `blocked` (the provider blocked it, or it is before `firstBookableDate`, ' +
      'which honours `booking_min_notice_days`). Ask one month at a time.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppAvailabilityDto)
  @ApiErrorResponses('MONTH_INVALID', 'VALIDATION_FAILED', 'SERVICE_NOT_FOUND', 'RATE_LIMITED')
  async serviceAvailability(@Param('id', uuidParam('SERVICE_NOT_FOUND')) id: string, @Query() query: AppAvailabilityQueryDto) {
    return { data: await this.catalog.serviceAvailability(id, query.month) };
  }

  @Get('services/:id/reviews')
  @Public()
  @ApiOperation({
    summary: 'Reviews of a service',
    description:
      'Public. Screen 12 "See all 32". Published reviews only — a hidden one never appears, and a redacted one comes back ' +
      'with the admin’s cleaned text. Each row carries the provider’s published reply when there is one. Author names are ' +
      'shortened to "Yasmine K.".',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiPaginatedResponse(AppReviewDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'SERVICE_NOT_FOUND', 'RATE_LIMITED')
  async serviceReviews(@Param('id', uuidParam('SERVICE_NOT_FOUND')) id: string, @Query() query: AppReviewsQueryDto, @ReqLang() lang: Lang) {
    return this.catalog.serviceReviews(id, query, lang);
  }

  @Get('providers/:id')
  @Public()
  @ApiOperation({
    summary: 'Provider profile',
    description:
      `Public. Screen 13 Provider profile: the verified badge, the stats row (rating, reviews, events done, years), ` +
      `"What we checked", the bio, up to 10 visible services, their packs, the rating breakdown and recent reviews. ` +
      `Only active, verified providers; anything else is 404 ${'`PROVIDER_NOT_FOUND`'}. ${LANGUAGE_NOTE} No phone, no email.`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppProviderDetailDto)
  @ApiErrorResponses('PROVIDER_NOT_FOUND', 'RATE_LIMITED')
  async provider(@Param('id', uuidParam('PROVIDER_NOT_FOUND')) id: string, @ReqLang() lang: Lang, @Req() req: Request) {
    return { data: await this.catalog.provider(id, lang, this.viewer(req)) };
  }

  @Get('providers/:id/reviews')
  @Public()
  @ApiOperation({ summary: 'Reviews of a provider', description: 'Public. Screen 13 "See all 32". Same rules as the service reviews.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiPaginatedResponse(AppReviewDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'PROVIDER_NOT_FOUND', 'RATE_LIMITED')
  async providerReviews(@Param('id', uuidParam('PROVIDER_NOT_FOUND')) id: string, @Query() query: AppReviewsQueryDto, @ReqLang() lang: Lang) {
    return this.catalog.providerReviews(id, query, lang);
  }

  @Get('packs')
  @Public()
  @ApiOperation({
    summary: 'Ready Packs',
    description:
      'Public (a token fills `isFavourite`). Screen 19 Ready Packs. Each card carries the saving against booking the ' +
      'services separately — the default order puts the biggest saving first — the item count, the category names and ' +
      'the provider who put the pack together. A pack flagged `needs_attention` (an item was unpublished or its provider ' +
      'blocked) is never listed.',
  })
  @ApiPaginatedResponse(AppPackCardDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'RATE_LIMITED')
  async packs(@Query() query: AppPacksQueryDto, @ReqLang() lang: Lang, @Req() req: Request) {
    return this.catalog.packs(query, lang, this.viewer(req));
  }

  @Get('packs/:id')
  @Public()
  @ApiOperation({
    summary: 'Pack detail',
    description:
      'Public. Screen 20 Pack detail: photos, "what is inside" line by line with each service’s own price, the pack price ' +
      'against `sumOfItems` with the saving, the wilayas **every** item covers, and recent reviews. Call ' +
      '`/app/packs/:id/availability` for the calendar.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppPackDetailDto)
  @ApiErrorResponses('PACK_NOT_FOUND', 'RATE_LIMITED')
  async pack(@Param('id', uuidParam('PACK_NOT_FOUND')) id: string, @ReqLang() lang: Lang, @Req() req: Request) {
    return { data: await this.catalog.pack(id, lang, this.viewer(req)) };
  }

  @Get('packs/:id/availability')
  @Public()
  @ApiOperation({
    summary: 'A month of availability for a whole pack',
    description:
      'Public. The calendar on screen 20, "Only days when all providers are free": the intersection across every item’s ' +
      'provider, so one taken provider makes the day `busy`. `maxEventsPerDay` is the smallest among the items.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppAvailabilityDto)
  @ApiErrorResponses('MONTH_INVALID', 'VALIDATION_FAILED', 'PACK_NOT_FOUND', 'RATE_LIMITED')
  async packAvailability(@Param('id', uuidParam('PACK_NOT_FOUND')) id: string, @Query() query: AppAvailabilityQueryDto) {
    return { data: await this.catalog.packAvailability(id, query.month) };
  }

  @Post('events')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Report a browsing event (accepted, not stored yet)',
    description:
      '**Stub — nothing is persisted in V1.** The offer places the event-driven analytics widgets (views, searches, ' +
      'funnel, heat map) in V2 (api-decisions §3 and the scope check), so this route validates the payload and answers ' +
      '202 without writing a row. It exists now so the app can ship the calls and start sending them from day one; when ' +
      'the `events` table lands, the same requests begin to count. **Do not** use it for anything the UI depends on — it ' +
      'returns no body.',
  })
  @ApiResponse({ status: 202, description: 'Accepted and discarded (V1).' })
  @ApiErrorResponses('VALIDATION_FAILED', 'RATE_LIMITED')
  async track(@Body() _dto: TrackEventDto): Promise<void> {
    // Intentionally empty: see the description. Keeping the DTO validated means
    // the contract is already pinned when V2 starts storing these.
  }
}
