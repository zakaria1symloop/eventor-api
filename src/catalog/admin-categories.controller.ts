import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { CategoriesService } from './categories.service.js';
import {
  CATEGORY_SORT_FIELDS,
  CategoriesQueryDto,
  CategoryDto,
  CategoryPositionDto,
  CategoryTabCountsDto,
  CreateCategoryDto,
  DeleteCategoryQueryDto,
  ReorderCategoriesDto,
  UpdateCategoryDto,
} from './dto/categories.dto.js';

@ApiTags('admin-categories')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin/categories')
export class AdminCategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @ApiOperation({
    summary: 'List categories',
    description:
      `Tabs \`tab\` (all | shown | hidden) with counters in \`meta.counts\` (they follow \`q\`, not the tab); search \`q\` in EN/AR names and slug; ` +
      `sortable by ${CATEGORY_SORT_FIELDS.join(', ')} (default position:asc). Each row has servicesCount, providersCount, bookings30dCount and ` +
      'missingTranslation. Export: resource `categories`. Used by CAT-01.',
  })
  @ApiPaginatedResponse(CategoryDto, { counts: CategoryTabCountsDto })
  @ApiErrorResponses('VALIDATION_FAILED', 'SORT_FIELD_NOT_ALLOWED')
  list(@Query() query: CategoriesQueryDto) {
    return this.categories.list(query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a category',
    description: 'Added at the end of the order. The slug is generated from nameEn when omitted. Used by CAT-02.',
  })
  @ApiDataResponse(CategoryDto, { status: 201 })
  @ApiErrorResponses('VALIDATION_FAILED', 'SLUG_TAKEN')
  async create(@Body() dto: CreateCategoryDto) {
    return { data: await this.categories.create(dto) };
  }

  @Patch('order')
  @ApiOperation({
    summary: 'Reorder categories',
    description:
      'Saves a drag-and-drop order: the given ids take the position slots they already occupy, in the new order (whole list or one tab). ' +
      'Returns every given id with its position. Used by CAT-01.',
  })
  @ApiDataResponse(CategoryPositionDto, { isArray: true })
  @ApiErrorResponses('VALIDATION_FAILED', 'CATEGORY_NOT_FOUND')
  async reorder(@Body() dto: ReorderCategoriesDto) {
    return { data: await this.categories.reorder(dto.ids) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a category', description: 'One category with its counts. Used by CAT-02.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(CategoryDto)
  @ApiErrorResponses('CATEGORY_NOT_FOUND')
  async get(@Param('id', uuidParam('CATEGORY_NOT_FOUND')) id: string) {
    return { data: await this.categories.get(id) };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a category',
    description:
      'Partial update of names, descriptions, icon, slug and `isVisible` (the "Shown in app" toggle; hidden categories are not selectable ' +
      'for new services; the dashboard confirms first when `servicesCount > 0`). Used by CAT-01 and CAT-02.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(CategoryDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'CATEGORY_NOT_FOUND', 'SLUG_TAKEN')
  async update(@Param('id', uuidParam('CATEGORY_NOT_FOUND')) id: string, @Body() dto: UpdateCategoryDto) {
    return { data: await this.categories.update(id, dto) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a category',
    description:
      'Soft delete. With services or providers it returns 409 `CATEGORY_HAS_SERVICES` with `details.servicesCount` and `details.providersCount`; ' +
      'pass `?moveTo=<categoryId>` to move them there first (same transaction). The slug becomes reusable. Used by CAT-02.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'CATEGORY_NOT_FOUND', 'CATEGORY_HAS_SERVICES', 'CATEGORY_MOVE_TARGET_INVALID')
  async remove(@Param('id', uuidParam('CATEGORY_NOT_FOUND')) id: string, @Query() query: DeleteCategoryQueryDto): Promise<void> {
    await this.categories.remove(id, query.moveTo);
  }
}
