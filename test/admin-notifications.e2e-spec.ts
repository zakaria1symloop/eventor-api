import type { AddressInfo } from 'node:net';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { Export } from '../src/admin/entities/export.entity.js';
import { ExportFormat, ExportStatus } from '../src/common/enums/admin.enums.js';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { DocumentType } from '../src/common/enums/file.enums.js';
import { Language, UserRole, UserStatus } from '../src/common/enums/user.enums.js';
import { AdminAlertsService } from '../src/notifications/admin-alerts.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { PACK_EVENTS } from '../src/packs/packs.events.js';
import { JOBS } from '../src/queue/jobs.js';
import { QueueService } from '../src/queue/queue.service.js';
import { VERIFICATION_EVENTS } from '../src/verification/verification.events.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeNotification,
  makePack,
  makeProvider,
  makeUser,
  makeUserDocument,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const API = '/api/v1/admin/notifications';
const HOUR = 3_600_000;
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('Admin notifications (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;
  let arabic: LoggedIn;

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin, { language: Language.En });
    arabic = await loginAs(t, UserRole.Admin, { language: Language.Ar });
  });

  afterAll(async () => {
    await t?.close();
  });

  const db = () => t.dataSource;
  const rowsFor = (type: string, key: string, value: string) =>
    db().query(`SELECT user_id, title, body, data, read_at FROM notifications WHERE type = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.${key}')) = ?`, [type, value]);
  const activeAdmins = async () => Number((await db().query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL"))[0].n);

  describe('fan-out', () => {
    it('writes one row per active admin in their language, never for blocked admins', async () => {
      const blocked = await makeUser(db(), { role: UserRole.Admin, status: UserStatus.Blocked });
      const key = uid();
      const written = await t.get(NotificationsService).notifyAdmins({
        type: 'test.fanout',
        en: { title: 'Hello', body: 'English body' },
        ar: { title: 'مرحبا', body: 'نص عربي' },
        data: { href: '/somewhere', key },
      });
      const rows = await rowsFor('test.fanout', 'key', key);
      expect(written).toBe(await activeAdmins());
      expect(rows).toHaveLength(written);
      const byUser = new Map(rows.map((r: any) => [r.user_id, r]));
      expect(byUser.get(admin.user.id)).toMatchObject({ title: 'Hello', body: 'English body', read_at: null });
      expect(byUser.get(arabic.user.id)).toMatchObject({ title: 'مرحبا', body: 'نص عربي' });
      expect(byUser.has(blocked.id)).toBe(false);
    });

    it('verification document uploaded (submitted, then resubmitted)', async () => {
      const { user: provider } = await makeProvider(db(), { user: { fullName: `Walid Saadi ${uid()}` } });
      const first = await makeUserDocument(db(), { userId: provider.id, type: DocumentType.NationalId });
      await t.get(EventEmitter2).emitAsync(VERIFICATION_EVENTS.documentUploaded, { documentId: first.id, userId: provider.id, type: DocumentType.NationalId, uploadedById: provider.id });
      const second = await makeUserDocument(db(), { userId: provider.id, type: DocumentType.NationalId });
      await t.get(EventEmitter2).emitAsync(VERIFICATION_EVENTS.documentUploaded, { documentId: second.id, userId: provider.id, type: DocumentType.NationalId, uploadedById: provider.id });
      const submitted = await rowsFor('verification.submitted', 'documentId', first.id);
      const resubmitted = await rowsFor('verification.resubmitted', 'documentId', second.id);
      expect(submitted).toHaveLength(await activeAdmins());
      expect(resubmitted).toHaveLength(await activeAdmins());
      expect(resubmitted.find((r: any) => r.user_id === admin.user.id)).toMatchObject({ title: 'Documents resubmitted', data: { href: `/verifications/${provider.id}?doc=${second.id}`, userId: provider.id } });
    });

    it('pack needs attention', async () => {
      const pack = await makePack(db());
      await t.get(EventEmitter2).emitAsync(PACK_EVENTS.needsAttention, {
        packId: pack.id,
        nameEn: pack.nameEn,
        nameAr: pack.nameAr,
        reasons: ['service_hidden'],
        provider: { userId: pack.providerId, email: 'x@test.dz', name: 'Provider', lang: 'en' },
      });
      const rows = await rowsFor('pack.needs_attention', 'packId', pack.id);
      expect(rows).toHaveLength(await activeAdmins());
      expect(rows.find((r: any) => r.user_id === arabic.user.id)).toMatchObject({ title: 'باقة تحتاج إلى مراجعة', data: { href: `/packs/${pack.id}` } });
    });

    it('booking without a reply: announced once by the hourly job', async () => {
      const late = await makeBooking(db(), { status: BookingStatus.Pending, createdAt: new Date(Date.now() - 50 * HOUR) });
      const fresh = await makeBooking(db(), { status: BookingStatus.Pending, createdAt: new Date(Date.now() - 2 * HOUR) });
      const alerts = t.get(AdminAlertsService);
      expect(await alerts.notifyNoReply()).toBeGreaterThanOrEqual(1);
      expect(await rowsFor('booking.no_reply', 'bookingId', late.id)).toHaveLength(await activeAdmins());
      expect(await rowsFor('booking.no_reply', 'bookingId', fresh.id)).toHaveLength(0);
      await alerts.notifyNoReply();
      expect(await rowsFor('booking.no_reply', 'bookingId', late.id)).toHaveLength(await activeAdmins());
      const [row] = (await rowsFor('booking.no_reply', 'bookingId', late.id)).filter((r: any) => r.user_id === admin.user.id);
      expect(row).toMatchObject({ title: `No reply on ${late.reference}`, data: { href: `/bookings/${late.id}`, reference: late.reference } });
    });

    it('export ready goes to the requesting admin only', async () => {
      const row = await db()
        .getRepository(Export)
        .save(db().getRepository(Export).create({ requestedById: admin.user.id, resource: 'reviews', filters: {}, columns: ['id', 'rating'], format: ExportFormat.Csv, status: ExportStatus.Queued }));
      await t.get(QueueService).add(JOBS.generateExport, { exportId: row.id });
      const rows = await rowsFor('export.ready', 'exportId', row.id);
      expect(rows.map((r: any) => r.user_id)).toEqual([admin.user.id]);
    });
  });

  describe('GET /admin/notifications, unread-count, read', () => {
    it('lists only my notifications, filters unread, marks read by ids or all', async () => {
      const me = await loginAs(t, UserRole.Admin);
      const other = await loginAs(t, UserRole.Admin);
      const old = await makeNotification(db(), { userId: me.user.id, type: 'dispute.opened', title: 'Old', createdAt: new Date(Date.now() - 5 * HOUR), data: { href: '/disputes/x' } });
      const read = await makeNotification(db(), { userId: me.user.id, title: 'Read', readAt: new Date(), createdAt: new Date(Date.now() - 3 * HOUR) });
      const recent = await makeNotification(db(), { userId: me.user.id, title: 'Recent', createdAt: new Date(Date.now() - HOUR) });
      const foreign = await makeNotification(db(), { userId: other.user.id, title: 'Not mine' });

      const list = await request(t.http).get(API).set(me.headers).expect(200);
      expect(list.body.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
      expect(list.body.data.map((n: any) => n.id)).toEqual([recent.id, read.id, old.id]);
      expect(list.body.data[2]).toEqual({ id: old.id, type: 'dispute.opened', title: 'Old', body: 'Test notification', data: { href: '/disputes/x' }, readAt: null, createdAt: expect.any(String) });
      expect((await request(t.http).get(API).set(me.headers).query({ unread: 'true' })).body.data.map((n: any) => n.id)).toEqual([recent.id, old.id]);
      expect((await request(t.http).get(API).set(me.headers).query({ limit: 1, page: 2 })).body).toMatchObject({ data: [{ id: read.id }], meta: { total: 3, totalPages: 3 } });
      expect((await request(t.http).get(`${API}/unread-count`).set(me.headers).expect(200)).body).toEqual({ data: { unread: 2 } });

      const marked = await request(t.http).post(`${API}/read`).set(me.headers).send({ ids: [old.id, foreign.id, read.id] }).expect(200);
      expect(marked.body.data).toEqual({ updated: 1, unread: 1 });
      expect((await db().query('SELECT read_at FROM notifications WHERE id = ?', [foreign.id]))[0].read_at).toBeNull();

      expect((await request(t.http).post(`${API}/read`).set(me.headers).send({ all: true }).expect(200)).body.data).toEqual({ updated: 1, unread: 0 });
      expect((await request(t.http).get(`${API}/unread-count`).set(other.headers)).body.data.unread).toBe(1);
    });

    it('validation, 401, 403', async () => {
      expectError(await request(t.http).post(`${API}/read`).set(admin.headers).send({}), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${API}/read`).set(admin.headers).send({ ids: ['nope'] }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${API}/read`).set(admin.headers).send({ all: false }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${API}/read`).set(admin.headers).send({ ids: [MISSING], extra: 1 }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(API).set(admin.headers).query({ unread: 'maybe' }), 400, 'VALIDATION_FAILED');
      const ar = await request(t.http).get(API).set(admin.headers).set('Accept-Language', 'ar').query({ limit: 500 });
      expectError(ar, 400, 'VALIDATION_FAILED');
      expect(ar.body.message).toBe('بعض الحقول غير صالحة.');
      expectError(await request(t.http).get(API), 401, 'AUTH_TOKEN_MISSING');
      expectError(await request(t.http).get(`${API}/unread-count`), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).get(API).set(client.headers), 403, 'FORBIDDEN_ROLE');
      expectError(await request(t.http).post(`${API}/read`).set(client.headers).send({ all: true }), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('socket notification:new', () => {
    const sockets: Socket[] = [];
    afterAll(() => sockets.forEach((s) => s.close()));

    it('is pushed to the sockets of each admin it belongs to', async () => {
      await t.app.listen(0, '127.0.0.1');
      const { port } = t.app.getHttpServer().address() as AddressInfo;
      const connect = async (token: string) => {
        const socket = io(`http://127.0.0.1:${port}/admin`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.on('ready', () => resolve());
          socket.on('connect_error', reject);
        });
        return socket;
      };
      const [en, ar] = await Promise.all([connect(admin.token), connect(arabic.token)]);
      const key = uid();
      const received = (socket: Socket) => new Promise<any>((resolve) => socket.on('notification:new', (n: any) => n.data?.key === key && resolve(n)));
      const [enMessage, arMessage] = [received(en), received(ar)];
      await t.get(NotificationsService).notifyAdmins({ type: 'test.socket', en: { title: 'Socket', body: 'b' }, ar: { title: 'مقبس', body: 'ب' }, data: { href: '/', key } });
      expect(await enMessage).toMatchObject({ id: expect.any(String), type: 'test.socket', title: 'Socket', readAt: null, data: { key } });
      expect(await arMessage).toMatchObject({ title: 'مقبس' });
    });
  });
});
