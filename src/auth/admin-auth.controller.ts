import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AUTH_THROTTLE } from '../common/http/throttles.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { envConfig, type Env } from '../config/env.js';
import { AdminAuthService, type SignedIn } from './admin-auth.service.js';
import { Public } from './decorators/public.decorator.js';
import {
  AcceptInvitationDto,
  AdminLoginDto,
  AuthSessionDto,
  ForgotPasswordDto,
  InvitationPreviewDto,
  ResetPasswordDto,
} from './dto/admin-auth.dto.js';
import { clearRefreshCookie, readRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from './refresh-cookie.js';

const COOKIE_NOTE =
  `Sets the httpOnly, SameSite=Strict refresh cookie \`${REFRESH_COOKIE}\` (path \`/api/v1/admin/auth\`, ` +
  'Secure in production; 30 days with `remember`, otherwise a browser-session cookie).';

@ApiTags('admin-auth')
@Public()
@Throttle(AUTH_THROTTLE)
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    @Inject(envConfig.KEY) private readonly env: Env,
  ) {}

  private respond(res: Response, signedIn: SignedIn): { data: AuthSessionDto } {
    setRefreshCookie(res, signedIn.refreshToken, signedIn.remember, this.env);
    return { data: signedIn.body };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in to the dashboard',
    description:
      `Public route. Admin accounts only. ${COOKIE_NOTE} 5 failed attempts for an email within 15 min ` +
      'lock it for 15 min (429 ACCOUNT_LOCKED with `details.retryAfterSeconds` and `Retry-After`). One dashboard session per ' +
      'admin: signing in ends the session on any other computer, which then gets 401 `AUTH_SESSION_REPLACED`. Used by AUTH-01.',
  })
  @ApiDataResponse(AuthSessionDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'INVALID_CREDENTIALS', 'FORBIDDEN_ROLE', 'ACCOUNT_BLOCKED', 'ACCOUNT_LOCKED', 'RATE_LIMITED')
  async login(@Body() dto: AdminLoginDto, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto.email, dto.password, dto.remember ?? false));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({
    summary: 'Get a new access token',
    description:
      `Public route authenticated by the refresh cookie. Rotates the refresh token. ${COOKIE_NOTE} ` +
      'Replaying an already-rotated token revokes the whole session. Used by every dashboard screen.',
  })
  @ApiDataResponse(AuthSessionDto)
  @ApiErrorResponses('AUTH_REFRESH_INVALID', 'AUTH_SESSION_REPLACED', 'RATE_LIMITED')
  @ApiResponse({ status: 401, description: '`ACCOUNT_BLOCKED`: This account is blocked (sessions revoked).' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return this.respond(res, await this.auth.refresh(readRefreshCookie(req)));
    } catch (error) {
      clearRefreshCookie(res, this.env);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiHeader({ name: 'Authorization', required: false, description: 'Bearer token, used when the cookie is absent.' })
  @ApiOperation({
    summary: 'Sign out',
    description: 'Public route. Revokes the current session (from the refresh cookie or the bearer token) and clears the cookie. Always 204. Used by the account menu.',
  })
  @ApiResponse({ status: 204, description: 'Signed out.' })
  @ApiErrorResponses('RATE_LIMITED')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readRefreshCookie(req), req.headers.authorization);
    clearRefreshCookie(res, this.env);
  }

  @Post('forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a password reset link',
    description:
      'Public route. Always 202, whether or not the email belongs to an admin. When it does, emails (EN/AR) a ' +
      'single-use link `${ADMIN_URL}/{locale}/reset-password?token=…` valid for 1 hour. Used by AUTH-02.',
  })
  @ApiResponse({ status: 202, description: 'Accepted.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'RATE_LIMITED')
  async forgot(@Body() dto: ForgotPasswordDto): Promise<void> {
    await this.auth.forgotPassword(dto.email);
  }

  @Post('reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Set a new password with a reset link',
    description: 'Public route. Consumes the token and signs the admin out everywhere. Used by AUTH-03.',
  })
  @ApiResponse({ status: 204, description: 'Password changed.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'RESET_TOKEN_INVALID', 'RESET_TOKEN_EXPIRED', 'PASSWORD_WEAK', 'RATE_LIMITED')
  async reset(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto.token, dto.password);
  }

  @Get('invitations/:token')
  @ApiOperation({
    summary: 'Read an admin invitation',
    description: 'Public route. Shows who is invited before they choose a password. Used by AUTH-04.',
  })
  @ApiParam({ name: 'token', description: 'Token from the invitation email.' })
  @ApiDataResponse(InvitationPreviewDto)
  @ApiErrorResponses('INVITATION_INVALID', 'INVITATION_EXPIRED', 'RATE_LIMITED')
  async invitation(@Param('token') token: string) {
    return { data: await this.auth.previewInvitation(token) };
  }

  @Post('invitations/:token/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept an admin invitation',
    description: `Public route. Creates the admin account (email verified) and signs it in. ${COOKIE_NOTE} Used by AUTH-04.`,
  })
  @ApiParam({ name: 'token', description: 'Token from the invitation email.' })
  @ApiBody({ type: AcceptInvitationDto })
  @ApiDataResponse(AuthSessionDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'INVITATION_INVALID', 'INVITATION_EXPIRED', 'PASSWORD_WEAK', 'EMAIL_TAKEN', 'RATE_LIMITED')
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.acceptInvitation(token, dto.password));
  }
}
