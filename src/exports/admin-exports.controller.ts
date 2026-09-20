import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { CreateExportDto, ExportDto, ExportResourceDto } from './dto/exports.dto.js';
import { EXPORT_SYNC_MAX_ROWS, ExportsService } from './exports.service.js';

@ApiTags('admin-exports')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/exports')
export class AdminExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get('resources')
  @ApiOperation({
    summary: 'Exportable resources',
    description: 'Each resource with its column keys, headers and default columns, for the export dialog. Used by STA-05.',
  })
  @ApiDataResponse(ExportResourceDto, { isArray: true })
  resources() {
    return { data: this.exports.resources() };
  }

  @Post()
  @ApiOperation({
    summary: 'Export a list',
    description:
      `Applies the list's \`filters\` and writes the chosen \`columns\` as CSV (UTF-8 with BOM) or XLSX. ` +
      `Below ${EXPORT_SYNC_MAX_ROWS} matching rows the file is generated now: \`status: done\` with a signed \`fileUrl\` ` +
      `(or \`failed\` with \`error\`). From ${EXPORT_SYNC_MAX_ROWS} rows it is queued (\`status: queued\`) and a download link ` +
      'is emailed when ready; poll `GET /admin/exports/:id` meanwhile. Writes an `export.requested` activity log entry. Used by STA-05.',
  })
  @ApiDataResponse(ExportDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED')
  async create(@CurrentUser() auth: AuthUser, @Body() dto: CreateExportDto) {
    return { data: await this.exports.create(auth, dto) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Export status',
    description: 'One of my exports, with a fresh signed `fileUrl` once done. Exports of other admins return 404. Used by STA-05.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(ExportDto)
  @ApiErrorResponses('EXPORT_NOT_FOUND')
  async get(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('EXPORT_NOT_FOUND')) id: string) {
    return { data: await this.exports.get(auth, id) };
  }
}
