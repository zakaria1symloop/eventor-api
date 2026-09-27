import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { AppException } from '../common/errors/app.exception.js';
import { ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { MailService } from '../mail/mail.service.js';
import { QueueService } from '../queue/queue.service.js';

class LiveResponseDto {
  @ApiProperty({ example: 'ok' })
  status: 'ok';
}

class ReadyResponseDto {
  @ApiProperty({ example: 'ok' })
  status: 'ok';

  @ApiProperty({ example: 'up' })
  database: 'up';

  @ApiProperty({ example: 'inline', enum: ['bullmq', 'inline'] })
  queue: string;

  @ApiProperty({
    example: 'smtp',
    enum: ['smtp', 'console'],
    description: '`smtp` when outgoing mail is configured; `console` means emails only reach the server log — codes and invoices are not delivered.',
  })
  mail: 'smtp' | 'console';
}

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly queue: QueueService,
    private readonly mail: MailService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness (alias)', description: 'Public. An alias of `GET /health/live`, so `GET {API_URL}/api/v1/health` answers 200 instead of 404.' })
  @ApiOkResponse({ type: LiveResponseDto })
  root(): LiveResponseDto {
    return this.live();
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness', description: 'Public. The process is running.' })
  @ApiOkResponse({ type: LiveResponseDto })
  live(): LiveResponseDto {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness', description: 'Public. The database answers; `queue` and `mail` say which drivers are configured (`mail: "console"` means no SMTP — no email leaves the server).' })
  @ApiOkResponse({ type: ReadyResponseDto })
  @ApiErrorResponses('SERVICE_UNAVAILABLE')
  async ready(): Promise<ReadyResponseDto> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw AppException.of('SERVICE_UNAVAILABLE');
    }
    return { status: 'ok', database: 'up', queue: this.queue.driver, mail: this.mail.driver };
  }
}
