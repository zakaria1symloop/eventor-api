import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../password.policy.js';
import { AdminMeDto } from './admin-me.dto.js';

export const normaliseEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class AdminLoginDto {
  @ApiProperty({ format: 'email', example: 'admin@eventor.dz', maxLength: 190 })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email: string;

  @ApiProperty({ example: 'Admin12345!', maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Keep the refresh cookie for 30 days instead of the browser session.',
  })
  @IsOptional()
  @IsBoolean()
  remember?: boolean;
}

export class ForgotPasswordDto {
  @ApiProperty({ format: 'email', example: 'admin@eventor.dz', maxLength: 190 })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({
    example: '0b8e1c52-7a44-4f0e-9d7b-3c2a1f6e5d40.q2VxY0l2Qm9yZkRqWkF4bUdLN3lQdE1zVHFjSWhOZ1Y',
    description: 'The `token` query parameter of the emailed link.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token: string;

  @ApiProperty({
    example: 'Sunflower42x',
    description: 'At least 10 characters with a letter and a digit (PASSWORD_WEAK otherwise).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class AcceptInvitationDto {
  @ApiProperty({
    example: 'Sunflower42x',
    description: 'At least 10 characters with a letter and a digit (PASSWORD_WEAK otherwise).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class AuthSessionDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…', description: 'JWT (HS256), send as `Authorization: Bearer`.' })
  accessToken: string;

  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds.' })
  expiresIn: number;

  @ApiProperty({ type: AdminMeDto })
  user: AdminMeDto;
}

export class InvitationPreviewDto {
  @ApiProperty({ example: 'Karim Benali' })
  fullName: string;

  @ApiProperty({ format: 'email', example: 'karim.benali@eventor.dz' })
  email: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-18T10:00:00.000Z' })
  expiresAt: string;
}
