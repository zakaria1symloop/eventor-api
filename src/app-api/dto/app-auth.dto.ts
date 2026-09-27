import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { normaliseEmail } from '../../auth/dto/admin-auth.dto.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/password.policy.js';
import { trim } from '../../common/dto/transforms.js';
import { Language, UserRole, VerificationStatus } from '../../common/enums/user.enums.js';
import { toPhone } from '../../users/users.policy.js';
import { AppMeDto } from './app-me.dto.js';

const PHONE_MESSAGE = 'phone must be an Algerian number: 0XXXXXXXXX or +213XXXXXXXXX';
const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters with a letter and a digit (422 PASSWORD_WEAK otherwise).`;

/** Only the two roles that can sign up in the app (tech-decisions → Auth). */
export enum AppSignupRole {
  Client = 'client',
  Provider = 'provider',
}

export class AppRegisterDto {
  @ApiProperty({ enum: AppSignupRole, example: AppSignupRole.Client, description: 'Chosen on screen 06 Role selection. Immutable afterwards.' })
  @IsEnum(AppSignupRole)
  role: AppSignupRole;

  @ApiProperty({ example: 'Amina Benali', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  fullName: string;

  @ApiProperty({ format: 'email', example: 'amina.benali@email.com', maxLength: 190 })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email: string;

  @ApiProperty({ example: '0555123456', description: '`0XXXXXXXXX` or `+213XXXXXXXXX`; stored as `+213XXXXXXXXX`.' })
  @Transform(toPhone)
  @Matches(/^\+213[1-9]\d{8}$/, { message: PHONE_MESSAGE })
  phone: string;

  @ApiProperty({ example: 'Sunflower42x', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH, description: PASSWORD_HINT })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

  @ApiProperty({ enum: Language, example: Language.En, description: 'Language toggle on screens 08/08a.' })
  @IsEnum(Language)
  language: Language;

  @ApiPropertyOptional({ example: 16, minimum: 1, maximum: 58, description: 'The wilaya the account lives in.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(58)
  wilayaCode?: number;

  @ApiPropertyOptional({ example: 'Studio Lumière', maxLength: 150, description: 'Providers only (required). 422 PROVIDER_FIELDS_REQUIRED when missing.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 150)
  businessName?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Providers only (required): the category they work in.' })
  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @ApiPropertyOptional({ type: [Number], example: [16, 9], description: 'Providers only: the wilayas they cover. Defaults to `wilayaCode`.' })
  @IsOptional()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(58, { each: true })
  wilayaCodes?: number[];
}

export class AppRegisterResultDto {
  @ApiProperty({ format: 'uuid', example: '5b0d6c9e-4a51-4c3f-9d0e-2f6b8a7c1e24' })
  userId: string;

  @ApiProperty({ format: 'email', example: 'amina.benali@email.com', description: 'Shown on screen 10 ("We sent a 6-digit code to …").' })
  emailSentTo: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-20T10:15:00.000Z', description: 'When the code stops working.' })
  expiresAt: string;

  @ApiProperty({ example: 60, description: 'Seconds before "Resend" may be used.' })
  resendAfterSeconds: number;

  @ApiProperty({ enum: VerificationStatus, example: VerificationStatus.Pending, description: 'Providers start `pending`; clients are `not_required`.' })
  verificationStatus: VerificationStatus;
}

export class AppVerifyEmailDto {
  @ApiProperty({ format: 'email', example: 'amina.benali@email.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email: string;

  @ApiProperty({ example: '284917', description: 'The 6 digits typed on screen 10.' })
  @Transform(trim)
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}

export class AppResendCodeDto {
  @ApiProperty({ format: 'email', example: 'amina.benali@email.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email: string;
}

export class AppLoginDto {
  @ApiProperty({ format: 'email', example: 'amina.benali@email.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email: string;

  @ApiProperty({ example: 'Sunflower42x', maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class AppRefreshDto {
  @ApiProperty({
    example: '0b8e1c52-7a44-4f0e-9d7b-3c2a1f6e5d40.1.q2VxY0l2Qm9yZkRqWkF4bUdLN3lQdE1zVHFjSWhOZ1Y',
    description: 'The refresh token from the previous login / refresh response. Rotates on every use.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  refreshToken: string;
}

export class AppLogoutDto {
  @ApiPropertyOptional({ description: 'The refresh token to revoke. When absent, the bearer token’s session is revoked.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}

export class AppForgotPasswordDto {
  @ApiProperty({ format: 'email', example: 'amina.benali@email.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email: string;
}

export class AppVerifyResetCodeDto {
  @ApiProperty({ format: 'email', example: 'amina.benali@email.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email: string;

  @ApiProperty({ example: '284917', description: 'The 6-digit code emailed by `/app/auth/forgot`. Checking it here does **not** consume it.' })
  @Transform(trim)
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}

export class AppResetPasswordDto {
  @ApiProperty({ format: 'email', example: 'amina.benali@email.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email: string;

  @ApiProperty({ example: '284917', description: 'The 6-digit code emailed by `/app/auth/forgot`.' })
  @Transform(trim)
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;

  @ApiProperty({ example: 'Sunflower42x', description: PASSWORD_HINT, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class AppSetPasswordDto {
  @ApiProperty({
    example: '0b8e1c52-7a44-4f0e-9d7b-3c2a1f6e5d40.q2VxY0l2Qm9yZkRqWkF4bUdLN3lQdE1zVHFjSWhOZ1Y',
    description: 'The `token` query parameter of `${APP_PUBLIC_URL}/set-password?token=…`.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token: string;

  @ApiProperty({ example: 'Sunflower42x', description: PASSWORD_HINT, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

/** What the app stores after login, refresh, verify-email and set-password. */
export class AppSessionDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…', description: 'JWT (HS256, audience `app`), send as `Authorization: Bearer`.' })
  accessToken: string;

  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds.' })
  expiresIn: number;

  @ApiProperty({
    example: '0b8e1c52-7a44-4f0e-9d7b-3c2a1f6e5d40.1.q2VxY0l2Qm9yZkRqWkF4bUdLN3lQdE1zVHFjSWhOZ1Y',
    description: 'Opaque, 30 days, single use. Keep it in secure storage — it is **not** a cookie on mobile.',
  })
  refreshToken: string;

  @ApiProperty({ type: AppMeDto })
  user: AppMeDto;
}

export class AppCodeSentDto {
  @ApiProperty({ format: 'email', example: 'amina.benali@email.com' })
  email: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-20T10:15:00.000Z' })
  expiresAt: string;

  @ApiProperty({ example: 60 })
  resendAfterSeconds: number;
}

export { UserRole };
