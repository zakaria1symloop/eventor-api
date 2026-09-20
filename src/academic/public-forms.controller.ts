import { Body, Controller, Get, Headers, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FORM_THROTTLE, UPLOAD_THROTTLE } from '../common/http/throttles.js';
import { uploadLimits } from '../common/http/upload-limits.js';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator.js';
import { AppException } from '../common/errors/app.exception.js';
import { resolveLanguage } from '../common/i18n/language.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { EditableRequestDto, EditAnswersDto, EmailCodeDto, EmailCodeResultDto, PublicFormDto, SubmissionResultDto, SubmitFormDto, UploadResultDto } from './dto/public-forms.dto.js';
import { PublicFormsService } from './public-forms.service.js';

const SLUG = { name: 'slug', example: 'event-request' };
const LANG = { name: 'Accept-Language', required: false, description: '`en` or `ar`: language of the emails and error messages.' };

@ApiTags('public-forms')
@Public()
@Controller('forms')
export class PublicFormsController {
  constructor(private readonly forms: PublicFormsService) {}

  @Get(':slug')
  @ApiOperation({
    summary: 'Get a public form',
    description: 'Public (no token). The live version schema and settings. 404 FORM_NOT_FOUND (unknown, deleted or never published), 410 FORM_CLOSED ("no longer accepting requests"). Used by ACR-07.',
  })
  @ApiParam(SLUG)
  @ApiDataResponse(PublicFormDto)
  @ApiErrorResponses('FORM_NOT_FOUND', 'FORM_CLOSED', 'RATE_LIMITED')
  async get(@Param('slug') slug: string) {
    return { data: await this.forms.getForm(slug) };
  }

  @Post(':slug/email-code')
  @Throttle(FORM_THROTTLE)
  @ApiOperation({
    summary: 'Email a verification code',
    description:
      'Public, 10/min per IP. A 6-digit code valid 15 min (`verification_codes`, purpose form_submission; a new code replaces older ones), emailed in the `Accept-Language` language. ' +
      'At most one per 60 s per email (429 CODE_RESEND_TOO_SOON with Retry-After). Used by ACR-07.',
  })
  @ApiParam(SLUG)
  @ApiHeader(LANG)
  @ApiDataResponse(EmailCodeResultDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'FORM_NOT_FOUND', 'FORM_CLOSED', 'CODE_RESEND_TOO_SOON', 'RATE_LIMITED')
  async emailCode(@Param('slug') slug: string, @Body() dto: EmailCodeDto, @Headers('accept-language') acceptLanguage?: string) {
    return { data: await this.forms.sendCode(slug, dto.email, resolveLanguage(acceptLanguage)) };
  }

  @Post(':slug/uploads')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(25) }))
  @ApiOperation({
    summary: 'Upload a file for a file field',
    description:
      'Public, 30/min. multipart `file`: PDF, JPEG or PNG sniffed from the content (415 FILE_TYPE_NOT_ALLOWED), at most `max_document_upload_mb` (413 FILE_TOO_LARGE), stored privately. ' +
      'Returns an `uploadToken` valid 1 h to send in `uploads` of the submission. Used by ACR-07.',
  })
  @ApiParam(SLUG)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiDataResponse(UploadResultDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'FORM_NOT_FOUND', 'FORM_CLOSED', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'RATE_LIMITED')
  async upload(@Param('slug') slug: string, @UploadedFile() file: { originalname: string; buffer: Buffer; size: number } | undefined) {
    if (!file) throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'file', code: 'IS_DEFINED', message: 'file is required' }]);
    return { data: await this.forms.upload(slug, file) };
  }

  @Post(':slug/submissions')
  @Throttle(FORM_THROTTLE)
  @ApiOperation({
    summary: 'Submit a request',
    description:
      'Public, 10/min. Checks in order: upload tokens (422 UPLOAD_TOKEN_INVALID), answers against the live version with the builder rules incl. showIf, required, min/max, pattern, date ' +
      'offsets and file constraints (422 FORM_ANSWERS_INVALID, `details: [{ fieldKey, code }]`), account when the form requires one (422 FORM_REQUIRES_ACCOUNT), the email code ' +
      '(422 CODE_INVALID / CODE_EXPIRED; 5 wrong tries expire it), the per-email monthly limit (429 FORM_SUBMISSION_LIMIT). Creates ACR-xxxxxx pending with the mapped fields, needs and ' +
      'attachments, links an existing client account with that email, emails the confirmation, notifies admins and pushes `academic_request:new` on the `/admin` socket. Used by ACR-07.',
  })
  @ApiParam(SLUG)
  @ApiHeader(LANG)
  @ApiDataResponse(SubmissionResultDto, { status: 201 })
  @ApiErrorResponses(
    'VALIDATION_FAILED',
    'FORM_NOT_FOUND',
    'FORM_CLOSED',
    'UPLOAD_TOKEN_INVALID',
    'FORM_ANSWERS_INVALID',
    'FORM_REQUIRES_ACCOUNT',
    'CODE_INVALID',
    'CODE_EXPIRED',
    'FORM_SUBMISSION_LIMIT',
    'RATE_LIMITED',
  )
  async submit(@Param('slug') slug: string, @Body() dto: SubmitFormDto, @Headers('accept-language') acceptLanguage?: string) {
    return { data: await this.forms.submit(slug, dto, resolveLanguage(acceptLanguage)) };
  }

  @Get(':slug/requests/:token')
  @ApiOperation({
    summary: 'Open the edit link',
    description: 'Public. The request whose admin asked for changes: requested fields and message, its own form version schema and current answers. 404 EDIT_LINK_INVALID (wrong, expired or used). Used by ACR-07 (edit).',
  })
  @ApiParam(SLUG)
  @ApiParam({ name: 'token', description: 'The token from the emailed link.' })
  @ApiDataResponse(EditableRequestDto)
  @ApiErrorResponses('EDIT_LINK_INVALID', 'RATE_LIMITED')
  async editable(@Param('slug') slug: string, @Param('token') token: string) {
    return { data: await this.forms.getEditable(slug, token) };
  }

  @Patch(':slug/requests/:token')
  @Throttle(FORM_THROTTLE)
  @ApiOperation({
    summary: 'Resubmit edited answers',
    description:
      'Public, 10/min. changes_requested → pending: answers validated against the request’s version (422 FORM_ANSWERS_INVALID; new files through `uploads`, other file fields keep theirs), ' +
      'mapped fields updated, changed fields stored for ACR-02, link invalidated, admins notified. Used by ACR-07 (edit).',
  })
  @ApiParam(SLUG)
  @ApiParam({ name: 'token' })
  @ApiDataResponse(EditableRequestDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'EDIT_LINK_INVALID', 'UPLOAD_TOKEN_INVALID', 'FORM_ANSWERS_INVALID', 'RATE_LIMITED')
  async edit(@Param('slug') slug: string, @Param('token') token: string, @Body() dto: EditAnswersDto) {
    return { data: await this.forms.editAnswers(slug, token, dto) };
  }
}
