import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { uploadLimits } from '../common/http/upload-limits.js';
import { UPLOAD_THROTTLE } from '../common/http/throttles.js';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { AdminMessageDto } from '../messaging/dto/messaging.dto.js';
import { DisputesService } from './disputes.service.js';
import {
  AddEvidenceDto,
  AssignDisputeDto,
  CloseDisputeDto,
  DISPUTE_SORT_FIELDS,
  DisputeDetailDto,
  DisputeMessageDto,
  DisputeRowDto,
  DisputesQueryDto,
  DisputeTabCountsDto,
  OpenDisputeDto,
  RequestEvidenceDto,
  ResolveDisputeDto,
} from './dto/disputes.dto.js';


const ID = { name: 'id', description: 'Dispute UUID or reference (`DSP-000031`).', example: 'DSP-000031' };

interface UploadedEvidence {
  originalname: string;
  size: number;
  buffer: Buffer;
}

@ApiTags('admin-disputes')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/disputes')
export class AdminDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @ApiOperation({
    summary: 'List disputes',
    description:
      'Tabs `tab` (open | in_review | resolved | closed | all) with counters in `meta.counts` (they follow the filters, not the tab; `resolved30d` / `closed30d` count decisions of the last 30 days by `resolvedAt`). Filters type (repeat), openedByRole, ' +
      'assignedAdminId (UUID, `me` or `unassigned`), bookingId, bookingStatus (repeat), userId (opened by or against), createdFrom/To (UTC days). `q`: exact DSP- or EVT- reference, or reference / party name contains. ' +
      `Sortable by ${DISPUTE_SORT_FIELDS.join(', ')}; default createdAt:asc on the open tab (oldest first), createdAt:desc otherwise. Export: resource \`disputes\`. Used by DSP-01, OVR-01 attention queue.`,
  })
  @ApiPaginatedResponse(DisputeRowDto, { counts: DisputeTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@CurrentUser() auth: AuthUser, @Query() query: DisputesQueryDto) {
    return this.disputes.list(auth, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Open a dispute on behalf of a party',
    description:
      'The booking must be accepted, completed or cancelled (422 BOOKING_NOT_DISPUTABLE), with no open or in-review dispute (409 DISPUTE_ALREADY_OPEN). Window (status-rules §6): from the event start ' +
      'until the event end + `dispute_window_hours`, or within 7 days of a cancellation; outside it 422 DISPUTE_WINDOW_CLOSED unless `ignoreWindow: true` with a `note`. ' +
      '`evidenceFileIds`: existing private uploads (422 EVIDENCE_FILE_INVALID), at most `max_dispute_evidence_files` (422 DISPUTE_EVIDENCE_LIMIT). Effects: reference DSP-xxxxxx, booking ' +
      '`dispute_status=open` (auto-completion and review requests paused), dispute conversation (client + provider + support) with a system message, the booking chat attached as a ' +
      '`chat_snapshot` evidence, timeline event, audit. Event `dispute.opened`: email + notification to the other party, admin notifications, socket `dispute:new` on `/admin`. Used by DSP-01, BKG-03.',
  })
  @ApiDataResponse(DisputeDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'BOOKING_NOT_FOUND', 'BOOKING_NOT_DISPUTABLE', 'DISPUTE_ALREADY_OPEN', 'DISPUTE_WINDOW_CLOSED', 'EVIDENCE_FILE_INVALID', 'DISPUTE_EVIDENCE_LIMIT')
  async open(@CurrentUser() auth: AuthUser, @Body() dto: OpenDisputeDto) {
    return { data: await this.disputes.open(auth, dto) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a dispute',
    description:
      'Both sides (contact, opening description, their messages in the dispute chat, evidence count, history: disputes, cancellations, provider rating), evidence (private files with signed URLs, ' +
      'chat snapshot), booking card (status, totals, invoice number), assigned admin, conversation id and status, decision, timeline (dispute events) and `allowedActions`. Used by DSP-02.',
  })
  @ApiParam(ID)
  @ApiDataResponse(DisputeDetailDto)
  @ApiErrorResponses('DISPUTE_NOT_FOUND')
  async get(@Param('id') id: string) {
    return { data: await this.disputes.get(await this.disputes.resolveId(id)) };
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign the dispute',
    description: 'To `adminId` (an active admin, 404 ADMIN_NOT_FOUND) or the signed-in admin. open → in_review (reassigning keeps in_review); resolved / closed: 409 DISPUTE_INVALID_TRANSITION. The admin joins the dispute chat. Used by DSP-01 (⋯ Assign to me), DSP-02.',
  })
  @ApiParam(ID)
  @ApiDataResponse(DisputeDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'DISPUTE_NOT_FOUND', 'ADMIN_NOT_FOUND', 'DISPUTE_INVALID_TRANSITION')
  async assign(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: AssignDisputeDto) {
    return { data: await this.disputes.assign(auth, await this.disputes.resolveId(id), dto) };
  }

  @Post(':id/evidence')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(10) }))
  @ApiOperation({
    summary: 'Add an evidence file for a party',
    description:
      'multipart/form-data `file` (PDF, JPEG, PNG, WebP, HEIC sniffed from the content, at most 5 MB: 413 FILE_TOO_LARGE, 415 FILE_TYPE_NOT_ALLOWED) and `partyUserId` (the client or provider of the booking, ' +
      '422 DISPUTE_PARTY_INVALID). Stored private; at most `max_dispute_evidence_files` files per party (422 DISPUTE_EVIDENCE_LIMIT). Open or in-review disputes only. Used by DSP-02.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'partyUserId'],
      properties: { file: { type: 'string', format: 'binary' }, partyUserId: { type: 'string', format: 'uuid' }, note: { type: 'string', maxLength: 500 } },
    },
  })
  @ApiParam(ID)
  @ApiDataResponse(DisputeDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'DISPUTE_NOT_FOUND', 'DISPUTE_INVALID_TRANSITION', 'DISPUTE_PARTY_INVALID', 'DISPUTE_EVIDENCE_LIMIT', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'RATE_LIMITED')
  async addEvidence(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: AddEvidenceDto, @UploadedFile() file: UploadedEvidence | undefined) {
    return { data: await this.disputes.addEvidence(auth, await this.disputes.resolveId(id), dto, file ? { buffer: file.buffer, originalName: file.originalname } : undefined) };
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Write in the dispute chat',
    description: 'Support message to both parties (the admin joins as Eventor support). 409 CONVERSATION_CLOSED once the chat is closed (7 days after the decision). Parties get a notification and push. Used by DSP-02.',
  })
  @ApiParam(ID)
  @ApiDataResponse(AdminMessageDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'DISPUTE_NOT_FOUND', 'CONVERSATION_CLOSED')
  async message(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: DisputeMessageDto) {
    return { data: await this.disputes.sendMessage(auth, await this.disputes.resolveId(id), dto.body) };
  }

  @Post(':id/request-evidence')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask a party for evidence',
    description: 'A support message in the dispute chat plus an `evidence_requested` timeline event; `fromUserId` must be the client or provider (422 DISPUTE_PARTY_INVALID). Open or in-review only. That party is notified. Used by DSP-02 (Ask for evidence).',
  })
  @ApiParam(ID)
  @ApiDataResponse(DisputeDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'DISPUTE_NOT_FOUND', 'DISPUTE_INVALID_TRANSITION', 'DISPUTE_PARTY_INVALID', 'CONVERSATION_CLOSED')
  async requestEvidence(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: RequestEvidenceDto) {
    return { data: await this.disputes.requestEvidence(auth, await this.disputes.resolveId(id), dto) };
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve the dispute',
    description:
      'open | in_review → resolved with a required decision note. Booking outcome through the booking status machine (notify off, the dispute email covers it): `completed` (accepted → completed, allowed ' +
      'before the window end; already completed: unchanged; cancelled: 409 BOOKING_INVALID_TRANSITION), `cancelled` (cancelled by admin, reason `dispute`; a completed booking is reopened then ' +
      'cancelled), `unchanged`. Booking `dispute_status=resolved`: reviews are unblocked and a later review on it is labelled `had_dispute`. Emails both parties (EN/AR) with the note; the ' +
      'dispute chat closes 7 days later (hourly job). Used by DSP-03.',
  })
  @ApiParam(ID)
  @ApiDataResponse(DisputeDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'DISPUTE_NOT_FOUND', 'DISPUTE_INVALID_TRANSITION', 'BOOKING_INVALID_TRANSITION')
  async resolve(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: ResolveDisputeDto) {
    return { data: await this.disputes.resolve(auth, await this.disputes.resolveId(id), dto) };
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Close the dispute without action',
    description:
      'open | in_review → closed with a note (kept as `decisionNote`; `resolvedBy` / `resolvedAt` record who closed it and when). Booking `dispute_status` back to `none` (or `resolved` if an earlier dispute was resolved): normal auto-completion resumes. ' +
      'Parties notified; the chat closes 7 days later. Used by DSP-01, DSP-02.',
  })
  @ApiParam(ID)
  @ApiDataResponse(DisputeDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'DISPUTE_NOT_FOUND', 'DISPUTE_INVALID_TRANSITION')
  async close(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: CloseDisputeDto) {
    return { data: await this.disputes.close(auth, await this.disputes.resolveId(id), dto) };
  }
}
