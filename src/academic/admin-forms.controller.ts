import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { CreateFormDto, FORM_SORT_FIELDS, FormDetailDto, FormRowDto, FormsQueryDto, FormTabCountsDto, FormVersionDto, SaveDraftDto, UpdateFormDto } from './dto/forms.dto.js';
import { FormsService } from './forms.service.js';

const ID = { name: 'id', format: 'uuid' };
const formId = () => uuidParam('FORM_NOT_FOUND');

@ApiTags('admin-forms')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/forms')
export class AdminFormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  @ApiOperation({
    summary: 'List request forms',
    description:
      'Tabs `tab` (draft | published | closed | all) with `meta.counts` (they follow `q`, not the tab). Rows carry the live version, submissions count, default flag, ' +
      `unpublished draft changes and the public link. \`q\`: name or slug. Sortable by ${FORM_SORT_FIELDS.join(', ')} (default updatedAt:desc). Export: resource \`forms\`. Used by ACR-05, ACR-01 (Forms tab).`,
  })
  @ApiPaginatedResponse(FormRowDto, { counts: FormTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@Query() query: FormsQueryDto) {
    return this.forms.list(query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a form',
    description:
      'A draft with a starter schema (requester name and phone, institution, title, event type, date, wilaya, attendees, needs, budget, all system-mapped, EN + AR). ' +
      'The slug comes from nameEn when omitted (409 SLUG_TAKEN for a taken explicit slug). The very first form becomes the default. Used by ACR-05 (New).',
  })
  @ApiDataResponse(FormDetailDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'SLUG_TAKEN')
  async create(@CurrentUser() auth: AuthUser, @Body() dto: CreateFormDto) {
    return { data: await this.forms.create(auth, dto) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a form', description: 'Settings, draft schema and published versions (newest first, with submissions per version). Used by ACR-06.' })
  @ApiParam(ID)
  @ApiDataResponse(FormDetailDto)
  @ApiErrorResponses('FORM_NOT_FOUND')
  async get(@Param('id', formId()) id: string) {
    return { data: await this.forms.get(id) };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit form settings',
    description:
      'nameEn/Ar, slug (409 SLUG_TAKEN), descriptions, requiresAuth, maxSubmissionsPerEmailPerMonth (null = unlimited), confirmationEn/Ar, isDefault (true makes it the only default; ' +
      'false on the default form: 409 FORM_DEFAULT_REQUIRED). Optional `updatedAt` for optimistic concurrency (409 STALE_UPDATE). Used by ACR-06 (Form settings).',
  })
  @ApiParam(ID)
  @ApiDataResponse(FormDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'FORM_NOT_FOUND', 'SLUG_TAKEN', 'FORM_DEFAULT_REQUIRED', 'STALE_UPDATE')
  async update(@CurrentUser() auth: AuthUser, @Param('id', formId()) id: string, @Body() dto: UpdateFormDto) {
    return { data: await this.forms.update(auth, id, dto) };
  }

  @Put(':id/draft')
  @ApiOperation({
    summary: 'Save the draft schema',
    description:
      'Strict structural validation (422 FORM_SCHEMA_INVALID with `details: [{ path, code }]`, e.g. `fields[3].options[0].label_ar` OPTION_LABEL_MISSING): 17 field types, unique keys, ' +
      'options on choice fields with EN + AR label strings, validation objects per type, showIf on an earlier field, each system mapping at most once and on a compatible type. ' +
      'Labels may still be empty in a draft. The live version is unchanged. Optional `updatedAt` (409 STALE_UPDATE). Used by ACR-06 (Save draft).',
  })
  @ApiParam(ID)
  @ApiDataResponse(FormDetailDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'FORM_NOT_FOUND', 'FORM_SCHEMA_INVALID', 'STALE_UPDATE')
  async saveDraft(@CurrentUser() auth: AuthUser, @Param('id', formId()) id: string, @Body() dto: SaveDraftDto) {
    return { data: await this.forms.saveDraft(auth, id, dto) };
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish the draft',
    description:
      'Draft or published forms (closed: 409 FORM_INVALID_TRANSITION). Validates the draft plus the required mappings title, event_date, wilaya, requester_name, requester_phone ' +
      '(422 FORM_SCHEMA_INVALID, code MAPPING_REQUIRED) and every EN + AR label (422 FORM_TRANSLATION_MISSING with the paths). Creates an immutable version (n + 1), sets it live ' +
      'and the status to published; existing requests keep their version. Used by ACR-06 (Publish).',
  })
  @ApiParam(ID)
  @ApiDataResponse(FormDetailDto)
  @ApiErrorResponses('FORM_NOT_FOUND', 'FORM_INVALID_TRANSITION', 'FORM_SCHEMA_INVALID', 'FORM_TRANSLATION_MISSING')
  async publish(@CurrentUser() auth: AuthUser, @Param('id', formId()) id: string) {
    return { data: await this.forms.publish(auth, id) };
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close a form', description: 'published → closed: the public link answers 410 FORM_CLOSED ("no longer accepting requests"). Used by ACR-05.' })
  @ApiParam(ID)
  @ApiDataResponse(FormDetailDto)
  @ApiErrorResponses('FORM_NOT_FOUND', 'FORM_INVALID_TRANSITION')
  async close(@CurrentUser() auth: AuthUser, @Param('id', formId()) id: string) {
    return { data: await this.forms.close(auth, id, 'close') };
  }

  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reopen a form', description: 'closed → published with its live version. Used by ACR-05.' })
  @ApiParam(ID)
  @ApiDataResponse(FormDetailDto)
  @ApiErrorResponses('FORM_NOT_FOUND', 'FORM_INVALID_TRANSITION')
  async reopen(@CurrentUser() auth: AuthUser, @Param('id', formId()) id: string) {
    return { data: await this.forms.close(auth, id, 'reopen') };
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Duplicate a form', description: 'A new draft "… (copy)" with slug `<slug>-copy[-n]`, the same settings and the draft (or live) schema; never the default. Used by ACR-05.' })
  @ApiParam(ID)
  @ApiDataResponse(FormDetailDto, { status: 201 })
  @ApiErrorResponses('FORM_NOT_FOUND')
  async duplicate(@CurrentUser() auth: AuthUser, @Param('id', formId()) id: string) {
    return { data: await this.forms.duplicate(auth, id) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a form',
    description: 'Soft delete (the slug is freed). Only without submissions (409 FORM_HAS_SUBMISSIONS: close it instead) and not the default form (409 FORM_DEFAULT_REQUIRED). Used by ACR-05.',
  })
  @ApiParam(ID)
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiErrorResponses('FORM_NOT_FOUND', 'FORM_HAS_SUBMISSIONS', 'FORM_DEFAULT_REQUIRED')
  async remove(@CurrentUser() auth: AuthUser, @Param('id', formId()) id: string) {
    await this.forms.remove(auth, id);
  }

  @Get(':id/versions/:versionId')
  @ApiOperation({ summary: 'Get a published version', description: 'The immutable schema of one version. Used by ACR-06 (versions), ACR-02.' })
  @ApiParam(ID)
  @ApiParam({ name: 'versionId', format: 'uuid' })
  @ApiDataResponse(FormVersionDto)
  @ApiErrorResponses('FORM_NOT_FOUND', 'FORM_VERSION_NOT_FOUND')
  async version(@Param('id', formId()) id: string, @Param('versionId', uuidParam('FORM_VERSION_NOT_FOUND')) versionId: string) {
    return { data: await this.forms.version(id, versionId) };
  }
}
