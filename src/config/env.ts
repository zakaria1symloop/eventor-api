import { registerAs } from '@nestjs/config';
import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1';

/**
 * Every environment variable the API reads, with its default. Validated once at
 * boot: a missing or malformed value stops the process with a list of what is
 * wrong. Every property has an initialiser so `Object.keys(new Env())` lists it.
 */
export class Env {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  // ── Database ──────────────────────────────────────────────
  @IsString()
  @IsNotEmpty()
  DB_HOST = '127.0.0.1';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  DB_PORT = 3306;

  @IsString()
  @IsNotEmpty()
  DB_USERNAME = '';

  @IsString()
  DB_PASSWORD = '';

  @IsString()
  @IsNotEmpty()
  DB_DATABASE = '';

  // ── HTTP ──────────────────────────────────────────────────
  /** "*" allows any origin; otherwise a comma-separated allowlist. */
  @IsString()
  CORS_ORIGINS = '*';

  @Transform(toBool)
  @IsBoolean()
  SWAGGER_ENABLED = true;

  @Transform(toBool)
  @IsBoolean()
  LOG_REQUESTS = true;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT = 100;

  @Type(() => Number)
  @IsInt()
  @Min(1000)
  THROTTLE_TTL_MS = 60_000;

  /** Uploads per minute per user or IP on file routes (read by the routes' @Throttle). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  UPLOAD_THROTTLE_LIMIT = 30;

  /** Max JSON / urlencoded body (multipart uploads have their own per-route limits). */
  @Matches(/^\d+(b|kb|mb)$/i, { message: 'BODY_LIMIT must look like 512kb or 1mb' })
  BODY_LIMIT = '1mb';

  // ── Public URLs (domains are not chosen yet) ──────────────
  @IsString()
  API_URL = 'http://localhost:3000';

  @IsString()
  ADMIN_URL = 'http://localhost:3001';

  @IsString()
  APP_PUBLIC_URL = 'http://localhost:3001';

  // ── Auth ──────────────────────────────────────────────────
  @IsString()
  @MinLength(16)
  JWT_ACCESS_SECRET = 'dev-only-access-secret-change-me';

  /** Access token lifetime in seconds (15 min). */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  JWT_ACCESS_TTL = 900;

  /** Requests per minute per IP on `/admin/auth/*` (read by the route's @Throttle). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_THROTTLE_LIMIT = 10;

  /**
   * Requests per minute per admin on the routes that send mail to a third party
   * (invitations, re-sends): tighter than the global default so a stolen session
   * cannot be used as a mail relay. Read by the routes' `@Throttle`.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  MAIL_THROTTLE_LIMIT = 20;

  // ── Files ─────────────────────────────────────────────────
  @IsString()
  @IsNotEmpty()
  STORAGE_ROOT = './storage';

  @IsString()
  @MinLength(16)
  FILES_SIGNING_SECRET = 'dev-only-files-secret-change-me';

  /** Lifetime of signed file URLs, in seconds. */
  @Type(() => Number)
  @IsInt()
  @Min(10)
  FILES_URL_TTL = 900;

  // ── Queue ─────────────────────────────────────────────────
  /** Empty: jobs run in-process (dev/test without Redis). */
  @IsString()
  REDIS_URL = '';

  // ── Mail (Google Workspace SMTP relay) ────────────────────
  /** Empty: mails are logged to the console instead of sent. */
  @IsString()
  SMTP_HOST = '';

  @Type(() => Number)
  @IsInt()
  SMTP_PORT = 587;

  @Transform(toBool)
  @IsBoolean()
  SMTP_SECURE = false;

  /**
   * Temporary switch while no SMTP account exists: sign-up marks the email as
   * verified and signs the user in, and login/booking skip the check. Turn it
   * off as soon as SMTP_HOST is configured.
   */
  @Transform(toBool)
  @IsBoolean()
  AUTH_SKIP_EMAIL_VERIFICATION = false;

  @IsString()
  SMTP_USER = '';

  @IsString()
  SMTP_PASSWORD = '';

  @IsString()
  MAIL_FROM = 'Eventor <no-reply@eventor.dz>';

  // ── Push (FCM, stub for now) ──────────────────────────────
  @IsString()
  FCM_PROJECT_ID = '';

  @IsString()
  FCM_CREDENTIALS_PATH = '';

  // ── Seed (read by the SeedV1 migration) ───────────────────
  @IsString()
  SEED_ADMIN_EMAIL = '';

  @IsString()
  SEED_ADMIN_PASSWORD = '';

  @IsString()
  SEED_ADMIN_NAME = '';
}

/** `CORS_ORIGINS` split into trimmed, non-empty entries. */
export const corsList = (value: string): string[] =>
  value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const DEV_SECRETS = ['dev-only-access-secret-change-me', 'dev-only-files-secret-change-me'];

export function validateEnv(raw: Record<string, unknown>): Env {
  const known = Object.keys(new Env());
  const picked = Object.fromEntries(
    known.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]),
  );

  const env = plainToInstance(Env, picked, { exposeDefaultValues: true });
  const errors = validateSync(env, { skipMissingProperties: false });
  const problems = errors.map(
    (e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
  );

  if (env.NODE_ENV === NodeEnv.Production) {
    for (const key of ['JWT_ACCESS_SECRET', 'FILES_SIGNING_SECRET'] as const) {
      if (DEV_SECRETS.includes(env[key]) || env[key].length < 32) {
        problems.push(`  - ${key}: must be a random value of at least 32 characters in production`);
      }
    }
    if (env.JWT_ACCESS_SECRET === env.FILES_SIGNING_SECRET) {
      problems.push('  - FILES_SIGNING_SECRET: must differ from JWT_ACCESS_SECRET');
    }
    if (corsList(env.CORS_ORIGINS).some((origin) => origin === '*') || corsList(env.CORS_ORIGINS).length === 0) {
      problems.push('  - CORS_ORIGINS: must list the allowed origins in production ("*" reflects any origin with credentials)');
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }

  return env;
}

/** Inject the validated environment with `@Inject(envConfig.KEY) env: Env`. */
export const envConfig = registerAs('env', () => validateEnv(process.env));
