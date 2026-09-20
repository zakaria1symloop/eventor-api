import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { uploadLimits } from '../common/http/upload-limits.js';
import { UPLOAD_THROTTLE } from '../common/http/throttles.js';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { PhotoDto, type UploadedPhotoFile } from '../files/photo-gallery.js';
import {
  CreateServiceDto,
  DeleteServiceQueryDto,
  HideServiceDto,
  PhotoOrderDto,
  SERVICE_SORT_FIELDS,
  ServiceDeletedDto,
  ServiceDetailDto,
  ServiceRowDto,
  ServicesQueryDto,
  ServiceTabCountsDto,
  UpdateServiceDto,
} from './dto/services.dto.js';
import { ServicesService } from './services.service.js';

const serviceId = () => uuidParam('SERVICE_NOT_FOUND');
const GUARD =
  'Publish guard (status-rules §3): EN + AR title and description, a base price, at least one photo, a visible category and at least one wilaya; ' +
  'otherwise 422 `SERVICE_PUBLISH_INVALID` with `details.missing` (titleEn, titleAr, descriptionEn, descriptionAr, price, photos, category, wilayas).';
const PACKS = 'Packs containing the service are recomputed (`needs_attention`).';

@ApiTags('admin-services')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/services')
export class AdminServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  @ApiOperation({
    summary: 'List services',
    description:
      'Tabs `tab` (all | published | draft | hidden | waiting_approval | reported) with counters in `meta.counts` (they follow every filter except the tab). ' +
      'Filters: categoryId, providerId, wilaya (repeat), priceMin/priceMax, priceType, ratingMin/ratingMax, status, featured, providerStatus, createdFrom/createdTo. ' +
      `\`q\`: full-text on EN/AR titles, title contains, provider name or business name contains. Sortable by ${SERVICE_SORT_FIELDS.join(', ')} (default createdAt:desc). ` +
      '`visibleInApp` applies the visibility rule (published, provider active and verified, an open wilaya). Export: resource `services`; saved views: resource `services`. Used by SRV-01.',
  })
  @ApiPaginatedResponse(ServiceRowDto, { counts: ServiceTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@Query() query: ServicesQueryDto) {
    return this.services.list(query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a service',
    description:
      'For a provider account (422 NOT_A_PROVIDER). The category must be visible (422 CATEGORY_HIDDEN) and wilayas open (422 WILAYA_CLOSED). ' +
      `Arabic fields may be empty in a draft. \`status: published\` runs the publish guard, which needs photos, so new services are usually saved as drafts first. ${GUARD} Used by SRV-05.`,
  })
  @ApiDataResponse(ServiceDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'NOT_A_PROVIDER', 'CATEGORY_NOT_FOUND', 'CATEGORY_HIDDEN', 'WILAYA_NOT_FOUND', 'WILAYA_CLOSED', 'SERVICE_PUBLISH_INVALID')
  async create(@CurrentUser() auth: AuthUser, @Body() dto: CreateServiceDto) {
    return { data: await this.services.create(auth, dto) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a service',
    description:
      'Everything on SRV-04: content EN/AR, facts, cancellation policy, extras, photos (signed URLs of the image and its thumb/medium variants), wilayas with open state, ' +
      'hidden banner, stats (bookings by status, revenue from completed bookings, rating breakdown, favourites, packs using it), provider card with counts, ' +
      '`visibilityReasons` (why it is not visible) and the publish checklist `publishMissing`. Used by SRV-04, SRV-05.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses('SERVICE_NOT_FOUND')
  async get(@Param('id', serviceId()) id: string) {
    return { data: await this.services.get(id) };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a service',
    description:
      'Partial update; `extras` and `wilayaCodes` replace their sets. A changed category must be visible, added wilayas open. Moving to another provider is refused while the ' +
      `service is in packs (409 SERVICE_IN_PACKS). \`status\` draft ⇄ published (hidden services use /show). A published service must still pass the guard after the change. ${GUARD} ${PACKS} Used by SRV-05.`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses(
    'VALIDATION_FAILED',
    'SERVICE_NOT_FOUND',
    'NOT_A_PROVIDER',
    'CATEGORY_NOT_FOUND',
    'CATEGORY_HIDDEN',
    'WILAYA_NOT_FOUND',
    'WILAYA_CLOSED',
    'SERVICE_IN_PACKS',
    'SERVICE_INVALID_TRANSITION',
    'SERVICE_PUBLISH_INVALID',
  )
  async update(@CurrentUser() auth: AuthUser, @Param('id', serviceId()) id: string, @Body() dto: UpdateServiceDto) {
    return { data: await this.services.update(auth, id, dto) };
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a service',
    description:
      'Soft delete. Refused with 409 `SERVICE_HAS_BOOKINGS` (details.upcomingBookings) while accepted upcoming bookings exist, unless `force=true` (they are kept). ' +
      `Pending bookings are cancelled (clients notified), the service leaves the featured list and its manual blocks are removed. ${PACKS} Used by SRV-06.`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDeletedDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'SERVICE_NOT_FOUND', 'SERVICE_HAS_BOOKINGS')
  async remove(@CurrentUser() auth: AuthUser, @Param('id', serviceId()) id: string, @Query() query: DeleteServiceQueryDto) {
    return { data: await this.services.remove(auth, id, query.force ?? false) };
  }

  @Post(':id/hide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Hide a service',
    description: `published → hidden with a reason, optional message to the provider and \`allowResubmit\`. Leaves the featured list; the provider is emailed. ${PACKS} Used by SRV-03.`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'SERVICE_NOT_FOUND', 'SERVICE_INVALID_TRANSITION')
  async hide(@CurrentUser() auth: AuthUser, @Param('id', serviceId()) id: string, @Body() dto: HideServiceDto) {
    return { data: await this.services.transition(auth, id, 'hide', dto) };
  }

  @Post(':id/show')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Show a hidden service', description: `hidden → published; clears the hidden reason; the provider is emailed. ${GUARD} ${PACKS} Used by SRV-01, SRV-04.` })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'SERVICE_INVALID_TRANSITION', 'SERVICE_PUBLISH_INVALID')
  async show(@CurrentUser() auth: AuthUser, @Param('id', serviceId()) id: string) {
    return { data: await this.services.transition(auth, id, 'show') };
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a draft', description: `draft → published. ${GUARD} ${PACKS} Used by SRV-05.` })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'SERVICE_INVALID_TRANSITION', 'SERVICE_PUBLISH_INVALID')
  async publish(@CurrentUser() auth: AuthUser, @Param('id', serviceId()) id: string) {
    return { data: await this.services.transition(auth, id, 'publish') };
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unpublish a service', description: `published → draft; leaves the featured list. ${PACKS} Used by SRV-05.` })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'SERVICE_INVALID_TRANSITION')
  async unpublish(@CurrentUser() auth: AuthUser, @Param('id', serviceId()) id: string) {
    return { data: await this.services.transition(auth, id, 'unpublish') };
  }

  @Post(':id/feature')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Feature on home',
    description: 'Published services only (409 SERVICE_INVALID_TRANSITION), at most 12 (409 FEATURED_LIMIT); appended at the end of the featured order. Idempotent. Used by SRV-02.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'SERVICE_INVALID_TRANSITION', 'FEATURED_LIMIT')
  async feature(@CurrentUser() auth: AuthUser, @Param('id', serviceId()) id: string) {
    return { data: await this.services.feature(auth, id, true) };
  }

  @Post(':id/unfeature')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove from home', description: 'Idempotent; the remaining featured services are renumbered. Used by SRV-02 (toast Undo).' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ServiceDetailDto)
  @ApiErrorResponses('SERVICE_NOT_FOUND')
  async unfeature(@CurrentUser() auth: AuthUser, @Param('id', serviceId()) id: string) {
    return { data: await this.services.feature(auth, id, false) };
  }

  @Post(':id/photos')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(25) }))
  @ApiOperation({
    summary: 'Add a photo',
    description:
      'multipart/form-data `file` (type sniffed from the content, `allowed_image_types`, at most `max_photo_upload_mb`). At most `max_photos_per_service` photos ' +
      '(422 PHOTO_LIMIT_REACHED). Compressed to WebP with thumb/medium variants by a job (`processingStatus`). Returns every photo in order. Used by SRV-05.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PhotoDto, { status: 201, isArray: true })
  @ApiErrorResponses('VALIDATION_FAILED', 'SERVICE_NOT_FOUND', 'PHOTO_LIMIT_REACHED', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'RATE_LIMITED')
  async addPhoto(@CurrentUser() auth: AuthUser, @Param('id', serviceId()) id: string, @UploadedFile() file: UploadedPhotoFile | undefined) {
    if (!file) throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'file', code: 'IS_DEFINED', message: 'file is required' }]);
    return { data: await this.services.addPhoto(auth, id, file) };
  }

  @Patch(':id/photos/order')
  @ApiOperation({ summary: 'Reorder photos', description: '`ids` lists every photo once (422 PHOTO_ORDER_INVALID); the first is the cover. Used by SRV-05.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PhotoDto, { isArray: true })
  @ApiErrorResponses('VALIDATION_FAILED', 'SERVICE_NOT_FOUND', 'PHOTO_ORDER_INVALID')
  async reorderPhotos(@CurrentUser() auth: AuthUser, @Param('id', serviceId()) id: string, @Body() dto: PhotoOrderDto) {
    return { data: await this.services.reorderPhotos(auth, id, dto.ids) };
  }

  @Delete(':id/photos/:photoId')
  @ApiOperation({
    summary: 'Remove a photo',
    description: 'The rest are renumbered. The last photo of a published service cannot be removed (422 SERVICE_PUBLISH_INVALID, missing photos). Used by SRV-05.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'photoId', format: 'uuid' })
  @ApiDataResponse(PhotoDto, { isArray: true })
  @ApiErrorResponses('SERVICE_NOT_FOUND', 'PHOTO_NOT_FOUND', 'SERVICE_PUBLISH_INVALID')
  async removePhoto(@CurrentUser() auth: AuthUser, @Param('id', serviceId()) id: string, @Param('photoId', uuidParam('PHOTO_NOT_FOUND')) photoId: string) {
    return { data: await this.services.removePhoto(auth, id, photoId) };
  }
}
