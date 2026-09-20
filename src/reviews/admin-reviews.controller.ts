import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import {
  DeleteReviewDto,
  EditReviewDto,
  ModerateReplyDto,
  ModerateReviewDto,
  ReplyDeletedDto,
  REVIEW_SORT_FIELDS,
  ReviewDeletedDto,
  ReviewDetailDto,
  ReviewRowDto,
  ReviewsQueryDto,
  ReviewTabCountsDto,
} from './dto/reviews.dto.js';
import { ReviewsService } from './reviews.service.js';

const reviewId = () => uuidParam('REVIEW_NOT_FOUND');
const replyId = () => uuidParam('REVIEW_REPLY_NOT_FOUND');
const RATINGS = 'Ratings (`avg_rating`, `rating_count` of the service, pack and provider) are recomputed in the same transaction from published and redacted reviews.';

@ApiTags('admin-reviews')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/reviews')
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @ApiOperation({
    summary: 'List reviews',
    description:
      'Tabs `tab` (all | published | reported | hidden | redacted) with counters in `meta.counts` (they follow the filters, not the tab; `reported` = open reports on the review). ' +
      'Filters rating (repeat) or ratingMin / ratingMax, providerId, serviceId, packId, authorId, hadDispute, flagged (detected flags present), createdFrom/To (UTC days); `q`: comment, author, ' +
      `provider or business name contains. Sortable by ${REVIEW_SORT_FIELDS.join(', ')} (default createdAt:desc). The comment is the original text cut to 200 characters. Export: resource \`reviews\`. Used by REV-01, OVR-01 attention queue.`,
  })
  @ApiPaginatedResponse(ReviewRowDto, { counts: ReviewTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@Query() query: ReviewsQueryDto) {
    return this.reviews.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a review',
    description: 'Full original and redacted text, detected flags, author, provider, service / pack and booking links, disputes on the booking, the provider reply, every report on the review and its reply, moderation info and `allowedActions`. Used by REV-02.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReviewDetailDto)
  @ApiErrorResponses('REVIEW_NOT_FOUND')
  async get(@Param('id', reviewId()) id: string) {
    return { data: await this.reviews.get(id) };
  }

  @Post(':id/moderate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Moderate a review',
    description:
      '`hide`: published | redacted → hidden. `show`: hidden | redacted → published. `redact`: published | hidden | redacted → redacted with `redactedComment` (required; 400 otherwise), the text shown ' +
      'publicly ("hide the phone number only"). Other moves: 409 REVIEW_INVALID_TRANSITION. These three resolve the open reports on the review and notify the author (unless `notifyAuthor: false`). ' +
      `\`dismiss_reports\`: dismisses the open reports and keeps the status (409 REVIEW_NO_OPEN_REPORTS when there are none). Reporters are notified of the outcome. ${RATINGS} Audit. Used by REV-01 (⋯), REV-02.`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReviewDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'REVIEW_NOT_FOUND', 'REVIEW_INVALID_TRANSITION', 'REVIEW_NO_OPEN_REPORTS')
  async moderate(@CurrentUser() auth: AuthUser, @Param('id', reviewId()) id: string, @Body() dto: ModerateReviewDto) {
    return { data: await this.reviews.moderate(auth, id, dto) };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit the review text',
    description: 'Replaces the comment (any status) with a required `reason`; detected flags are scanned again. Audit (sensitive) keeps the old and new text. No notification. Used by REV-02 (⋯ Edit text).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReviewDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'REVIEW_NOT_FOUND')
  async edit(@CurrentUser() auth: AuthUser, @Param('id', reviewId()) id: string, @Body() dto: EditReviewDto) {
    return { data: await this.reviews.edit(auth, id, dto) };
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a review',
    description: `Soft delete with a required \`reason\`; the author cannot write another review for the booking. Open reports on it are resolved. ${RATINGS} Audit (sensitive). Used by REV-03.`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReviewDeletedDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'REVIEW_NOT_FOUND')
  async remove(@CurrentUser() auth: AuthUser, @Param('id', reviewId()) id: string, @Body() dto: DeleteReviewDto) {
    return { data: await this.reviews.remove(auth, id, dto) };
  }
}

@ApiTags('admin-reviews')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/review-replies')
export class AdminReviewRepliesController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post(':id/hide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hide a provider reply', description: 'published → hidden; open reports on the reply are resolved; the provider is notified. Returns the review. Used by REV-02.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReviewDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'REVIEW_REPLY_NOT_FOUND', 'REVIEW_REPLY_INVALID_TRANSITION')
  async hide(@CurrentUser() auth: AuthUser, @Param('id', replyId()) id: string, @Body() dto: ModerateReplyDto) {
    return { data: await this.reviews.moderateReply(auth, id, 'hide', dto) };
  }

  @Post(':id/show')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Show a hidden reply again', description: 'hidden → published; the provider is notified. Returns the review. Used by REV-02.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReviewDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'REVIEW_REPLY_NOT_FOUND', 'REVIEW_REPLY_INVALID_TRANSITION')
  async show(@CurrentUser() auth: AuthUser, @Param('id', replyId()) id: string, @Body() dto: ModerateReplyDto) {
    return { data: await this.reviews.moderateReply(auth, id, 'show', dto) };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a provider reply', description: 'Soft delete; open reports on the reply are resolved. Audit (sensitive, keeps the text). Used by REV-02.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReplyDeletedDto)
  @ApiErrorResponses('REVIEW_REPLY_NOT_FOUND')
  async remove(@CurrentUser() auth: AuthUser, @Param('id', replyId()) id: string) {
    return { data: await this.reviews.removeReply(auth, id) };
  }
}
