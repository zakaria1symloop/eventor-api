import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MAIL_THROTTLE } from '../common/http/throttles.js';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { uuidPipe } from './admin-me.controller.js';
import { AdminsService } from './admins.service.js';
import { AdminListItemDto, AdminsQueryDto, ADMIN_SORT_FIELDS, CreateInvitationDto } from './dto/admins.dto.js';

@ApiTags('admin-admins')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/admins')
export class AdminAdminsController {
  constructor(private readonly admins: AdminsService) {}

  @Get()
  @ApiOperation({
    summary: 'List admins and pending invitations',
    description: `Sortable by ${ADMIN_SORT_FIELDS.join(', ')} (default createdAt:desc). Filter \`status\` (active | invited), search \`q\`. Used by SET-05 (Team).`,
  })
  @ApiPaginatedResponse(AdminListItemDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@CurrentUser() auth: AuthUser, @Query() query: AdminsQueryDto) {
    return this.admins.listAdmins(auth, query);
  }

  @Post('invitations')
  @Throttle(MAIL_THROTTLE)
  @ApiOperation({
    summary: 'Invite an admin',
    description:
      'Emails a 72 h invitation link (`${ADMIN_URL}/{locale}/accept-invitation?token=…`). Returns the new list row. ' +
      'Rate limited to `MAIL_THROTTLE_LIMIT` (20) per minute: this route sends mail to an address the caller chooses. Used by SET-05.',
  })
  @ApiDataResponse(AdminListItemDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'EMAIL_TAKEN', 'INVITATION_EXISTS', 'RATE_LIMITED')
  async invite(@CurrentUser() auth: AuthUser, @Body() dto: CreateInvitationDto) {
    return { data: await this.admins.invite(auth, dto) };
  }

  @Post('invitations/:id/resend')
  @HttpCode(HttpStatus.OK)
  @Throttle(MAIL_THROTTLE)
  @ApiOperation({
    summary: 'Resend an invitation',
    description:
      'New token and a fresh 72 h expiry; the old link stops working. Rate limited to `MAIL_THROTTLE_LIMIT` (20) per minute. Used by SET-05.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AdminListItemDto)
  @ApiErrorResponses('INVITATION_NOT_FOUND', 'RATE_LIMITED')
  async resend(@CurrentUser() auth: AuthUser, @Param('id', uuidPipe('INVITATION_NOT_FOUND')) id: string) {
    return { data: await this.admins.resendInvitation(auth, id) };
  }

  @Post('invitations/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an invitation', description: 'The link stops working. Used by SET-05.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Invitation revoked.' })
  @ApiErrorResponses('INVITATION_NOT_FOUND')
  async revoke(@CurrentUser() auth: AuthUser, @Param('id', uuidPipe('INVITATION_NOT_FOUND')) id: string): Promise<void> {
    await this.admins.revokeInvitation(auth, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove an admin',
    description: 'Soft-deletes the admin and revokes their sessions. You cannot remove yourself or the last active admin. Used by SET-05.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Admin removed.' })
  @ApiErrorResponses('ADMIN_NOT_FOUND', 'CANNOT_REMOVE_SELF', 'LAST_ADMIN')
  async remove(@CurrentUser() auth: AuthUser, @Param('id', uuidPipe('ADMIN_NOT_FOUND')) id: string): Promise<void> {
    await this.admins.removeAdmin(auth, id);
  }
}
