import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { Category } from '../src/catalog/entities/category.entity.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { Service } from '../src/services/entities/service.entity.js';
import { ProviderProfile } from '../src/users/entities/provider-profile.entity.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeCategory,
  makeProvider,
  makeService,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const BASE = '/api/v1/admin/categories';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('Admin categories (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin);
  });

  afterAll(async () => {
    await t?.close();
  });

  const audited = (action: string, objectId: string) => t.dataSource.getRepository(AuditLog).findOneBy({ action, objectId });

  describe('GET /admin/categories', () => {
    let tag: string;
    let photo: Category;
    let decor: Category;
    let hidden: Category;

    beforeAll(async () => {
      tag = uid();
      const db = t.dataSource;
      photo = await makeCategory(db, { nameEn: `Photo ${tag}`, nameAr: `تصوير ${tag}`, position: 1000 });
      decor = await makeCategory(db, { nameEn: `Decor ${tag}`, nameAr: `ديكور ${tag}`, position: 999, descriptionEn: 'Only EN' });
      hidden = await makeCategory(db, { nameEn: `Hidden ${tag}`, nameAr: `مخفي ${tag}`, position: 1001, isVisible: false });

      const { user: provider } = await makeProvider(db, { profile: { categoryId: photo.id } });
      const service = await makeService(db, { providerId: provider.id, categoryId: photo.id });
      await makeService(db, { providerId: provider.id, categoryId: photo.id });
      await makeBooking(db, { serviceId: service.id, providerId: provider.id });
      const old = await makeBooking(db, { serviceId: service.id, providerId: provider.id });
      await db.query('UPDATE bookings SET created_at = ? WHERE id = ?', [new Date(Date.now() - 40 * 86_400_000), old.id]);
    });

    it('lists by position with counts, flags and tab counters', async () => {
      const res = await request(t.http).get(BASE).query({ q: tag }).set(admin.headers).expect(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1, counts: { all: 3, shown: 2, hidden: 1 } });
      expect(res.body.data.map((c: any) => c.id)).toEqual([decor.id, photo.id, hidden.id]);
      const row = res.body.data[1];
      expect(Object.keys(row).sort()).toEqual(
        [
          'bookings30dCount',
          'createdAt',
          'descriptionAr',
          'descriptionEn',
          'icon',
          'id',
          'isVisible',
          'missingTranslation',
          'nameAr',
          'nameEn',
          'position',
          'providersCount',
          'servicesCount',
          'slug',
          'updatedAt',
        ].sort(),
      );
      // makeService creates its own provider profile in a random category, so only the explicit one counts here.
      expect(row).toMatchObject({ servicesCount: 2, providersCount: 1, bookings30dCount: 1, missingTranslation: false });
      expect(res.body.data[0].missingTranslation).toBe(true);
    });

    it('filters by tab, searches Arabic names, sorts and paginates', async () => {
      const shown = await request(t.http).get(BASE).query({ q: tag, tab: 'hidden' }).set(admin.headers).expect(200);
      expect(shown.body.data.map((c: any) => c.id)).toEqual([hidden.id]);
      expect(shown.body.meta.counts).toEqual({ all: 3, shown: 2, hidden: 1 });

      const arabic = await request(t.http).get(BASE).query({ q: `ديكور ${tag}` }).set(admin.headers).expect(200);
      expect(arabic.body.data.map((c: any) => c.id)).toEqual([decor.id]);

      const byName = await request(t.http).get(BASE).query({ q: tag, sort: 'nameEn:desc', limit: 2, page: 1 }).set(admin.headers).expect(200);
      expect(byName.body.data.map((c: any) => c.id)).toEqual([photo.id, hidden.id]);
      expect(byName.body.meta).toMatchObject({ total: 3, totalPages: 2 });
    });

    it('400 for a bad tab, sort field or unknown parameter; Arabic message', async () => {
      expectError(await request(t.http).get(BASE).query({ tab: 'nope', foo: 1 }).set(admin.headers), 400, 'VALIDATION_FAILED');
      const sort = await request(t.http).get(BASE).query({ sort: 'servicesCount:asc' }).set(admin.headers).set('Accept-Language', 'ar');
      expectError(sort, 400, 'SORT_FIELD_NOT_ALLOWED');
      expect(sort.body.message).toBe('لا يمكن الترتيب حسب "servicesCount".');
    });

    it('401 / 403', async () => {
      expectError(await request(t.http).get(BASE), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).get(BASE).set(client.headers), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('POST /admin/categories', () => {
    it('creates at the end of the order with a generated slug, and audits', async () => {
      const tag = uid();
      const res = await request(t.http)
        .post(BASE)
        .set(admin.headers)
        .send({ nameEn: `  Salles des fêtes ${tag} `, nameAr: `قاعات ${tag}`, icon: 'building', descriptionEn: '', descriptionAr: null })
        .expect(201);
      expect(res.body.data).toMatchObject({
        slug: `salles-des-fetes-${tag}`,
        nameEn: `Salles des fêtes ${tag}`,
        descriptionEn: null,
        isVisible: true,
        servicesCount: 0,
        missingTranslation: false,
      });
      const [{ max }] = await t.dataSource.query('SELECT MAX(position) AS max FROM categories');
      expect(res.body.data.position).toBe(Number(max));
      expect(await audited('category.created', res.body.data.id)).not.toBeNull();

      const again = await request(t.http).post(BASE).set(admin.headers).send({ nameEn: `Salles des fêtes ${tag}`, nameAr: 'x', icon: 'building' }).expect(201);
      expect(again.body.data.slug).toBe(`salles-des-fetes-${tag}-2`);
    });

    it('409 SLUG_TAKEN for an explicit slug in use', async () => {
      const existing = await makeCategory(t.dataSource);
      const res = await request(t.http).post(BASE).set(admin.headers).send({ slug: existing.slug, nameEn: 'X', nameAr: 'س', icon: 'star' });
      expectError(res, 409, 'SLUG_TAKEN');
    });

    it('400 for missing, malformed and unknown fields, and when both names are empty', async () => {
      const res = await request(t.http).post(BASE).set(admin.headers).send({ slug: 'Not A Slug', icon: 'Bad Icon', isVisible: 'yes', color: 'red' });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(res.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['slug', 'nameEn', 'nameAr', 'icon', 'isVisible', 'color']));
      const noName = await request(t.http).post(BASE).set(admin.headers).send({ nameEn: ' ', nameAr: '', icon: 'star' });
      expectError(noName, 400, 'VALIDATION_FAILED');
      expect(noName.body.details.map((d: any) => d.field)).toEqual(['nameEn', 'nameAr']);
    });

    it('401 / 403', async () => {
      expectError(await request(t.http).post(BASE).send({}), 401, 'AUTH_TOKEN_MISSING');
      const provider = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).post(BASE).set(provider.headers).send({}), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('GET /admin/categories/:id', () => {
    it('returns one category; 404 for unknown, malformed and deleted ids', async () => {
      const category = await makeCategory(t.dataSource);
      const res = await request(t.http).get(`${BASE}/${category.id}`).set(admin.headers).expect(200);
      expect(res.body.data).toMatchObject({ id: category.id, servicesCount: 0 });
      expectError(await request(t.http).get(`${BASE}/${MISSING}`).set(admin.headers), 404, 'CATEGORY_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/zzz`).set(admin.headers), 404, 'CATEGORY_NOT_FOUND');
      await t.dataSource.getRepository(Category).softDelete(category.id);
      expectError(await request(t.http).get(`${BASE}/${category.id}`).set(admin.headers), 404, 'CATEGORY_NOT_FOUND');
    });
  });

  describe('PATCH /admin/categories/:id', () => {
    it('updates fields and audits the changes', async () => {
      const category = await makeCategory(t.dataSource);
      const slug = `renamed-${uid()}`;
      const res = await request(t.http)
        .patch(`${BASE}/${category.id}`)
        .set(admin.headers)
        .send({ slug, nameEn: 'Renamed', descriptionEn: 'Weddings', descriptionAr: 'أعراس', icon: 'camera' })
        .expect(200);
      expect(res.body.data).toMatchObject({ slug, nameEn: 'Renamed', icon: 'camera', descriptionAr: 'أعراس' });
      const audit = await audited('category.updated', category.id);
      expect(audit?.changes).toMatchObject({ nameEn: { from: category.nameEn, to: 'Renamed' }, slug: { from: category.slug, to: slug } });
    });

    it('toggles visibility with a dedicated audit action', async () => {
      const category = await makeCategory(t.dataSource);
      const res = await request(t.http).patch(`${BASE}/${category.id}`).set(admin.headers).send({ isVisible: false }).expect(200);
      expect(res.body.data.isVisible).toBe(false);
      expect(await audited('category.hidden', category.id)).not.toBeNull();
      await request(t.http).patch(`${BASE}/${category.id}`).set(admin.headers).send({ isVisible: true }).expect(200);
      expect(await audited('category.shown', category.id)).not.toBeNull();
    });

    it('409 SLUG_TAKEN, 404, 400', async () => {
      const a = await makeCategory(t.dataSource);
      const b = await makeCategory(t.dataSource);
      expectError(await request(t.http).patch(`${BASE}/${b.id}`).set(admin.headers).send({ slug: a.slug }), 409, 'SLUG_TAKEN');
      expectError(await request(t.http).patch(`${BASE}/${MISSING}`).set(admin.headers).send({ nameEn: 'x' }), 404, 'CATEGORY_NOT_FOUND');
      expectError(await request(t.http).patch(`${BASE}/${b.id}`).set(admin.headers).send({ position: 3 }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${BASE}/${b.id}`).set(admin.headers).send({ nameEn: '', nameAr: '' }), 400, 'VALIDATION_FAILED');
    });

    it('401 / 403', async () => {
      expectError(await request(t.http).patch(`${BASE}/${MISSING}`).send({}), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).patch(`${BASE}/${MISSING}`).set(client.headers).send({}), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('PATCH /admin/categories/order', () => {
    it('moves the ids into the slots they occupy and audits', async () => {
      const db = t.dataSource;
      const a = await makeCategory(db, { position: 5001 });
      const b = await makeCategory(db, { position: 5002 });
      const c = await makeCategory(db, { position: 5003 });
      const res = await request(t.http).patch(`${BASE}/order`).set(admin.headers).send({ ids: [c.id, a.id, b.id] }).expect(200);
      expect(res.body.data).toEqual([
        { id: c.id, position: 5001 },
        { id: a.id, position: 5002 },
        { id: b.id, position: 5003 },
      ]);
      const rows = await db.getRepository(Category).find({ where: [{ id: a.id }, { id: b.id }, { id: c.id }], order: { position: 'ASC' } });
      expect(rows.map((r) => r.id)).toEqual([c.id, a.id, b.id]);
      expect(await t.dataSource.getRepository(AuditLog).existsBy({ action: 'category.reordered' })).toBe(true);
    });

    it('404 with the unknown ids, 400 on bad input', async () => {
      const a = await makeCategory(t.dataSource);
      const res = await request(t.http).patch(`${BASE}/order`).set(admin.headers).send({ ids: [a.id, MISSING] });
      expectError(res, 404, 'CATEGORY_NOT_FOUND');
      expect(res.body.details).toEqual({ ids: [MISSING] });
      expectError(await request(t.http).patch(`${BASE}/order`).set(admin.headers).send({ ids: [] }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${BASE}/order`).set(admin.headers).send({ ids: [a.id, a.id] }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${BASE}/order`).set(admin.headers).send({ ids: ['x'] }), 400, 'VALIDATION_FAILED');
    });

    it('401', async () => {
      expectError(await request(t.http).patch(`${BASE}/order`).send({ ids: [MISSING] }), 401, 'AUTH_TOKEN_MISSING');
    });
  });

  describe('DELETE /admin/categories/:id', () => {
    it('soft-deletes an empty category and frees its slug', async () => {
      const category = await makeCategory(t.dataSource);
      await request(t.http).delete(`${BASE}/${category.id}`).set(admin.headers).expect(204);
      const row = await t.dataSource.getRepository(Category).findOneOrFail({ where: { id: category.id }, withDeleted: true });
      expect(row.deletedAt).not.toBeNull();
      expect(row.slug).toBe(`${category.slug}~${category.id.slice(0, 8)}`);
      expect(await audited('category.deleted', category.id)).not.toBeNull();
      await request(t.http).post(BASE).set(admin.headers).send({ slug: category.slug, nameEn: 'Reuse', nameAr: 'إعادة', icon: 'star' }).expect(201);
    });

    it('409 CATEGORY_HAS_SERVICES with counts, then moves services and providers with moveTo', async () => {
      const db = t.dataSource;
      const from = await makeCategory(db);
      const to = await makeCategory(db);
      const { user: provider, profile } = await makeProvider(db, { profile: { categoryId: from.id } });
      const service = await makeService(db, { providerId: provider.id, categoryId: from.id });

      const blocked = await request(t.http).delete(`${BASE}/${from.id}`).set(admin.headers).set('Accept-Language', 'ar');
      expectError(blocked, 409, 'CATEGORY_HAS_SERVICES');
      expect(blocked.body.details).toEqual({ servicesCount: 1, providersCount: 1 });
      expect(blocked.body.message).toBe('لا تزال هذه الفئة تضم 1 خدمة و1 مقدم خدمة. اختر فئة لنقلهم إليها.');

      await request(t.http).delete(`${BASE}/${from.id}`).query({ moveTo: to.id }).set(admin.headers).expect(204);
      expect((await db.getRepository(Service).findOneByOrFail({ id: service.id })).categoryId).toBe(to.id);
      expect((await db.getRepository(ProviderProfile).findOneByOrFail({ id: profile.id })).categoryId).toBe(to.id);
      const audit = await audited('category.deleted', from.id);
      expect(audit?.changes).toMatchObject({ movedServices: 1, movedProviders: 1, movedTo: { id: to.id } });
    });

    it('422 CATEGORY_MOVE_TARGET_INVALID for itself or a missing target (nothing moves)', async () => {
      const db = t.dataSource;
      const from = await makeCategory(db);
      const service = await makeService(db, { categoryId: from.id });
      expectError(await request(t.http).delete(`${BASE}/${from.id}`).query({ moveTo: from.id }).set(admin.headers), 422, 'CATEGORY_MOVE_TARGET_INVALID');
      expectError(await request(t.http).delete(`${BASE}/${from.id}`).query({ moveTo: MISSING }).set(admin.headers), 422, 'CATEGORY_MOVE_TARGET_INVALID');
      expectError(await request(t.http).delete(`${BASE}/${from.id}`).query({ moveTo: 'x' }).set(admin.headers), 400, 'VALIDATION_FAILED');
      expect((await db.getRepository(Service).findOneByOrFail({ id: service.id })).categoryId).toBe(from.id);
    });

    it('404 / 401 / 403', async () => {
      expectError(await request(t.http).delete(`${BASE}/${MISSING}`).set(admin.headers), 404, 'CATEGORY_NOT_FOUND');
      expectError(await request(t.http).delete(`${BASE}/${MISSING}`), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).delete(`${BASE}/${MISSING}`).set(client.headers), 403, 'FORBIDDEN_ROLE');
    });
  });
});
