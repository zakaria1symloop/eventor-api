import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DataSource } from 'typeorm';
import { Export } from '../admin/entities/export.entity.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditLevel, ExportFormat, ExportStatus } from '../common/enums/admin.enums.js';
import { FilePurpose } from '../common/enums/file.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { flattenValidationErrors, type FieldError } from '../common/errors/validation.js';
import { isLang } from '../common/i18n/language.js';
import { runInTransaction } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { MailService } from '../mail/mail.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { JOBS } from '../queue/jobs.js';
import { QueueService } from '../queue/queue.service.js';
import { User } from '../users/entities/user.entity.js';
import type { CreateExportDto, ExportDto, ExportResourceDto } from './dto/exports.dto.js';
import { ExportRegistry, type ExportCell, type ExportDefinition } from './export-registry.js';
import { CSV_MIME, toCsv, toXlsx, XLSX_MIME } from './export-writers.js';

/** Below this many rows the file is generated during the request (STA-05). */
export const EXPORT_SYNC_MAX_ROWS = 5_000;
/** Rows read per query while generating. */
export const EXPORT_BATCH_SIZE = 1_000;
/** Hard cap per file. */
export const EXPORT_MAX_ROWS = 200_000;
/** Validity of the download link sent by email. */
export const EXPORT_EMAIL_LINK_DAYS = 7;

interface GenerateExportJob {
  exportId: string;
}

@Injectable()
export class ExportsService implements OnModuleInit {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: ExportRegistry,
    private readonly files: FilesService,
    private readonly queue: QueueService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.queue.registerHandler<GenerateExportJob>(JOBS.generateExport, ({ exportId }) => this.runQueued(exportId));
  }

  resources(): ExportResourceDto[] {
    return this.registry.list().map((def) => {
      const defaults = new Set(def.defaultColumns ?? def.columns.map((c) => c.key));
      return {
        resource: def.resource,
        screens: def.screens,
        columns: def.columns.map((c) => ({ key: c.key, header: c.header, isDefault: defaults.has(c.key) })),
      };
    });
  }

  async create(auth: AuthUser, dto: CreateExportDto): Promise<ExportDto> {
    const def = this.registry.get(dto.resource);
    const errors: FieldError[] = [];
    if (!def) {
      errors.push({
        field: 'resource',
        code: 'IS_IN',
        message: `resource must be one of: ${this.registry.list().map((d) => d.resource).join(', ')}`,
      });
      throw new AppException(400, 'VALIDATION_FAILED', errors);
    }
    const rawFilters = dto.filters ?? {};
    const filters = plainToInstance(def.filters, rawFilters) as object;
    errors.push(
      ...flattenValidationErrors(
        await validate(filters, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: false }),
        'filters',
      ),
    );
    const known = new Set(def.columns.map((c) => c.key));
    const columns = dto.columns ? [...new Set(dto.columns)] : (def.defaultColumns ?? def.columns.map((c) => c.key));
    columns
      .filter((key) => !known.has(key))
      .forEach((key) => errors.push({ field: 'columns', code: 'IS_IN', message: `Unknown column "${key}" for ${def.resource}` }));
    if (errors.length > 0) throw new AppException(400, 'VALIDATION_FAILED', errors);

    const estimate = await def.count(filters);
    const queued = estimate >= EXPORT_SYNC_MAX_ROWS;

    const row = await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const repository = em.getRepository(Export);
      const saved = await repository.save(
        repository.create({
          requestedById: auth.id,
          resource: def.resource,
          filters: rawFilters,
          columns,
          format: dto.format,
          status: ExportStatus.Queued,
          rowCount: null,
          fileId: null,
          emailedAt: null,
          error: null,
        }),
      );
      await this.audit.log(
        {
          action: 'export.requested',
          objectType: 'export',
          objectId: saved.id,
          objectLabel: `${def.resource} (${dto.format})`,
          level: AuditLevel.Info,
          changes: { resource: def.resource, format: dto.format, filters: rawFilters, columns, estimatedRows: estimate },
        },
        em,
      );
      if (queued) {
        afterCommit(() => this.queue.add<GenerateExportJob>(JOBS.generateExport, { exportId: saved.id }, { attempts: 1, jobId: saved.id }));
      }
      return saved;
    });

    if (!queued) {
      await this.generate(row.id);
    }
    return this.get(auth, row.id);
  }

  async get(auth: AuthUser, id: string): Promise<ExportDto> {
    const row = await this.dataSource.getRepository(Export).findOneBy({ id, requestedById: auth.id });
    if (!row) throw AppException.of('EXPORT_NOT_FOUND');
    return this.toDto(row);
  }

  private toDto(row: Export): ExportDto {
    return {
      id: row.id,
      resource: row.resource,
      format: row.format,
      status: row.status,
      filters: row.filters,
      columns: row.columns,
      rowCount: row.rowCount,
      fileUrl: row.status === ExportStatus.Done && row.fileId ? this.files.signedUrl(row.fileId) : null,
      emailedAt: row.emailedAt ? row.emailedAt.toISOString() : null,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Builds the file for an export row. Idempotent: finished exports are left alone. */
  async generate(exportId: string): Promise<Export | null> {
    const repository = this.dataSource.getRepository(Export);
    const row = await repository.findOneBy({ id: exportId });
    if (!row || row.status === ExportStatus.Done || row.status === ExportStatus.Failed) return null;
    const def = this.registry.get(row.resource);

    await repository.update(row.id, { status: ExportStatus.Running });
    try {
      if (!def) throw new Error(`No export registered for "${row.resource}"`);
      const { buffer, rowCount } = await this.build(def, row);
      const extension = row.format === ExportFormat.Xlsx ? 'xlsx' : 'csv';
      const stamp = new Date().toISOString().slice(0, 10);
      const file = await this.files.store({
        buffer,
        originalName: `eventor-${row.resource}-${stamp}.${extension}`,
        purpose: FilePurpose.Export,
        ownerId: row.requestedById,
        mimeType: row.format === ExportFormat.Xlsx ? XLSX_MIME : CSV_MIME,
      });
      await repository.update(row.id, { status: ExportStatus.Done, fileId: file.id, rowCount, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Export ${row.id} (${row.resource}) failed: ${message}`, error instanceof Error ? error.stack : undefined);
      await repository.update(row.id, { status: ExportStatus.Failed, error: message.slice(0, 1000) });
    }
    return repository.findOneBy({ id: row.id });
  }

  private async build(def: ExportDefinition, row: Export): Promise<{ buffer: Buffer; rowCount: number }> {
    const filters = plainToInstance(def.filters, row.filters) as object;
    const columns = row.columns.map((key) => def.columns.find((c) => c.key === key)).filter((c) => !!c);
    const cells: ExportCell[][] = [];
    for (let offset = 0; offset < EXPORT_MAX_ROWS; offset += EXPORT_BATCH_SIZE) {
      const batch = await def.fetch(filters, { offset, limit: EXPORT_BATCH_SIZE });
      for (const item of batch) cells.push(columns.map((column) => column.value(item)));
      if (batch.length < EXPORT_BATCH_SIZE) break;
    }
    const headers = columns.map((c) => c.header);
    const buffer = row.format === ExportFormat.Xlsx ? await toXlsx(def.resource, headers, cells) : toCsv(headers, cells);
    return { buffer, rowCount: cells.length };
  }

  /** Queue job: generate, then email the requester a download link. */
  private async runQueued(exportId: string): Promise<void> {
    const row = await this.generate(exportId);
    if (!row || row.status !== ExportStatus.Done || !row.fileId || row.emailedAt) return;
    const user = await this.dataSource.getRepository(User).findOne({ where: { id: row.requestedById }, withDeleted: true });
    if (!user) return;
    await this.mail.enqueue({
      to: user.email,
      template: 'export-ready',
      lang: isLang(user.language) ? user.language : 'en',
      data: {
        name: user.fullName,
        resource: row.resource,
        rowCount: row.rowCount ?? 0,
        url: this.files.signedUrl(row.fileId, { ttlSeconds: EXPORT_EMAIL_LINK_DAYS * 86_400 }),
        days: EXPORT_EMAIL_LINK_DAYS,
      },
    });
    await this.dataSource.getRepository(Export).update(row.id, { emailedAt: new Date() });
    await this.notifications.notifyAdmins(
      {
        type: 'export.ready',
        en: { title: 'Export ready', body: `Your ${row.resource} export (${row.rowCount ?? 0} rows) is ready to download.` },
        ar: { title: 'التصدير جاهز', body: `تصدير ${row.resource} (${row.rowCount ?? 0} سطر) جاهز للتنزيل.` },
        data: { href: `/exports/${row.id}`, exportId: row.id, resource: row.resource },
      },
      { onlyUserIds: [row.requestedById] },
    );
  }
}
