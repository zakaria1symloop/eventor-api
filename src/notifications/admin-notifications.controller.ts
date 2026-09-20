import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { AdminNotificationsService } from './admin-notifications.service.js';
import { AdminNotificationDto, AdminNotificationsQueryDto, MarkNotificationsReadDto, MarkReadResultDto, UnreadCountDto } from './dto/admin-notifications.dto.js';

const LIVE = 'Live: `notification:new` (AdminNotificationDto) on the `/admin` Socket.IO namespace, sent to the sockets of the admin it belongs to.';

@ApiTags('admin-notifications')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly notifications: AdminNotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List my notifications',
    description:
      'Notifications of the signed-in admin, newest first; `unread=true` for unread only. Written for every active admin on: verification submitted / resubmitted, booking without a reply ' +
      '(hourly job), dispute opened, academic request submitted / edited, review / reply / message / other report, pack needing attention; `export.ready` goes to the requesting admin only. ' +
      `Title and body are in the admin’s language. ${LIVE} Used by SHL-02.`,
  })
  @ApiPaginatedResponse(AdminNotificationDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  list(@CurrentUser() auth: AuthUser, @Query() query: AdminNotificationsQueryDto) {
    return this.notifications.list(auth.id, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread notifications count', description: `Feeds the bell badge. ${LIVE} Used by SHL-02.` })
  @ApiDataResponse(UnreadCountDto)
  async unreadCount(@CurrentUser() auth: AuthUser) {
    return { data: { unread: await this.notifications.unreadCount(auth.id) } };
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark notifications as read',
    description: '`{ ids: [...] }` or `{ all: true }`. Only the signed-in admin’s rows change (other ids are ignored); already-read rows keep their `readAt`. Used by SHL-02.',
  })
  @ApiDataResponse(MarkReadResultDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async read(@CurrentUser() auth: AuthUser, @Body() dto: MarkNotificationsReadDto) {
    return { data: await this.notifications.markRead(auth.id, dto) };
  }
}
