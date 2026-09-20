import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import {
  AdminMessageDto,
  CloseConversationDto,
  CONVERSATION_SORT_FIELDS,
  ConversationCountsDto,
  ConversationDetailDto,
  ConversationRowDto,
  ConversationsQueryDto,
  CreateConversationDto,
  MessagesPageDto,
  MessagesQueryDto,
  ModerateMessageDto,
  ReadResultDto,
  SendMessageDto,
} from './dto/messaging.dto.js';
import { MessagingService } from './messaging.service.js';

const conversationId = () => uuidParam('CONVERSATION_NOT_FOUND');
const messageId = () => uuidParam('MESSAGE_NOT_FOUND');
const SOCKET = 'Live: `/admin` Socket.IO namespace pushes `message:new` / `conversation:updated`.';

@ApiTags('admin-messages')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/conversations')
export class AdminConversationsController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  @ApiOperation({
    summary: 'List conversations',
    description:
      'Filters kind (direct | support | dispute), reported (open reports on its messages), aboutBooking, bookingId, userId, unread (by the current admin as support participant), status; ' +
      '`q`: participant name contains or full-text on message text. Counters for the MSG-01 chips in `meta.counts` (they follow the other filters). ' +
      `Sortable by ${CONVERSATION_SORT_FIELDS.join(', ')} (default lastMessageAt:desc). The last message preview is masked. Export: resource \`conversations\` (metadata only). ${SOCKET} Used by MSG-01.`,
  })
  @ApiPaginatedResponse(ConversationRowDto, { counts: ConversationCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@CurrentUser() auth: AuthUser, @Query() query: ConversationsQueryDto) {
    return this.messaging.list(auth, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Message users as Eventor support',
    description:
      'Creates a support conversation with the users (clients or providers; 422 RECIPIENT_INVALID) and the admin as support participant, or reuses the open support ' +
      'conversation of a single user. The first message is sent as "Eventor support"; `email: true` also emails it. Audit `conversation.support_message_sent`. Used by MSG-02.',
  })
  @ApiDataResponse(ConversationDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'RECIPIENT_INVALID', 'BOOKING_NOT_FOUND')
  async create(@CurrentUser() auth: AuthUser, @Body() dto: CreateConversationDto) {
    return { data: await this.messaging.create(auth, dto) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a conversation',
    description: 'Participants (write access, blocked flag), booking card, dispute, open reports, closed info and whether contact details are unmasked for the participants. Used by MSG-01.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ConversationDetailDto)
  @ApiErrorResponses('CONVERSATION_NOT_FOUND')
  async get(@CurrentUser() auth: AuthUser, @Param('id', conversationId()) id: string) {
    return { data: await this.messaging.get(auth, id) };
  }

  @Get(':id/messages')
  @ApiOperation({
    summary: 'List messages',
    description:
      'Newest page first, returned oldest → newest; `before` (a message id) pages back, `meta.nextBefore` is the cursor for the previous page. Admins get the original `body`, ' +
      '`bodyMasked`, detected contact kinds, status (hidden and deleted included) and moderation info; system messages have no sender. Used by MSG-01.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: MessagesPageDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'CONVERSATION_NOT_FOUND', 'MESSAGE_NOT_FOUND')
  messages(@Param('id', conversationId()) id: string, @Query() query: MessagesQueryDto) {
    return this.messaging.messages(id, query);
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Reply as Eventor support',
    description:
      'The admin joins as support participant the first time (system message "<name> joined as Eventor support"). Refused with 409 CONVERSATION_CLOSED when closed for everyone. ' +
      `Contact details in the text are masked for participants like any message. ${SOCKET} Used by MSG-01.`,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AdminMessageDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_CLOSED')
  async send(@CurrentUser() auth: AuthUser, @Param('id', conversationId()) id: string, @Body() dto: SendMessageDto) {
    return { data: await this.messaging.send(auth, id, dto.body) };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark as read', description: 'Sets the current admin’s `last_read_at` (no-op when the admin is not a participant: `lastReadAt` null). Used by MSG-01.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReadResultDto)
  @ApiErrorResponses('CONVERSATION_NOT_FOUND')
  async read(@CurrentUser() auth: AuthUser, @Param('id', conversationId()) id: string) {
    return { data: await this.messaging.markRead(auth, id) };
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Close a conversation',
    description:
      '`scope: all` makes it read-only for every non-support participant; `one_participant` (with `userId`, 422 PARTICIPANT_NOT_FOUND) only for that user. ' +
      '`resolveReports` resolves the open reports on its messages. Audit (sensitive). Used by MSG-03.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ConversationDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_ALREADY_CLOSED', 'PARTICIPANT_NOT_FOUND')
  async close(@CurrentUser() auth: AuthUser, @Param('id', conversationId()) id: string, @Body() dto: CloseConversationDto) {
    return { data: await this.messaging.close(auth, id, dto) };
  }

  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reopen a conversation', description: 'Participants can write again, except blocked or deleted accounts. Used by MSG-03.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ConversationDetailDto)
  @ApiErrorResponses('CONVERSATION_NOT_FOUND', 'CONVERSATION_NOT_CLOSED')
  async reopen(@CurrentUser() auth: AuthUser, @Param('id', conversationId()) id: string) {
    return { data: await this.messaging.reopen(auth, id) };
  }
}

@ApiTags('admin-messages')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/messages')
export class AdminMessagesController {
  constructor(private readonly messaging: MessagingService) {}

  @Post(':id/hide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hide a message', description: 'visible → hidden; the row is kept. Optional `reason` (audit note). Used by MSG-01.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AdminMessageDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'MESSAGE_NOT_FOUND', 'MESSAGE_INVALID_TRANSITION')
  async hide(@CurrentUser() auth: AuthUser, @Param('id', messageId()) id: string, @Body() dto: ModerateMessageDto) {
    return { data: await this.messaging.moderate(auth, id, 'hide', dto.reason) };
  }

  @Post(':id/unhide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Show a hidden message again', description: 'hidden → visible. Used by MSG-01.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AdminMessageDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'MESSAGE_NOT_FOUND', 'MESSAGE_INVALID_TRANSITION')
  async unhide(@CurrentUser() auth: AuthUser, @Param('id', messageId()) id: string, @Body() dto: ModerateMessageDto) {
    return { data: await this.messaging.moderate(auth, id, 'unhide', dto.reason) };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a message', description: 'visible | hidden → deleted (status only, the row and text are kept for audit). Optional `reason`. Used by MSG-01.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AdminMessageDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'MESSAGE_NOT_FOUND', 'MESSAGE_INVALID_TRANSITION')
  async remove(@CurrentUser() auth: AuthUser, @Param('id', messageId()) id: string, @Body() dto: ModerateMessageDto) {
    return { data: await this.messaging.moderate(auth, id, 'delete', dto.reason) };
  }
}
