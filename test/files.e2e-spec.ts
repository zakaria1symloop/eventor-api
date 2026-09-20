import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { FileVariant } from '../src/files/entities/file-variant.entity.js';
import { FileProcessingStatus, FilePurpose } from '../src/common/enums/file.enums.js';
import { FILE_EVENTS } from '../src/files/files.events.js';
import { FilesService } from '../src/files/files.service.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { runInTransaction } from '../src/database/transaction.js';
import { createApp, expectError, makeUser, type TestApp } from './utils/index.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

const pathOf = (url: string) => url.replace('http://localhost:3000', '');

describe('Files (e2e)', () => {
  let t: TestApp;
  let files: FilesService;

  beforeAll(async () => {
    t = await createApp();
    files = t.get(FilesService);
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('private documents', () => {
    it('serves a document through a valid signed URL', async () => {
      const owner = await makeUser(t.dataSource);
      const file = await files.store({
        buffer: PDF,
        originalName: 'carte-identite.pdf',
        purpose: FilePurpose.Document,
        ownerId: owner.id,
      });
      expect(file).toMatchObject({ isPrivate: true, mimeType: 'application/pdf', processingStatus: 'ready' });
      expect(file.storagePath.startsWith('private/document/')).toBe(true);

      const res = await request(t.http)
        .get(pathOf(files.signedUrl(file.id)))
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['cache-control']).toBe('private, no-store');
      // The dashboard iframes PDFs: no X-Frame-Options, framing limited by CSP frame-ancestors.
      expect(res.headers['x-frame-options']).toBeUndefined();
      expect(res.headers['content-security-policy']).toMatch(/^frame-ancestors 'self'( https?:\/\/\S+)+$/);
      expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);
    });

    it('refuses a private file without a signature', async () => {
      const file = await files.store({ buffer: PDF, originalName: 'a.pdf', purpose: FilePurpose.Document });
      expectError(await request(t.http).get(`/api/v1/files/${file.id}`), 403, 'FILE_URL_INVALID');
    });

    it('refuses a tampered signature', async () => {
      const file = await files.store({ buffer: PDF, originalName: 'a.pdf', purpose: FilePurpose.Document });
      const url = pathOf(files.signedUrl(file.id)).replace(/sig=[^&]+/, 'sig=AAAA');
      expectError(await request(t.http).get(url), 403, 'FILE_URL_INVALID');
    });

    it('refuses an expired URL', async () => {
      const file = await files.store({ buffer: PDF, originalName: 'a.pdf', purpose: FilePurpose.Document });
      const url = files.signedUrl(file.id, { ttlSeconds: 60, now: Date.now() - 3_600_000 });
      expectError(await request(t.http).get(pathOf(url)), 403, 'FILE_URL_EXPIRED');
    });

    it('returns 404 FILE_NOT_FOUND for unknown ids', async () => {
      expectError(
        await request(t.http).get('/api/v1/files/00000000-0000-4000-8000-000000000000'),
        404,
        'FILE_NOT_FOUND',
      );
      expectError(await request(t.http).get('/api/v1/files/not-a-uuid'), 404, 'FILE_NOT_FOUND');
    });

    it('rejects a disguised executable with 415', async () => {
      await expect(
        files.store({ buffer: Buffer.from('MZ\x90\x00 not a pdf'), originalName: 'x.pdf', purpose: FilePurpose.Document }),
      ).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
    });

    it('rejects documents over max_document_upload_mb with 413', async () => {
      const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024 + 1)]);
      await expect(
        files.store({ buffer: big, originalName: 'big.pdf', purpose: FilePurpose.Document }),
      ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', details: { maxMb: 5 } });
    });
  });

  describe('photos', () => {
    it('runs the image pipeline through the queue and serves variants', async () => {
      const failed = vi.fn();
      t.get(EventEmitter2).on(FILE_EVENTS.processingFailed, failed);

      const jpeg = await sharp({
        create: { width: 2400, height: 1200, channels: 3, background: { r: 200, g: 40, b: 90 } },
      })
        .jpeg()
        .withMetadata({ exif: { IFD0: { Copyright: 'Eventor test' } } })
        .toBuffer();

      const stored = await files.store({
        buffer: jpeg,
        originalName: 'salle.jpg',
        purpose: FilePurpose.ServicePhoto,
      });

      // Inline queue driver: processing has finished when store() resolves.
      const [file] = await t.dataSource.query('SELECT * FROM files WHERE id = ?', [stored.id]);
      expect(failed).not.toHaveBeenCalled();
      expect(file).toMatchObject({
        processing_status: FileProcessingStatus.Ready,
        mime_type: 'image/webp',
        width: 1920,
        height: 960,
        is_private: 0,
      });
      expect(existsSync(join(files.root, stored.storagePath))).toBe(false); // original removed

      const variants = await t.dataSource.getRepository(FileVariant).find({ where: { fileId: stored.id } });
      expect(variants.map((v) => [v.variant, v.width]).sort()).toEqual([
        ['medium', 800],
        ['thumb', 320],
      ]);

      // Public photo: served without a signature, cacheable.
      const res = await request(t.http).get(`/api/v1/files/${stored.id}?variant=thumb`).expect(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toContain('public');
    });

    it('enqueues the job only after the transaction commits', async () => {
      const png = await sharp({
        create: { width: 400, height: 300, channels: 4, background: '#00aa00' },
      })
        .png()
        .toBuffer();

      const id = await runInTransaction(t.dataSource, async (em, afterCommit) => {
        const stored = await files.store(
          { buffer: png, originalName: 'pack.png', purpose: FilePurpose.PackPhoto },
          { em, afterCommit },
        );
        const [inside] = await em.query('SELECT processing_status FROM files WHERE id = ?', [stored.id]);
        expect(inside.processing_status).toBe('pending');
        return stored.id;
      });

      const [after] = await t.dataSource.query('SELECT processing_status, width FROM files WHERE id = ?', [id]);
      expect(after).toEqual({ processing_status: 'ready', width: 400 });
    });

    it('rejects an image type not in allowed_image_types', async () => {
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      await expect(
        files.store({ buffer: gif, originalName: 'x.gif', purpose: FilePurpose.Avatar }),
      ).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
    });
  });
});
