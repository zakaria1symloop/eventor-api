import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { AdminSettingsService } from './admin-settings.service.js';
import { SettingDiffDto, SettingsDto, UpdateSettingsDto } from './dto/admin-settings.dto.js';

@ApiTags('admin-settings')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly settings: AdminSettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'All platform settings',
    description:
      'Grouped by section (commission, bookings, uploads, languages, notifications, support, maintenance) with the typed value, ' +
      'default, type, limits, `sensitive` flag and who changed it last. Used by SET-01.',
  })
  @ApiDataResponse(SettingsDto)
  async get() {
    return { data: await this.settings.getAll() };
  }

  @Patch()
  @ApiOperation({
    summary: 'Save settings',
    description:
      'Saves a batch of `values` atomically. Each key is validated against its type and range (`details[].field` = `values.<key>`). ' +
      'Changing a sensitive key (platform_fee_percent, pack_fee_percent, invoice_issuer, maintenance_mode) without `confirm: true` ' +
      'returns 409 `SETTINGS_CONFIRM_REQUIRED` with `details.diff: SettingDiffDto[]` (every change) and `details.sensitiveKeys`: show the confirm dialog, then resend with `confirm: true`. ' +
      'Send `expectedUpdatedAt` (key → loaded `updatedAt`) for optimistic concurrency: 409 `STALE_UPDATE` with `details.keys`. ' +
      'Unchanged values are ignored; every save writes one `settings.updated` activity log entry (level sensitive). Returns all settings. Used by SET-01.',
  })
  @ApiDataResponse(SettingsDto)
  @ApiExtraModels(SettingDiffDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'SETTINGS_CONFIRM_REQUIRED', 'STALE_UPDATE')
  async update(@CurrentUser() auth: AuthUser, @Body() dto: UpdateSettingsDto) {
    return { data: await this.settings.update(auth, dto) };
  }
}
