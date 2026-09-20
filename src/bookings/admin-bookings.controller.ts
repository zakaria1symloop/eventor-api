import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { BookingsService } from './bookings.service.js';
import {
  BOOKING_SORT_FIELDS,
  BookingDetailDto,
  BookingRowDto,
  BookingsQueryDto,
  BookingTabCountsDto,
  ChangePriceDto,
  ChangeStatusDto,
  CreateBookingDto,
  InvoiceDto,
  RemindResultDto,
  RescheduleBookingDto,
  UpdateBookingDto,
} from './dto/bookings.dto.js';
import { InvoicesService } from './invoices.service.js';

const ID = { name: 'id', description: 'Booking UUID or reference (`EVT-002041`).', example: 'EVT-002041' };

@ApiTags('admin-bookings')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/bookings')
export class AdminBookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly invoices: InvoicesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List bookings',
    description:
      'Tabs `tab` (all | pending | accepted | completed | declined | cancelled | disputed) with counters in `meta.counts` (they follow the filters, not the tab; `noReply` counts pending past the deadline). ' +
      '`noReply=true`: pending longer than `booking_reply_deadline_hours`. Filters clientId, providerId, serviceId, packId, categoryId, academicRequestId, wilaya (repeat), ' +
      'eventDateFrom/To, createdFrom/To (UTC days), amountMin/Max (total), source, disputeStatus. `q`: exact reference, or client / provider / business name, service title, pack name. ' +
      `Sortable by ${BOOKING_SORT_FIELDS.join(', ')} (default createdAt:desc). Export: resource \`bookings\`. Used by BKG-01, OVR-01 attention queue.`,
  })
  @ApiPaginatedResponse(BookingRowDto, { counts: BookingTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@Query() query: BookingsQueryDto) {
    return this.bookings.list(query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a booking for a client',
    description:
      'Pending booking with reference EVT-xxxxxx, lines (service + extras, or pack items with the pack discount), totals and the fee snapshot (`platform_fee_percent` or `pack_fee_percent`). ' +
      'Guards (status-rules §5): client account (422 NOT_A_CLIENT), service / pack visible in the app (422 SERVICE_UNAVAILABLE_FOR_BOOKING / PACK_UNAVAILABLE), provider accepting bookings ' +
      '(422 PROVIDER_NOT_ACCEPTING), date ≥ today + `booking_min_notice_days` (422 MIN_NOTICE), provider free (row lock; 409 DATE_UNAVAILABLE at `max_events_per_day` or blocked). ' +
      'Availability `held`, direct conversation linked or created (with a system message), source `dashboard`, `created_by`. Event `booking.created` (provider emailed). Used by BKG-01, ACR-02.',
  })
  @ApiDataResponse(BookingDetailDto, { status: 201 })
  @ApiErrorResponses(
    'VALIDATION_FAILED',
    'USER_NOT_FOUND',
    'SERVICE_NOT_FOUND',
    'PACK_NOT_FOUND',
    'WILAYA_NOT_FOUND',
    'COMMUNE_NOT_FOUND',
    'ACADEMIC_REQUEST_NOT_FOUND',
    'NOT_A_CLIENT',
    'SERVICE_UNAVAILABLE_FOR_BOOKING',
    'PACK_UNAVAILABLE',
    'PROVIDER_NOT_ACCEPTING',
    'MIN_NOTICE',
    'BOOKING_EXTRA_INVALID',
    'COMMUNE_WILAYA_MISMATCH',
    'DATE_UNAVAILABLE',
  )
  async create(@CurrentUser() auth: AuthUser, @Body() dto: CreateBookingDto) {
    return { data: await this.bookings.create(auth, dto) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a booking',
    description:
      'Party cards (client bookings count; provider rating, reply time), service or pack, event details, lines, totals, fee and provider amount, timeline (status changes, ' +
      'reschedules and price changes with actors), pending reschedule, latest invoice, conversation with its last 3 messages, dispute, `allowedTransitions` and the activity history. Used by BKG-03.',
  })
  @ApiParam(ID)
  @ApiDataResponse(BookingDetailDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND')
  async get(@Param('id') id: string) {
    return { data: await this.bookings.get(await this.bookings.resolveId(id)) };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit event details',
    description:
      'eventType, startTime, endTime, locationText, wilayaCode, communeId (must be in the wilaya), guests, clientNote. Pending or accepted only (409 BOOKING_NOT_EDITABLE). ' +
      '`eventDate` is refused with 422 USE_RESCHEDULE. Prices are not recomputed (use the price action). Used by BKG-03 (Event details drawer).',
  })
  @ApiParam(ID)
  @ApiDataResponse(BookingDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_NOT_EDITABLE', 'USE_RESCHEDULE', 'WILAYA_NOT_FOUND', 'COMMUNE_NOT_FOUND', 'COMMUNE_WILAYA_MISMATCH')
  async update(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: UpdateBookingDto) {
    return { data: await this.bookings.update(auth, await this.bookings.resolveId(id), dto) };
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change the booking status',
    description:
      'pending → accepted | declined | cancelled; accepted → cancelled | completed; completed → `reopen` (accepted). Other moves: 409 BOOKING_INVALID_TRANSITION. `reason` is required except ' +
      'for accepted, `note` always. Admins may complete before the event date (flagged `earlyCompletion` in the audit). Effects: accept re-checks the date (409 DATE_UNAVAILABLE), ' +
      'availability `booked`, invoice issued (INV-YYYY-NNNN, issuer from `invoice_issuer`, PDF render job) and contact details unmasked in chat; decline / cancel release availability ' +
      '(cancel voids the invoice); complete sets `completed_at` and counters; reopen reverts them and withdraws the review request when no review exists. ' +
      'Status change row, audit and `booking.<status>` event; emails to client / provider when `notify`. Used by BKG-04.',
  })
  @ApiParam(ID)
  @ApiDataResponse(BookingDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_INVALID_TRANSITION', 'DATE_UNAVAILABLE')
  async changeStatus(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: ChangeStatusDto) {
    return { data: await this.bookings.changeStatus(auth, await this.bookings.resolveId(id), dto) };
  }

  @Post(':id/reschedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reschedule a booking',
    description:
      'Pending booking: the new date applies directly. Accepted booking: a pending proposal ("New date waiting for confirmation"), unless `force` applies it directly. ' +
      'The provider must be free on the new date (409 DATE_UNAVAILABLE) unless `force` ("Book anyway"). One pending proposal at a time (409 RESCHEDULE_PENDING_EXISTS). ' +
      'Past dates: 422 BOOKING_DATE_PAST. Used by BKG-05.',
  })
  @ApiParam(ID)
  @ApiDataResponse(BookingDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_NOT_EDITABLE', 'BOOKING_DATE_PAST', 'DATE_UNAVAILABLE', 'RESCHEDULE_PENDING_EXISTS')
  async reschedule(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: RescheduleBookingDto) {
    return { data: await this.bookings.reschedule(auth, await this.bookings.resolveId(id), dto) };
  }

  @Post(':id/reschedules/:rid/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a reschedule proposal', description: 'pending → cancelled (409 RESCHEDULE_NOT_PENDING otherwise). Used by BKG-03.' })
  @ApiParam(ID)
  @ApiParam({ name: 'rid', format: 'uuid' })
  @ApiDataResponse(BookingDetailDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'RESCHEDULE_NOT_FOUND', 'RESCHEDULE_NOT_PENDING')
  async cancelReschedule(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Param('rid', uuidParam('RESCHEDULE_NOT_FOUND')) rid: string) {
    return { data: await this.bookings.cancelReschedule(auth, await this.bookings.resolveId(id), rid) };
  }

  @Patch(':id/price')
  @ApiOperation({
    summary: 'Adjust the price',
    description:
      'Replaces the lines (kinds service, extra, pack_service, discount, adjustment) and recomputes subtotal, discounts and total (422 BOOKING_TOTAL_NEGATIVE). Pending or accepted only. ' +
      'Writes a price change row; an accepted booking gets a new invoice version (the previous one is voided). Event `booking.price_changed` (client emailed). Used by BKG-06.',
  })
  @ApiParam(ID)
  @ApiDataResponse(BookingDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_NOT_EDITABLE', 'BOOKING_TOTAL_NEGATIVE')
  async changePrice(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: ChangePriceDto) {
    return { data: await this.bookings.changePrice(auth, await this.bookings.resolveId(id), dto) };
  }

  @Post(':id/remind')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remind the provider',
    description: 'Pending bookings only (409 BOOKING_NOT_EDITABLE). Email + push (stub) to the provider, `reminder_sent_at` set; at most once per 12 h (429 REMINDER_TOO_SOON with Retry-After). Used by BKG-01, BKG-03.',
  })
  @ApiParam(ID)
  @ApiDataResponse(RemindResultDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'BOOKING_NOT_EDITABLE', 'REMINDER_TOO_SOON')
  async remind(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return { data: await this.bookings.remind(auth, await this.bookings.resolveId(id)) };
  }

  @Get(':id/invoice')
  @ApiOperation({ summary: 'Get the invoice', description: 'Latest version (voided versions are listed in `versions`). 404 INVOICE_NOT_FOUND before acceptance. Used by BKG-07.' })
  @ApiParam(ID)
  @ApiDataResponse(InvoiceDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'INVOICE_NOT_FOUND')
  async invoice(@Param('id') id: string) {
    return { data: await this.invoices.latest(await this.bookings.resolveId(id)) };
  }

  @Get(':id/invoice.pdf')
  @ApiOperation({ summary: 'Download the invoice PDF', description: 'Latest version as `application/pdf` (rendered now if the render job has not run yet). Used by BKG-07 (Download PDF).' })
  @ApiParam(ID)
  @ApiProduces('application/pdf')
  @ApiResponse({ status: 200, description: 'PDF file', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } })
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'INVOICE_NOT_FOUND')
  async invoicePdf(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const { buffer, fileName } = await this.invoices.pdf(await this.bookings.resolveId(id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    return new StreamableFile(buffer);
  }

  @Post(':id/invoice/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email the invoice to the client', description: 'Sends the latest version as a PDF attachment in the client’s language and sets `sent_to_client_at`. Audit `invoice.sent`. Used by BKG-07.' })
  @ApiParam(ID)
  @ApiDataResponse(InvoiceDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'INVOICE_NOT_FOUND')
  async sendInvoice(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return { data: await this.invoices.send(auth, await this.bookings.resolveId(id)) };
  }
}
