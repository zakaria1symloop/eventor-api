import { Controller, Get, Header, Inject } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { envConfig, type Env } from '../config/env.js';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DataSource } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { PASSWORD_MIN_LENGTH } from '../auth/password.policy.js';
import { MESSAGE_MAX_LENGTH } from '../common/enums/messaging.enums.js';
import { ReqLang } from '../common/i18n/lang.decorator.js';
import type { Lang } from '../common/i18n/language.js';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '../common/i18n/language.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { SettingsService } from '../settings/settings.service.js';
import { AppConfigDto } from './dto/app-catalog.dto.js';
import { ALLOWED_DOCUMENT_MIME } from './app-me.service.js';
import { BUDGET_MAX_ITEMS, pickTextOrNull } from './app.policy.js';

/** File-picker extensions matching `ALLOWED_DOCUMENT_MIME` (the server still sniffs the bytes). */
const DOCUMENT_EXTENSIONS: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/heic': ['heic'],
  'image/heif': ['heif'],
};

/**
 * What the app reads before anything else (screen 01 Splash): whether it must
 * force an update, whether the platform is in maintenance, and the limits it
 * should enforce locally so a user is not told "too large" only after a slow
 * upload.
 */
@ApiTags('app-config')
@Public()
@Controller('app')
export class AppConfigController {
  constructor(
    private readonly settings: SettingsService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(envConfig.KEY) private readonly env: Env,
  ) {}

  @Get('config')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiHeader({ name: 'Accept-Language', required: false, description: '`en` or `ar`: picks `maintenanceMessage`.' })
  @ApiOperation({
    summary: 'Public app configuration',
    description:
      'Public (no token). Screen 01 Splash calls it on every cold start. Compare `minAppVersion` with the installed ' +
      'build and show the store prompt when it is lower; when `maintenanceMode` is true, show `maintenanceMessage` and ' +
      'stop. Also carries the upload limits, the business `limits` object (budget lines, photos, evidence, message length, ' +
      'document types as MIME **and** extensions, the event-request form slug), the password rule the register screens ' +
      'print, and the legal links the "By continuing you agree…" line points at. Cacheable for 60 s.',
  })
  @ApiDataResponse(AppConfigDto)
  @ApiErrorResponses('RATE_LIMITED')
  async config(@ReqLang() lang: Lang) {
    const settings = await this.settings.getMany([
      'min_app_version',
      'maintenance_mode',
      'maintenance_message_en',
      'maintenance_message_ar',
      'languages_required',
      'currency',
      'support_email',
      'support_phone',
      'terms_url',
      'privacy_url',
      'max_photo_upload_mb',
      'max_document_upload_mb',
      'max_photos_per_service',
      'max_photos_per_pack',
      'max_dispute_evidence_files',
      'allowed_image_types',
      'booking_min_notice_days',
      'booking_reply_deadline_hours',
      'dispute_window_hours',
    ] as const);

    // "New event request" opens the default published form in a WebView.
    const [defaultForm] = await this.dataSource.query(
      "SELECT slug FROM forms WHERE is_default = 1 AND status = 'published' AND deleted_at IS NULL LIMIT 1",
    );

    const orNull = (value: string | null | undefined) => (value && value.trim() !== '' ? value : null);
    const data: AppConfigDto = {
      minAppVersion: settings.min_app_version,
      maintenanceMode: settings.maintenance_mode,
      maintenanceMessage: pickTextOrNull(lang, settings.maintenance_message_en, settings.maintenance_message_ar),
      maintenanceMessageEn: orNull(settings.maintenance_message_en),
      maintenanceMessageAr: orNull(settings.maintenance_message_ar),
      languages: settings.languages_required?.length ? [...settings.languages_required] : [...SUPPORTED_LANGUAGES],
      defaultLanguage: DEFAULT_LANGUAGE,
      currency: settings.currency,
      emailVerificationRequired: !this.env.AUTH_SKIP_EMAIL_VERIFICATION,
      supportEmail: orNull(settings.support_email),
      supportPhone: orNull(settings.support_phone),
      termsUrl: orNull(settings.terms_url),
      privacyUrl: orNull(settings.privacy_url),
      uploads: {
        maxPhotoMb: settings.max_photo_upload_mb,
        maxDocumentMb: settings.max_document_upload_mb,
        maxPhotosPerService: settings.max_photos_per_service,
        imageTypes: [...settings.allowed_image_types],
      },
      limits: {
        budgetItemsMax: BUDGET_MAX_ITEMS,
        photosPerService: settings.max_photos_per_service,
        photosPerPack: settings.max_photos_per_pack,
        documentMaxMb: settings.max_document_upload_mb,
        photoMaxMb: settings.max_photo_upload_mb,
        disputeEvidenceMax: settings.max_dispute_evidence_files,
        messageMaxLength: MESSAGE_MAX_LENGTH,
        eventRequestFormSlug: defaultForm?.slug ?? null,
        documentAcceptedMimeTypes: [...ALLOWED_DOCUMENT_MIME],
        documentAcceptedExtensions: [...ALLOWED_DOCUMENT_MIME].flatMap((mime) => DOCUMENT_EXTENSIONS[mime] ?? []),
      },
      passwordPolicy: { minLength: PASSWORD_MIN_LENGTH, needsLetterAndDigit: true },
      booking: {
        minNoticeDays: settings.booking_min_notice_days,
        replyDeadlineHours: settings.booking_reply_deadline_hours,
        cancellationWindowHours: settings.dispute_window_hours,
      },
    };
    return { data };
  }
}
