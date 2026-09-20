import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { UserRole } from '../common/enums/user.enums.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiAuthErrors, ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { NavCountsDto, OverviewDto, OverviewQueryDto } from './dto/overview.dto.js';
import { SearchQueryDto, SearchResultDto } from './dto/search.dto.js';
import { OverviewService } from './overview.service.js';
import { SearchService } from './search.service.js';

@ApiTags('admin-overview')
@ApiBearerAuth()
@ApiAuthErrors()
@ApiErrorResponses('AUTH_SESSION_REVOKED')
@Roles(UserRole.Admin)
@Controller('admin')
export class AdminOverviewController {
  constructor(
    private readonly overview: OverviewService,
    private readonly searchService: SearchService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Overview',
    description:
      '`range` today | 7d | 30d (default) | this_month | custom (`from`, `to` as Africa/Algiers days, at most 366 days, 422 OVERVIEW_RANGE_INVALID). Attention queue (live counters), KPIs with the ' +
      'previous period and delta (bookings created, booking value = totals of accepted + completed bookings created in the period, new clients + providers, average rating of reviews ' +
      'written), bookings per day (requests, completed), bookings by status (all time), latest bookings (last 24 h, else the latest 5) and the 8 latest activity entries with dashboard links. ' +
      'Daily figures come from `stats_daily` (nightly rollup at 01:00 Algiers) and are computed live for today and any day not rolled up yet. Cached 60 s per range. Used by OVR-01.',
  })
  @ApiDataResponse(OverviewDto)
  @ApiErrorResponses('VALIDATION_FAILED', 'OVERVIEW_RANGE_INVALID')
  async get(@Query() query: OverviewQueryDto) {
    return { data: await this.overview.overview(query) };
  }

  @Get('nav-counts')
  @ApiOperation({
    summary: 'Sidebar counters',
    description:
      'Verifications waiting, bookings without a reply, disputes open or in review, pending academic requests, reported reviews, reported messages and conversations unread by the signed-in admin. ' +
      'A few grouped queries, cached 30 s per admin. Used by the dashboard sidebar (all pages).',
  })
  @ApiDataResponse(NavCountsDto)
  async navCounts(@CurrentUser() auth: AuthUser) {
    return { data: await this.overview.navCounts(auth.id) };
  }

  @Get('search')
  @ApiOperation({
    summary: 'Global search',
    description:
      '`scope` all (default) | users | services | bookings | requests | disputes | pages, `limit` per group (1–20, default 5). Users: name, email, phone, business name (admins excluded); ' +
      'services: title EN/AR, business name; bookings: reference, client or business name, invoice number; requests: reference, title, requester, institution; disputes: reference, booking ' +
      'reference, party names; pages: static dashboard routes matched on EN/AR titles and keywords (title EN, subtitle AR). `exactMatch` for an exact EVT- / ACR- / DSP- / INV- reference ' +
      '(`#` allowed), email or phone (0XXXXXXXXX or +213 formats), opened on Enter. Recent searches are kept by the dashboard, not stored. Used by SHL-01.',
  })
  @ApiDataResponse(SearchResultDto)
  @ApiErrorResponses('VALIDATION_FAILED')
  async search(@Query() query: SearchQueryDto) {
    return { data: await this.searchService.search(query) };
  }
}
