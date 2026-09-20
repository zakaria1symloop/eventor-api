import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { ConvertReportDto, DismissReportDto, MessageReportsDismissedDto, ReportRowDto, ReportsQueryDto, ReportTabCountsDto, ResolveReportDto } from './dto/reports.dto.js';
import { ReportsService } from './reports.service.js';

const reportId = () => uuidParam('REPORT_NOT_FOUND');

@ApiTags('admin-reports')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ApiOperation({
    summary: 'List reports',
    description:
      'Tabs `tab` (open | resolved | dismissed | all, default open) with counters in `meta.counts`. Filters targetType (repeat), reason (repeat), createdFrom/To (UTC days). Sort createdAt ' +
      '(default asc on the open tab, oldest first; desc otherwise). Each row has a target summary (label, dashboard `href`, review / conversation / booking ids). A null `reporter` is an ' +
      'automatic report from the flag scan. Export: resource `reports`. Used by REV-01 / REV-02, MSG-01, SRV-01 reported filter, OVR-01.',
  })
  @ApiPaginatedResponse(ReportRowDto, { counts: ReportTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@Query() query: ReportsQueryDto) {
    return this.reports.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a report', description: 'The report row with its target summary. Used by REV-02, MSG-01.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReportRowDto)
  @ApiErrorResponses('REPORT_NOT_FOUND')
  async get(@Param('id', reportId()) id: string) {
    return { data: await this.reports.getRow(id) };
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve a report',
    description:
      'open → resolved with a `note` and optional `action` label (what was done on the target elsewhere: hide, block, close chat…). Acting resolves **every** open report on the same target ' +
      '(status-rules §9). Reporters get a notification. Already resolved or dismissed: 409 REPORT_INVALID_TRANSITION. Audit.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReportRowDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'REPORT_NOT_FOUND', 'REPORT_INVALID_TRANSITION')
  async resolve(@CurrentUser() auth: AuthUser, @Param('id', reportId()) id: string, @Body() dto: ResolveReportDto) {
    return { data: await this.reports.resolve(auth, id, dto) };
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss a report', description: 'open → dismissed (this report only) with a `note`; the reporter is notified. 409 REPORT_INVALID_TRANSITION when not open. Audit. Used by REV-01 (⋯ Dismiss report), MSG-01.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReportRowDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'REPORT_NOT_FOUND', 'REPORT_INVALID_TRANSITION')
  async dismiss(@CurrentUser() auth: AuthUser, @Param('id', reportId()) id: string, @Body() dto: DismissReportDto) {
    return { data: await this.reports.dismiss(auth, id, dto) };
  }

  @Post(':id/convert-to-dispute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Convert a report to a dispute',
    description:
      'Only an open report (409 REPORT_INVALID_TRANSITION) on a review (its booking) or a message whose conversation is about a booking; anything else is 422 REPORT_NOT_CONVERTIBLE. Opens the ' +
      'dispute through the disputes module in the same transaction (DSP- reference, dispute chat, booking frozen, `dispute.opened` notifications); the dispute window is not enforced. ' +
      'Booking rules still apply: 422 BOOKING_NOT_DISPUTABLE, 409 DISPUTE_ALREADY_OPEN. The report and the other open reports on the target become resolved with `disputeId`. Used by REV-02 (⋯ Convert report to dispute).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ReportRowDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'REPORT_NOT_FOUND', 'REPORT_INVALID_TRANSITION', 'REPORT_NOT_CONVERTIBLE', 'BOOKING_NOT_DISPUTABLE', 'DISPUTE_ALREADY_OPEN')
  async convert(@CurrentUser() auth: AuthUser, @Param('id', reportId()) id: string, @Body() dto: ConvertReportDto) {
    return { data: await this.reports.convertToDispute(auth, id, dto) };
  }
}

@ApiTags('admin-messages')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/messages')
export class AdminMessageReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post(':id/reports/dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dismiss the reports on a message',
    description: 'Convenience for MSG-01 "Dismiss report": every open report on the message → dismissed with the `note`; reporters notified. 409 MESSAGE_NO_OPEN_REPORTS when none. Audit. Used by MSG-01.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(MessageReportsDismissedDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'MESSAGE_NOT_FOUND', 'MESSAGE_NO_OPEN_REPORTS')
  async dismiss(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('MESSAGE_NOT_FOUND')) id: string, @Body() dto: DismissReportDto) {
    return { data: await this.reports.dismissForMessage(auth, id, dto) };
  }
}
