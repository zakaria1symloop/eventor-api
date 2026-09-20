import request from 'supertest';
import { AuditLevel, AuditSource } from '../src/common/enums/admin.enums.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { User } from '../src/users/entities/user.entity.js';
import { createApp, expectError, loginAs, makeAuditLog, makeUser, uid, type LoggedIn, type TestApp } from './utils/index.js';

const URL = '/api/v1/admin/activity-log';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('Admin activity log (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;
  let actor: User;
  let tag: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin);
    actor = await makeUser(t.dataSource, { role: UserRole.Admin });
    tag = uid();
    const db = t.dataSource;
    const at = (iso: string) => new Date(iso);
    ids.old = (
      await makeAuditLog(db, {
        actorId: actor.id,
        actorRole: UserRole.Admin,
        action: `test.${tag}.created`,
        objectType: `obj${tag}`,
        objectId: MISSING,
        objectLabel: `Label ${tag} old`,
        level: AuditLevel.Normal,
        source: AuditSource.Dashboard,
        createdAt: at('2026-01-10T10:00:00.000Z'),
      })
    ).id;
    ids.mid = (
      await makeAuditLog(db, {
        actorId: actor.id,
        actorRole: UserRole.Admin,
        action: `test.${tag}.updated`,
        objectType: `obj${tag}`,
        objectId: MISSING,
        objectLabel: `Label ${tag} mid`,
        level: AuditLevel.Sensitive,
        source: AuditSource.Dashboard,
        changes: { nameEn: { from: 'A', to: 'B' } },
        note: `note ${tag}`,
        ip: '41.111.24.8',
        userAgent: 'Vitest',
        requestId: `req_${tag}`,
        createdAt: at('2026-02-10T10:00:00.000Z'),
      })
    ).id;
    ids.system = (
      await makeAuditLog(db, {
        action: `test.${tag}.job`,
        objectType: `obj${tag}`,
        level: AuditLevel.Info,
        source: AuditSource.System,
        createdAt: at('2026-03-10T10:00:00.000Z'),
      })
    ).id;
  });

  afterAll(async () => {
    await t?.close();
  });

  const list = (query: Record<string, unknown>, headers = admin.headers) => request(t.http).get(URL).query(query).set(headers);

  describe('GET /admin/activity-log', () => {
    it('lists newest first with actor summary and pagination meta', async () => {
      const res = await list({ objectType: `obj${tag}`, limit: 2 }).expect(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(res.body.data.map((r: any) => r.id)).toEqual([ids.system, ids.mid]);
      expect(Object.keys(res.body.data[1]).sort()).toEqual(
        ['action', 'actor', 'actorRole', 'createdAt', 'hasChanges', 'hasNote', 'id', 'ip', 'level', 'objectId', 'objectLabel', 'objectType', 'source'].sort(),
      );
      expect(res.body.data[1]).toMatchObject({
        actor: { id: actor.id, fullName: actor.fullName, email: actor.email, role: 'admin', isDeleted: false },
        hasChanges: true,
        hasNote: true,
      });
      expect(res.body.data[0].actor).toBeNull();

      const page2 = await list({ objectType: `obj${tag}`, limit: 2, page: 2 }).expect(200);
      expect(page2.body.data.map((r: any) => r.id)).toEqual([ids.old]);
      const asc = await list({ objectType: `obj${tag}`, sort: 'createdAt:asc' }).expect(200);
      expect(asc.body.data.map((r: any) => r.id)).toEqual([ids.old, ids.mid, ids.system]);
    });

    it('filters by actor, action (multi), object, level, source, dates and q', async () => {
      const idsOf = async (query: Record<string, unknown>) =>
        (await list({ objectType: `obj${tag}`, ...query }).expect(200)).body.data.map((r: any) => r.id);

      expect(await idsOf({ actorId: actor.id })).toEqual([ids.mid, ids.old]);
      expect(await idsOf({ action: [`test.${tag}.created`, `test.${tag}.job`] })).toEqual([ids.system, ids.old]);
      expect(await idsOf({ action: `test.${tag}.updated` })).toEqual([ids.mid]);
      expect(await idsOf({ objectId: MISSING })).toEqual([ids.mid, ids.old]);
      expect(await idsOf({ level: ['sensitive', 'info'] })).toEqual([ids.system, ids.mid]);
      expect(await idsOf({ source: 'system' })).toEqual([ids.system]);
      expect(await idsOf({ from: '2026-02-01T00:00:00.000Z', to: '2026-02-28T23:59:59.999Z' })).toEqual([ids.mid]);
      expect(await idsOf({ q: `note ${tag}` })).toEqual([ids.mid]);
      expect(await idsOf({ q: `req_${tag}` })).toEqual([ids.mid]);
      expect((await list({ q: `Label ${tag}` }).expect(200)).body.meta.total).toBe(2);
    });

    it('400 for bad filters and a disallowed sort', async () => {
      const res = await list({ level: 'loud', from: 'yesterday', actorId: 'x', extra: 1 });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(res.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['level', 'from', 'actorId', 'extra']));
      expectError(await list({ sort: 'action:asc' }), 400, 'SORT_FIELD_NOT_ALLOWED');
    });

    it('401 without a token, 403 for a client, Arabic messages', async () => {
      expectError(await request(t.http).get(URL), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await list({}, client.headers), 403, 'FORBIDDEN_ROLE');
      const ar = await list({ sort: 'action:asc' }).set('Accept-Language', 'ar');
      expect(ar.body.message).toBe('لا يمكن الترتيب حسب "action".');
    });
  });

  describe('GET /admin/activity-log/:id', () => {
    it('returns the full entry with the object link hint', async () => {
      const res = await request(t.http).get(`${URL}/${ids.mid}`).set(admin.headers).expect(200);
      expect(res.body.data).toMatchObject({
        id: ids.mid,
        changes: { nameEn: { from: 'A', to: 'B' } },
        note: `note ${tag}`,
        userAgent: 'Vitest',
        requestId: `req_${tag}`,
        ip: '41.111.24.8',
        object: { type: `obj${tag}`, id: MISSING, label: `Label ${tag} mid` },
        actor: { id: actor.id },
      });
    });

    it('shows removed actors', async () => {
      await t.dataSource.getRepository(User).softDelete(actor.id);
      const res = await request(t.http).get(`${URL}/${ids.old}`).set(admin.headers).expect(200);
      expect(res.body.data.actor).toMatchObject({ id: actor.id, isDeleted: true });
      await t.dataSource.getRepository(User).restore(actor.id);
    });

    it('404 AUDIT_LOG_NOT_FOUND for an unknown or malformed id', async () => {
      expectError(await request(t.http).get(`${URL}/${MISSING}`).set(admin.headers), 404, 'AUDIT_LOG_NOT_FOUND');
      expectError(await request(t.http).get(`${URL}/nope`).set(admin.headers), 404, 'AUDIT_LOG_NOT_FOUND');
    });

    it('401 / 403', async () => {
      expectError(await request(t.http).get(`${URL}/${ids.mid}`), 401, 'AUTH_TOKEN_MISSING');
      const provider = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).get(`${URL}/${ids.mid}`).set(provider.headers), 403, 'FORBIDDEN_ROLE');
    });
  });
});
