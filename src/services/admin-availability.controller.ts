import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { AvailabilityService } from './availability.service.js';
import { AvailabilityBlockDto, AvailabilityMonthDto, AvailabilityQueryDto, CreateAvailabilityBlockDto } from './dto/availability.dto.js';

@ApiTags('admin-availability')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin')
export class AdminAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('providers/:id/availability')
  @ApiOperation({
    summary: 'Provider availability for a month',
    description:
      'Every day of `month` with its items: manual blocks (removable), held (pending booking) and booked (accepted booking) rows; bookings without an ' +
      'availability row are included as held/booked. Day status: booked > held > blocked > partial > free. Used by SRV-04 (Availability tab), USR-10.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Provider user id.' })
  @ApiDataResponse(AvailabilityMonthDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'USER_NOT_FOUND', 'NOT_A_PROVIDER')
  async month(@Param('id', uuidParam('USER_NOT_FOUND')) id: string, @Query() query: AvailabilityQueryDto) {
    return { data: await this.availability.month(id, query.month) };
  }

  @Post('providers/:id/availability/blocks')
  @ApiOperation({
    summary: 'Block a day or time range',
    description:
      'Whole day without times, or `startTime`–`endTime`; optionally one service of the provider (422 AVAILABILITY_SERVICE_INVALID). ' +
      'Dates before today (Africa/Algiers) are refused (422 AVAILABILITY_DATE_PAST). Used by SRV-04.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Provider user id.' })
  @ApiDataResponse(AvailabilityBlockDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'USER_NOT_FOUND', 'NOT_A_PROVIDER', 'AVAILABILITY_DATE_PAST', 'AVAILABILITY_SERVICE_INVALID')
  async block(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('USER_NOT_FOUND')) id: string, @Body() dto: CreateAvailabilityBlockDto) {
    return { data: await this.availability.createBlock(auth, id, dto) };
  }

  @Delete('availability-blocks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a manual block', description: 'Held and booked rows belong to bookings (409 AVAILABILITY_BLOCK_NOT_REMOVABLE). Used by SRV-04.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Removed.' })
  @ApiErrorResponses('AVAILABILITY_BLOCK_NOT_FOUND', 'AVAILABILITY_BLOCK_NOT_REMOVABLE')
  async unblock(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('AVAILABILITY_BLOCK_NOT_FOUND')) id: string): Promise<void> {
    await this.availability.removeBlock(auth, id);
  }
}
