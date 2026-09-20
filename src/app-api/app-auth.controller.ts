import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator.js';
import { AUTH_THROTTLE } from '../common/http/throttles.js';
import { ReqLang } from '../common/i18n/lang.decorator.js';
import type { Lang } from '../common/i18n/language.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { AppAuthService } from './app-auth.service.js';
import {
  AppCodeSentDto,
  AppForgotPasswordDto,
  AppLoginDto,
  AppLogoutDto,
  AppRefreshDto,
  AppRegisterDto,
  AppRegisterResultDto,
  AppResendCodeDto,
  AppResetPasswordDto,
  AppSessionDto,
  AppSetPasswordDto,
  AppVerifyEmailDto,
} from './dto/app-auth.dto.js';

const TOKEN_NOTE =
  'Returns `refreshToken` **in the body** (mobile has no cookie jar): store it in the OS keychain / keystore, ' +
  'never in plain preferences. It rotates on every `/app/auth/refresh`, and replaying a rotated one revokes the whole session.';

/**
 * Sign-up and sign-in for the mobile app. Separate from `/admin/auth/*`: these
 * routes mint tokens with audience `app`, which `/admin/**` refuses, and they
 * accept client and provider accounts only.
 */
@ApiTags('app-auth')
@Public()
@Throttle(AUTH_THROTTLE)
@Controller('app/auth')
export class AppAuthController {
  constructor(private readonly auth: AppAuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a client or provider account',
    description:
      'Public route. Screen 08 Register · client and 08a Register · provider. Creates the account **unverified**, ' +
      'emails a 6-digit code (15 min, 5 tries) and returns where it went, so the app can go straight to screen 10 Verify code. ' +
      'No tokens are issued until the email is verified. A provider must send `businessName` and `categoryId`; ' +
      'their three documents are uploaded afterwards with `POST /app/me/documents` (screen 08a), which needs the token ' +
      'from `POST /app/auth/verify-email`.',
  })
  @ApiDataResponse(AppRegisterResultDto, { status: 201, description: 'Account created; the code is on its way.' })
  @ApiErrorResponses(
    'VALIDATION_FAILED',
    'EMAIL_TAKEN',
    'PHONE_TAKEN',
    'PASSWORD_WEAK',
    'PROVIDER_FIELDS_REQUIRED',
    'PROVIDER_FIELDS_NOT_ALLOWED',
    'CATEGORY_NOT_FOUND',
    'WILAYA_NOT_FOUND',
    'RATE_LIMITED',
  )
  async register(@Body() dto: AppRegisterDto) {
    return { data: await this.auth.register(dto) };
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the email address and sign in',
    description: `Public route. Screen 10 Verify code. Consumes the code and signs the account in. ${TOKEN_NOTE}`,
  })
  @ApiDataResponse(AppSessionDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'CODE_INVALID', 'CODE_EXPIRED', 'ACCOUNT_BLOCKED', 'ROLE_NOT_ALLOWED_IN_APP', 'RATE_LIMITED')
  async verifyEmail(@Body() dto: AppVerifyEmailDto, @ReqLang() lang: Lang) {
    return { data: await this.auth.verifyEmail(dto.email, dto.code, lang) };
  }

  @Post('verify-email/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send the verification code again',
    description:
      'Public route. Screen 10 "Didn’t get the code? Resend". One code per 60 s per address (429 `CODE_RESEND_TOO_SOON` ' +
      'with `details.retryAfterSeconds`), on top of the per-IP auth limit. Answers the same shape for an unknown or ' +
      'already verified address, so it cannot be used to test whether an account exists.',
  })
  @ApiDataResponse(AppCodeSentDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'CODE_RESEND_TOO_SOON', 'RATE_LIMITED')
  async resend(@Body() dto: AppResendCodeDto, @ReqLang() lang: Lang) {
    return { data: await this.auth.resendVerification(dto.email, lang) };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      `Public route. Screen 07 Login. Client and provider accounts only. ${TOKEN_NOTE} ` +
      '5 failed attempts for an email within 15 min lock it for 15 min (429 `ACCOUNT_LOCKED`, `details.retryAfterSeconds`). ' +
      'An unverified account gets 403 `EMAIL_NOT_VERIFIED` with `details.email` — send the user to screen 10 and call ' +
      '`/app/auth/verify-email/resend`. A blocked account gets 403 `ACCOUNT_BLOCKED` with the admin’s `details.message`.',
  })
  @ApiDataResponse(AppSessionDto)
  @ApiErrorResponses(
    'VALIDATION_FAILED',
    'INVALID_CREDENTIALS',
    'EMAIL_NOT_VERIFIED',
    'ACCOUNT_BLOCKED',
    'ROLE_NOT_ALLOWED_IN_APP',
    'ACCOUNT_LOCKED',
    'RATE_LIMITED',
  )
  async login(@Body() dto: AppLoginDto, @ReqLang() lang: Lang) {
    return { data: await this.auth.login(dto.email, dto.password, lang) };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a new access token',
    description:
      'Public route authenticated by the refresh token in the body (screen 01 Splash restores the session with it). ' +
      `${TOKEN_NOTE} A refresh token minted for the dashboard is refused.`,
  })
  @ApiDataResponse(AppSessionDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'AUTH_REFRESH_INVALID', 'RATE_LIMITED')
  @ApiResponse({ status: 401, description: '`ACCOUNT_BLOCKED`: this account is blocked (every session is revoked).' })
  async refresh(@Body() dto: AppRefreshDto, @ReqLang() lang: Lang) {
    return { data: await this.auth.refresh(dto.refreshToken, lang) };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out',
    description:
      'Public route. Revokes the session behind the `refreshToken` in the body, or the one of the bearer token when the ' +
      'body is empty. Always 204, so signing out never fails on the device. Remove the FCM token first with ' +
      '`DELETE /app/me/device-tokens/:token`.',
  })
  @ApiResponse({ status: 204, description: 'Signed out.' })
  @ApiErrorResponses('RATE_LIMITED')
  async logout(@Body() dto: AppLogoutDto, @Req() req: Request): Promise<void> {
    await this.auth.logout(dto.refreshToken, req.headers.authorization);
  }

  @Post('forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a password reset code',
    description:
      'Public route. Screen 09 Forgot password. **Always 202**, whether or not the address has an account, so it cannot ' +
      'be used to discover one. When it does, emails a 6-digit code valid 15 min, then screen 10a Set new password.',
  })
  @ApiResponse({ status: 202, description: 'Accepted (says nothing about whether the account exists).' })
  @ApiErrorResponses('VALIDATION_FAILED', 'RATE_LIMITED')
  async forgot(@Body() dto: AppForgotPasswordDto, @ReqLang() lang: Lang): Promise<void> {
    await this.auth.forgotPassword(dto.email, lang);
  }

  @Post('reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Set a new password with the emailed code',
    description:
      'Public route. Screen 10a Set new password. Consumes the code and revokes **every** session, so the user signs in ' +
      'again with the new password.',
  })
  @ApiResponse({ status: 204, description: 'Password changed; sign in again.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'CODE_INVALID', 'CODE_EXPIRED', 'PASSWORD_WEAK', 'ACCOUNT_BLOCKED', 'ROLE_NOT_ALLOWED_IN_APP', 'RATE_LIMITED')
  async reset(@Body() dto: AppResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto.email, dto.code, dto.password);
  }

  @Post('set-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Choose a password for an account an admin created',
    description:
      'Public route. The account has no password yet and was emailed `${APP_PUBLIC_URL}/set-password?token=…` (valid 7 days, ' +
      `single use). Sets the password, marks the email verified and signs in. ${TOKEN_NOTE}`,
  })
  @ApiDataResponse(AppSessionDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'RESET_TOKEN_INVALID', 'RESET_TOKEN_EXPIRED', 'PASSWORD_WEAK', 'ACCOUNT_BLOCKED', 'ROLE_NOT_ALLOWED_IN_APP', 'RATE_LIMITED')
  async setPassword(@Body() dto: AppSetPasswordDto, @ReqLang() lang: Lang) {
    return { data: await this.auth.setPassword(dto.token, dto.password, lang) };
  }
}
