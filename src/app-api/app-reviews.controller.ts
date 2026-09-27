import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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
import { AppProviderService } from './app-provider.service.js';
import { AppReviewsService } from './app-reviews.service.js';
import { AppMessageDto } from './dto/app-messages.dto.js';
import { AppReviewReplyDto } from './dto/app-provider.dto.js';
import {
  AppCreateReviewDto,
  AppDisputeDetailDto,
  AppDisputeEvidenceDto,
  AppDisputeMessageDto,
  AppDisputeRowDto,
  AppDisputesQueryDto,
  AppEditReviewDto,
  AppMyReviewDto,
  AppMyReviewsQueryDto,
  AppOpenDisputeDto,
  AppWithdrawDisputeDto,
} from './dto/app-reviews.dto.js';

/** Evidence files are capped at 5 MB by the dispute rules; this is the multipart ceiling. */
const MAX_EVIDENCE_MB = 10;

/**
 * "Leave a review" (screen map §C) and the problem-reporting flow: a client
 * reviews a completed booking, a provider replies once, and either party can
 * raise a dispute on a booking and talk to Eventor about it.
 */
@ApiTags('app-reviews')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiHeader({ name: 'Accept-Language', required: false, description: '`en` or `ar`. Falls back to the account’s language, then `en`.' })
@ApiErrorResponses('FORBIDDEN_AUDIENCE', 'ACCOUNT_BLOCKED')
@Roles(UserRole.Client, UserRole.Provider)
@Controller('app')
export class AppReviewsController {
  constructor(
    private readonly reviews: AppReviewsService,
    private readonly provider: AppProviderService,
  ) {}

  // ── reviews ─────────────────────────────────────────────────

  @Post('bookings/:id/review')
  @Roles(UserRole.Client)
  @ApiOperation({
    summary: 'Review a completed booking',
    description:
      'The "Leave a review" screen, usually opened from the notification. status-rules §8: **the client** of a ' +
      '**completed** booking, one review per booking, from `review_open_after_hours` (24 h) after the completion until ' +
      '60 days after it, and never while a dispute is open. The comment is scanned for phone numbers, emails, links ' +
      'and insults: a flagged review is **still published** and opens an automatic report for an admin to look at.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppMyReviewDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'NOT_OWNER', 'REVIEW_EXISTS', 'REVIEW_NOT_ALLOWED', 'REVIEW_WINDOW_CLOSED', 'FORBIDDEN_ROLE')
  async create(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @Body() dto: AppCreateReviewDto, @ReqLang() lang: Lang) {
    return { data: await this.reviews.create(auth, id, dto, lang) };
  }

  @Patch('reviews/:id')
  @Roles(UserRole.Client)
  @ApiOperation({
    summary: 'Edit my review',
    description: 'status-rules §8: the author edits their review for **48 hours** after writing it; after that it answers 422 `REVIEW_EDIT_WINDOW_CLOSED`. Ratings are recomputed.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppMyReviewDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'REVIEW_NOT_FOUND', 'NOT_OWNER', 'REVIEW_EDIT_WINDOW_CLOSED', 'FORBIDDEN_ROLE')
  async edit(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('REVIEW_NOT_FOUND')) id: string, @Body() dto: AppEditReviewDto, @ReqLang() lang: Lang) {
    return { data: await this.reviews.edit(auth, id, dto, lang) };
  }

  @Get('me/reviews')
  @Roles(UserRole.Client)
  @ApiOperation({
    summary: 'Reviews I wrote',
    description: 'Profile · My reviews. A review an admin hid or redacted keeps its row and says so in `status`, so the client is never left wondering where it went.',
  })
  @ApiPaginatedResponse(AppMyReviewDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'FORBIDDEN_ROLE')
  async mine(@CurrentUser() auth: AuthUser, @Query() query: AppMyReviewsQueryDto, @ReqLang() lang: Lang) {
    return this.reviews.mine(auth, query, lang);
  }

  // ── the provider's reply ────────────────────────────────────

  @Post('reviews/:id/reply')
  @Roles(UserRole.Provider)
  @ApiOperation({
    summary: 'Reply to a review',
    description:
      'status-rules §8: **one** public reply per review, by the provider it is about. The text goes through the same ' +
      'flag scan as a review. Editable and deletable for 48 h.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'The new reply’s id.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'REVIEW_NOT_FOUND', 'NOT_OWNER', 'REVIEW_REPLY_EXISTS', 'FORBIDDEN_ROLE')
  async reply(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('REVIEW_NOT_FOUND')) id: string, @Body() dto: AppReviewReplyDto) {
    return { data: await this.provider.reply(auth, id, dto.body) };
  }

  @Patch('reviews/replies/:id')
  @Roles(UserRole.Provider)
  @ApiOperation({ summary: 'Edit my reply', description: 'Within 48 h of writing it (status-rules §8), otherwise 422 `REVIEW_EDIT_WINDOW_CLOSED`.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The reply’s id.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'REVIEW_REPLY_NOT_FOUND', 'NOT_OWNER', 'REVIEW_EDIT_WINDOW_CLOSED', 'FORBIDDEN_ROLE')
  async editReply(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('REVIEW_REPLY_NOT_FOUND')) id: string, @Body() dto: AppReviewReplyDto) {
    return { data: await this.provider.editReply(auth, id, dto.body) };
  }

  @Delete('reviews/replies/:id')
  @Roles(UserRole.Provider)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete my reply', description: 'Within the same 48-hour window. The review itself is untouched.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiErrorResponses('REVIEW_REPLY_NOT_FOUND', 'NOT_OWNER', 'REVIEW_EDIT_WINDOW_CLOSED', 'FORBIDDEN_ROLE')
  async deleteReply(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('REVIEW_REPLY_NOT_FOUND')) id: string) {
    await this.provider.deleteReply(auth, id);
  }

  // ── disputes ────────────────────────────────────────────────

  @Post('bookings/:id/disputes')
  @ApiOperation({
    summary: 'Report a problem on a booking',
    description:
      'status-rules §6, for **either** party. The window runs from the event start until `dispute_window_hours` ' +
      '(72 h) after the event end, or 7 days after a contested cancellation — outside it, 422 ' +
      '`DISPUTE_WINDOW_CLOSED`. Opening one pauses the automatic completion and the reviews, attaches a snapshot of ' +
      'your chat as evidence, and opens a dispute conversation with the other party and Eventor. Only one open ' +
      'dispute per booking. Payment is cash, so a dispute is a way to hand the problem to an admin — there are no ' +
      'refunds and no fees.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppDisputeDetailDto, { status: 201 })
  @ApiErrorResponses(
    'VALIDATION_FAILED',
    'BOOKING_NOT_FOUND',
    'NOT_OWNER',
    'BOOKING_NOT_DISPUTABLE',
    'DISPUTE_ALREADY_OPEN',
    'DISPUTE_WINDOW_CLOSED',
    'EVIDENCE_FILE_INVALID',
    'DISPUTE_EVIDENCE_LIMIT',
  )
  async openDispute(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('BOOKING_NOT_FOUND')) id: string, @Body() dto: AppOpenDisputeDto, @ReqLang() lang: Lang) {
    return { data: await this.reviews.openDispute(auth, id, dto, lang) };
  }

  @Get('disputes')
  @ApiOperation({ summary: 'My disputes', description: 'Every dispute on a booking of yours, whichever side opened it, newest first.' })
  @ApiPaginatedResponse(AppDisputeRowDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async listDisputes(@CurrentUser() auth: AuthUser, @Query() query: AppDisputesQueryDto, @ReqLang() lang: Lang) {
    return this.reviews.listDisputes(auth, query, lang);
  }

  @Get('disputes/:id')
  @ApiOperation({
    summary: 'Dispute detail',
    description:
      'The dispute screen: the description, the evidence (private to the two parties and Eventor), the id of the ' +
      'dispute chat and, once an admin has decided, the decision note. A dispute on somebody else’s booking answers ' +
      '403 `NOT_OWNER`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppDisputeDetailDto)
  @ApiErrorResponses('DISPUTE_NOT_FOUND', 'NOT_OWNER')
  async dispute(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('DISPUTE_NOT_FOUND')) id: string, @ReqLang() lang: Lang) {
    return { data: await this.reviews.disputeDetail(auth, id, lang) };
  }

  @Post('disputes/:id/messages')
  @ApiOperation({
    summary: 'Write in the dispute chat (text convenience)',
    description:
      'The dispute conversation holds you, the other party and Eventor support. This route is a **text-only convenience**: ' +
      'the normal `POST /app/conversations/{conversationId}/messages` route works in the dispute chat too while it is ' +
      'open — including multipart images — using the `conversationId` from the dispute detail. Messages are never ' +
      'masked here — an admin is reading. A closed dispute chat answers **409 `CONVERSATION_CLOSED`**.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppMessageDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'DISPUTE_NOT_FOUND', 'NOT_OWNER', 'CONVERSATION_CLOSED')
  async disputeMessage(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('DISPUTE_NOT_FOUND')) id: string, @Body() dto: AppDisputeMessageDto) {
    return { data: await this.reviews.sendDisputeMessage(auth, id, dto.body) };
  }

  @Post('disputes/:id/evidence')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(MAX_EVIDENCE_MB) }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, note: { type: 'string', example: 'Call log screenshot.' } } } })
  @ApiOperation({
    summary: 'Add evidence',
    description:
      'One file at a time, at most `max_dispute_evidence_files` per party (422 `DISPUTE_EVIDENCE_LIMIT`) and 5 MB each ' +
      '(413 `FILE_TOO_LARGE`). Evidence is private to the two parties and Eventor. Only while the dispute is open or in review.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppDisputeDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'DISPUTE_NOT_FOUND', 'NOT_OWNER', 'DISPUTE_INVALID_TRANSITION', 'DISPUTE_EVIDENCE_LIMIT', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'RATE_LIMITED')
  async addEvidence(
    @CurrentUser() auth: AuthUser,
    @Param('id', uuidParam('DISPUTE_NOT_FOUND')) id: string,
    @Body() dto: AppDisputeEvidenceDto,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @ReqLang() lang: Lang,
  ) {
    if (!file) throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'file', code: 'REQUIRED', message: 'file is required' }]);
    return { data: await this.reviews.addEvidence(auth, id, dto.note ?? null, { buffer: file.buffer, originalName: file.originalname }, lang) };
  }

  @Post('disputes/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw my dispute',
    description:
      'status-rules §6: the person who opened a dispute can close it while it is still open or in review — the ' +
      'booking then continues normally and the other party is told. Anyone else, or a dispute already decided, gets ' +
      '409 `DISPUTE_NOT_WITHDRAWABLE`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppDisputeDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'DISPUTE_NOT_FOUND', 'NOT_OWNER', 'DISPUTE_NOT_WITHDRAWABLE')
  async withdraw(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('DISPUTE_NOT_FOUND')) id: string, @Body() dto: AppWithdrawDisputeDto, @ReqLang() lang: Lang) {
    return { data: await this.reviews.withdraw(auth, id, dto.note, lang) };
  }
}
