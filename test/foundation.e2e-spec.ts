import request from 'supertest';
import { UserRole } from '../src/common/enums/user.enums.js';
import { createApp, expectError, loginAs, type TestApp } from './utils/index.js';
import { TestRoutesController } from './utils/test-routes.controller.js';

describe('Foundation (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createApp({ controllers: [TestRoutesController] });
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('health', () => {
    it('GET /health/live is public', async () => {
      const res = await request(t.http).get('/api/v1/health/live').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f]{8}$/);
    });

    it('GET /health/ready reaches the database and reports the queue driver', async () => {
      const res = await request(t.http).get('/api/v1/health/ready').expect(200);
      expect(res.body).toEqual({ status: 'ok', database: 'up', queue: 'inline' });
    });

    it('reuses a well-formed incoming x-request-id', async () => {
      const res = await request(t.http)
        .get('/api/v1/health/live')
        .set('x-request-id', 'nginx-abc123');
      expect(res.headers['x-request-id']).toBe('nginx-abc123');
    });
  });

  describe('error shape', () => {
    it('answers unknown routes with the standard JSON body', async () => {
      const res = await request(t.http).get('/api/v1/nope');
      expectError(res, 404, 'ROUTE_NOT_FOUND');
      expect(res.body.path).toBe('/api/v1/nope');
      expect(res.body.message).toBe('This route does not exist.');
      expect(res.body.details).toBeNull();
    });

    it('translates the message with Accept-Language: ar', async () => {
      const res = await request(t.http).get('/api/v1/nope').set('Accept-Language', 'ar-DZ,ar;q=0.9');
      expectError(res, 404, 'ROUTE_NOT_FOUND');
      expect(res.body.message).toBe('هذا المسار غير موجود.');
    });

    it('hides internal errors behind a generic 500', async () => {
      const res = await request(t.http).get('/api/v1/__test/boom');
      expectError(res, 500, 'INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
    });

    it('returns 400 BAD_REQUEST for malformed JSON', async () => {
      const res = await request(t.http)
        .post('/api/v1/__test/validate')
        .set('Content-Type', 'application/json')
        .send('{"name": ');
      expectError(res, 400, 'BAD_REQUEST');
    });
  });

  describe('validation', () => {
    const valid = {
      name: 'Sara',
      email: 'sara@eventor.dz',
      eventType: 'wedding',
      guests: { count: 120 },
    };

    it('accepts a valid body', async () => {
      const res = await request(t.http).post('/api/v1/__test/validate').send(valid).expect(201);
      expect(res.body.data).toEqual(valid);
    });

    it('returns VALIDATION_FAILED with per-field details', async () => {
      const res = await request(t.http)
        .post('/api/v1/__test/validate')
        .send({ name: 'A name that is far too long', eventType: 'party', guests: { count: 0 }, extra: 1 });

      expectError(res, 400, 'VALIDATION_FAILED');
      const details = res.body.details as { field: string; code: string; message: string }[];
      const pairs = details.map((d) => `${d.field}:${d.code}`);
      expect(pairs).toEqual(
        expect.arrayContaining([
          'name:MAX_LENGTH',
          'email:IS_EMAIL',
          'eventType:IS_ENUM',
          'guests.count:MIN',
          'extra:WHITELIST_VALIDATION',
        ]),
      );
      details.forEach((d) => expect(typeof d.message).toBe('string'));
    });

    it('translates the top-level validation message to Arabic', async () => {
      const res = await request(t.http)
        .post('/api/v1/__test/validate')
        .set('Accept-Language', 'ar')
        .send({});
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(res.body.message).toBe('بعض الحقول غير صالحة.');
    });
  });

  describe('guards', () => {
    it('401 AUTH_TOKEN_MISSING without a token', async () => {
      expectError(await request(t.http).get('/api/v1/__test/private'), 401, 'AUTH_TOKEN_MISSING');
    });

    it('401 AUTH_TOKEN_INVALID with a forged token', async () => {
      const res = await request(t.http)
        .get('/api/v1/__test/private')
        .set('Authorization', 'Bearer not.a.jwt');
      expectError(res, 401, 'AUTH_TOKEN_INVALID');
    });

    it('lets any authenticated role through a private route', async () => {
      const client = await loginAs(t, UserRole.Client);
      const res = await request(t.http).get('/api/v1/__test/private').set(client.headers).expect(200);
      expect(res.body.data).toMatchObject({ id: client.user.id, role: 'client' });
    });

    it('403 FORBIDDEN_ROLE for a non-admin on an admin route', async () => {
      const provider = await loginAs(t, UserRole.Provider);
      const res = await request(t.http).get('/api/v1/__test/admin-only').set(provider.headers);
      expectError(res, 403, 'FORBIDDEN_ROLE');
    });

    it('lets an admin through an admin route', async () => {
      const admin = await loginAs(t, UserRole.Admin);
      const res = await request(t.http).get('/api/v1/__test/admin-only').set(admin.headers).expect(200);
      expect(res.body.data.id).toBe(admin.user.id);
    });
  });
});
