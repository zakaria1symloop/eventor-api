import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { AcademicRequestsService } from './academic-requests.service.js';
import {
  ACADEMIC_REQUEST_SORT_FIELDS,
  AcademicRequestDetailDto,
  AcademicRequestRowDto,
  AcademicRequestsQueryDto,
  AcademicRequestTabCountsDto,
  ApproveRequestDto,
  AssignRequestDto,
  BookProposalDto,
  CancelRequestDto,
  CreateProposalDto,
  RejectRequestDto,
  RequestChangesDto,
} from './dto/academic-requests.dto.js';

const ID = { name: 'id', description: 'Request UUID or reference (`ACR-000142`).', example: 'ACR-000142' };
const PROPOSAL = { name: 'proposalId', format: 'uuid' };

@ApiTags('admin-academic-requests')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/academic-requests')
export class AdminAcademicRequestsController {
  constructor(private readonly requests: AcademicRequestsService) {}

  @Get()
  @ApiOperation({
    summary: 'List academic requests',
    description:
      'Tabs `tab` (pending | changes_requested | approved | in_progress | rejected | completed | cancelled | all) with `meta.counts` (they follow the filters, not the tab). ' +
      'Filters formId, wilaya (repeat), eventDateFrom/To, assignedAdminId (UUID, `me`, `unassigned`). `q`: exact reference, or requester name / email, institution, title. ' +
      `Sortable by ${ACADEMIC_REQUEST_SORT_FIELDS.join(', ')} (default submittedAt:desc). Export: resource \`academic-requests\`. Used by ACR-01, OVR-01 attention queue.`,
  })
  @ApiPaginatedResponse(AcademicRequestRowDto, { counts: AcademicRequestTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@CurrentUser() auth: AuthUser, @Query() query: AcademicRequestsQueryDto) {
    return this.requests.list(auth, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get an academic request',
    description:
      'Requester (linked account or none), answers rendered with the request’s own form version ([{ key, labelEn/Ar, type, value, displayValue, changed }]), attachments (signed URLs), ' +
      'needs, proposals with service summary and booking, bookings, requested changes and the fields changed since, decision, `allowedActions` and the timeline (activity log). Used by ACR-02.',
  })
  @ApiParam(ID)
  @ApiDataResponse(AcademicRequestDetailDto)
  @ApiErrorResponses('ACADEMIC_REQUEST_NOT_FOUND')
  async get(@Param('id') id: string) {
    return { data: await this.requests.get(await this.requests.resolveId(id)) };
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign an admin', description: 'Defaults to the current admin (404 ADMIN_NOT_FOUND for an unknown or inactive admin). Open requests only. Used by ACR-01 (Assign to me), ACR-02.' })
  @ApiParam(ID)
  @ApiDataResponse(AcademicRequestDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'ACADEMIC_REQUEST_NOT_FOUND', 'ADMIN_NOT_FOUND', 'ACADEMIC_REQUEST_INVALID_TRANSITION')
  async assign(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: AssignRequestDto) {
    return { data: await this.requests.assign(auth, await this.requests.resolveId(id), dto.adminId) };
  }

  @Post(':id/request-changes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask the requester for changes',
    description:
      'pending → changes_requested. `fields` must exist in the request’s form version (422 ACADEMIC_REQUEST_FIELDS_INVALID). Emails the requester a single-use edit link valid 14 days ' +
      '(`/f/:slug/edit?token=…`, public `GET/PATCH /forms/:slug/requests/:token`); after the edit the request returns to pending with the changed fields highlighted. Used by ACR-04.',
  })
  @ApiParam(ID)
  @ApiDataResponse(AcademicRequestDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'ACADEMIC_REQUEST_NOT_FOUND', 'ACADEMIC_REQUEST_INVALID_TRANSITION', 'ACADEMIC_REQUEST_FIELDS_INVALID')
  async requestChanges(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: RequestChangesDto) {
    return { data: await this.requests.requestChanges(auth, await this.requests.resolveId(id), dto) };
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a request',
    description: 'pending → approved; optional `serviceIds` are added as proposals (404 SERVICE_NOT_FOUND, 409 PROPOSAL_EXISTS). Emails the requester the message and the proposals. Used by ACR-03.',
  })
  @ApiParam(ID)
  @ApiDataResponse(AcademicRequestDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'ACADEMIC_REQUEST_NOT_FOUND', 'ACADEMIC_REQUEST_INVALID_TRANSITION', 'SERVICE_NOT_FOUND', 'PROPOSAL_EXISTS')
  async approve(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: ApproveRequestDto) {
    return { data: await this.requests.approve(auth, await this.requests.resolveId(id), dto) };
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a request', description: 'pending | changes_requested → rejected (final), reason + message emailed to the requester. Used by ACR-02 (Reject panel).' })
  @ApiParam(ID)
  @ApiDataResponse(AcademicRequestDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'ACADEMIC_REQUEST_NOT_FOUND', 'ACADEMIC_REQUEST_INVALID_TRANSITION')
  async reject(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: RejectRequestDto) {
    return { data: await this.requests.reject(auth, await this.requests.resolveId(id), dto.reason, dto.message) };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a request',
    description: 'Open statuses → cancelled. Linked pending bookings are cancelled through the booking rules (reason `academic_request_cancelled`); requester emailed, providers notified. Used by ACR-02.',
  })
  @ApiParam(ID)
  @ApiDataResponse(AcademicRequestDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'ACADEMIC_REQUEST_NOT_FOUND', 'ACADEMIC_REQUEST_INVALID_TRANSITION')
  async cancel(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: CancelRequestDto) {
    return { data: await this.requests.cancel(auth, await this.requests.resolveId(id), dto.reason) };
  }

  @Post(':id/proposals')
  @ApiOperation({ summary: 'Propose a service', description: 'Open requests only. 404 SERVICE_NOT_FOUND, 409 PROPOSAL_EXISTS (one proposal per service). Used by ACR-02 (Propose service).' })
  @ApiParam(ID)
  @ApiDataResponse(AcademicRequestDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'ACADEMIC_REQUEST_NOT_FOUND', 'ACADEMIC_REQUEST_INVALID_TRANSITION', 'SERVICE_NOT_FOUND', 'PROPOSAL_EXISTS')
  async addProposal(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() dto: CreateProposalDto) {
    return { data: await this.requests.addProposal(auth, await this.requests.resolveId(id), dto.serviceId, dto.note ?? null) };
  }

  @Delete(':id/proposals/:proposalId')
  @ApiOperation({ summary: 'Remove a proposal', description: 'Not once booked (409 PROPOSAL_BOOKED). The service can be proposed again. Used by ACR-02.' })
  @ApiParam(ID)
  @ApiParam(PROPOSAL)
  @ApiDataResponse(AcademicRequestDetailDto)
  @ApiErrorResponses('ACADEMIC_REQUEST_NOT_FOUND', 'PROPOSAL_NOT_FOUND', 'PROPOSAL_BOOKED')
  async removeProposal(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Param('proposalId', uuidParam('PROPOSAL_NOT_FOUND')) proposalId: string) {
    return { data: await this.requests.removeProposal(auth, await this.requests.resolveId(id), proposalId) };
  }

  @Post(':id/proposals/:proposalId/book')
  @ApiOperation({
    summary: 'Book a proposal',
    description:
      'approved | in_progress requests. In one transaction: links the requester’s client account by email or creates one (set-password invitation email; 422 REQUESTER_NOT_CLIENT when the ' +
      'email belongs to a provider, admin, blocked or deleted account), creates the booking through the booking rules (service visible, provider accepting, min notice, availability) with ' +
      '`academic_request_id`, date / wilaya / attendees from the request unless overridden, links the proposal and moves the request to in_progress. Used by ACR-02 (Create booking) → BKG-03.',
  })
  @ApiParam(ID)
  @ApiParam(PROPOSAL)
  @ApiDataResponse(AcademicRequestDetailDto, { status: 201 })
  @ApiErrorResponses(
    'VALIDATION_FAILED',
    'ACADEMIC_REQUEST_NOT_FOUND',
    'PROPOSAL_NOT_FOUND',
    'ACADEMIC_REQUEST_INVALID_TRANSITION',
    'PROPOSAL_BOOKED',
    'REQUESTER_NOT_CLIENT',
    'SERVICE_NOT_FOUND',
    'SERVICE_UNAVAILABLE_FOR_BOOKING',
    'PROVIDER_NOT_ACCEPTING',
    'MIN_NOTICE',
    'WILAYA_NOT_FOUND',
    'DATE_UNAVAILABLE',
  )
  async book(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Param('proposalId', uuidParam('PROPOSAL_NOT_FOUND')) proposalId: string, @Body() dto: BookProposalDto) {
    return { data: await this.requests.book(auth, await this.requests.resolveId(id), proposalId, dto) };
  }
}
