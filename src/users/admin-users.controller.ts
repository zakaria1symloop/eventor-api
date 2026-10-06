import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { UPLOAD_THROTTLE } from '../common/http/throttles.js';
import { uploadLimits } from '../common/http/upload-limits.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import {
  BlockImpactDto,
  BlockResultDto,
  BlockUserDto,
  BulkItemResultDto,
  BulkUsersDto,
  CreateNoteDto,
  CreateUserDto,
  DeleteUserDto,
  NoteDto,
  PasswordResetDto,
  PasswordResetResultDto,
  RemoveAvatarDto,
  SessionsRevokedDto,
  UpdateUserDto,
  USER_SORT_FIELDS,
  UserDetailDto,
  UserRowDto,
  UsersQueryDto,
  UserTabCountsDto,
} from './dto/users.dto.js';
import { AvatarsService, type AvatarUpload } from './avatars.service.js';
import { UserAccountsService } from './user-accounts.service.js';
import { UsersService } from './users.service.js';

const userId = () => uuidParam('USER_NOT_FOUND');

@ApiTags('admin-users')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly accounts: UserAccountsService,
    private readonly avatars: AvatarsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List clients and providers',
    description:
      'Tabs `tab` (all | clients | providers | blocked | awaiting_verification) with counters in `meta.counts` (they follow every filter except the tab). ' +
      'Filters: role, status, verificationStatus, wilaya (repeat), categoryId, minRating/maxRating, joinedFrom/joinedTo, ' +
      'minCompletedBookings/maxCompletedBookings, lastActive (7d | 30d | 90d | never), language. `q`: full-text on name and email, exact email or phone, ' +
      `business name contains. Sortable by ${USER_SORT_FIELDS.join(', ')} (default createdAt:desc). Admins are never listed. ` +
      'Export: resource `users`; saved views: resource `users`. Used by USR-01, USR-03.',
  })
  @ApiPaginatedResponse(UserRowDto, { counts: UserTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@Query() query: UsersQueryDto) {
    return this.users.list(query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a client or provider',
    description:
      'Creates the account without a password and emails a set-password link (`${APP_PUBLIC_URL}/set-password?token=…`, valid 7 days). ' +
      'Phone `0XXXXXXXXX` or `+213…` is stored as `+213XXXXXXXXX`. Providers need businessName and categoryId and get a provider profile; ' +
      'without `skipVerification` they are `pending` and appear in VER-01. Used by USR-05.',
  })
  @ApiDataResponse(UserDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'EMAIL_TAKEN', 'PHONE_TAKEN', 'NOT_A_PROVIDER', 'CATEGORY_NOT_FOUND', 'WILAYA_NOT_FOUND')
  async create(@CurrentUser() auth: AuthUser, @Body() dto: CreateUserDto) {
    return { data: await this.users.create(auth, dto) };
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk block, unblock or delete',
    description:
      'All-or-nothing: every id is checked first (exists, state allows the action, no active items for delete). One refusal changes nothing and ' +
      'returns 409 `BULK_ACTION_REFUSED` with `details.refused: [{ id, code }]`. Block needs `reason` and `bookings`. Returns one result per id. Used by USR-04.',
  })
  @ApiDataResponse(BulkItemResultDto, { isArray: true })
  @ApiErrorResponses('VALIDATION_FAILED', 'BULK_ACTION_REFUSED')
  async bulk(@CurrentUser() auth: AuthUser, @Body() dto: BulkUsersDto) {
    return { data: await this.accounts.bulk(auth, dto) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a user profile',
    description:
      'Profile with stats (bookings, services, packs, reviews, disputes, earnings, reply rate), provider profile and wilayas, documents summary, ' +
      'block banner data, and recent bookings (4), services (4), reviews (3) and notes (3). Used by USR-10, USR-11, USR-13.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(UserDetailDto)
  @ApiErrorResponses('USER_NOT_FOUND')
  async get(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string) {
    return { data: await this.users.get(id, auth) };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit user details',
    description:
      'Partial update. Provider fields (businessName, categoryId, bioEn/bioAr, wilayaCodes, acceptingBookings, languagesSpoken, yearsActive) only for providers. ' +
      'Changing email or phone requires `reason`. `role` cannot be sent (400 ROLE_IMMUTABLE). Audited with a diff. Used by USR-06.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(UserDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'ROLE_IMMUTABLE', 'USER_NOT_FOUND', 'EMAIL_TAKEN', 'PHONE_TAKEN', 'NOT_A_PROVIDER', 'CATEGORY_NOT_FOUND', 'WILAYA_NOT_FOUND')
  async update(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string, @Body() dto: UpdateUserDto) {
    return { data: await this.users.update(auth, id, dto) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a user (anonymise)',
    description:
      'Body `{ typedName }` must match the full name. Refused with 409 `ACCOUNT_HAS_ACTIVE_ITEMS` (details upcomingBookings, openDisputes) while the user has ' +
      'accepted upcoming bookings or an open dispute. Soft-deletes, cancels pending bookings, revokes sessions; personal data is anonymised by a daily job after 30 days. Used by USR-08.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'USER_NOT_FOUND', 'TYPED_NAME_MISMATCH', 'ACCOUNT_HAS_ACTIVE_ITEMS')
  async remove(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string, @Body() dto: DeleteUserDto): Promise<void> {
    await this.accounts.remove(auth, id, dto);
  }

  @Get(':id/block-impact')
  @ApiOperation({ summary: 'Preview what blocking does', description: 'Counts shown in the impact box before confirming. Used by USR-07.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(BlockImpactDto)
  @ApiErrorResponses('USER_NOT_FOUND')
  async blockImpact(@Param('id', userId()) id: string) {
    return { data: await this.accounts.blockImpact(id) };
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Block a user',
    description:
      'One transaction: status blocked (reason, optional future `until`, message), sessions revoked, provider services and packs hidden by the visibility rule, ' +
      'pending bookings cancelled when `bookings=cancel` (status change rows + `booking.cancelled` events), conversations read-only for the user; audit (sensitive); ' +
      'the user is emailed. An hourly job unblocks when `until` passes. Used by USR-07, USR-13.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(BlockResultDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'USER_NOT_FOUND', 'USER_ALREADY_BLOCKED')
  async block(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string, @Body() dto: BlockUserDto) {
    return { data: await this.accounts.block(auth, id, dto) };
  }

  @Post(':id/avatar')
  @HttpCode(HttpStatus.OK)
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(20) }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({
    summary: 'Replace a user’s photo',
    description:
      'Same rules as the app’s own upload: `max_photo_upload_mb`, type sniffed from the bytes, WebP variants built in the ' +
      'background, previous photo deleted. Audited as `user.avatar_replaced`. Returns the profile (user page).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(UserDetailDto)
  @ApiErrorResponses('USER_NOT_FOUND', 'VALIDATION_FAILED', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'RATE_LIMITED')
  async replaceAvatar(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string, @UploadedFile() file: AvatarUpload | undefined) {
    await this.users.load(id);
    await this.avatars.replace(id, file, 'user.avatar_replaced');
    return { data: await this.users.get(id, auth) };
  }

  @Delete(':id/avatar')
  @ApiOperation({
    summary: 'Remove a user’s photo',
    description: 'E.g. an inappropriate picture. The optional `note` goes to the activity log (`user.avatar_removed`). Returns the profile (user page).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(UserDetailDto)
  @ApiErrorResponses('USER_NOT_FOUND', 'VALIDATION_FAILED')
  async removeAvatar(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string, @Body() dto: RemoveAvatarDto) {
    await this.users.load(id);
    await this.avatars.remove(id, 'user.avatar_removed', dto.note ?? null);
    return { data: await this.users.get(id, auth) };
  }

  @Post(':id/unblock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Unblock a user',
    description: 'Services and packs become visible again, conversations writable; cancelled bookings stay cancelled. Returns the profile. Used by USR-13.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(UserDetailDto)
  @ApiErrorResponses('USER_NOT_FOUND', 'USER_NOT_BLOCKED')
  async unblock(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string) {
    return { data: await this.accounts.unblock(auth, id) };
  }

  @Post(':id/password-reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset a user password',
    description:
      '`link`: emails `${APP_PUBLIC_URL}/reset-password?token=…` (60 min). `temporary`: sets and returns a generated password, shown once. ' +
      '`signOutEverywhere` revokes every session. Used by USR-09.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PasswordResetResultDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'USER_NOT_FOUND')
  async passwordReset(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string, @Body() dto: PasswordResetDto) {
    return { data: await this.accounts.passwordReset(auth, id, dto) };
  }

  @Post(':id/sessions/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out everywhere', description: 'Revokes every session of the user. Used by USR-09.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(SessionsRevokedDto)
  @ApiErrorResponses('USER_NOT_FOUND')
  async revokeSessions(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string) {
    return { data: await this.accounts.revokeSessions(auth, id) };
  }

  @Get(':id/notes')
  @ApiOperation({ summary: 'List internal notes', description: 'Newest first. Used by USR-10, USR-11.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiPaginatedResponse(NoteDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'USER_NOT_FOUND')
  listNotes(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string, @Query() query: PaginationQueryDto) {
    return this.users.listNotes(auth, id, query);
  }

  @Post(':id/notes')
  @ApiOperation({ summary: 'Add an internal note', description: 'Visible to admins only. Used by USR-10, USR-11.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(NoteDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'USER_NOT_FOUND')
  async addNote(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string, @Body() dto: CreateNoteDto) {
    return { data: await this.users.addNote(auth, id, dto) };
  }

  @Delete(':id/notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an internal note', description: 'Only its author (403 NOT_OWNER otherwise). Used by USR-10, USR-11.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'noteId', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiErrorResponses('USER_NOT_FOUND', 'NOTE_NOT_FOUND', 'NOT_OWNER')
  async deleteNote(@CurrentUser() auth: AuthUser, @Param('id', userId()) id: string, @Param('noteId', uuidParam('NOTE_NOT_FOUND')) noteId: string): Promise<void> {
    await this.users.deleteNote(auth, id, noteId);
  }
}
