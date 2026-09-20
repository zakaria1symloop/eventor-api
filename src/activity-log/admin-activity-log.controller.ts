import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { ActivityLogService } from './activity-log.service.js';
import { ActivityLogDetailDto, ActivityLogItemDto, ActivityLogQueryDto } from './dto/activity-log.dto.js';

@ApiTags('admin-activity-log')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/activity-log')
export class AdminActivityLogController {
  constructor(private readonly log: ActivityLogService) {}

  @Get()
  @ApiOperation({
    summary: 'Activity log',
    description:
      'Read-only audit trail, newest first (`sort=createdAt:asc|desc`). Filters: actorId, action (multi), objectType + objectId ' +
      '(history of one object, e.g. BKG-03 History), level (multi), source (multi), from/to (createdAt, inclusive), q. ' +
      'Each row has an actor summary. Used by LOG-01 and the History tabs of detail drawers. Export: resource `activity-log`.',
  })
  @ApiPaginatedResponse(ActivityLogItemDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@Query() query: ActivityLogQueryDto) {
    return this.log.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Activity log entry',
    description: 'Full entry: actor, object link hint `{ type, id, label }`, source/IP/user agent, request id, old → new changes and note. Used by LOG-02.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ActivityLogDetailDto)
  @ApiErrorResponses('AUDIT_LOG_NOT_FOUND')
  async get(@Param('id', uuidParam('AUDIT_LOG_NOT_FOUND')) id: string) {
    return { data: await this.log.get(id) };
  }
}
