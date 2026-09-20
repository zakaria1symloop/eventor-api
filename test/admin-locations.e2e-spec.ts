import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { Commune } from '../src/catalog/entities/commune.entity.js';
import { Wilaya } from '../src/catalog/entities/wilaya.entity.js';
import { ServiceStatus } from '../src/common/enums/catalog.enums.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { ServiceWilaya } from '../src/services/entities/service-wilaya.entity.js';
import { ProviderWilaya } from '../src/users/entities/provider-wilaya.entity.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeCommune,
  makeProvider,
  makeService,
  makeUser,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const API = '/api/v1/admin';
const MISSING = '00000000-0000-4000-8000-000000000000';
/** Wilayas this suite changes; restored afterwards (other suites share the database). */
const ILLIZI = 33;
const DJANET = 56;

describe('Admin wilayas & communes (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin);
  });

  afterAll(async () => {
    await t.dataSource.query('UPDATE wilayas SET is_open = 1, name = ?, name_ar = ? WHERE code = ?', ['Illizi', 'إليزي', ILLIZI]);
    await t.dataSource.query('UPDATE wilayas SET is_open = 1 WHERE code = ?', [DJANET]);
    await t?.close();
  });

  const audited = (action: string, objectId: string) => t.dataSource.getRepository(AuditLog).findOneBy({ action, objectId });

  describe('GET /admin/wilayas', () => {
    beforeAll(async () => {
      const db = t.dataSource;
      await db.getRepository(Wilaya).update(DJANET, { isOpen: false });
      const { user, profile } = await makeProvider(db);
      await db.getRepository(ProviderWilaya).insert({ providerProfileId: profile.id, wilayaCode: ILLIZI });
      const published = await makeService(db, { providerId: user.id, status: ServiceStatus.Published });
      const draft = await makeService(db, { providerId: user.id, status: ServiceStatus.Draft });
      await db.getRepository(ServiceWilaya).insert([
        { serviceId: published.id, wilayaCode: ILLIZI },
        { serviceId: draft.id, wilayaCode: ILLIZI },
      ]);
      await makeUser(db, { role: UserRole.Client, wilayaCode: ILLIZI });
      await makeCommune(db, { wilayaCode: ILLIZI });
    });

    it('lists the 58 wilayas by code with tab counters', async () => {
      const res = await request(t.http).get(`${API}/wilayas`).query({ limit: 100 }).set(admin.headers).expect(200);
      expect(res.body.meta).toMatchObject({ page: 1, limit: 100, total: 58, totalPages: 1 });
      expect(res.body.meta.counts.all).toBe(58);
      expect(res.body.meta.counts.closed).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0]).toMatchObject({ code: 1, name: 'Adrar' });
      expect(Object.keys(res.body.data[0]).sort()).toEqual(
        ['clientsCount', 'code', 'communesCount', 'isOpen', 'name', 'nameAr', 'providersCount', 'region', 'servicesCount', 'updatedAt'].sort(),
      );
      const illizi = res.body.data.find((w: any) => w.code === ILLIZI);
      expect(illizi).toMatchObject({ providersCount: 1, servicesCount: 1, clientsCount: 1 });
      expect(illizi.communesCount).toBeGreaterThanOrEqual(1);
    });

    it('filters by tab, region, q (name, Arabic, code) and sorts', async () => {
      const closed = await request(t.http).get(`${API}/wilayas`).query({ tab: 'closed' }).set(admin.headers).expect(200);
      expect(closed.body.data.map((w: any) => w.code)).toContain(DJANET);
      expect(closed.body.data.every((w: any) => !w.isOpen)).toBe(true);

      const south = await request(t.http).get(`${API}/wilayas`).query({ region: ['south'], limit: 100 }).set(admin.headers).expect(200);
      expect(south.body.data.every((w: any) => w.region === 'south')).toBe(true);
      const two = await request(t.http).get(`${API}/wilayas`).query({ region: ['south', 'highlands'], limit: 100 }).set(admin.headers).expect(200);
      expect(two.body.meta.total).toBeGreaterThan(south.body.meta.total);

      const q = async (value: string) => (await request(t.http).get(`${API}/wilayas`).query({ q: value }).set(admin.headers).expect(200)).body.data.map((w: any) => w.code);
      expect(await q('Oran')).toEqual([31]);
      expect(await q('وهران')).toEqual([31]);
      expect(await q('16')).toEqual([16]);

      const sorted = await request(t.http).get(`${API}/wilayas`).query({ sort: 'name:desc', limit: 1 }).set(admin.headers).expect(200);
      expect(sorted.body.data[0].name).toBe('Touggourt');
    });

    it('400 / 401 / 403 / Arabic', async () => {
      expectError(await request(t.http).get(`${API}/wilayas`).query({ region: 'mars' }).set(admin.headers), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(`${API}/wilayas`).query({ sort: 'region:asc' }).set(admin.headers), 400, 'SORT_FIELD_NOT_ALLOWED');
      expectError(await request(t.http).get(`${API}/wilayas`), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      const res = await request(t.http).get(`${API}/wilayas`).set(client.headers).set('Accept-Language', 'ar');
      expectError(res, 403, 'FORBIDDEN_ROLE');
      expect(res.body.message).toBe('دور حسابك لا يسمح بالوصول إلى هذا.');
    });
  });

  describe('GET /admin/wilayas/:code', () => {
    it('returns one wilaya; 404 for unknown and malformed codes', async () => {
      const res = await request(t.http).get(`${API}/wilayas/16`).set(admin.headers).expect(200);
      expect(res.body.data).toMatchObject({ code: 16, name: 'Alger', nameAr: 'الجزائر', region: 'north_centre' });
      expectError(await request(t.http).get(`${API}/wilayas/99`).set(admin.headers), 404, 'WILAYA_NOT_FOUND');
      expectError(await request(t.http).get(`${API}/wilayas/abc`).set(admin.headers), 404, 'WILAYA_NOT_FOUND');
      expectError(await request(t.http).get(`${API}/wilayas/16`), 401, 'AUTH_TOKEN_MISSING');
    });
  });

  describe('PATCH /admin/wilayas/:code', () => {
    it('409 WILAYA_CLOSE_CONFIRM_REQUIRED with counts, then closes with confirm and reopens', async () => {
      const blocked = await request(t.http).patch(`${API}/wilayas/${ILLIZI}`).set(admin.headers).send({ isOpen: false });
      expectError(blocked, 409, 'WILAYA_CLOSE_CONFIRM_REQUIRED');
      expect(blocked.body.details).toEqual({ servicesCount: 1, providersCount: 1 });
      expect((await t.dataSource.getRepository(Wilaya).findOneByOrFail({ code: ILLIZI })).isOpen).toBe(true);

      const closed = await request(t.http).patch(`${API}/wilayas/${ILLIZI}`).set(admin.headers).send({ isOpen: false, confirm: true }).expect(200);
      expect(closed.body.data.isOpen).toBe(false);
      expect((await audited('wilaya.closed', String(ILLIZI)))?.level).toBe('sensitive');

      const reopened = await request(t.http).patch(`${API}/wilayas/${ILLIZI}`).set(admin.headers).send({ isOpen: true }).expect(200);
      expect(reopened.body.data.isOpen).toBe(true);
      expect(await audited('wilaya.opened', String(ILLIZI))).not.toBeNull();
    });

    it('renames and audits', async () => {
      const res = await request(t.http).patch(`${API}/wilayas/${ILLIZI}`).set(admin.headers).send({ name: ' Illizi (test) ', nameAr: 'إليزي ت' }).expect(200);
      expect(res.body.data).toMatchObject({ name: 'Illizi (test)', nameAr: 'إليزي ت' });
      expect((await audited('wilaya.updated', String(ILLIZI)))?.changes).toMatchObject({ name: { from: 'Illizi', to: 'Illizi (test)' } });
    });

    it('400 / 404 / 401 / 403', async () => {
      expectError(await request(t.http).patch(`${API}/wilayas/16`).set(admin.headers).send({ isOpen: 'no', region: 'south' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${API}/wilayas/99`).set(admin.headers).send({ isOpen: true }), 404, 'WILAYA_NOT_FOUND');
      expectError(await request(t.http).patch(`${API}/wilayas/16`).send({}), 401, 'AUTH_TOKEN_MISSING');
      const provider = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).patch(`${API}/wilayas/16`).set(provider.headers).send({}), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('communes', () => {
    let tag: string;

    beforeAll(() => {
      tag = uid();
    });

    it('GET /admin/wilayas/:code/communes searches, sorts and paginates', async () => {
      const db = t.dataSource;
      const a = await makeCommune(db, { wilayaCode: 16, name: `Alpha ${tag}`, nameAr: `ألفا ${tag}`, postalCode: '16001' });
      const b = await makeCommune(db, { wilayaCode: 16, name: `Beta ${tag}`, nameAr: `بيتا ${tag}` });
      await makeCommune(db, { wilayaCode: 31, name: `Gamma ${tag}` });
      await makeBooking(db, { communeId: b.id });

      const res = await request(t.http).get(`${API}/wilayas/16/communes`).query({ q: tag }).set(admin.headers).expect(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
      expect(res.body.data.map((c: any) => [c.id, c.bookingsCount])).toEqual([
        [a.id, 0],
        [b.id, 1],
      ]);
      expect(Object.keys(res.body.data[0]).sort()).toEqual(['bookingsCount', 'createdAt', 'id', 'name', 'nameAr', 'postalCode', 'updatedAt', 'wilayaCode']);

      const desc = await request(t.http).get(`${API}/wilayas/16/communes`).query({ q: tag, sort: 'name:desc', limit: 1, page: 2 }).set(admin.headers).expect(200);
      expect(desc.body.data.map((c: any) => c.id)).toEqual([a.id]);
      const arabic = await request(t.http).get(`${API}/wilayas/16/communes`).query({ q: `بيتا ${tag}` }).set(admin.headers).expect(200);
      expect(arabic.body.data.map((c: any) => c.id)).toEqual([b.id]);
      const postal = await request(t.http).get(`${API}/wilayas/16/communes`).query({ q: '16001' }).set(admin.headers).expect(200);
      expect(postal.body.data.map((c: any) => c.id)).toContain(a.id);

      expectError(await request(t.http).get(`${API}/wilayas/99/communes`).set(admin.headers), 404, 'WILAYA_NOT_FOUND');
      expectError(await request(t.http).get(`${API}/wilayas/16/communes`).query({ sort: 'bookingsCount:asc' }).set(admin.headers), 400, 'SORT_FIELD_NOT_ALLOWED');
      expectError(await request(t.http).get(`${API}/wilayas/16/communes`), 401, 'AUTH_TOKEN_MISSING');
    });

    it('POST /admin/communes creates, audits, rejects duplicates (case/accent-insensitive) and restores deleted ones', async () => {
      const res = await request(t.http)
        .post(`${API}/communes`)
        .set(admin.headers)
        .send({ wilayaCode: 16, name: ` Hydra ${tag} `, nameAr: `حيدرة ${tag}`, postalCode: '16035' })
        .expect(201);
      expect(res.body.data).toMatchObject({ wilayaCode: 16, name: `Hydra ${tag}`, postalCode: '16035', bookingsCount: 0 });
      expect(await audited('commune.created', res.body.data.id)).not.toBeNull();

      const dup = await request(t.http).post(`${API}/communes`).set(admin.headers).set('Accept-Language', 'ar').send({ wilayaCode: 16, name: `HYDRÂ ${tag}`, nameAr: 'x' });
      expectError(dup, 409, 'COMMUNE_EXISTS');
      expect(dup.body.message).toBe('توجد بلدية بهذا الاسم في هذه الولاية.');
      await request(t.http).post(`${API}/communes`).set(admin.headers).send({ wilayaCode: 31, name: `Hydra ${tag}`, nameAr: 'x' }).expect(201);

      await request(t.http).delete(`${API}/communes/${res.body.data.id}`).set(admin.headers).expect(204);
      const restored = await request(t.http).post(`${API}/communes`).set(admin.headers).send({ wilayaCode: 16, name: `Hydra ${tag}`, nameAr: 'حيدرة' }).expect(201);
      expect(restored.body.data).toMatchObject({ id: res.body.data.id, nameAr: 'حيدرة', postalCode: null });
    });

    it('POST /admin/communes: 400 / 404 / 401 / 403', async () => {
      const bad = await request(t.http).post(`${API}/communes`).set(admin.headers).send({ wilayaCode: 'x', postalCode: '123', extra: 1 });
      expectError(bad, 400, 'VALIDATION_FAILED');
      expect(bad.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['wilayaCode', 'name', 'nameAr', 'postalCode', 'extra']));
      expectError(await request(t.http).post(`${API}/communes`).set(admin.headers).send({ wilayaCode: 99, name: 'X', nameAr: 'س' }), 404, 'WILAYA_NOT_FOUND');
      expectError(await request(t.http).post(`${API}/communes`).send({}), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).post(`${API}/communes`).set(client.headers).send({}), 403, 'FORBIDDEN_ROLE');
    });

    it('PATCH /admin/communes/:id updates inline, clears the postal code, and checks names', async () => {
      const db = t.dataSource;
      const commune = await makeCommune(db, { wilayaCode: 16, name: `Kouba ${tag}`, postalCode: '16050' });
      const other = await makeCommune(db, { wilayaCode: 16, name: `Other ${tag}` });
      const res = await request(t.http).patch(`${API}/communes/${commune.id}`).set(admin.headers).send({ nameAr: 'القبة', postalCode: '' }).expect(200);
      expect(res.body.data).toMatchObject({ nameAr: 'القبة', postalCode: null });
      expect((await audited('commune.updated', commune.id))?.changes).toMatchObject({ postalCode: { from: '16050', to: null } });

      expectError(await request(t.http).patch(`${API}/communes/${commune.id}`).set(admin.headers).send({ name: other.name }), 409, 'COMMUNE_EXISTS');
      // A deleted commune with the target name does not block the rename.
      await request(t.http).delete(`${API}/communes/${other.id}`).set(admin.headers).expect(204);
      await request(t.http).patch(`${API}/communes/${commune.id}`).set(admin.headers).send({ name: other.name }).expect(200);

      expectError(await request(t.http).patch(`${API}/communes/${MISSING}`).set(admin.headers).send({ nameAr: 'x' }), 404, 'COMMUNE_NOT_FOUND');
      expectError(await request(t.http).patch(`${API}/communes/nope`).set(admin.headers).send({ nameAr: 'x' }), 404, 'COMMUNE_NOT_FOUND');
      expectError(await request(t.http).patch(`${API}/communes/${commune.id}`).set(admin.headers).send({ wilayaCode: 31 }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${API}/communes/${commune.id}`).send({}), 401, 'AUTH_TOKEN_MISSING');
    });

    it('DELETE /admin/communes/:id: 204, 409 COMMUNE_IN_USE, 404', async () => {
      const db = t.dataSource;
      const free = await makeCommune(db, { wilayaCode: 16 });
      await request(t.http).delete(`${API}/communes/${free.id}`).set(admin.headers).expect(204);
      expect(await db.getRepository(Commune).findOneBy({ id: free.id })).toBeNull();
      expect(await audited('commune.deleted', free.id)).not.toBeNull();

      const used = await makeCommune(db, { wilayaCode: 16 });
      await makeBooking(db, { communeId: used.id });
      const res = await request(t.http).delete(`${API}/communes/${used.id}`).set(admin.headers);
      expectError(res, 409, 'COMMUNE_IN_USE');
      expect(res.body.details).toEqual({ bookingsCount: 1 });

      expectError(await request(t.http).delete(`${API}/communes/${free.id}`).set(admin.headers), 404, 'COMMUNE_NOT_FOUND');
      expectError(await request(t.http).delete(`${API}/communes/${used.id}`), 401, 'AUTH_TOKEN_MISSING');
    });

    describe('import', () => {
      const upload = (content: string | Buffer, filename = 'communes.csv') =>
        request(t.http)
          .post(`${API}/communes/import`)
          .set(admin.headers)
          .attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), { filename, contentType: 'text/csv' });

      it('GET template returns the CSV header', async () => {
        const res = await request(t.http).get(`${API}/communes/import/template`).set(admin.headers).expect(200);
        expect(res.headers['content-type']).toMatch(/^text\/csv/);
        expect(res.headers['content-disposition']).toContain('communes-template.csv');
        expect(res.text).toContain('wilaya_code,name,name_ar,postal_code');
        expectError(await request(t.http).get(`${API}/communes/import/template`), 401, 'AUTH_TOKEN_MISSING');
      });

      it('creates, updates, skips and reports line errors, then audits', async () => {
        const db = t.dataSource;
        await makeCommune(db, { wilayaCode: 5, name: `Same ${tag}`, nameAr: 'نفس', postalCode: '05000' });
        await makeCommune(db, { wilayaCode: 5, name: `Changed ${tag}`, nameAr: 'قديم', postalCode: '05001' });
        const csv = [
          'wilaya_code,name,name_ar,postal_code',
          `5,New ${tag},جديد,05002`,
          `5,"Same ${tag}",نفس,`,
          `5,changed ${tag},جديد,`,
          `99,Nowhere ${tag},مكان,`,
          `5,New ${tag},مكرر,`,
          '5,,,1',
        ].join('\r\n');
        const res = await upload(csv).expect(200);
        expect(res.body.data).toEqual({
          created: 1,
          updated: 1,
          skipped: 1,
          errors: [
            { line: 5, message: 'Unknown wilaya code 99' },
            { line: 6, message: 'Duplicate of line 2' },
            { line: 7, message: 'name is required; name_ar is required; postal_code must have 5 digits' },
          ],
        });
        const changed = await db.getRepository(Commune).findOneByOrFail({ wilayaCode: 5, name: `Changed ${tag}` });
        expect(changed).toMatchObject({ nameAr: 'جديد', postalCode: '05001' });
        expect(await db.getRepository(Commune).existsBy({ wilayaCode: 5, name: `New ${tag}`, postalCode: '05002' })).toBe(true);
        expect(await db.getRepository(AuditLog).existsBy({ action: 'communes.imported' })).toBe(true);
      });

      it('422 CSV_HEADER_INVALID and CSV_TOO_MANY_ROWS', async () => {
        const header = await upload('code,name\n16,x');
        expectError(header, 422, 'CSV_HEADER_INVALID');
        expect(header.body.details).toMatchObject({ received: 'code,name' });
        const rows = ['wilaya_code,name,name_ar', ...Array.from({ length: 5001 }, (_, i) => `16,C${i},ب`)].join('\n');
        expectError(await upload(rows), 422, 'CSV_TOO_MANY_ROWS');
      });

      it('400 without a file, 415 for a binary file, 413 above 2 MB', async () => {
        const none = await request(t.http).post(`${API}/communes/import`).set(admin.headers).field('x', '1');
        expectError(none, 400, 'VALIDATION_FAILED');
        expect(none.body.details[0].field).toBe('file');
        expectError(await upload(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]), 'communes.xlsx'), 415, 'FILE_TYPE_NOT_ALLOWED');
        const big = await upload(`wilaya_code,name,name_ar\n${'x'.repeat(2 * 1024 * 1024)}`);
        expectError(big, 413, 'FILE_TOO_LARGE');
        expect(big.body.details).toEqual({ maxMb: 2 });
      });

      it('401 / 403', async () => {
        expectError(await request(t.http).post(`${API}/communes/import`), 401, 'AUTH_TOKEN_MISSING');
        const client = await loginAs(t, UserRole.Client);
        expectError(await request(t.http).post(`${API}/communes/import`).set(client.headers), 403, 'FORBIDDEN_ROLE');
      });
    });
  });
});
