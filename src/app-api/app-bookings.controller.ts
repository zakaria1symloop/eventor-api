import { Body, Controller, Get, Header, Headers, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { BookingSource } from '../common/enums/booking.enums.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ReqLang } from '../common/i18n/lang.decorator.js';
import type { Lang } from '../common/i18n/language.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { InvoiceDto } from '../bookings/dto/bookings.dto.js';
import { AppBookingsService } from './app-bookings.service.js';
import {
  AppBookingCardDto,
  AppBookingDetailDto,
  AppCancelBookingDto,
  AppCheckInDto,
  AppClientBookingsQueryDto,
  AppCreateBookingDto,
  AppQuoteDto,
  AppQuoteResultDto,
  AppRescheduleDto,
} from './dto/app-bookings.dto.js';

/** `X-Platform` tells the booking row where it came from (`bookings.source`). */
export function sourceFromHeader(platform: string | undefined): BookingSource {
  const value = String(platform ?? '').toLowerCase();
  if (value === 'ios') return BookingSource.Ios;
  if (value === 'web') return BookingSource.Web;
  return BookingSource.Android;
}

const OWNERSHIP_NOTE =
  'Only the client who made the booking can read or change it: somebody else’s booking answers **403 `NOT_OWNER`**, ' +
  'and an unknown id **404 `BOOKING_NOT_FOUND`**.';

/**
 * The client half of the booking flow: the request sheet on screens 12 and 20,
 * the Bookings tab and the booking detail. Every rule (availability, minimum
 * notice, transitions, invoices) is the one in `status-rules.md` §5 — this
 * controller only scopes it to the signed-in client.
 */
@ApiTags('app-bookings')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiHeader({ name: 'Accept-Language', required: false, description: '`en` or `ar`. Falls back to the account’s language, then `en`.' })
@ApiErrorResponses('FORBIDDEN_AUDIENCE', 'ACCOUNT_BLOCKED', 'FORBIDDEN_ROLE')
@Roles(UserRole.Client)
@Controller('app/bookings')
export class AppBookingsController {
  constructor(private readonly bookings: AppBookingsService) {}

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Price a booking before sending it',
    description:
      'The booking request sheet opened from screen 12 Service detail and screen 20 Pack detail. Returns the very lines ' +
      '`POST /app/bookings` would create, the totals and whether that date can be booked — **it writes nothing**. ' +
      '`feePercent` is Eventor’s cut for its own accounting; payment is cash between client and provider, so the client ' +
      'owes `total` and nothing else. An unavailable date is not an error here: `available` is `false` and ' +
      '`unavailableReason` says why, so the sheet can grey the button instead of showing a toast.',
  })
  @ApiDataResponse(AppQuoteResultDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'SERVICE_NOT_FOUND', 'PACK_NOT_FOUND', 'BOOKING_EXTRA_INVALID', 'RATE_LIMITED')
  async quote(@Body() dto: AppQuoteDto, @ReqLang() lang: Lang) {
    return { data: await this.bookings.quote(dto, lang) };
  }

  @Post()
  @ApiOperation({
    summary: 'Send a booking request',
    description:
      'The booking request flow (screen map §C "Booking request"). Creates one **pending** booking (status-rules §5): ' +
      'the reference `EVT-…`, the priced lines, the fee snapshot, a hold on the provider’s date and the direct ' +
      'conversation the two of you then talk in. The provider is notified. Send `X-Platform` so the booking records ' +
      'which app it came from.',
  })
  @ApiHeader({ name: 'X-Platform', required: false, description: '`android` (default), `ios` or `web`.' })
  @ApiDataResponse(AppBookingDetailDto, { status: 201, description: 'The new pending booking.' })
  @ApiErrorResponses(
    'VALIDATION_FAILED',
    'EMAIL_NOT_VERIFIED',
    'SERVICE_NOT_FOUND',
    'PACK_NOT_FOUND',
    'SERVICE_UNAVAILABLE_FOR_BOOKING',
    'PACK_UNAVAILABLE',
    'PROVIDER_NOT_ACCEPTING',
    'MIN_NOTICE',
    'DATE_UNAVAILABLE',
    'BOOKING_DUPLICATE',
    'BOOKING_EXTRA_INVALID',
    'WILAYA_NOT_FOUND',
    'COMMUNE_NOT_FOUND',
    'COMMUNE_WILAYA_MISMATCH',
    'RATE_LIMITED',
  )
  async create(@CurrentUser() auth: AuthUser, @Body() dto: AppCreateBookingDto, @Headers('x-platform') platform: string | undefined, @ReqLang() lang: Lang) {
    return { data: await this.bookings.create(auth, dto, sourceFromHeader(platform), lang) };
  }

  @Get()
  @ApiOperation({
    summary: 'My bookings',
    description:
      'The client **Bookings** tab. One tab per call: `upcoming` (accepted, event still ahead), `pending` (waiting for ' +
      'the provider), `past` (completed, or accepted with the event behind us) and `cancelled` (cancelled **and** ' +
      'declined). Each card carries `allowedActions`, so the row’s buttons and the write endpoints can never disagree.',
  })
  @ApiPaginatedResponse(AppBookingCardDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async list(@CurrentUser() auth: AuthUser, @Query() query: AppClientBookingsQueryDto, @ReqLang() lang: Lang) {
    return this.bookings.list(auth, 'client', query.tab, query, lang);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Booking detail',
    description:
      `The booking detail behind the Bookings tab: the priced lines, the timeline of everything that happened, the ` +
      `provider card, the invoice summary once the booking is accepted, the dispute summary, the id of the chat and ` +
      `the ${'`allowedActions`'}. The provider’s phone appears only once the booking is accepted, and their email never ` +
      `does (mobile-api §7). ${OWNERSHIP_NOTE}`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'NOT_OWNER')
  async detail(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @ReqLang() lang: Lang) {
    return { data: await this.bookings.detail(auth, id, 'client', lang) };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel my booking',
    description:
      'status-rules §5: a client cancels a `pending` or an `accepted` booking. **No fee and no window are enforced** — ' +
      'payment is cash, the service’s own policy text (`cancellationPolicy` on the detail) is shown but not applied, ' +
      'and a disagreement becomes a dispute. The date is released and any invoice is voided.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'NOT_OWNER', 'BOOKING_INVALID_TRANSITION')
  async cancel(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @Body() dto: AppCancelBookingDto, @ReqLang() lang: Lang) {
    return { data: await this.bookings.changeStatus(auth, id, 'client', 'cancelled', dto.reason, lang) };
  }

  @Post(':id/reschedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Propose another date',
    description:
      'status-rules §5 "Reschedule": either party proposes, the other accepts. On a **pending** booking the change is ' +
      'applied straight away; on an **accepted** one it becomes a proposal the provider answers with ' +
      '`/reschedules/{rid}/accept|reject`. Only one proposal can be open at a time.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'NOT_OWNER', 'BOOKING_NOT_EDITABLE', 'BOOKING_DATE_PAST', 'DATE_UNAVAILABLE', 'RESCHEDULE_PENDING_EXISTS')
  async reschedule(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @Body() dto: AppRescheduleDto, @ReqLang() lang: Lang) {
    return { data: await this.bookings.reschedule(auth, id, 'client', dto, lang) };
  }

  @Post(':id/reschedules/:rid/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept the provider’s new date',
    description: 'Moves the booking and its availability hold to the proposed date. You cannot answer a proposal you made yourself (403 `NOT_OWNER`); cancel it instead.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'rid', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'NOT_OWNER', 'RESCHEDULE_NOT_FOUND', 'RESCHEDULE_NOT_PENDING', 'BOOKING_NOT_EDITABLE', 'DATE_UNAVAILABLE')
  async acceptReschedule(
    @CurrentUser() auth: AuthUser,
    @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string,
    @Param('rid', uuidParam('RESCHEDULE_NOT_FOUND')) rid: string,
    @ReqLang() lang: Lang,
  ) {
    return { data: await this.bookings.respondToReschedule(auth, id, 'client', rid, 'accept', lang) };
  }

  @Post(':id/reschedules/:rid/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refuse the provider’s new date', description: 'Closes the proposal; the booking keeps its original date.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'rid', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'NOT_OWNER', 'RESCHEDULE_NOT_FOUND', 'RESCHEDULE_NOT_PENDING', 'BOOKING_NOT_EDITABLE')
  async rejectReschedule(
    @CurrentUser() auth: AuthUser,
    @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string,
    @Param('rid', uuidParam('RESCHEDULE_NOT_FOUND')) rid: string,
    @ReqLang() lang: Lang,
  ) {
    return { data: await this.bookings.respondToReschedule(auth, id, 'client', rid, 'reject', lang) };
  }

  @Post(':id/reschedules/:rid/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw my own reschedule proposal',
    description:
      'Only the **proposer** can withdraw, and only while the proposal is still pending (409 `RESCHEDULE_NOT_PENDING` ' +
      'otherwise). Withdrawing somebody else’s proposal is 403 `NOT_OWNER` — answer it with `/accept` or `/reject` instead. ' +
      'The booking keeps its current date.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'rid', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'NOT_OWNER', 'RESCHEDULE_NOT_FOUND', 'RESCHEDULE_NOT_PENDING')
  async withdrawReschedule(
    @CurrentUser() auth: AuthUser,
    @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string,
    @Param('rid', uuidParam('RESCHEDULE_NOT_FOUND')) rid: string,
    @ReqLang() lang: Lang,
  ) {
    return { data: await this.bookings.withdrawReschedule(auth, id, 'client', rid, lang) };
  }

  @Post(':id/check-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'All good / Report a problem',
    description:
      'status-rules §5, after the event: `{"answer":"ok"}` is **All good**. When both the client and the provider have ' +
      'tapped it the booking completes immediately instead of waiting out the 72-hour dispute window. ' +
      '`{"answer":"problem"}` deliberately answers **422 `CHECK_IN_NOT_ALLOWED`** with `details.next` pointing at ' +
      '`POST /app/bookings/{id}/disputes` — reporting a problem is opening a dispute, and it needs a description.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'NOT_OWNER', 'CHECK_IN_NOT_ALLOWED', 'CHECK_IN_TOO_EARLY', 'CHECK_IN_DISPUTED')
  async checkIn(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @Body() dto: AppCheckInDto, @ReqLang() lang: Lang) {
    return { data: await this.bookings.checkIn(auth, id, 'client', dto.answer, lang) };
  }

  @Get(':id/invoice')
  @ApiOperation({
    summary: 'The invoice of my booking',
    description: 'Eventor issues an invoice document when a booking is accepted (status-rules §5). Only the booking’s own client can read it.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(InvoiceDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'NOT_OWNER', 'INVOICE_NOT_FOUND')
  async invoice(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string) {
    return { data: await this.bookings.invoice(auth, id, 'client') };
  }

  @Get(':id/invoice.pdf')
  @ApiProduces('application/pdf')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'The invoice as a PDF', description: 'The same invoice as a downloadable PDF, for the share sheet. Only the booking’s own client can read it.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The PDF bytes.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } })
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'NOT_OWNER', 'INVOICE_NOT_FOUND')
  async invoicePdf(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @Res() res: Response) {
    const { buffer, fileName } = await this.bookings.invoicePdf(auth, id, 'client');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  }
}
