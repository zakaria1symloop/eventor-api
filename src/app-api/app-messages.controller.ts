import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { UPLOAD_THROTTLE } from '../common/http/throttles.js';
import { uploadLimits } from '../common/http/upload-limits.js';
import { ReqLang } from '../common/i18n/lang.decorator.js';
import type { Lang } from '../common/i18n/language.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import type { UploadedPhotoFile } from '../files/photo-gallery.js';
import { AppMessagesService } from './app-messages.service.js';
import {
  AppConversationDetailDto,
  AppConversationRowDto,
  AppConversationsQueryDto,
  AppMessageDto,
  AppMessagesPageDto,
  AppMessagesQueryDto,
  AppReadResultDto,
  AppReportDto,
  AppReportMessageDto,
  AppReportResultDto,
  AppSendMessageDto,
  AppStartConversationDto,
} from './dto/app-messages.dto.js';

/** Multipart ceiling for a chat image; the stricter platform setting still applies. */
const MAX_IMAGE_MB = 20;

const SOCKET_NOTE =
  'Live updates come from the Socket.IO namespace **`/app`** (`message:new`, `conversation:updated`), authenticated ' +
  'with the same access token. Polling is a fallback, not the design.';

/**
 * Screens 14 Messages and 15 Chat, for clients and providers alike. Contact
 * details stay masked until the pair share an accepted booking (status-rules
 * §10) and **the unmasked text is never sent** — `body` is already what you may
 * show. No participant's email or phone is ever returned here.
 */
@ApiTags('app-messages')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiHeader({ name: 'Accept-Language', required: false, description: '`en` or `ar`. Falls back to the account’s language, then `en`.' })
@ApiErrorResponses('FORBIDDEN_AUDIENCE', 'ACCOUNT_BLOCKED')
@Roles(UserRole.Client, UserRole.Provider)
@Controller('app')
export class AppMessagesController {
  constructor(private readonly messages: AppMessagesService) {}

  @Get('conversations')
  @ApiOperation({
    summary: 'My conversations',
    description:
      `Screen 14 Messages: the avatar, the name, the last message, the time and the unread badge. ` +
      `The **All / Unread** chips are \`filter=all|unread\`; \`filter=booking\` keeps the chats attached to a booking. ` +
      `\`q\` searches the other person's name. ${SOCKET_NOTE}`,
  })
  @ApiPaginatedResponse(AppConversationRowDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async list(@CurrentUser() auth: AuthUser, @Query() query: AppConversationsQueryDto, @ReqLang() lang: Lang) {
    return this.messages.list(auth, query, lang);
  }

  @Get('conversations/:id')
  @ApiOperation({
    summary: 'Conversation header',
    description:
      'The header of screen 15 Chat: who you are talking to, the booking context card, whether you can still write and ' +
      '`contactUnmasked`. A conversation you are not part of answers **403 `NOT_A_PARTICIPANT`**.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppConversationDetailDto)
  @ApiErrorResponses('CONVERSATION_NOT_FOUND', 'NOT_A_PARTICIPANT')
  async get(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('CONVERSATION_NOT_FOUND')) id: string, @ReqLang() lang: Lang) {
    return { data: await this.messages.get(auth, id, lang) };
  }

  @Get('conversations/:id/messages')
  @ApiOperation({
    summary: 'The messages of a chat',
    description:
      'Screen 15’s bubbles, **oldest first** so the list appends at the bottom. Scroll up by sending the previous ' +
      'page’s `meta.nextBefore` as `before`; `meta.hasMore` says when to stop. A message an admin hid comes back as ' +
      '`[removed by Eventor]`, and deleted ones are simply absent.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: AppMessagesPageDto, description: 'A cursor page: `{ data, meta: { limit, hasMore, nextBefore } }`.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'CONVERSATION_NOT_FOUND', 'NOT_A_PARTICIPANT', 'MESSAGE_NOT_FOUND')
  async messagesPage(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('CONVERSATION_NOT_FOUND')) id: string, @Query() query: AppMessagesQueryDto) {
    return this.messages.messages(auth, id, query);
  }

  @Post('conversations')
  @ApiOperation({
    summary: 'Start (or continue) a chat',
    description:
      'The "Message" button on screen 12 Service detail. A client writes to a provider and the other way round — there ' +
      'is exactly **one direct conversation per pair** (status-rules §10), so calling this again just adds a message to ' +
      'the existing one. `bookingId` attaches the context card, and must be a booking the two of you share.',
  })
  @ApiDataResponse(AppConversationDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'USER_NOT_FOUND', 'RECIPIENT_INVALID', 'BOOKING_NOT_FOUND', 'NOT_OWNER', 'CONVERSATION_CLOSED', 'CONVERSATION_READ_ONLY')
  async start(@CurrentUser() auth: AuthUser, @Body() dto: AppStartConversationDto, @ReqLang() lang: Lang) {
    return { data: await this.messages.start(auth, dto, lang) };
  }

  @Post('conversations/:id/messages')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(MAX_IMAGE_MB) }))
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { body: { type: 'string', example: 'We can be there from 17:00.' }, file: { type: 'string', format: 'binary', description: 'An image, as multipart.' } },
    },
  })
  @ApiOperation({
    summary: 'Send a message',
    description:
      'JSON `{ "body": "…" }` for text, or `multipart/form-data` with `file` for an image (and an optional `body` ' +
      'caption). The type is sniffed from the bytes. Contact details in the text are masked for the other party until ' +
      'you share an accepted booking. A chat an admin closed answers 403 `CONVERSATION_CLOSED`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppMessageDto, { status: 201 })
  @ApiErrorResponses(
    'VALIDATION_FAILED',
    'CONVERSATION_NOT_FOUND',
    'NOT_A_PARTICIPANT',
    'CONVERSATION_CLOSED',
    'CONVERSATION_READ_ONLY',
    'FILE_TOO_LARGE',
    'FILE_TYPE_NOT_ALLOWED',
    'RATE_LIMITED',
  )
  async send(
    @CurrentUser() auth: AuthUser,
    @Param('id', uuidParam('CONVERSATION_NOT_FOUND')) id: string,
    @Body() dto: AppSendMessageDto,
    @UploadedFile() file: UploadedPhotoFile | undefined,
  ) {
    return { data: await this.messages.send(auth, id, dto?.body ?? null, file) };
  }

  @Post('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a chat as read', description: 'Clears the unread badge on screen 14 and stops the push for it. Call it when screen 15 opens and on each new message you display.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppReadResultDto)
  @ApiErrorResponses('CONVERSATION_NOT_FOUND', 'NOT_A_PARTICIPANT')
  async read(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('CONVERSATION_NOT_FOUND')) id: string) {
    return { data: await this.messages.markRead(auth, id) };
  }

  @Post('messages/:id/report')
  @ApiOperation({
    summary: 'Report a message',
    description:
      'Screen 15 long-press. Opens a report an admin then handles (status-rules §9). One open report per reporter and ' +
      'target: reporting twice answers 201 with `created: false` rather than an error.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppReportResultDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'MESSAGE_NOT_FOUND', 'NOT_A_PARTICIPANT')
  async reportMessage(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('MESSAGE_NOT_FOUND')) id: string, @Body() dto: AppReportMessageDto) {
    return { data: await this.messages.reportMessage(auth, id, dto.reason, dto.note ?? null) };
  }

  @Post('reports')
  @ApiOperation({
    summary: 'Report a service, pack, user or review',
    description:
      'The "Report" action on screens 12, 13 and 15 (status-rules §9). An admin resolves it, and acting on the target ' +
      'closes every open report on it. One open report per reporter and target.',
  })
  @ApiDataResponse(AppReportResultDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'REPORT_TARGET_NOT_FOUND', 'MESSAGE_NOT_FOUND', 'NOT_A_PARTICIPANT')
  async report(@CurrentUser() auth: AuthUser, @Body() dto: AppReportDto) {
    return { data: await this.messages.report(auth, dto.targetType, dto.targetId, dto.reason, dto.note ?? null) };
  }
}
