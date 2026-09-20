import { Controller, Get, Inject, Param, Query, Res, StreamableFile } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator.js';
import { AppException } from '../common/errors/app.exception.js';
import { ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { envConfig, type Env } from '../config/env.js';
import { FileDownloadQueryDto } from './dto/file-download-query.dto.js';
import { FilesService } from './files.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `'self'` plus the CORS allowlist; with `CORS_ORIGINS=*` only the dashboard (`ADMIN_URL`). */
export function frameAncestors(env: Pick<Env, 'CORS_ORIGINS' | 'ADMIN_URL'>): string {
  const origins =
    env.CORS_ORIGINS.trim() === '*'
      ? [env.ADMIN_URL]
      : env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  const sources = origins.map((origin) => {
    try {
      return new URL(origin).origin;
    } catch {
      return null;
    }
  });
  return ["'self'", ...new Set(sources.filter((s): s is string => !!s))].join(' ');
}

@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    @Inject(envConfig.KEY) private readonly env: Env,
  ) {}

  @Public()
  @Get(':id')
  @ApiOperation({
    summary: 'Download a file',
    description:
      'Public route (no bearer token): access is granted by the signed URL the API returns ' +
      'in resources (`exp` + `sig`). Private files (documents, evidence, invoices, ' +
      'attachments) always need a valid, unexpired signature; published photos can be ' +
      'fetched without one and are cacheable. Used by VER-02, SRV-02, BKG-03.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('application/octet-stream', 'image/webp', 'application/pdf')
  @ApiOkResponse({ description: 'The file content.' })
  @ApiErrorResponses('VALIDATION_FAILED', 'FILE_URL_INVALID', 'FILE_URL_EXPIRED', 'FILE_NOT_FOUND', 'FILE_NOT_READY')
  async download(
    @Param('id') id: string,
    @Query() query: FileDownloadQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!UUID.test(id)) {
      throw AppException.of('FILE_NOT_FOUND');
    }
    const file = await this.files.openForDownload(id, query);

    res.setHeader(
      'Cache-Control',
      file.isPrivate ? 'private, no-store' : 'public, max-age=86400, immutable',
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The dashboard (another origin) previews PDFs and photos in an iframe: allow only it as a framing ancestor.
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors(this.env)}`);

    const inline = file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf';
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      length: file.sizeBytes,
      disposition: `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }
}
