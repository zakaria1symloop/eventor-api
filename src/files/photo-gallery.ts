import { ApiProperty } from '@nestjs/swagger';
import type { EntityManager } from 'typeorm';
import { FilePurpose, FileProcessingStatus, FileVariantKind } from '../common/enums/file.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import type { AfterCommit } from '../database/transaction.js';
import type { FilesService } from './files.service.js';

export interface UploadedPhotoFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

export class PhotoDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) fileId: string;
  @ApiProperty({ example: 0, description: '0 = cover.' }) position: number;
  @ApiProperty({ example: true }) isCover: boolean;
  @ApiProperty({ description: 'Signed, expiring URL of the compressed WebP image.' }) url: string;
  @ApiProperty({ description: 'Signed URL of the 320 px variant.' }) thumbUrl: string;
  @ApiProperty({ description: 'Signed URL of the 800 px variant.' }) mediumUrl: string;
  @ApiProperty({ type: Number, nullable: true, example: 1920 }) width: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 1280 }) height: number | null;
  @ApiProperty({ enum: FileProcessingStatus, description: 'Variants exist once `ready`.' }) processingStatus: FileProcessingStatus;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

interface GalleryTable {
  table: 'service_photos' | 'pack_photos';
  ownerColumn: 'service_id' | 'pack_id';
  purpose: FilePurpose.ServicePhoto | FilePurpose.PackPhoto;
}

export const SERVICE_GALLERY: GalleryTable = { table: 'service_photos', ownerColumn: 'service_id', purpose: FilePurpose.ServicePhoto };
export const PACK_GALLERY: GalleryTable = { table: 'pack_photos', ownerColumn: 'pack_id', purpose: FilePurpose.PackPhoto };

interface PhotoRow {
  id: string;
  owner_id: string;
  file_id: string;
  position: number;
  width: number | null;
  height: number | null;
  processing_status: FileProcessingStatus;
  created_at: Date;
}

/**
 * Ordered photos of a service or a pack (position 0 = cover). Files go through
 * FilesService (type/size from settings, WebP pipeline as a job after commit).
 */
export class PhotoGallery {
  constructor(
    private readonly files: FilesService,
    private readonly config: GalleryTable,
  ) {}

  async rows(em: EntityManager, ownerIds: string[]): Promise<PhotoRow[]> {
    if (ownerIds.length === 0) return [];
    const { table, ownerColumn } = this.config;
    return em.query(
      `SELECT ph.id, ph.${ownerColumn} AS owner_id, ph.file_id, ph.position, f.width, f.height, f.processing_status, ph.created_at
       FROM ${table} ph JOIN files f ON f.id = ph.file_id
       WHERE ph.${ownerColumn} IN (?) ORDER BY ph.position, ph.created_at, ph.id`,
      [ownerIds],
    );
  }

  async list(em: EntityManager, ownerId: string): Promise<PhotoDto[]> {
    return (await this.rows(em, [ownerId])).map((row) => this.toDto(row));
  }

  /** Cover file id per owner (lowest position). */
  async covers(em: EntityManager, ownerIds: string[]): Promise<Map<string, string>> {
    const covers = new Map<string, string>();
    for (const row of await this.rows(em, ownerIds)) if (!covers.has(row.owner_id)) covers.set(row.owner_id, row.file_id);
    return covers;
  }

  async count(em: EntityManager, ownerId: string): Promise<number> {
    const [row] = await em.query(`SELECT COUNT(*) AS n FROM ${this.config.table} WHERE ${this.config.ownerColumn} = ?`, [ownerId]);
    return Number(row.n);
  }

  coverUrl(fileId: string | null | undefined): string | null {
    return fileId ? this.files.signedUrl(fileId, { variant: FileVariantKind.Thumb }) : null;
  }

  toDto(row: PhotoRow): PhotoDto {
    return {
      id: row.id,
      fileId: row.file_id,
      position: Number(row.position),
      isCover: Number(row.position) === 0,
      url: this.files.signedUrl(row.file_id),
      thumbUrl: this.files.signedUrl(row.file_id, { variant: FileVariantKind.Thumb }),
      mediumUrl: this.files.signedUrl(row.file_id, { variant: FileVariantKind.Medium }),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      processingStatus: row.processing_status,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  /** Appends a photo; refuses past `max` with 422 PHOTO_LIMIT_REACHED. The owner row must already be locked. */
  async add(em: EntityManager, afterCommit: AfterCommit, ownerId: string, file: UploadedPhotoFile, max: number, uploaderId: string | null): Promise<string> {
    const { table, ownerColumn } = this.config;
    const [row] = await em.query(`SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS maxPosition FROM ${table} WHERE ${ownerColumn} = ?`, [ownerId]);
    if (Number(row.n) >= max) throw AppException.of('PHOTO_LIMIT_REACHED', { max, count: Number(row.n) });
    const stored = await this.files.store({ buffer: file.buffer, originalName: file.originalname, purpose: this.config.purpose, ownerId: uploaderId }, { em, afterCommit });
    await em.query(`INSERT INTO ${table} (id, created_at, ${ownerColumn}, file_id, position) VALUES (UUID(), ?, ?, ?, ?)`, [
      new Date(),
      ownerId,
      stored.id,
      Number(row.maxPosition) + 1,
    ]);
    return stored.id;
  }

  /** `ids` must list every photo exactly once; the first becomes the cover. */
  async reorder(em: EntityManager, ownerId: string, ids: string[]): Promise<void> {
    const current = await this.rows(em, [ownerId]);
    const known = new Set(current.map((p) => p.id));
    if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
      throw AppException.of('PHOTO_ORDER_INVALID', { expected: current.length });
    }
    for (const [position, id] of ids.entries()) {
      await em.query(`UPDATE ${this.config.table} SET position = ? WHERE id = ?`, [position, id]);
    }
  }

  /** Removes a photo, renumbers the rest and soft-deletes the file when nothing else uses it. */
  async remove(em: EntityManager, ownerId: string, photoId: string): Promise<{ fileId: string }> {
    const { table, ownerColumn } = this.config;
    const [photo] = await em.query(`SELECT id, file_id FROM ${table} WHERE id = ? AND ${ownerColumn} = ? FOR UPDATE`, [photoId, ownerId]);
    if (!photo) throw AppException.of('PHOTO_NOT_FOUND');
    await em.query(`DELETE FROM ${table} WHERE id = ?`, [photoId]);
    const rest = await this.rows(em, [ownerId]);
    for (const [position, row] of rest.entries()) {
      if (Number(row.position) !== position) await em.query(`UPDATE ${table} SET position = ? WHERE id = ?`, [position, row.id]);
    }
    const [[inServices], [inPacks]] = await Promise.all([
      em.query('SELECT COUNT(*) AS n FROM service_photos WHERE file_id = ?', [photo.file_id]),
      em.query('SELECT COUNT(*) AS n FROM pack_photos WHERE file_id = ?', [photo.file_id]),
    ]);
    if (Number(inServices.n) + Number(inPacks.n) === 0) {
      await em.query('UPDATE files SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [new Date(), photo.file_id]);
    }
    return { fileId: photo.file_id };
  }
}
