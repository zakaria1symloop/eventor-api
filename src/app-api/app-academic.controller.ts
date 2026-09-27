import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { uuidParam } from '../common/dto/transforms.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiPaginatedResponse } from '../common/pagination/paginated.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { AppAcademicService } from './app-academic.service.js';
import { AppAcademicRequestDetailDto, AppAcademicRequestRowDto, AppAcademicRequestsQueryDto } from './dto/app-academic.dto.js';

/**
 * The signed-in account's own academic (event) requests. Requests are submitted
 * through the admin-built web form `/f/:slug` (status-rules §7) — signed-in
 * submissions link to the account via `requester_id`, and this is where the app
 * lists them ("My event requests").
 */
@ApiTags('app-me')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiHeader({ name: 'Accept-Language', required: false, description: '`en` or `ar`. Falls back to the account’s language, then `en`.' })
@ApiErrorResponses('FORBIDDEN_AUDIENCE', 'ACCOUNT_BLOCKED')
@Roles(UserRole.Client, UserRole.Provider)
@Controller('app/me/academic-requests')
export class AppAcademicController {
  constructor(private readonly academic: AppAcademicService) {}

  @Get()
  @ApiOperation({
    summary: 'My event requests',
    description:
      'The academic requests **this account** submitted through the web form while signed in (linked by `requester_id`), ' +
      'newest first. Requests sent without an account are not listed — they are followed by email.',
  })
  @ApiPaginatedResponse(AppAcademicRequestRowDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async list(@CurrentUser() auth: AuthUser, @Query() query: AppAcademicRequestsQueryDto) {
    return this.academic.list(auth, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One of my event requests',
    description:
      'The request with its answers rendered through the **form version it was submitted with** (immutable, status-rules §7), ' +
      'so the app can show exactly what was sent. Somebody else’s request answers 404 — the API does not confirm it exists.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(AppAcademicRequestDetailDto)
  @ApiErrorResponses('ACADEMIC_REQUEST_NOT_FOUND')
  async detail(@CurrentUser() auth: AuthUser, @Param('id', uuidParam('ACADEMIC_REQUEST_NOT_FOUND')) id: string) {
    return { data: await this.academic.detail(auth, id) };
  }
}
