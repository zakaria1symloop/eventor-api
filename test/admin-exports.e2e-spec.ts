import ExcelJS from 'exceljs';
import request from 'supertest';
import { IsOptional, IsString } from 'class-validator';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { Export } from '../src/admin/entities/export.entity.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { ExportRegistry } from '../src/exports/export-registry.js';
import { EXPORT_SYNC_MAX_ROWS } from '../src/exports/exports.service.js';
import { MailService } from '../src/mail/mail.service.js';
import { createApp, expectError, loginAs, makeCategory, uid, type LoggedIn, type TestApp } from './utils/index.js';

const BASE = '/api/v1/admin/exports';
const MISSING = '00000000-0000-4000-8000-000000000000';

class BigFilters {
  @IsOptional()
  @IsString()
  label?: string;
}

/** Downloads a signed file URL through the app (it points at API_URL). */
function download(t: TestApp, fileUrl: string) {
  const { pathname, search } = new URL(fileUrl);
  return request(t.http)
    .get(pathname + search)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

describe('Admin exports (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;
  let tag: string;

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin);
    tag = uid();
    await makeCategory(t.dataSource, { nameEn: `Export ${tag} A`, nameAr: `تصدير ${tag}`, isVisible: true });
    await makeCategory(t.dataSource, { nameEn: `Export ${tag} B`, nameAr: `=cmd ${tag}`, isVisible: false });
    // A resource that reports many rows, to exercise the queued path without inserting 5,000 rows.
    t.get(ExportRegistry).register<BigFilters, { n: number }>({
      resource: `test-big-${tag}`,
      screens: 'TEST',
      filters: BigFilters,
      columns: [{ key: 'n', header: 'N', value: (r) => r.n }],
      count: async () => EXPORT_SYNC_MAX_ROWS,
      fetch: async (_filters, page) => (page.offset === 0 ? [{ n: 1 }, { n: 2 }, { n: 3 }] : []),
    });
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('GET /admin/exports/resources', () => {
    it('lists the registered resources with columns', async () => {
      const res = await request(t.http).get(`${BASE}/resources`).set(admin.headers).expect(200);
      const resources = res.body.data.map((r: any) => r.resource);
      expect(resources).toEqual(expect.arrayContaining(['activity-log', 'categories', 'wilayas']));
      const categories = res.body.data.find((r: any) => r.resource === 'categories');
      expect(categories.columns).toEqual(expect.arrayContaining([{ key: 'nameEn', header: 'Name (EN)', isDefault: true }]));
    });

    it('401 / 403', async () => {
      expectError(await request(t.http).get(`${BASE}/resources`), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).get(`${BASE}/resources`).set(client.headers), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('POST /admin/exports', () => {
    it('generates a small CSV synchronously with the list filters and a signed URL', async () => {
      const res = await request(t.http)
        .post(BASE)
        .set(admin.headers)
        .send({ resource: 'categories', filters: { q: `Export ${tag}` }, columns: ['nameEn', 'nameAr', 'isVisible'], format: 'csv' })
        .expect(201);
      expect(res.body.data).toMatchObject({ resource: 'categories', format: 'csv', status: 'done', rowCount: 2, error: null, emailedAt: null });
      expect(res.body.data.fileUrl).toMatch(/\/api\/v1\/files\/[0-9a-f-]{36}\?exp=\d+&sig=/);

      const file = await download(t, res.body.data.fileUrl).expect(200);
      const text = (file.body as Buffer).toString('utf8');
      expect(text).toBe(`\uFEFFName (EN),Name (AR),Shown in app\r\nExport ${tag} A,تصدير ${tag},yes\r\nExport ${tag} B,'=cmd ${tag},no\r\n`);

      expect(await t.dataSource.getRepository(AuditLog).existsBy({ action: 'export.requested', objectId: res.body.data.id })).toBe(true);
    });

    it('writes XLSX with default columns and tab filter', async () => {
      const res = await request(t.http)
        .post(BASE)
        .set(admin.headers)
        .send({ resource: 'categories', filters: { q: `Export ${tag}`, tab: 'hidden' }, format: 'xlsx' })
        .expect(201);
      expect(res.body.data).toMatchObject({ status: 'done', rowCount: 1 });
      const file = await download(t, res.body.data.fileUrl).expect(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(file.body as unknown as ArrayBuffer);
      const sheet = workbook.worksheets[0]!;
      expect(sheet.getRow(1).values).toEqual([undefined, 'Position', 'Slug', 'Name (EN)', 'Name (AR)', 'Shown in app', 'Services', 'Providers', 'Bookings (30 days)']);
      expect(sheet.getRow(2).getCell(3).value).toBe(`Export ${tag} B`);
    });

    it('exports wilayas and the activity log', async () => {
      const wilayas = await request(t.http).post(BASE).set(admin.headers).send({ resource: 'wilayas', filters: { q: 'Alger' }, format: 'csv' }).expect(201);
      expect(wilayas.body.data).toMatchObject({ status: 'done', rowCount: 1 });
      const log = await request(t.http)
        .post(BASE)
        .set(admin.headers)
        .send({ resource: 'activity-log', filters: { actorId: admin.user.id, action: ['export.requested'] }, format: 'csv' })
        .expect(201);
      expect(log.body.data.status).toBe('done');
      expect(log.body.data.rowCount).toBeGreaterThanOrEqual(3);
    });

    it(`queues from ${EXPORT_SYNC_MAX_ROWS} rows and emails a link when done`, async () => {
      const mail = t.get(MailService);
      const res = await request(t.http).post(BASE).set(admin.headers).send({ resource: `test-big-${tag}`, format: 'csv' }).expect(201);
      // The response describes the export as created; the inline queue has already run it by now.
      const row = await t.dataSource.getRepository(Export).findOneByOrFail({ id: res.body.data.id });
      expect(row).toMatchObject({ status: 'done', rowCount: 3 });
      expect(row.emailedAt).not.toBeNull();
      expect(mail.outbox.some((m) => m.to === admin.user.email && m.subject === 'Your export is ready')).toBe(true);

      const status = await request(t.http).get(`${BASE}/${row.id}`).set(admin.headers).expect(200);
      expect(status.body.data).toMatchObject({ status: 'done', fileUrl: expect.any(String) });
    });

    it('400 for unknown resource, filters, columns, format and fields', async () => {
      const res = await request(t.http)
        .post(BASE)
        .set(admin.headers)
        .send({ resource: 'categories', filters: { tab: 'gone', nope: 1 }, columns: ['nameEn', 'secret'], format: 'csv' });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(res.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['filters.tab', 'filters.nope', 'columns']));

      const unknown = await request(t.http).post(BASE).set(admin.headers).send({ resource: 'nothing', format: 'csv' });
      expectError(unknown, 400, 'VALIDATION_FAILED');
      expect(unknown.body.details[0].field).toBe('resource');

      const shape = await request(t.http).post(BASE).set(admin.headers).send({ format: 'pdf', extra: true });
      expect(shape.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['resource', 'format', 'extra']));
    });

    it('401 / 403 / Arabic', async () => {
      expectError(await request(t.http).post(BASE).send({ resource: 'categories', format: 'csv' }), 401, 'AUTH_TOKEN_MISSING');
      const provider = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).post(BASE).set(provider.headers).send({ resource: 'categories', format: 'csv' }), 403, 'FORBIDDEN_ROLE');
      const ar = await request(t.http).post(BASE).set(admin.headers).set('Accept-Language', 'ar').send({});
      expect(ar.body.message).toBe('بعض الحقول غير صالحة.');
    });
  });

  describe('GET /admin/exports/:id', () => {
    it('404 for another admin export, an unknown or a malformed id', async () => {
      const mine = await request(t.http).post(BASE).set(admin.headers).send({ resource: 'wilayas', format: 'csv' }).expect(201);
      const other = await loginAs(t, UserRole.Admin);
      expectError(await request(t.http).get(`${BASE}/${mine.body.data.id}`).set(other.headers), 404, 'EXPORT_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/${MISSING}`).set(admin.headers), 404, 'EXPORT_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/abc`).set(admin.headers), 404, 'EXPORT_NOT_FOUND');
    });

    it('401', async () => {
      expectError(await request(t.http).get(`${BASE}/${MISSING}`), 401, 'AUTH_TOKEN_MISSING');
    });
  });
});
