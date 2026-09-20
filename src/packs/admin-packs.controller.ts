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
import { PhotoOrderDto } from '../services/dto/services.dto.js';
import { CreatePackDto, PACK_SORT_FIELDS, PackDeletedDto, PackDetailDto, PackRowDto, PacksQueryDto, PackTabCountsDto, UpdatePackDto } from './dto/packs.dto.js';
import { PacksService } from './packs.service.js';

const packId = () => uuidParam('PACK_NOT_FOUND');
const ITEMS =
  '`serviceIds` (2–6, ordered, unique) must be services of `providerId` (422 PACK_SERVICE_OTHER_PROVIDER; unknown or deleted: 422 PACK_SERVICE_NOT_FOUND).';
const GUARD =
  'Publish guard (status-rules §4): 422 `PACK_PUBLISH_INVALID` with `details.missing` (nameEn, nameAr, items (<2), unpublishedItems, providerBlocked, providerNotVerified, priceNotBelowSum).';

@ApiTags('admin-packs')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/packs')
export class AdminPacksController {
  constructor(private readonly packs: PacksService) {}

  @Get()
  @ApiOperation({
    summary: 'List Ready Packs',
    description:
      'Tabs `tab` (all | published | draft | unpublished | needs_attention) with counters in `meta.counts` (they follow the filters, not the tab). ' +
      `Filters providerId, eventType, wilaya (repeat), priceMin/priceMax; \`q\` on names, provider name and business name. Sortable by ${PACK_SORT_FIELDS.join(', ')} ` +
      '(default createdAt:desc). Rows carry the price, the sum of the items and the savings. Export: resource `packs`. Used by PCK-01.',
  })
  @ApiPaginatedResponse(PackRowDto, { counts: PackTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@Query() query: PacksQueryDto) {
    return this.packs.list(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a pack', description: `Draft pack for a provider account (422 NOT_A_PROVIDER); the wilaya must be open. ${ITEMS} Used by PCK-03.` })
  @ApiDataResponse(PackDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'NOT_A_PROVIDER', 'WILAYA_NOT_FOUND', 'WILAYA_CLOSED', 'PACK_SERVICE_NOT_FOUND', 'PACK_SERVICE_OTHER_PROVIDER')
  async create(@CurrentUser() auth: AuthUser, @Body() dto: CreatePackDto) {
    return { data: await this.packs.create(auth, dto) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a pack',
    description: 'Items with their service summary, price and availability, photos, stats, `attentionReasons` and the publish checklist `publishMissing`. Used by PCK-02, PCK-03.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PackDetailDto)
  @ApiErrorResponses('PACK_NOT_FOUND')
  async get(@Param('id', packId()) id: string) {
    return { data: await this.packs.get(id) };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a pack', description: `Partial update; \`serviceIds\` replaces the items. ${ITEMS} A published pack must still pass the guard. ${GUARD} Used by PCK-03.` })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PackDetailDto)
  @ApiErrorResponses(
    'VALIDATION_FAILED',
    'PACK_NOT_FOUND',
    'NOT_A_PROVIDER',
    'WILAYA_NOT_FOUND',
    'WILAYA_CLOSED',
    'PACK_SERVICE_NOT_FOUND',
    'PACK_SERVICE_OTHER_PROVIDER',
    'PACK_PUBLISH_INVALID',
  )
  async update(@CurrentUser() auth: AuthUser, @Param('id', packId()) id: string, @Body() dto: UpdatePackDto) {
    return { data: await this.packs.update(auth, id, dto) };
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a pack',
    description: 'Soft delete; refused with 409 PACK_HAS_BOOKINGS while accepted upcoming bookings exist. Pending bookings are cancelled. Used by PCK-01, PCK-02.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PackDeletedDto)
  @ApiErrorResponses('PACK_NOT_FOUND', 'PACK_HAS_BOOKINGS')
  async remove(@CurrentUser() auth: AuthUser, @Param('id', packId()) id: string) {
    return { data: await this.packs.remove(auth, id) };
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a pack', description: `draft | unpublished → published. ${GUARD} Used by PCK-03.` })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PackDetailDto)
  @ApiErrorResponses('PACK_NOT_FOUND', 'PACK_INVALID_TRANSITION', 'PACK_PUBLISH_INVALID')
  async publish(@CurrentUser() auth: AuthUser, @Param('id', packId()) id: string) {
    return { data: await this.packs.transition(auth, id, 'publish') };
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unpublish a pack', description: 'published → unpublished. Used by PCK-01, PCK-02.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PackDetailDto)
  @ApiErrorResponses('PACK_NOT_FOUND', 'PACK_INVALID_TRANSITION')
  async unpublish(@CurrentUser() auth: AuthUser, @Param('id', packId()) id: string) {
    return { data: await this.packs.transition(auth, id, 'unpublish') };
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Duplicate a pack', description: 'A draft copy (names suffixed "(copy)" / "(نسخة)") with the same items and photos. Used by PCK-01, PCK-02.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PackDetailDto, { status: 201 })
  @ApiErrorResponses('PACK_NOT_FOUND')
  async duplicate(@CurrentUser() auth: AuthUser, @Param('id', packId()) id: string) {
    return { data: await this.packs.duplicate(auth, id) };
  }

  @Post(':id/photos')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(25) }))
  @ApiOperation({
    summary: 'Add a pack photo',
    description: 'multipart/form-data `file`; at most `max_photos_per_pack` (422 PHOTO_LIMIT_REACHED); compressed by the photo pipeline. Returns every photo in order. Used by PCK-03.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PhotoDto, { status: 201, isArray: true })
  @ApiErrorResponses('VALIDATION_FAILED', 'PACK_NOT_FOUND', 'PHOTO_LIMIT_REACHED', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'RATE_LIMITED')
  async addPhoto(@CurrentUser() auth: AuthUser, @Param('id', packId()) id: string, @UploadedFile() file: UploadedPhotoFile | undefined) {
    if (!file) throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'file', code: 'IS_DEFINED', message: 'file is required' }]);
    return { data: await this.packs.addPhoto(auth, id, file) };
  }

  @Patch(':id/photos/order')
  @ApiOperation({ summary: 'Reorder pack photos', description: '`ids` lists every photo once (422 PHOTO_ORDER_INVALID); the first is the cover. Used by PCK-03.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PhotoDto, { isArray: true })
  @ApiErrorResponses('VALIDATION_FAILED', 'PACK_NOT_FOUND', 'PHOTO_ORDER_INVALID')
  async reorderPhotos(@CurrentUser() auth: AuthUser, @Param('id', packId()) id: string, @Body() dto: PhotoOrderDto) {
    return { data: await this.packs.reorderPhotos(auth, id, dto.ids) };
  }

  @Delete(':id/photos/:photoId')
  @ApiOperation({ summary: 'Remove a pack photo', description: 'The rest are renumbered. Used by PCK-03.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'photoId', format: 'uuid' })
  @ApiDataResponse(PhotoDto, { isArray: true })
  @ApiErrorResponses('PACK_NOT_FOUND', 'PHOTO_NOT_FOUND')
  async removePhoto(@CurrentUser() auth: AuthUser, @Param('id', packId()) id: string, @Param('photoId', uuidParam('PHOTO_NOT_FOUND')) photoId: string) {
    return { data: await this.packs.removePhoto(auth, id, photoId) };
  }
}
