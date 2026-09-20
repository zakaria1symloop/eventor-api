import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AdminMeDto } from '../auth/dto/admin-me.dto.js';
import { UserRole } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { AdminsService } from './admins.service.js';
import { ChangePasswordDto, SessionDto, UpdateMeDto } from './dto/admins.dto.js';

export const uuidPipe = (code: 'SESSION_NOT_FOUND' | 'ADMIN_NOT_FOUND' | 'INVITATION_NOT_FOUND') =>
  new ParseUUIDPipe({ exceptionFactory: () => AppException.of(code) });

@ApiTags('admin-me')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/me')
export class AdminMeController {
  constructor(private readonly admins: AdminsService) {}

  @Get()
  @ApiOperation({ summary: 'My account', description: 'The signed-in admin. Used by the top bar and SET-01 (My account).' })
  @ApiDataResponse(AdminMeDto)
  async me(@CurrentUser() auth: AuthUser) {
    return { data: await this.admins.getMe(auth) };
  }

  @Patch()
  @ApiOperation({
    summary: 'Update my account',
    description: 'Name, email and language. Changing the email needs `currentPassword`. Used by SET-01.',
  })
  @ApiDataResponse(AdminMeDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'CURRENT_PASSWORD_INVALID', 'EMAIL_TAKEN')
  async update(@CurrentUser() auth: AuthUser, @Body() dto: UpdateMeDto) {
    return { data: await this.admins.updateMe(auth, dto) };
  }

  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change my password', description: 'Signs out every other session. Used by SET-01.' })
  @ApiResponse({ status: 204, description: 'Password changed.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'CURRENT_PASSWORD_INVALID', 'PASSWORD_WEAK')
  async changePassword(@CurrentUser() auth: AuthUser, @Body() dto: ChangePasswordDto): Promise<void> {
    await this.admins.changePassword(auth, dto);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'My active sessions', description: 'Dashboard sessions, most recently used first. Used by SET-01.' })
  @ApiDataResponse(SessionDto, { isArray: true })
  async sessions(@CurrentUser() auth: AuthUser) {
    return { data: await this.admins.listSessions(auth) };
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out a session', description: 'Revokes one of my sessions. Used by SET-01.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Session revoked.' })
  @ApiErrorResponses('SESSION_NOT_FOUND')
  async revokeSession(@CurrentUser() auth: AuthUser, @Param('id', uuidPipe('SESSION_NOT_FOUND')) id: string): Promise<void> {
    await this.admins.revokeSession(auth, id);
  }
}
