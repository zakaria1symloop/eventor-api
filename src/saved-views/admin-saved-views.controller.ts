import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { CreateSavedViewDto, SavedViewDto, SavedViewsQueryDto, UpdateSavedViewDto } from './dto/saved-views.dto.js';
import { SavedViewsService } from './saved-views.service.js';

const SCREENS = 'Used by the saved-views menu of the list screens (USR-01, BKG-01, LOG-01, and others).';

@ApiTags('admin-saved-views')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/saved-views')
export class AdminSavedViewsController {
  constructor(private readonly views: SavedViewsService) {}

  @Get()
  @ApiOperation({ summary: 'List saved views', description: `My views and views shared by other admins, sorted by name (not paginated). ${SCREENS}` })
  @ApiDataResponse(SavedViewDto, { isArray: true })
  @ApiErrorResponses('VALIDATION_FAILED')
  async list(@CurrentUser() auth: AuthUser, @Query() query: SavedViewsQueryDto) {
    return { data: await this.views.list(auth, query) };
  }

  @Post()
  @ApiOperation({ summary: 'Save a view', description: `Names are unique per admin and resource. ${SCREENS}` })
  @ApiDataResponse(SavedViewDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'SAVED_VIEW_NAME_TAKEN')
  async create(@CurrentUser() auth: AuthUser, @Body() dto: CreateSavedViewDto) {
    return { data: await this.views.create(auth, dto) };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a saved view', description: `Owner only: rename, change the query or share it. ${SCREENS}` })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(SavedViewDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'NOT_OWNER', 'SAVED_VIEW_NOT_FOUND', 'SAVED_VIEW_NAME_TAKEN')
  async update(
    @CurrentUser() auth: AuthUser,
    @Param('id', uuidParam('SAVED_VIEW_NOT_FOUND')) id: string,
    @Body() dto: UpdateSavedViewDto,
  ) {
    return { data: await this.views.update(auth, id, dto) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a saved view', description: `Owner only (soft delete). ${SCREENS}` })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiErrorResponses('NOT_OWNER', 'SAVED_VIEW_NOT_FOUND')
  async remove(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('SAVED_VIEW_NOT_FOUND')) id: string): Promise<void> {
    await this.views.remove(auth, id);
  }
}
