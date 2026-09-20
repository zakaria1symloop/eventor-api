import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { uploadLimits } from '../common/http/upload-limits.js';
import { UPLOAD_THROTTLE } from '../common/http/throttles.js';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { DocumentType } from '../common/enums/file.enums.js';
import { UserRole } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import {
  DocumentDecisionDto,
  RejectDocumentDto,
  UploadDocumentDto,
  VERIFICATION_SORT_FIELDS,
  VerificationDetailDto,
  VerificationNeighboursQueryDto,
  VerificationRowDto,
  VerificationsQueryDto,
  VerificationTabCountsDto,
} from './dto/verification.dto.js';
import { VerificationService, type UploadedDocumentFile } from './verification.service.js';

const RECOMPUTE =
  'Recomputes `users.verification_status` (verified when national_id, commercial_register_or_artisan_card and tax_card are all approved; ' +
  'rejected when any is rejected; pending otherwise). Becoming verified emails "Profile approved" in the provider\'s language.';

@ApiTags('admin-verifications')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin')
export class AdminVerificationsController {
  constructor(private readonly verification: VerificationService) {}

  @Get('verifications')
  @ApiOperation({
    summary: 'Verification queue',
    description:
      'Providers by tab (waiting | resubmitted | approved | rejected | incomplete | all, default waiting) with counters in `meta.counts` ' +
      '(they follow the filters, not the tab). Filters categoryId, wilaya (repeat), documentType, submittedFrom/submittedTo, `q`. ' +
      `Sortable by ${VERIFICATION_SORT_FIELDS.join(', ')} (default submittedAt:asc, oldest first). Export: resource \`verifications\`. Used by VER-01.`,
  })
  @ApiPaginatedResponse(VerificationRowDto, { counts: VerificationTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@Query() query: VerificationsQueryDto) {
    return this.verification.list(query);
  }

  @Get('verifications/:userId')
  @ApiOperation({
    summary: 'Review a provider’s documents',
    description:
      'One slot per required document with the current version (signed view URL, mime, size, status, rejection, reviewer) and older versions, ' +
      'the account fields for "check against account", and `neighbours` (previous/next provider) in the queue described by the same query ' +
      'parameters as the list (tab, filters, sort). Used by VER-02.',
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiDataResponse(VerificationDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED', 'USER_NOT_FOUND', 'NOT_A_PROVIDER')
  async detail(@Param('userId', uuidParam('USER_NOT_FOUND')) userId: string, @Query() query: VerificationNeighboursQueryDto) {
    return { data: await this.verification.detail(userId, query) };
  }

  @Post('documents/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a document', description: `Current pending document → approved. ${RECOMPUTE} Used by VER-02, VER-04.` })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(DocumentDecisionDto)
  @ApiErrorResponses('DOCUMENT_NOT_FOUND', 'DOCUMENT_INVALID_TRANSITION')
  async approve(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('DOCUMENT_NOT_FOUND')) id: string) {
    return { data: await this.verification.decide(auth, id, 'approve') };
  }

  @Post('documents/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a document',
    description: `Current pending document → rejected with \`reasonCode\` and a required \`message\`; the provider is emailed. ${RECOMPUTE} Used by VER-03.`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(DocumentDecisionDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'DOCUMENT_NOT_FOUND', 'DOCUMENT_INVALID_TRANSITION')
  async reject(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('DOCUMENT_NOT_FOUND')) id: string, @Body() dto: RejectDocumentDto) {
    return { data: await this.verification.decide(auth, id, 'reject', dto) };
  }

  @Post('documents/:id/undo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Undo a decision',
    description: `Current approved or rejected document → pending (clears the rejection and reviewer). ${RECOMPUTE} Used by VER-02, VER-04 (toast Undo).`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(DocumentDecisionDto)
  @ApiErrorResponses('DOCUMENT_NOT_FOUND', 'DOCUMENT_INVALID_TRANSITION')
  async undo(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('DOCUMENT_NOT_FOUND')) id: string) {
    return { data: await this.verification.decide(auth, id, 'undo') };
  }

  @Post('users/:id/documents')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(25) }))
  @ApiOperation({
    summary: 'Upload a document for a provider',
    description:
      'multipart/form-data `type` + `file` (PDF, JPEG or PNG sniffed from the content, at most `max_document_upload_mb`). Creates a new pending current ' +
      `version; the previous version of that type stops being current. ${RECOMPUTE} Used by VER-02.`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['type', 'file'],
      properties: { type: { type: 'string', enum: Object.values(DocumentType) }, file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(DocumentDecisionDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'USER_NOT_FOUND', 'NOT_A_PROVIDER', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'RATE_LIMITED')
  async upload(
    @CurrentUser() auth: AuthUser,
    @Param('id', uuidParam('USER_NOT_FOUND')) id: string,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: UploadedDocumentFile | undefined,
  ) {
    if (!file) throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'file', code: 'IS_DEFINED', message: 'file is required' }]);
    return { data: await this.verification.upload(auth, id, dto.type, file) };
  }
}
