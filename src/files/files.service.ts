import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { fileTypeFromBuffer } from 'file-type';
import type { EntityManager, Repository } from 'typeorm';
import { API_PREFIX } from '../app.setup.js';
import { AppException } from '../common/errors/app.exception.js';
import {
  FileProcessingStatus,
  FilePurpose,
  FileVariantKind,
} from '../common/enums/file.enums.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { envConfig, type Env } from '../config/env.js';
import type { AfterCommit } from '../database/transaction.js';
import { JOBS } from '../queue/jobs.js';
import { QueueService } from '../queue/queue.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { FileVariant } from './entities/file-variant.entity.js';
import { StoredFile } from './entities/stored-file.entity.js';
import { FileSigner } from './file-signer.js';
import { FILE_EVENTS, type FileProcessingEvent } from './files.events.js';
import { processImage } from './image-pipeline.js';

/** Photos: recompressed to WebP with variants, public. */
export const IMAGE_PURPOSES: ReadonlySet<FilePurpose> = new Set([
  FilePurpose.Avatar,
  FilePurpose.ServicePhoto,
  FilePurpose.PackPhoto,
]);

/** Stored as uploaded and only served through signed URLs. */
export const PRIVATE_PURPOSES: ReadonlySet<FilePurpose> = new Set([
  FilePurpose.Document,
  FilePurpose.Evidence,
  FilePurpose.Invoice,
  FilePurpose.Attachment,
  FilePurpose.Export,
  FilePurpose.Message,
]);

const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
]);

const GENERATED_PURPOSES: ReadonlySet<FilePurpose> = new Set([
  FilePurpose.Invoice,
  FilePurpose.Export,
]);

export interface StoreFileInput {
  buffer: Buffer;
  originalName: string;
  purpose: FilePurpose;
  ownerId?: string | null;
  /** Only trusted for files the API generates itself (invoices, exports). */
  mimeType?: string;
}

export interface StoreFileOptions {
  /** Save the row in the caller's transaction. */
  em?: EntityManager;
  /** With `em`: enqueue image processing only after the transaction commits. */
  afterCommit?: AfterCommit;
}

export interface FileDownload {
  stream: ReadStream;
  mimeType: string;
  sizeBytes: number;
  fileName: string;
  isPrivate: boolean;
}

interface ProcessImageJob {
  fileId: string;
}

/**
 * Stores uploads under STORAGE_ROOT (`private/` or `public/`), checks type and
 * size against settings, runs the photo pipeline as a queued job, and issues
 * signed, expiring URLs. `storage_path` is relative to STORAGE_ROOT and never
 * leaves the API.
 */
@Injectable()
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger(FilesService.name);
  private readonly signer: FileSigner;
  readonly root: string;

  constructor(
    @Inject(envConfig.KEY) private readonly env: Env,
    @InjectRepository(StoredFile) private readonly files: Repository<StoredFile>,
    @InjectRepository(FileVariant) private readonly variants: Repository<FileVariant>,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
    private readonly events: DomainEvents,
  ) {
    this.signer = new FileSigner(env.FILES_SIGNING_SECRET);
    this.root = resolve(env.STORAGE_ROOT);
  }

  onModuleInit(): void {
    this.queue.registerHandler<ProcessImageJob>(JOBS.processImage, ({ fileId }) =>
      this.processImageJob(fileId),
    );
  }

  async store(input: StoreFileInput, options: StoreFileOptions = {}): Promise<StoredFile> {
    const isImage = IMAGE_PURPOSES.has(input.purpose);
    if (isImage && options.em && !options.afterCommit) {
      // The job would run before COMMIT and not find the row.
      throw new Error('FilesService.store: pass afterCommit together with em for photos');
    }
    const isPrivate = PRIVATE_PURPOSES.has(input.purpose);
    const mimeType = await this.checkUpload(input, isImage);

    const id = randomUUID();
    const ext = extensionFor(mimeType, input.originalName);
    const relativePath = this.buildPath(isPrivate, input.purpose, id, isImage ? '.orig' : '', ext);
    await this.write(relativePath, input.buffer);

    const repository = options.em ? options.em.getRepository(StoredFile) : this.files;
    const file = repository.create({
      id,
      ownerId: input.ownerId ?? null,
      purpose: input.purpose,
      storagePath: relativePath,
      originalName: input.originalName.slice(0, 255),
      mimeType,
      sizeBytes: input.buffer.length,
      originalSizeBytes: input.buffer.length,
      width: null,
      height: null,
      processingStatus: isImage ? FileProcessingStatus.Pending : FileProcessingStatus.Ready,
      checksum: createHash('sha256').update(input.buffer).digest('hex'),
      isPrivate,
    });

    try {
      await repository.save(file);
    } catch (error) {
      await rm(this.absolute(relativePath), { force: true });
      throw error;
    }

    if (isImage) {
      const enqueue = () => this.queue.add<ProcessImageJob>(JOBS.processImage, { fileId: id });
      if (options.afterCommit) {
        options.afterCommit(enqueue);
      } else {
        await enqueue();
      }
    }
    return file;
  }

  /** Job handler: WebP main image + thumb/medium variants; the original is deleted. */
  async processImageJob(fileId: string): Promise<void> {
    const file = await this.files.findOne({ where: { id: fileId } });
    if (!file || file.processingStatus !== FileProcessingStatus.Pending) {
      return; // Already processed or deleted: jobs are idempotent.
    }

    try {
      const { photo_max_dimension_px, photo_quality } = await this.settings.getMany([
        'photo_max_dimension_px',
        'photo_quality',
      ] as const);
      const original = await readFile(this.absolute(file.storagePath));
      const result = await processImage(original, {
        maxDimension: photo_max_dimension_px,
        quality: photo_quality,
      });

      const mainPath = this.buildPath(file.isPrivate, file.purpose, file.id, '', 'webp');
      await this.write(mainPath, result.main.buffer);

      const variantRows: FileVariant[] = [];
      for (const [kind, image] of Object.entries(result.variants) as [
        FileVariantKind,
        (typeof result.variants)[FileVariantKind],
      ][]) {
        if (!image) continue;
        const path = this.buildPath(file.isPrivate, file.purpose, file.id, `_${kind}`, 'webp');
        await this.write(path, image.buffer);
        variantRows.push(
          this.variants.create({
            fileId: file.id,
            variant: kind,
            storagePath: path,
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            sizeBytes: image.sizeBytes,
          }),
        );
      }

      const originalPath = file.storagePath;
      await this.files.manager.transaction(async (em) => {
        await em.delete(FileVariant, { fileId: file.id });
        await em.save(variantRows);
        await em.update(StoredFile, file.id, {
          storagePath: mainPath,
          mimeType: result.main.mimeType,
          sizeBytes: result.main.sizeBytes,
          width: result.main.width,
          height: result.main.height,
          processingStatus: FileProcessingStatus.Ready,
        });
      });
      await rm(this.absolute(originalPath), { force: true });
      await this.events.emit<FileProcessingEvent>(FILE_EVENTS.processed, {
        fileId: file.id,
        ownerId: file.ownerId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Image ${file.id} could not be processed: ${message}`);
      await this.files.update(file.id, { processingStatus: FileProcessingStatus.Failed });
      await this.events.emit<FileProcessingEvent>(FILE_EVENTS.processingFailed, {
        fileId: file.id,
        ownerId: file.ownerId,
        error: message,
      });
      // Not rethrown: a corrupt image will not succeed on retry.
    }
  }

  /** Absolute, signed, expiring URL for a file or one of its variants. */
  signedUrl(
    fileId: string,
    options: { variant?: FileVariantKind | null; ttlSeconds?: number; now?: number } = {},
  ): string {
    const exp =
      Math.floor((options.now ?? Date.now()) / 1000) + (options.ttlSeconds ?? this.env.FILES_URL_TTL);
    const sig = this.signer.sign(fileId, options.variant, exp);
    const query = new URLSearchParams();
    if (options.variant) query.set('variant', options.variant);
    query.set('exp', String(exp));
    query.set('sig', sig);
    return `${this.env.API_URL.replace(/\/$/, '')}${API_PREFIX}/files/${fileId}?${query}`;
  }

  /**
   * Resolves a download. Private files need a valid signature; public photos
   * are served without one (the controller adds public cache headers).
   */
  async openForDownload(
    fileId: string,
    access: { variant?: FileVariantKind; exp?: number; sig?: string },
  ): Promise<FileDownload> {
    const file = await this.files.findOne({ where: { id: fileId } });
    if (!file) {
      throw AppException.of('FILE_NOT_FOUND');
    }

    const signed = access.sig !== undefined || access.exp !== undefined;
    if (file.isPrivate || signed) {
      const check = this.signer.verify(file.id, access.variant, access.exp, access.sig);
      if (check === 'invalid') throw AppException.of('FILE_URL_INVALID');
      if (check === 'expired') throw AppException.of('FILE_URL_EXPIRED');
    }
    if (file.processingStatus !== FileProcessingStatus.Ready) {
      throw AppException.of('FILE_NOT_READY');
    }

    let path = file.storagePath;
    let mimeType = file.mimeType;
    if (access.variant) {
      const variant = await this.variants.findOne({
        where: { fileId: file.id, variant: access.variant },
      });
      if (!variant) {
        throw AppException.of('FILE_NOT_FOUND');
      }
      path = variant.storagePath;
      mimeType = variant.mimeType;
    }

    const absolutePath = this.absolute(path);
    const info = await stat(absolutePath).catch(() => null);
    if (!info?.isFile()) {
      this.logger.error(`File ${file.id} is missing on disk`);
      throw AppException.of('FILE_NOT_FOUND');
    }

    return {
      stream: createReadStream(absolutePath),
      mimeType,
      sizeBytes: info.size,
      fileName: downloadName(file.originalName, mimeType),
      isPrivate: file.isPrivate,
    };
  }

  private async checkUpload(input: StoreFileInput, isImage: boolean): Promise<string> {
    const limits = await this.settings.getMany([
      'max_photo_upload_mb',
      'max_document_upload_mb',
      'allowed_image_types',
    ] as const);
    const sniffed = (await fileTypeFromBuffer(input.buffer))?.mime;

    if (GENERATED_PURPOSES.has(input.purpose)) {
      const mime = sniffed ?? input.mimeType;
      if (!mime) throw AppException.of('FILE_TYPE_NOT_ALLOWED');
      return mime;
    }

    const maxMb = isImage ? limits.max_photo_upload_mb : limits.max_document_upload_mb;
    if (input.buffer.length > maxMb * 1024 * 1024) {
      throw new AppException(413, 'FILE_TOO_LARGE', { maxMb });
    }

    const allowed = isImage
      ? new Set(limits.allowed_image_types.map((type) => normaliseImageType(type)))
      : DOCUMENT_MIME_TYPES;
    if (!sniffed || !allowed.has(sniffed)) {
      throw AppException.of('FILE_TYPE_NOT_ALLOWED');
    }
    return sniffed;
  }

  private buildPath(
    isPrivate: boolean,
    purpose: FilePurpose,
    id: string,
    suffix: string,
    ext: string,
  ): string {
    const now = new Date();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return [
      isPrivate ? 'private' : 'public',
      purpose,
      String(now.getUTCFullYear()),
      month,
      `${id}${suffix}.${ext}`,
    ].join('/');
  }

  private absolute(relativePath: string): string {
    const absolutePath = resolve(this.root, relativePath);
    const inside = relative(this.root, absolutePath);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error(`Refusing a storage path outside STORAGE_ROOT: ${relativePath}`);
    }
    return absolutePath;
  }

  private async write(relativePath: string, data: Buffer): Promise<void> {
    const absolutePath = this.absolute(relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, data);
  }
}

function normaliseImageType(type: string): string {
  const value = type.trim().toLowerCase();
  if (value.includes('/')) return value;
  return `image/${value === 'jpg' ? 'jpeg' : value}`;
}

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function extensionFor(mimeType: string, originalName: string): string {
  const fromName = extname(originalName).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '');
  return EXTENSIONS[mimeType] ?? (fromName || 'bin');
}

function downloadName(originalName: string, mimeType: string): string {
  const base = originalName.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} ._-]/gu, '_') || 'file';
  const ext = EXTENSIONS[mimeType];
  return ext ? `${base}.${ext}` : base;
}
