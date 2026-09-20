import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { SavedView } from '../src/admin/entities/saved-view.entity.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { createApp, expectError, loginAs, uid, type LoggedIn, type TestApp } from './utils/index.js';

const BASE = '/api/v1/admin/saved-views';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('Admin saved views (e2e)', () => {
  let t: TestApp;
  let me: LoggedIn;
  let other: LoggedIn;
  let resource: string;

  beforeAll(async () => {
    t = await createApp();
    me = await loginAs(t, UserRole.Admin);
    other = await loginAs(t, UserRole.Admin);
    resource = `test-${uid()}`;
  });

  afterAll(async () => {
    await t?.close();
  });

  const create = (who: LoggedIn, body: Record<string, unknown>) =>
    request(t.http).post(BASE).set(who.headers).send({ resource, query: { status: ['pending'] }, ...body });

  describe('POST /admin/saved-views', () => {
    it('creates a private view and audits it', async () => {
      const res = await create(me, { name: '  Pending  ' }).expect(201);
      expect(Object.keys(res.body.data).sort()).toEqual(['createdAt', 'id', 'isOwner', 'isShared', 'name', 'owner', 'query', 'resource', 'updatedAt']);
      expect(res.body.data).toMatchObject({
        resource,
        name: 'Pending',
        query: { status: ['pending'] },
        isShared: false,
        isOwner: true,
        owner: { id: me.user.id, fullName: me.user.fullName },
      });
      expect(await t.dataSource.getRepository(AuditLog).existsBy({ action: 'saved_view.created', objectId: res.body.data.id })).toBe(true);
    });

    it('409 SAVED_VIEW_NAME_TAKEN for the same owner and resource only', async () => {
      await create(me, { name: 'Dup' }).expect(201);
      expectError(await create(me, { name: 'Dup' }), 409, 'SAVED_VIEW_NAME_TAKEN');
      await create(other, { name: 'Dup' }).expect(201);
    });

    it('400 for missing fields, wrong types and unknown fields', async () => {
      const res = await request(t.http).post(BASE).set(me.headers).send({ resource: 'Bad Resource', name: '', query: 'x', isShared: 'yes', extra: 1 });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(res.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['resource', 'name', 'query', 'isShared', 'extra']));
    });

    it('401 / 403 / Arabic', async () => {
      expectError(await request(t.http).post(BASE).send({}), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await create(client, { name: 'x' }), 403, 'FORBIDDEN_ROLE');
      const ar = await create(me, { name: 'Dup' }).set('Accept-Language', 'ar');
      expect(ar.body.message).toBe('لديك بالفعل عرض محفوظ بهذا الاسم.');
    });
  });

  describe('GET /admin/saved-views', () => {
    it('returns my views and shared ones, filtered by resource, sorted by name', async () => {
      const shared = await create(other, { name: 'A shared', isShared: true }).expect(201);
      await create(other, { name: 'B private' }).expect(201);
      await request(t.http).post(BASE).set(me.headers).send({ resource: `${resource}-x`, name: 'Elsewhere', query: {} }).expect(201);

      const res = await request(t.http).get(BASE).query({ resource }).set(me.headers).expect(200);
      expect(res.body.data.map((v: any) => [v.name, v.isOwner])).toEqual([
        ['A shared', false],
        ['Dup', true],
        ['Pending', true],
      ]);
      expect(res.body.data[0].id).toBe(shared.body.data.id);

      const all = await request(t.http).get(BASE).set(me.headers).expect(200);
      expect(all.body.data.some((v: any) => v.name === 'Elsewhere')).toBe(true);
      expectError(await request(t.http).get(BASE).query({ resource: 'NO!' }).set(me.headers), 400, 'VALIDATION_FAILED');
    });

    it('401', async () => {
      expectError(await request(t.http).get(BASE), 401, 'AUTH_TOKEN_MISSING');
    });
  });

  describe('PATCH /admin/saved-views/:id', () => {
    it('lets the owner rename, share and change the query', async () => {
      const view = (await create(me, { name: 'To edit' }).expect(201)).body.data;
      const res = await request(t.http)
        .patch(`${BASE}/${view.id}`)
        .set(me.headers)
        .send({ name: 'Edited', isShared: true, query: { status: ['accepted'] } })
        .expect(200);
      expect(res.body.data).toMatchObject({ name: 'Edited', isShared: true, query: { status: ['accepted'] } });
      const audit = await t.dataSource.getRepository(AuditLog).findOneByOrFail({ action: 'saved_view.updated', objectId: view.id });
      expect(Object.keys(audit.changes!).sort()).toEqual(['isShared', 'name', 'query']);
    });

    it('403 NOT_OWNER on a shared view of another admin, 404 on a private one', async () => {
      const shared = (await create(other, { name: `Shared ${uid()}`, isShared: true }).expect(201)).body.data;
      const hidden = (await create(other, { name: `Private ${uid()}` }).expect(201)).body.data;
      expectError(await request(t.http).patch(`${BASE}/${shared.id}`).set(me.headers).send({ name: 'Mine now' }), 403, 'NOT_OWNER');
      expectError(await request(t.http).patch(`${BASE}/${hidden.id}`).set(me.headers).send({ name: 'Mine now' }), 404, 'SAVED_VIEW_NOT_FOUND');
    });

    it('404 for unknown / malformed ids, 409 on a taken name, 400 on bad input', async () => {
      expectError(await request(t.http).patch(`${BASE}/${MISSING}`).set(me.headers).send({ name: 'x' }), 404, 'SAVED_VIEW_NOT_FOUND');
      expectError(await request(t.http).patch(`${BASE}/nope`).set(me.headers).send({ name: 'x' }), 404, 'SAVED_VIEW_NOT_FOUND');
      const view = (await create(me, { name: 'Rename me' }).expect(201)).body.data;
      expectError(await request(t.http).patch(`${BASE}/${view.id}`).set(me.headers).send({ name: 'Pending' }), 409, 'SAVED_VIEW_NAME_TAKEN');
      expectError(await request(t.http).patch(`${BASE}/${view.id}`).set(me.headers).send({ isShared: 1, resource: 'x' }), 400, 'VALIDATION_FAILED');
    });

    it('401', async () => {
      expectError(await request(t.http).patch(`${BASE}/${MISSING}`).send({}), 401, 'AUTH_TOKEN_MISSING');
    });
  });

  describe('DELETE /admin/saved-views/:id', () => {
    it('soft-deletes my view', async () => {
      const view = (await create(me, { name: 'Delete me' }).expect(201)).body.data;
      await request(t.http).delete(`${BASE}/${view.id}`).set(me.headers).expect(204);
      expect(await t.dataSource.getRepository(SavedView).findOneBy({ id: view.id })).toBeNull();
      expect(await t.dataSource.getRepository(AuditLog).existsBy({ action: 'saved_view.deleted', objectId: view.id })).toBe(true);
      expectError(await request(t.http).delete(`${BASE}/${view.id}`).set(me.headers), 404, 'SAVED_VIEW_NOT_FOUND');
    });

    it('403 NOT_OWNER for a shared view of another admin; 401 / 403 role', async () => {
      const shared = (await create(other, { name: `Shared del ${uid()}`, isShared: true }).expect(201)).body.data;
      expectError(await request(t.http).delete(`${BASE}/${shared.id}`).set(me.headers), 403, 'NOT_OWNER');
      expectError(await request(t.http).delete(`${BASE}/${shared.id}`), 401, 'AUTH_TOKEN_MISSING');
      const provider = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).delete(`${BASE}/${shared.id}`).set(provider.headers), 403, 'FORBIDDEN_ROLE');
    });
  });
});
