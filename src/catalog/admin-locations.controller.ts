import { uploadLimits } from '../common/http/upload-limits.js';
import { UPLOAD_THROTTLE } from '../common/http/throttles.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { intParam, uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { COMMUNES_CSV_MAX_BYTES, COMMUNES_CSV_MAX_ROWS, COMMUNES_CSV_TEMPLATE } from './communes-csv.js';
import {
  COMMUNE_SORT_FIELDS,
  CommuneDto,
  CommunesImportResultDto,
  CommunesQueryDto,
  CreateCommuneDto,
  UpdateCommuneDto,
  UpdateWilayaDto,
  WILAYA_SORT_FIELDS,
  WilayaDto,
  WilayasQueryDto,
  WilayaTabCountsDto,
} from './dto/locations.dto.js';
import { LocationsService } from './locations.service.js';


interface UploadedCsv {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const CSV_MIME_TYPES = new Set(['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream']);

@ApiTags('admin-locations')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin')
export class AdminLocationsController {
  constructor(private readonly locations: LocationsService) {}

  // ── wilayas ────────────────────────────────────────────────

  @Get('wilayas')
  @ApiOperation({
    summary: 'List wilayas',
    description:
      `Tabs \`tab\` (all | open | closed) with counters in \`meta.counts\`; \`q\` in name, Arabic name and code; \`region\` (multi); ` +
      `sortable by ${WILAYA_SORT_FIELDS.join(', ')} (default code:asc). Each row has communesCount, providersCount, servicesCount (published) ` +
      'and clientsCount. Export: resource `wilayas`. Used by LOC-01.',
  })
  @ApiPaginatedResponse(WilayaDto, { counts: WilayaTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  listWilayas(@Query() query: WilayasQueryDto) {
    return this.locations.listWilayas(query);
  }

  @Get('wilayas/:code')
  @ApiOperation({ summary: 'Get a wilaya', description: 'One wilaya with its counts. Used by LOC-02.' })
  @ApiParam({ name: 'code', type: Number, example: 16 })
  @ApiDataResponse(WilayaDto)
  @ApiErrorResponses('WILAYA_NOT_FOUND')
  async getWilaya(@Param('code', intParam('WILAYA_NOT_FOUND')) code: number) {
    return { data: await this.locations.getWilaya(code) };
  }

  @Patch('wilayas/:code')
  @ApiOperation({
    summary: 'Open, close or rename a wilaya',
    description:
      'Closing hides the wilaya from search and blocks new bookings there. Without `confirm: true` it returns 409 ' +
      '`WILAYA_CLOSE_CONFIRM_REQUIRED` with `details.servicesCount` and `details.providersCount` for the confirm dialog. Used by LOC-01 and LOC-02.',
  })
  @ApiParam({ name: 'code', type: Number, example: 16 })
  @ApiDataResponse(WilayaDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'WILAYA_NOT_FOUND', 'WILAYA_CLOSE_CONFIRM_REQUIRED')
  async updateWilaya(@Param('code', intParam('WILAYA_NOT_FOUND')) code: number, @Body() dto: UpdateWilayaDto) {
    return { data: await this.locations.updateWilaya(code, dto) };
  }

  @Get('wilayas/:code/communes')
  @ApiOperation({
    summary: 'List the communes of a wilaya',
    description: `Search \`q\` in names and postal code; sortable by ${COMMUNE_SORT_FIELDS.join(', ')} (default name:asc). Used by LOC-02.`,
  })
  @ApiParam({ name: 'code', type: Number, example: 16 })
  @ApiPaginatedResponse(CommuneDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED', 'WILAYA_NOT_FOUND')
  listCommunes(@Param('code', intParam('WILAYA_NOT_FOUND')) code: number, @Query() query: CommunesQueryDto) {
    return this.locations.listCommunes(code, query);
  }

  // ── communes ───────────────────────────────────────────────

  @Post('communes')
  @ApiOperation({ summary: 'Add a commune', description: 'Names are unique per wilaya. Used by LOC-02.' })
  @ApiDataResponse(CommuneDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'WILAYA_NOT_FOUND', 'COMMUNE_EXISTS')
  async createCommune(@Body() dto: CreateCommuneDto) {
    return { data: await this.locations.createCommune(dto) };
  }

  @Get('communes/import/template')
  @Header('Content-Disposition', 'attachment; filename="communes-template.csv"')
  @ApiOperation({ summary: 'CSV import template', description: 'Header `wilaya_code,name,name_ar,postal_code` and two example rows (UTF-8 with BOM). Used by LOC-02.' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The template file.', content: { 'text/csv': { schema: { type: 'string' } } } })
  template(): StreamableFile {
    return new StreamableFile(Buffer.from(COMMUNES_CSV_TEMPLATE, 'utf8'), { type: 'text/csv; charset=utf-8' });
  }

  @Post('communes/import')
  @HttpCode(HttpStatus.OK)
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(10) }))
  @ApiOperation({
    summary: 'Import communes from CSV',
    description:
      `multipart/form-data with \`file\`: UTF-8 CSV, header \`wilaya_code,name,name_ar,postal_code\` (postal_code optional), at most ` +
      `${COMMUNES_CSV_MAX_ROWS} rows and ${COMMUNES_CSV_MAX_BYTES / 1024 / 1024} MB. Rows match existing communes by wilaya + name: new → created, ` +
      'changed Arabic name or postal code → updated (an empty postal_code keeps the current one), identical → skipped. Bad lines are reported in ' +
      '`errors` and the rest are applied in one transaction. Used by LOC-02.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiDataResponse(CommunesImportResultDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'CSV_HEADER_INVALID', 'CSV_TOO_MANY_ROWS', 'RATE_LIMITED')
  async importCommunes(@UploadedFile() file: UploadedCsv | undefined) {
    if (!file) {
      throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'file', code: 'IS_DEFINED', message: 'file is required' }]);
    }
    if (file.size > COMMUNES_CSV_MAX_BYTES) {
      throw new AppException(413, 'FILE_TOO_LARGE', { maxMb: COMMUNES_CSV_MAX_BYTES / 1024 / 1024 });
    }
    const named = /\.csv$/i.test(file.originalname);
    if ((!named && !CSV_MIME_TYPES.has(file.mimetype)) || file.buffer.includes(0)) {
      throw AppException.of('FILE_TYPE_NOT_ALLOWED');
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    } catch {
      throw AppException.of('FILE_TYPE_NOT_ALLOWED');
    }
    return { data: await this.locations.importCommunes(text) };
  }

  @Patch('communes/:id')
  @ApiOperation({ summary: 'Update a commune', description: 'Names and postal code (inline edit). Used by LOC-02.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(CommuneDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'COMMUNE_NOT_FOUND', 'COMMUNE_EXISTS')
  async updateCommune(@Param('id', uuidParam('COMMUNE_NOT_FOUND')) id: string, @Body() dto: UpdateCommuneDto) {
    return { data: await this.locations.updateCommune(id, dto) };
  }

  @Delete('communes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a commune', description: 'Soft delete; 409 `COMMUNE_IN_USE` (`details.bookingsCount`) when bookings use it. Used by LOC-02.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiErrorResponses('COMMUNE_NOT_FOUND', 'COMMUNE_IN_USE')
  async removeCommune(@Param('id', uuidParam('COMMUNE_NOT_FOUND')) id: string): Promise<void> {
    await this.locations.removeCommune(id);
  }
}
