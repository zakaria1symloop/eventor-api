import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiParam, ApiProduces, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { AppException } from '../common/errors/app.exception.js';
import { UserRole } from '../common/enums/user.enums.js';
import { UPLOAD_THROTTLE } from '../common/http/throttles.js';
import { uploadLimits } from '../common/http/upload-limits.js';
import { ReqLang } from '../common/i18n/lang.decorator.js';
import type { Lang } from '../common/i18n/language.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { InvoiceDto } from '../bookings/dto/bookings.dto.js';
import { AvailabilityBlockDto, AvailabilityMonthDto } from '../services/dto/availability.dto.js';
import { ServiceDetailDto } from '../services/dto/services.dto.js';
import { PackDetailDto, PackRowDto } from '../packs/dto/packs.dto.js';
import { PhotoDto, type UploadedPhotoFile } from '../files/photo-gallery.js';
import { AppBookingsService } from './app-bookings.service.js';
import { AppProviderService } from './app-provider.service.js';
import { AppMeDto } from './dto/app-me.dto.js';
import {
  AppBookingCardDto,
  AppCancelBookingDto,
  AppCheckInDto,
  AppProviderBookingsQueryDto,
  AppRescheduleDto,
  AppBookingDetailDto,
} from './dto/app-bookings.dto.js';
import {
  AppAvailabilityMonthQueryDto,
  AppCreateBlockDto,
  AppCreatePackDto,
  AppCreateServiceDto,
  AppPhotoOrderDto,
  AppProviderHomeDto,
  AppProviderReviewDto,
  AppProviderServiceRowDto,
  AppUpdatePackDto,
  AppUpdateProviderProfileDto,
  AppUpdateServiceDto,
} from './dto/app-provider.dto.js';

/** Multipart ceiling; the stricter `max_photo_upload_mb` setting is applied by the pipeline. */
const MAX_PHOTO_MB = 20;

const OWNERSHIP_NOTE = 'Yours only: another provider’s row answers **403 `NOT_OWNER`**, an unknown id **404**.';

/**
 * The provider app: screens 21 Home · Provider and 21a Home · Provider ·
 * Pending, the Requests tab, Services, My packs, the Calendar and the Profile
 * tab. Services, packs and availability run through the same services the
 * dashboard uses, so the publish checklist, the photo limits and the open
 * wilaya rule are literally the admin ones.
 */
@ApiTags('app-provider')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiHeader({ name: 'Accept-Language', required: false, description: '`en` or `ar`. Falls back to the account’s language, then `en`.' })
@ApiErrorResponses('FORBIDDEN_AUDIENCE', 'FORBIDDEN_ROLE', 'ACCOUNT_BLOCKED', 'NOT_A_PROVIDER')
@Roles(UserRole.Provider)
@Controller('app/provider')
export class AppProviderController {
  constructor(
    private readonly provider: AppProviderService,
    private readonly bookings: AppBookingsService,
  ) {}

  // ── home ────────────────────────────────────────────────────

  @Get('home')
  @ApiOperation({
    summary: 'Everything the provider home needs, in one call',
    description:
      'Screens **21 Home · Provider** and **21a Home · Provider · Pending**. `state` decides which one to draw: ' +
      '`verified` gives the full home (counts, booking requests with Accept / Decline, the next accepted bookings, ' +
      'your services with their availability and the "Available for bookings" toggle); `pending` and `rejected` give ' +
      '21a, with `verificationSteps` and the same `documents` payload as `GET /app/me/documents` so the screen can ' +
      'offer a resubmit without a second call.',
  })
  @ApiDataResponse(AppProviderHomeDto)
  @ApiErrorResponses('USER_NOT_FOUND')
  async home(@CurrentUser() auth: AuthUser, @ReqLang() lang: Lang) {
    return { data: await this.provider.home(auth, lang) };
  }

  @Patch('profile')
  @ApiOperation({
    summary: 'Edit my provider profile',
    description:
      'The Profile tab and the **"Available for bookings"** toggle on screen 21. Turning `acceptingBookings` off keeps ' +
      'the services visible and refuses new bookings (status-rules §3). `wilayaCodes` replaces the set and every added ' +
      'wilaya must be open. The account’s own name, phone, language and avatar live on `PATCH /app/me`. ' +
      '**Deliberately answers with the whole account (`AppMeDto`)**, provider profile included, so one round trip ' +
      'refreshes everything the Profile tab shows — this differs from the other provider routes on purpose.',
  })
  @ApiDataResponse(AppMeDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'CATEGORY_NOT_FOUND', 'CATEGORY_HIDDEN', 'WILAYA_NOT_FOUND', 'WILAYA_CLOSED', 'NOT_A_PROVIDER')
  async updateProfile(@CurrentUser() auth: AuthUser, @Body() dto: AppUpdateProviderProfileDto, @ReqLang() lang: Lang) {
    return { data: await this.provider.updateProfile(auth, dto, lang) };
  }

  // ── bookings ────────────────────────────────────────────────

  @Get('bookings')
  @ApiOperation({
    summary: 'My booking requests and bookings',
    description:
      'The provider **Requests** tab. `requests` is everything still pending, `upcoming` the accepted bookings from ' +
      'today on, `past` the completed ones and the accepted ones whose event has gone by. The client’s phone and email ' +
      'appear only once you have accepted (status-rules §10).',
  })
  @ApiPaginatedResponse(AppBookingCardDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async listBookings(@CurrentUser() auth: AuthUser, @Query() query: AppProviderBookingsQueryDto, @ReqLang() lang: Lang) {
    return this.bookings.list(auth, 'provider', query.tab, query, lang);
  }

  @Get('bookings/:id')
  @ApiOperation({ summary: 'Booking detail', description: `The request detail behind screen 21. ${OWNERSHIP_NOTE}` })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'NOT_OWNER')
  async booking(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @ReqLang() lang: Lang) {
    return { data: await this.bookings.detail(auth, id, 'provider', lang) };
  }

  @Post('bookings/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a booking request',
    description:
      'The **Accept** button on screen 21 (status-rules §5). The date is re-checked under a row lock, the hold becomes ' +
      'a booking, Eventor issues the invoice and contact details become visible in the chat. Only a **verified and ' +
      'active** provider can accept (422 `PROVIDER_NOT_VERIFIED`).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'NOT_OWNER', 'BOOKING_INVALID_TRANSITION', 'DATE_UNAVAILABLE', 'PROVIDER_NOT_VERIFIED')
  async accept(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @ReqLang() lang: Lang) {
    return { data: await this.bookings.changeStatus(auth, id, 'provider', 'accepted', null, lang) };
  }

  @Post('bookings/:id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a booking request', description: 'The **Decline** button on screen 21. The held date is released and the client is told why.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'NOT_OWNER', 'BOOKING_INVALID_TRANSITION')
  async decline(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @Body() dto: AppCancelBookingDto, @ReqLang() lang: Lang) {
    return { data: await this.bookings.changeStatus(auth, id, 'provider', 'declined', dto.reason, lang) };
  }

  @Post('bookings/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an accepted booking', description: 'status-rules §5: no fee and no window are enforced (cash). The date is released and the invoice voided.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'NOT_OWNER', 'BOOKING_INVALID_TRANSITION')
  async cancel(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @Body() dto: AppCancelBookingDto, @ReqLang() lang: Lang) {
    return { data: await this.bookings.changeStatus(auth, id, 'provider', 'cancelled', dto.reason, lang) };
  }

  @Post('bookings/:id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark the event as done',
    description:
      'status-rules §5: an accepted booking whose event date has passed becomes `completed`. The client is invited to ' +
      'review it after `review_open_after_hours`. A job does this automatically 72 h after the event when nobody does.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'NOT_OWNER', 'BOOKING_INVALID_TRANSITION')
  async complete(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @ReqLang() lang: Lang) {
    return { data: await this.bookings.changeStatus(auth, id, 'provider', 'completed', null, lang) };
  }

  @Post('bookings/:id/reschedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Propose another date', description: 'status-rules §5. A pending booking moves straight away; an accepted one waits for the client’s answer.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'NOT_OWNER', 'BOOKING_NOT_EDITABLE', 'BOOKING_DATE_PAST', 'DATE_UNAVAILABLE', 'RESCHEDULE_PENDING_EXISTS')
  async reschedule(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @Body() dto: AppRescheduleDto, @ReqLang() lang: Lang) {
    return { data: await this.bookings.reschedule(auth, id, 'provider', dto, lang) };
  }

  @Post('bookings/:id/reschedules/:rid/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept the client’s new date', description: 'Moves the booking and its hold. You cannot answer your own proposal (403 `NOT_OWNER`).' })
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
    return { data: await this.bookings.respondToReschedule(auth, id, 'provider', rid, 'accept', lang) };
  }

  @Post('bookings/:id/reschedules/:rid/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refuse the client’s new date', description: 'Closes the proposal; the booking keeps its date.' })
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
    return { data: await this.bookings.respondToReschedule(auth, id, 'provider', rid, 'reject', lang) };
  }

  @Post('bookings/:id/reschedules/:rid/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw my own reschedule proposal',
    description:
      'Only the **proposer** can withdraw, and only while the proposal is pending (409 `RESCHEDULE_NOT_PENDING` otherwise). ' +
      'The client’s proposal is answered with `/accept` or `/reject`, never withdrawn (403 `NOT_OWNER`).',
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
    return { data: await this.bookings.withdrawReschedule(auth, id, 'provider', rid, lang) };
  }

  @Get('bookings/:id/invoice')
  @ApiOperation({
    summary: 'The invoice of my booking',
    description:
      'The provider side of the invoice Eventor issues when a booking is accepted (status-rules §5). Readable only on ' +
      '**accepted or completed** bookings of yours — anything else answers 404 `INVOICE_NOT_FOUND`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(InvoiceDto)
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'NOT_OWNER', 'INVOICE_NOT_FOUND')
  async invoice(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string) {
    return { data: await this.bookings.invoice(auth, id, 'provider') };
  }

  @Get('bookings/:id/invoice.pdf')
  @ApiProduces('application/pdf')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'The invoice as a PDF', description: 'The same invoice as a downloadable PDF, for the share sheet. Accepted or completed bookings of yours only.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The PDF bytes.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } })
  @ApiErrorResponses('BOOKING_NOT_FOUND', 'NOT_OWNER', 'INVOICE_NOT_FOUND')
  async invoicePdf(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @Res() res: Response) {
    const { buffer, fileName } = await this.bookings.invoicePdf(auth, id, 'provider');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  }

  @Post('bookings/:id/check-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'All good / Report a problem',
    description:
      'The provider half of status-rules §5: `{"answer":"ok"}` confirms the event went well, and when the client has ' +
      'confirmed too the booking completes immediately. `{"answer":"problem"}` answers 422 with `details.next` pointing ' +
      'at `POST /app/bookings/{id}/disputes`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBookingDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'NOT_OWNER', 'CHECK_IN_NOT_ALLOWED', 'CHECK_IN_TOO_EARLY', 'CHECK_IN_DISPUTED')
  async checkIn(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @Body() dto: AppCheckInDto, @ReqLang() lang: Lang) {
    return { data: await this.bookings.checkIn(auth, id, 'provider', dto.answer, lang) };
  }

  // ── services ────────────────────────────────────────────────

  @Get('services')
  @ApiOperation({
    summary: 'My services',
    description: 'The Services tab and the "Your services" block on screen 21. Drafts, published and hidden services, with `visibleInApp` saying whether clients can find each one today.',
  })
  @ApiDataResponse(AppProviderServiceRowDto, { isArray: true })
  async listServices(@CurrentUser() auth: AuthUser, @ReqLang() lang: Lang) {
    return { data: await this.provider.listServices(auth, lang) };
  }

  @Get('services/:id')
  @ApiOperation({
    summary: 'One of my services',
    description: `The editing screen’s source of truth: the same \`ServiceDetailDto\` the PATCH and publish routes answer with, so an edit form never has to work from a list row. ${OWNERSHIP_NOTE}`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'NOT_OWNER')
  async getService(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('SERVICE_NOT_FOUND')) id: string) {
    return { data: await this.provider.getService(auth, id) };
  }

  @Post('services')
  @ApiOperation({
    summary: 'Create a service',
    description:
      'Add a service (Services · Add a service). It starts as a **draft**: publish it with `/publish` once the ' +
      'checklist in status-rules §3 is met (EN + AR title and description, a base price, at least one photo, a visible ' +
      'category and at least one **open** wilaya). The owner is always you.',
  })
  @ApiDataResponse(ServiceDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'CATEGORY_NOT_FOUND', 'CATEGORY_HIDDEN', 'WILAYA_NOT_FOUND', 'WILAYA_CLOSED', 'NOT_A_PROVIDER')
  async createService(@CurrentUser() auth: AuthUser, @Body() dto: AppCreateServiceDto) {
    return { data: await this.provider.createService(auth, dto) };
  }

  @Patch('services/:id')
  @ApiOperation({ summary: 'Edit a service', description: `Partial update of one of your services; \`wilayaCodes\` and \`extras\` replace their set. ${OWNERSHIP_NOTE}` })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'SERVICE_NOT_FOUND', 'NOT_OWNER', 'CATEGORY_NOT_FOUND', 'CATEGORY_HIDDEN', 'WILAYA_NOT_FOUND', 'WILAYA_CLOSED')
  async updateService(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('SERVICE_NOT_FOUND')) id: string, @Body() dto: AppUpdateServiceDto) {
    return { data: await this.provider.updateService(auth, id, dto) };
  }

  @Post('services/:id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish a service',
    description:
      'status-rules §3 `draft → published`. Refuses with 422 `SERVICE_PUBLISH_INVALID` and `details.missing` listing ' +
      'what the form still needs, and with 422 `PROVIDER_NOT_VERIFIED` while your profile is under review.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'NOT_OWNER', 'SERVICE_INVALID_TRANSITION', 'SERVICE_PUBLISH_INVALID', 'PROVIDER_NOT_VERIFIED')
  async publishService(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('SERVICE_NOT_FOUND')) id: string) {
    return { data: await this.provider.transitionService(auth, id, 'publish') };
  }

  @Post('services/:id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unpublish a service', description: 'status-rules §3 `published → draft`: out of search and of your profile. Packs containing it are recomputed.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'NOT_OWNER', 'SERVICE_INVALID_TRANSITION')
  async unpublishService(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('SERVICE_NOT_FOUND')) id: string) {
    return { data: await this.provider.transitionService(auth, id, 'unpublish') };
  }

  @Delete('services/:id')
  @ApiOperation({
    summary: 'Delete a service',
    description: 'Soft delete. Refused with 409 `SERVICE_HAS_BOOKINGS` while an accepted booking is still ahead; pending bookings on it are cancelled (status-rules §3).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The deleted service’s id and what it affected.' })
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'NOT_OWNER', 'SERVICE_HAS_BOOKINGS', 'SERVICE_IN_PACKS')
  async deleteService(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('SERVICE_NOT_FOUND')) id: string) {
    return { data: await this.provider.removeService(auth, id) };
  }

  @Post('services/:id/photos')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(MAX_PHOTO_MB) }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({
    summary: 'Add a photo to a service',
    description:
      'The type is sniffed from the bytes. The image becomes WebP with `thumb` and `medium` variants through a ' +
      'background job, so the variants may lag a second behind. The limit is `max_photos_per_service` ' +
      '(422 `PHOTO_LIMIT_REACHED`). Returns the whole gallery in order.',
  })
  @ApiDataResponse(PhotoDto, { isArray: true, status: 201 })
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'NOT_OWNER', 'PHOTO_LIMIT_REACHED', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'VALIDATION_FAILED', 'RATE_LIMITED')
  async addServicePhoto(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('SERVICE_NOT_FOUND')) id: string, @UploadedFile() file: UploadedPhotoFile | undefined) {
    if (!file) throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'file', code: 'REQUIRED', message: 'file is required' }]);
    return { data: await this.provider.addServicePhoto(auth, id, file) };
  }

  @Patch('services/:id/photos/order')
  @ApiOperation({ summary: 'Reorder a service’s photos', description: 'Send every photo id in the new order; the first one is the cover.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PhotoDto, { isArray: true })
  @ApiErrorResponses('VALIDATION_FAILED', 'SERVICE_NOT_FOUND', 'NOT_OWNER', 'PHOTO_ORDER_INVALID')
  async orderServicePhotos(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('SERVICE_NOT_FOUND')) id: string, @Body() dto: AppPhotoOrderDto) {
    return { data: await this.provider.reorderServicePhotos(auth, id, dto.ids) };
  }

  @Delete('services/:id/photos/:photoId')
  @ApiOperation({ summary: 'Remove a photo', description: 'Refused with 422 `SERVICE_PUBLISH_INVALID` when it is the last photo of a published service — unpublish it first.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'photoId', format: 'uuid' })
  @ApiDataResponse(PhotoDto, { isArray: true })
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'NOT_OWNER', 'PHOTO_NOT_FOUND', 'SERVICE_PUBLISH_INVALID')
  async deleteServicePhoto(
    @CurrentUser() auth: AuthUser,
    @Param('id', uuidParam('SERVICE_NOT_FOUND')) id: string,
    @Param('photoId', uuidParam('PHOTO_NOT_FOUND')) photoId: string,
  ) {
    return { data: await this.provider.removeServicePhoto(auth, id, photoId) };
  }

  // ── packs ───────────────────────────────────────────────────

  @Get('packs')
  @ApiOperation({ summary: 'My Ready Packs', description: 'The "My packs" tab. `needsAttention` marks a pack whose items are no longer all published (status-rules §4).' })
  @ApiDataResponse(PackRowDto, { isArray: true })
  async listPacks(@CurrentUser() auth: AuthUser) {
    return { data: await this.provider.listPacks(auth) };
  }

  @Get('packs/:id')
  @ApiOperation({
    summary: 'One of my packs',
    description: `The pack editing screen’s source of truth: the same \`PackDetailDto\` the PATCH and publish routes answer with, including \`attentionReasons\` and the \`publishMissing\` checklist. ${OWNERSHIP_NOTE}`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PackDetailDto)
  @ApiErrorResponses('PACK_NOT_FOUND', 'NOT_OWNER')
  async getPack(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('PACK_NOT_FOUND')) id: string) {
    return { data: await this.provider.getPack(auth, id) };
  }

  @Post('packs')
  @ApiOperation({
    summary: 'Create a Ready Pack',
    description: 'status-rules §4: a pack is built from **your own** services (at least 2), in one wilaya, at a price below the sum of the items. It starts as a draft.',
  })
  @ApiDataResponse(PackDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'PACK_SERVICE_NOT_FOUND', 'PACK_SERVICE_OTHER_PROVIDER', 'WILAYA_NOT_FOUND', 'WILAYA_CLOSED', 'NOT_A_PROVIDER')
  async createPack(@CurrentUser() auth: AuthUser, @Body() dto: AppCreatePackDto) {
    return { data: await this.provider.createPack(auth, dto) };
  }

  @Patch('packs/:id')
  @ApiOperation({ summary: 'Edit a pack', description: `\`serviceIds\` replaces the items, in order. ${OWNERSHIP_NOTE}` })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PackDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'PACK_NOT_FOUND', 'NOT_OWNER', 'PACK_SERVICE_NOT_FOUND', 'PACK_SERVICE_OTHER_PROVIDER', 'WILAYA_NOT_FOUND', 'WILAYA_CLOSED')
  async updatePack(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('PACK_NOT_FOUND')) id: string, @Body() dto: AppUpdatePackDto) {
    return { data: await this.provider.updatePack(auth, id, dto) };
  }

  @Post('packs/:id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a pack', description: 'status-rules §4. 422 `PACK_PUBLISH_INVALID` lists what is missing; 422 `PROVIDER_NOT_VERIFIED` while your profile is under review.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PackDetailDto)
  @ApiErrorResponses('PACK_NOT_FOUND', 'NOT_OWNER', 'PACK_INVALID_TRANSITION', 'PACK_PUBLISH_INVALID', 'PROVIDER_NOT_VERIFIED')
  async publishPack(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('PACK_NOT_FOUND')) id: string) {
    return { data: await this.provider.transitionPack(auth, id, 'publish') };
  }

  @Post('packs/:id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unpublish a pack', description: 'status-rules §4 `published → unpublished`.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PackDetailDto)
  @ApiErrorResponses('PACK_NOT_FOUND', 'NOT_OWNER', 'PACK_INVALID_TRANSITION')
  async unpublishPack(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('PACK_NOT_FOUND')) id: string) {
    return { data: await this.provider.transitionPack(auth, id, 'unpublish') };
  }

  @Delete('packs/:id')
  @ApiOperation({ summary: 'Delete a pack', description: 'Soft delete; refused with 409 `PACK_HAS_BOOKINGS` while a booking on it is still live.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The deleted pack’s id.' })
  @ApiErrorResponses('PACK_NOT_FOUND', 'NOT_OWNER', 'PACK_HAS_BOOKINGS')
  async deletePack(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('PACK_NOT_FOUND')) id: string) {
    return { data: await this.provider.removePack(auth, id) };
  }

  @Post('packs/:id/photos')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(MAX_PHOTO_MB) }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Add a photo to a pack', description: 'Same pipeline and limits as a service photo; the limit is `max_photos_per_pack`.' })
  @ApiDataResponse(PhotoDto, { isArray: true, status: 201 })
  @ApiErrorResponses('PACK_NOT_FOUND', 'NOT_OWNER', 'PHOTO_LIMIT_REACHED', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'VALIDATION_FAILED', 'RATE_LIMITED')
  async addPackPhoto(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('PACK_NOT_FOUND')) id: string, @UploadedFile() file: UploadedPhotoFile | undefined) {
    if (!file) throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'file', code: 'REQUIRED', message: 'file is required' }]);
    return { data: await this.provider.addPackPhoto(auth, id, file) };
  }

  @Patch('packs/:id/photos/order')
  @ApiOperation({ summary: 'Reorder a pack’s photos', description: 'Send every photo id in the new order.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PhotoDto, { isArray: true })
  @ApiErrorResponses('VALIDATION_FAILED', 'PACK_NOT_FOUND', 'NOT_OWNER', 'PHOTO_ORDER_INVALID')
  async orderPackPhotos(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('PACK_NOT_FOUND')) id: string, @Body() dto: AppPhotoOrderDto) {
    return { data: await this.provider.reorderPackPhotos(auth, id, dto.ids) };
  }

  @Delete('packs/:id/photos/:photoId')
  @ApiOperation({ summary: 'Remove a pack photo', description: 'Removes one photo from the pack gallery.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'photoId', format: 'uuid' })
  @ApiDataResponse(PhotoDto, { isArray: true })
  @ApiErrorResponses('PACK_NOT_FOUND', 'NOT_OWNER', 'PHOTO_NOT_FOUND')
  async deletePackPhoto(
    @CurrentUser() auth: AuthUser,
    @Param('id', uuidParam('PACK_NOT_FOUND')) id: string,
    @Param('photoId', uuidParam('PHOTO_NOT_FOUND')) photoId: string,
  ) {
    return { data: await this.provider.removePackPhoto(auth, id, photoId) };
  }

  // ── availability ────────────────────────────────────────────

  @Get('availability')
  @ApiOperation({
    summary: 'My calendar, one month at a time',
    description:
      'The Calendar tab. Every day of the month with what is on it: `booked` (an accepted booking), `held` (a pending ' +
      'request), `blocked` (a block you added for the whole day), `partial` or `free`. `maxEventsPerDay` is the ' +
      'highest capacity among your services.',
  })
  @ApiQuery({ name: 'month', example: '2026-11', description: '`YYYY-MM`.' })
  @ApiDataResponse(AvailabilityMonthDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'NOT_A_PROVIDER')
  async availability(@CurrentUser() auth: AuthUser, @Query() query: AppAvailabilityMonthQueryDto) {
    return { data: await this.provider.month(auth, query.month) };
  }

  @Post('availability/blocks')
  @ApiOperation({
    summary: 'Block a day (or part of one)',
    description:
      'Marks a day as unavailable so clients cannot book it. Omit the times to block the whole day, or send `startTime` ' +
      '**and** `endTime` for a slot. `serviceId` narrows the block to one of your services. Past dates are refused ' +
      '(422 `AVAILABILITY_DATE_PAST`).',
  })
  @ApiDataResponse(AvailabilityBlockDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'AVAILABILITY_DATE_PAST', 'AVAILABILITY_SERVICE_INVALID', 'NOT_A_PROVIDER')
  async block(@CurrentUser() auth: AuthUser, @Body() dto: AppCreateBlockDto) {
    return { data: await this.provider.createBlock(auth, dto) };
  }

  @Delete('availability/blocks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unblock a day', description: 'Only a block **you** added: a booked or held day is not removable (409 `AVAILABILITY_BLOCK_NOT_REMOVABLE`).' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Removed.' })
  @ApiErrorResponses('AVAILABILITY_BLOCK_NOT_FOUND', 'NOT_OWNER', 'AVAILABILITY_BLOCK_NOT_REMOVABLE')
  async unblock(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('AVAILABILITY_BLOCK_NOT_FOUND')) id: string) {
    await this.provider.removeBlock(auth, id);
  }

  // ── reviews received ────────────────────────────────────────

  @Get('reviews')
  @ApiOperation({
    summary: 'Reviews I received',
    description:
      'Profile · Reviews. Authors appear as "Yasmine K." (mobile-api §7) and reviews an admin hid are left out. ' +
      '`replyEditable` says whether your reply is still inside its 48-hour window.',
  })
  @ApiPaginatedResponse(AppProviderReviewDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async reviews(@CurrentUser() auth: AuthUser, @Query() query: PaginationQueryDto, @ReqLang() lang: Lang) {
    return this.provider.reviews(auth, query, lang);
  }
}
