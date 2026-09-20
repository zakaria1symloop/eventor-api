import { Controller, Get, Header } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { PASSWORD_MIN_LENGTH } from '../auth/password.policy.js';
import { ReqLang } from '../common/i18n/lang.decorator.js';
import type { Lang } from '../common/i18n/language.js';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '../common/i18n/language.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { SettingsService } from '../settings/settings.service.js';
import { AppConfigDto } from './dto/app-catalog.dto.js';
import { pickTextOrNull } from './app.policy.js';

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
  constructor(private readonly settings: SettingsService) {}

  @Get('config')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiHeader({ name: 'Accept-Language', required: false, description: '`en` or `ar`: picks `maintenanceMessage`.' })
  @ApiOperation({
    summary: 'Public app configuration',
    description:
      'Public (no token). Screen 01 Splash calls it on every cold start. Compare `minAppVersion` with the installed ' +
      'build and show the store prompt when it is lower; when `maintenanceMode` is true, show `maintenanceMessage` and ' +
      'stop. Also carries the upload limits, the password rule the register screens print, and the legal links the ' +
      '"By continuing you agree…" line points at. Cacheable for 60 s.',
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
      'allowed_image_types',
      'booking_min_notice_days',
      'booking_reply_deadline_hours',
      'dispute_window_hours',
    ] as const);

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
