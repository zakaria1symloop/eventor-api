import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { AppBudgetService } from './app-budget.service.js';
import { AppFavouritesService } from './app-favourites.service.js';
import { AppMeService, type UploadedFile as MulterFile } from './app-me.service.js';
import {
  AppBudgetDto,
  AppChangePasswordDto,
  AppDeviceTokenDto,
  AppDocumentsDto,
  AppFavouriteDto,
  AppFavouritesQueryDto,
  AppMeDto,
  AppNotificationDto,
  AppNotificationPreferencesDto,
  AppNotificationsQueryDto,
  AppSessionRowDto,
  CreateBudgetItemDto,
  CreateFavouriteDto,
  DeleteAppMeDto,
  DeleteFavouriteByTargetDto,
  MarkNotificationsReadDto,
  MarkedReadDto,
  PutBudgetDto,
  RegisterDeviceTokenDto,
  RevokedSessionsDto,
  UnreadCountDto,
  UpdateAppMeDto,
  UpdateBudgetItemDto,
  UpdateNotificationPreferencesDto,
  UploadAppDocumentDto,
} from './dto/app-me.dto.js';

/** Multipart limit for documents and avatars; the service then applies the stricter platform setting. */
const MAX_UPLOAD_MB = 20;

/**
 * The signed-in account: profile, sessions, provider documents, devices,
 * notifications, favourites and the private budget. Everything here is scoped
 * to the caller — there is no `:userId` to tamper with.
 */
@ApiTags('app-me')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED', 'FORBIDDEN_AUDIENCE', 'ACCOUNT_BLOCKED')
@Roles(UserRole.Client, UserRole.Provider)
@Controller('app/me')
export class AppMeController {
  constructor(
    private readonly me: AppMeService,
    private readonly favourites: AppFavouritesService,
    private readonly budget: AppBudgetService,
  ) {}

  // ── profile ─────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'My account',
    description:
      'Screen 21a Home · Provider · Pending and the Profile tab. Carries `verificationStatus`, the provider profile when ' +
      'the account is one, and the two unread counters the tab bar badges.',
  })
  @ApiDataResponse(AppMeDto)
  async profile(@CurrentUser() auth: AuthUser, @ReqLang() lang: Lang) {
    return { data: await this.me.profile(auth.id, lang) };
  }

  @Patch()
  @ApiOperation({
    summary: 'Update my profile',
    description:
      'Profile · Edit. Name, phone, language, wilaya and the avatar (send a `avatarFileId` from `POST /app/me/avatar`, ' +
      'or `null` to remove it). The role and the email are immutable here.',
  })
  @ApiDataResponse(AppMeDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'PHONE_TAKEN', 'WILAYA_NOT_FOUND', 'FILE_NOT_FOUND', 'USER_NOT_FOUND')
  async update(@CurrentUser() auth: AuthUser, @Body() dto: UpdateAppMeDto, @ReqLang() lang: Lang) {
    return { data: await this.me.update(auth, dto, lang) };
  }

  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change my password', description: 'Profile · Change password. Signs out every **other** session; this one keeps working.' })
  @ApiResponse({ status: 204, description: 'Password changed.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'CURRENT_PASSWORD_INVALID', 'PASSWORD_WEAK')
  async changePassword(@CurrentUser() auth: AuthUser, @Body() dto: AppChangePasswordDto): Promise<void> {
    await this.me.changePassword(auth, dto.currentPassword, dto.newPassword);
  }

  @Post('avatar')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(MAX_UPLOAD_MB) }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({
    summary: 'Upload my avatar',
    description:
      'Profile · Edit. The type is sniffed from the bytes, not the extension; the image is converted to WebP with ' +
      '`thumb` (320 px) and `medium` (800 px) variants by a background job, so `avatarUrl` may serve the original for a ' +
      'moment. The previous avatar is deleted. Returns the refreshed profile.',
  })
  @ApiDataResponse(AppMeDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'RATE_LIMITED')
  async avatar(@CurrentUser() auth: AuthUser, @UploadedFile() file: MulterFile | undefined, @ReqLang() lang: Lang) {
    if (!file) {
      return { data: await this.me.profile(auth.id, lang) };
    }
    return { data: await this.me.uploadAvatar(auth, file, lang) };
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete my account',
    description:
      'Profile · Delete account, confirmed with the current password. Soft delete with the same guards as the admin route: ' +
      'an upcoming booking or an open dispute refuses it with 409 `ACCOUNT_HAS_ACTIVE_ITEMS` and the counts. Pending ' +
      'bookings are cancelled, every session is revoked, and personal data is anonymised after 30 days — reviews and ' +
      'bookings stay, attributed to "Deleted user".',
  })
  @ApiResponse({ status: 204, description: 'Account closed.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'CURRENT_PASSWORD_INVALID', 'ACCOUNT_HAS_ACTIVE_ITEMS', 'USER_NOT_FOUND')
  async remove(@CurrentUser() auth: AuthUser, @Body() dto: DeleteAppMeDto): Promise<void> {
    await this.me.deleteAccount(auth, dto.password);
  }

  // ── sessions ────────────────────────────────────────────────

  @Get('sessions')
  @ApiOperation({ summary: 'My signed-in devices', description: 'Profile · Security. App sessions only; the dashboard’s are never listed.' })
  @ApiDataResponse(AppSessionRowDto, { isArray: true })
  async sessions(@CurrentUser() auth: AuthUser) {
    return { data: await this.me.listSessions(auth) };
  }

  @Delete('sessions')
  @ApiOperation({ summary: 'Sign out my other devices', description: 'Revokes every app session except the one making the call.' })
  @ApiDataResponse(RevokedSessionsDto)
  async revokeOtherSessions(@CurrentUser() auth: AuthUser) {
    return { data: await this.me.revokeSession(auth, null) };
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out one device', description: 'Revokes one of my app sessions.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Session revoked.' })
  @ApiErrorResponses('SESSION_NOT_FOUND')
  async revokeSession(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('SESSION_NOT_FOUND')) id: string): Promise<void> {
    await this.me.revokeSession(auth, id);
  }

  // ── provider documents (screens 08a / 08d) ──────────────────

  @Get('documents')
  @ApiOperation({
    summary: 'My verification documents',
    description:
      'Screens 08c/08d Resubmit documents and 21a Pending. One entry per required type — `national_id`, ' +
      '`commercial_register_or_artisan_card`, `tax_card` — each with its status (`missing` when nothing was sent), the ' +
      'reject reason with a translated label, the admin’s note and when it was reviewed. Providers only.',
  })
  @ApiDataResponse(AppDocumentsDto)
  @ApiErrorResponses('NOT_A_PROVIDER', 'USER_NOT_FOUND')
  async documents(@CurrentUser() auth: AuthUser, @ReqLang() lang: Lang) {
    return { data: await this.me.documents(auth, lang) };
  }

  @Post('documents')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(MAX_UPLOAD_MB) }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['type', 'file'],
      properties: {
        type: { type: 'string', enum: ['national_id', 'commercial_register_or_artisan_card', 'tax_card'] },
        file: { type: 'string', format: 'binary', description: 'PDF or image, at most `max_document_upload_mb` (5 MB).' },
      },
    },
  })
  @ApiOperation({
    summary: 'Send (or resend) a verification document',
    description:
      'Screens 08a Register · provider and 08d Resubmit documents. Stores a **new current version**, back to `pending`; ' +
      'the previous one is kept as history for the admin. The account’s `verificationStatus` is recomputed from the ' +
      'current documents (status-rules §2), so a resubmission moves a rejected provider back to `pending`. Returns the ' +
      'whole document list, ready for the screen.',
  })
  @ApiDataResponse(AppDocumentsDto, { status: 201, description: 'The new version is stored; the whole document list comes back.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'NOT_A_PROVIDER', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'RATE_LIMITED')
  async uploadDocument(
    @CurrentUser() auth: AuthUser,
    @Body() dto: UploadAppDocumentDto,
    @UploadedFile() file: MulterFile | undefined,
    @ReqLang() lang: Lang,
  ) {
    if (!file) {
      throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'file', code: 'REQUIRED', message: 'A file is required' }]);
    }
    return { data: await this.me.uploadDocument(auth, dto.type, file, lang) };
  }

  // ── devices & notification preferences ──────────────────────

  @Post('device-tokens')
  @ApiOperation({
    summary: 'Register this device for push',
    description:
      'Screen 16 Notifications / app start. Idempotent: sending the same token again refreshes it and moves it to this ' +
      'account (a shared phone). Call `DELETE` on sign-out so the next user does not get these pushes.',
  })
  @ApiDataResponse(AppDeviceTokenDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async registerDevice(@CurrentUser() auth: AuthUser, @Body() dto: RegisterDeviceTokenDto) {
    return { data: await this.me.registerDeviceToken(auth, dto) };
  }

  @Delete('device-tokens/:token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop push on this device', description: 'Call it before `POST /app/auth/logout`.' })
  @ApiParam({ name: 'token', description: 'The FCM token, URL-encoded.' })
  @ApiResponse({ status: 204, description: 'Device removed.' })
  @ApiErrorResponses('DEVICE_TOKEN_NOT_FOUND')
  async removeDevice(@CurrentUser() auth: AuthUser, @Param('token') token: string): Promise<void> {
    await this.me.removeDeviceToken(auth, token);
  }

  @Get('notification-preferences')
  @ApiOperation({
    summary: 'My notification settings',
    description: 'Profile · Notifications. Everything is on until the user changes it; security emails are never muted.',
  })
  @ApiDataResponse(AppNotificationPreferencesDto)
  async notificationPreferences(@CurrentUser() auth: AuthUser) {
    return { data: await this.me.notificationPreferences(auth) };
  }

  @Patch('notification-preferences')
  @ApiOperation({ summary: 'Change my notification settings', description: 'Profile · Notifications. Send only the switches that changed.' })
  @ApiDataResponse(AppNotificationPreferencesDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async updateNotificationPreferences(@CurrentUser() auth: AuthUser, @Body() dto: UpdateNotificationPreferencesDto) {
    return { data: await this.me.updateNotificationPreferences(auth, dto) };
  }

  // ── notifications (screen 16) ───────────────────────────────

  @Get('notifications')
  @ApiOperation({
    summary: 'My notifications',
    description:
      'Screen 16 Notifications. Newest first, each row carrying `group` (`today` | `this_week` | `earlier`, Africa/Algiers) ' +
      'so the app renders the three sections without recomputing dates, and `data` for the deep link.',
  })
  @ApiPaginatedResponse(AppNotificationDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async notifications(@CurrentUser() auth: AuthUser, @Query() query: AppNotificationsQueryDto) {
    return this.me.notifications(auth, query);
  }

  @Get('notifications/unread-count')
  @ApiOperation({ summary: 'Unread notification count', description: 'The bell badge on screen 11 Home.' })
  @ApiDataResponse(UnreadCountDto)
  async unreadCount(@CurrentUser() auth: AuthUser) {
    return { data: await this.me.unreadCount(auth) };
  }

  @Post('notifications/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark notifications read',
    description: 'Screen 16 "Mark all read" (`all: true`) or tapping one row (`ids`). Already-read rows are left alone.',
  })
  @ApiDataResponse(MarkedReadDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async markRead(@CurrentUser() auth: AuthUser, @Body() dto: MarkNotificationsReadDto) {
    return { data: await this.me.markRead(auth, dto) };
  }

  @Delete('notifications/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a notification',
    description: 'Screen 16, swipe-to-delete. Removes one of **my** notifications for good (hard delete) — it will not come back on the next sync.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiErrorResponses('NOTIFICATION_NOT_FOUND')
  async deleteNotification(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('NOTIFICATION_NOT_FOUND')) id: string): Promise<void> {
    await this.me.deleteNotification(auth, id);
  }

  // ── favourites (screen 17) ──────────────────────────────────

  @Get('favourites')
  @ApiOperation({
    summary: 'My favourites',
    description:
      'Screen 17 Favorites. Services and packs together, newest first. A row whose target stopped being visible stays in ' +
      'the list with `available: false`, so the grid does not silently shrink. `categoryId` is the chip row (services only, ' +
      'since packs have no single category).',
  })
  @ApiPaginatedResponse(AppFavouriteDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async listFavourites(@CurrentUser() auth: AuthUser, @Query() query: AppFavouritesQueryDto, @ReqLang() lang: Lang) {
    return this.favourites.list(auth, query, lang);
  }

  @Post('favourites')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a favourite',
    description:
      'The ♥ on screens 12, 13, 19 and 20. Exactly one of `serviceId` / `packId`. Idempotent: favouriting twice returns ' +
      'the same row rather than an error.',
  })
  @ApiDataResponse(AppFavouriteDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'FAVOURITE_TARGET_INVALID', 'SERVICE_NOT_FOUND', 'PACK_NOT_FOUND', 'FAVOURITE_NOT_FOUND')
  async addFavourite(@CurrentUser() auth: AuthUser, @Body() dto: CreateFavouriteDto, @ReqLang() lang: Lang) {
    return { data: await this.favourites.add(auth, dto, lang) };
  }

  @Delete('favourites')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a favourite by its target',
    description:
      'Un-save straight from a card: `?serviceId=` or `?packId=` (exactly one), no favourite row id needed. ' +
      '**Idempotent** — removing something that is not saved still answers 204, so a double tap on ♥ never errors.',
  })
  @ApiResponse({ status: 204, description: 'Not a favourite any more (whether or not it was one).' })
  @ApiErrorResponses('VALIDATION_FAILED', 'FAVOURITE_TARGET_INVALID')
  async removeFavouriteByTarget(@CurrentUser() auth: AuthUser, @Query() query: DeleteFavouriteByTargetDto): Promise<void> {
    await this.favourites.removeByTarget(auth, query);
  }

  @Delete('favourites/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a favourite', description: 'Screen 17, the ♥ on a card. `:id` is the **favourite** id, not the service id (or use `DELETE /app/me/favourites?serviceId=`).' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'The `id` of the favourite row.' })
  @ApiResponse({ status: 204, description: 'Removed.' })
  @ApiErrorResponses('FAVOURITE_NOT_FOUND')
  async removeFavourite(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('FAVOURITE_NOT_FOUND')) id: string): Promise<void> {
    await this.favourites.remove(auth, id);
  }

  // ── budget (screen 18) ──────────────────────────────────────

  @Get('budget')
  @ApiOperation({
    summary: 'My budget',
    description:
      'Screen 18 Budget. **Private to its owner**: there is no endpoint, admin or otherwise, that reads somebody else’s ' +
      'budget. 404 `BUDGET_NOT_FOUND` until the client creates one with `PUT`.',
  })
  @ApiDataResponse(AppBudgetDto)
  @ApiErrorResponses('BUDGET_NOT_FOUND', 'NOT_OWNER')
  async getBudget(@CurrentUser() auth: AuthUser, @ReqLang() lang: Lang) {
    return { data: await this.budget.get(auth, lang) };
  }

  @Put('budget')
  @ApiOperation({
    summary: 'Create or update my budget',
    description: 'Screen 18 header · Edit. One budget per client: the first call creates it, later ones replace title, date and plan.',
  })
  @ApiDataResponse(AppBudgetDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'NOT_OWNER')
  async putBudget(@CurrentUser() auth: AuthUser, @Body() dto: PutBudgetDto, @ReqLang() lang: Lang) {
    return { data: await this.budget.put(auth, dto, lang) };
  }

  @Delete('budget')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete my budget',
    description:
      'Screen 18f. Deletes the budget and all its lines for good; linked bookings are not touched. Afterwards `GET` answers ' +
      '404 `BUDGET_NOT_FOUND` and Home shows "Plan your budget" again. 404 `BUDGET_NOT_FOUND` when there is none (treat as already deleted).',
  })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiErrorResponses('BUDGET_NOT_FOUND', 'NOT_OWNER')
  async deleteBudget(@CurrentUser() auth: AuthUser): Promise<void> {
    await this.budget.remove(auth);
  }

  @Post('budget/items')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a budget line',
    description:
      'Screen 18 "+ Add an expense". `bookingId` links the line to one of **my** bookings, which is what makes it count ' +
      'in "3 of 6 services booked" and fills `providerName`.',
  })
  @ApiDataResponse(AppBudgetDto, { status: 201, description: 'The whole budget, recomputed.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'BUDGET_NOT_FOUND', 'BUDGET_ITEM_LIMIT', 'BUDGET_BOOKING_ALREADY_LINKED', 'CATEGORY_NOT_FOUND', 'BOOKING_NOT_FOUND', 'NOT_OWNER')
  async addBudgetItem(@CurrentUser() auth: AuthUser, @Body() dto: CreateBudgetItemDto, @ReqLang() lang: Lang) {
    return { data: await this.budget.addItem(auth, dto, lang) };
  }

  @Patch('budget/items/:id')
  @ApiOperation({ summary: 'Edit a budget line', description: 'Screen 18, tapping a line. Send only the fields that changed.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBudgetDto, { description: 'The whole budget, recomputed.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'BUDGET_NOT_FOUND', 'BUDGET_ITEM_NOT_FOUND', 'BUDGET_BOOKING_ALREADY_LINKED', 'CATEGORY_NOT_FOUND', 'BOOKING_NOT_FOUND', 'NOT_OWNER')
  async updateBudgetItem(
    @CurrentUser() auth: AuthUser,
    @Param('id', uuidParam('BUDGET_ITEM_NOT_FOUND')) id: string,
    @Body() dto: UpdateBudgetItemDto,
    @ReqLang() lang: Lang,
  ) {
    return { data: await this.budget.updateItem(auth, id, dto, lang) };
  }

  @Delete('budget/items/:id')
  @ApiOperation({ summary: 'Delete a budget line', description: 'Screen 18. Returns the recomputed budget so the header updates in one round trip.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppBudgetDto)
  @ApiErrorResponses('BUDGET_NOT_FOUND', 'BUDGET_ITEM_NOT_FOUND', 'NOT_OWNER')
  async removeBudgetItem(
    @CurrentUser() auth: AuthUser,
    @Param('id', uuidParam('BUDGET_ITEM_NOT_FOUND')) id: string,
    @ReqLang() lang: Lang,
  ) {
    return { data: await this.budget.removeItem(auth, id, lang) };
  }
}
