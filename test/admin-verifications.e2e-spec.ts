import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { DocumentRejectReason, DocumentStatus, DocumentType } from '../src/common/enums/file.enums.js';
import { Language, UserRole, VerificationStatus } from '../src/common/enums/user.enums.js';
import { ExportRegistry } from '../src/exports/export-registry.js';
import { MailService } from '../src/mail/mail.service.js';
import { User } from '../src/users/entities/user.entity.js';
import { UserDocument } from '../src/verification/entities/user-document.entity.js';
import {
  createApp,
  expectError,
  loginAs,
  makeCategory,
  makeProvider,
  makeUser,
  makeUserDocument,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const MISSING = '00000000-0000-4000-8000-000000000000';
const { NationalId: ID, CommercialRegisterOrArtisanCard: RC, TaxCard: TAX } = DocumentType;
const { Pending: P, Approved: A, Rejected: R } = DocumentStatus;

const pdf = (text = 'demo') => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${text}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);

describe('Admin verifications (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin);
  });

  afterAll(async () => {
    await t?.close();
  });

  const db = () => t.dataSource;
  const reloadUser = (id: string) => db().getRepository(User).findOneByOrFail({ id });
  const lastMailTo = (email: string) => [...t.get(MailService).outbox].reverse().find((m) => m.to === email);

  /** A provider with documents in the given states; `older` adds a previous (non-current) version of that type. */
  async function provider(
    name: string,
    docs: [DocumentType, DocumentStatus, { daysAgo?: number; older?: DocumentStatus }?][],
    overrides: { categoryId?: string; wilayaCode?: number; language?: Language } = {},
  ) {
    const { user } = await makeProvider(db(), {
      user: { fullName: name, verificationStatus: VerificationStatus.Pending, wilayaCode: overrides.wilayaCode ?? 16, language: overrides.language ?? Language.En },
      profile: overrides.categoryId ? { categoryId: overrides.categoryId } : {},
    });
    const documents: UserDocument[] = [];
    for (const [type, status, options = {}] of docs) {
      const createdAt = new Date(Date.now() - (options.daysAgo ?? 1) * 86_400_000);
      if (options.older) {
        await makeUserDocument(db(), { userId: user.id, type, status: options.older, isCurrent: false, createdAt: new Date(createdAt.getTime() - 86_400_000) });
      }
      documents.push(await makeUserDocument(db(), { userId: user.id, type, status, createdAt }));
    }
    const current = documents.map((d) => d.status);
    const verificationStatus = current.includes(R) ? VerificationStatus.Rejected : current.length === 3 && current.every((s) => s === A) ? VerificationStatus.Verified : VerificationStatus.Pending;
    await db().getRepository(User).update(user.id, { verificationStatus });
    return { user: await reloadUser(user.id), documents };
  }

  describe('GET /admin/verifications', () => {
    let tag: string;
    let category: string;
    let waitingOld: User;
    let waitingNew: User;
    let resubmitted: User;
    let approved: User;
    let rejected: User;
    let incomplete: User;

    beforeAll(async () => {
      tag = uid();
      category = (await makeCategory(db())).id;
      waitingOld = (await provider(`Walid ${tag}`, [[ID, P, { daysAgo: 5 }], [RC, P, { daysAgo: 5 }], [TAX, P, { daysAgo: 5 }]], { categoryId: category, wilayaCode: 25 })).user;
      waitingNew = (await provider(`Nassim ${tag}`, [[ID, A, { daysAgo: 2 }], [RC, P, { daysAgo: 2 }]], { wilayaCode: 31 })).user;
      resubmitted = (await provider(`Fatima ${tag}`, [[ID, P, { daysAgo: 3, older: R }], [RC, A], [TAX, A]], { wilayaCode: 31 })).user;
      approved = (await provider(`Karim ${tag}`, [[ID, A], [RC, A], [TAX, A]], { categoryId: category })).user;
      rejected = (await provider(`Amina ${tag}`, [[ID, A], [RC, A], [TAX, R]])).user;
      incomplete = (await provider(`Sara ${tag}`, [])).user;
      await makeUser(db(), { fullName: `Client ${tag}` });
    });

    const list = (query: Record<string, unknown> = {}) => request(t.http).get('/api/v1/admin/verifications').query({ q: tag, ...query }).set(admin.headers);
    const ids = (res: request.Response) => res.body.data.map((r: any) => r.user.id);

    it('defaults to the waiting tab, oldest submission first, with counters and the row shape', async () => {
      const res = await list().expect(200);
      expect(res.body.meta).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
        counts: { waiting: 2, resubmitted: 1, approved: 1, rejected: 1, incomplete: 1, all: 6 },
      });
      expect(ids(res)).toEqual([waitingOld.id, waitingNew.id]);
      expect(res.body.data[1]).toEqual({
        user: { id: waitingNew.id, fullName: `Nassim ${tag}`, email: waitingNew.email, phone: null, avatarUrl: null },
        businessName: expect.any(String),
        category: { id: expect.any(String), nameEn: expect.any(String), nameAr: expect.any(String) },
        wilaya: { code: 31, name: 'Oran', nameAr: 'وهران' },
        documents: [
          { type: 'national_id', status: 'approved' },
          { type: 'commercial_register_or_artisan_card', status: 'pending' },
          { type: 'tax_card', status: 'missing' },
        ],
        progress: { approved: 1, rejected: 0, waiting: 1, missing: 1 },
        submittedAt: expect.stringMatching(/^\d{4}-/),
        status: 'waiting',
        verificationStatus: 'pending',
      });
    });

    it('lists each tab and applies filters and sort', async () => {
      expect(ids(await list({ tab: 'resubmitted' }).expect(200))).toEqual([resubmitted.id]);
      expect(ids(await list({ tab: 'approved' }).expect(200))).toEqual([approved.id]);
      expect(ids(await list({ tab: 'rejected' }).expect(200))).toEqual([rejected.id]);
      const inc = await list({ tab: 'incomplete' }).expect(200);
      expect(ids(inc)).toEqual([incomplete.id]);
      expect(inc.body.data[0]).toMatchObject({ submittedAt: null, progress: { missing: 3 } });
      expect(ids(await list({ tab: 'all', sort: 'fullName:asc' }).expect(200))).toEqual([rejected.id, resubmitted.id, approved.id, waitingNew.id, incomplete.id, waitingOld.id]);

      expect(ids(await list({ tab: 'all', categoryId: category, sort: 'fullName:asc' }).expect(200))).toEqual([approved.id, waitingOld.id]);
      const oran = await list({ tab: 'all', wilaya: 31, sort: 'fullName:asc' }).expect(200);
      expect(ids(oran)).toEqual([resubmitted.id, waitingNew.id]);
      expect(oran.body.meta.counts).toMatchObject({ waiting: 1, resubmitted: 1, all: 2 });
      expect(ids(await list({ tab: 'all', documentType: 'tax_card', sort: 'fullName:asc' }).expect(200))).toEqual([rejected.id, resubmitted.id, approved.id, waitingOld.id]);
      const today = new Date().toISOString().slice(0, 10);
      const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
      expect(ids(await list({ submittedFrom: fourDaysAgo, submittedTo: today }).expect(200))).toEqual([waitingNew.id]);
      expect(ids(await list({ sort: 'submittedAt:desc', limit: 1, page: 2 }).expect(200))).toEqual([waitingOld.id]);
    });

    it('400 for bad tab, filter and sort; 401; 403', async () => {
      const res = await list({ tab: 'pending', documentType: 'passport', foo: 1 });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(res.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['tab', 'documentType', 'foo']));
      expectError(await list({ sort: 'email:asc' }), 400, 'SORT_FIELD_NOT_ALLOWED');
      expectError(await request(t.http).get('/api/v1/admin/verifications'), 401, 'AUTH_TOKEN_MISSING');
      const other = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).get('/api/v1/admin/verifications').set(other.headers), 403, 'FORBIDDEN_ROLE');
    });

    it('returns the review page with previous versions, account fields and queue neighbours', async () => {
      const detail = (id: string, query: Record<string, unknown>) => request(t.http).get(`/api/v1/admin/verifications/${id}`).query({ q: tag, ...query }).set(admin.headers);

      const first = await detail(waitingOld.id, { tab: 'waiting' }).expect(200);
      expect(first.body.data.neighbours).toEqual({ prevUserId: null, nextUserId: waitingNew.id, position: 1, total: 2 });
      const second = await detail(waitingNew.id, {}).expect(200);
      expect(second.body.data.neighbours).toEqual({ prevUserId: waitingOld.id, nextUserId: null, position: 2, total: 2 });
      const reversed = await detail(waitingNew.id, { sort: 'submittedAt:desc' }).expect(200);
      expect(reversed.body.data.neighbours).toMatchObject({ prevUserId: null, nextUserId: waitingOld.id });
      const outside = await detail(approved.id, { tab: 'waiting' }).expect(200);
      expect(outside.body.data.neighbours).toEqual({ prevUserId: null, nextUserId: null, position: null, total: 2 });

      const res = await detail(resubmitted.id, { tab: 'resubmitted' }).expect(200);
      const data = res.body.data;
      expect(data).toMatchObject({ verificationStatus: 'pending', status: 'resubmitted', progress: { approved: 2, waiting: 1 } });
      expect(data.documents.map((d: any) => d.type)).toEqual(['national_id', 'commercial_register_or_artisan_card', 'tax_card']);
      expect(data.documents[0].current).toMatchObject({ status: 'pending', isCurrent: true, mimeType: 'application/pdf', sizeBytes: 1024, reviewedBy: null });
      expect(data.documents[0].current.viewUrl).toMatch(/\/api\/v1\/files\/[0-9a-f-]{36}\?exp=\d+&sig=/);
      expect(data.documents[0].previous).toHaveLength(1);
      expect(data.documents[0].previous[0]).toMatchObject({ status: 'rejected', isCurrent: false });
      expect(data.account).toMatchObject({ id: resubmitted.id, fullName: `Fatima ${tag}`, email: resubmitted.email, wilaya: { code: 31 }, businessName: expect.any(String) });

      expectError(await request(t.http).get(`/api/v1/admin/verifications/${MISSING}`).set(admin.headers), 404, 'USER_NOT_FOUND');
      const client = await makeUser(db());
      expectError(await request(t.http).get(`/api/v1/admin/verifications/${client.id}`).set(admin.headers), 422, 'NOT_A_PROVIDER');
    });

    it('registers the verifications export', async () => {
      const definition = t.get(ExportRegistry).get('verifications')!;
      expect(await definition.count({ q: tag, tab: 'all' })).toBe(6);
      const rows = await definition.fetch({ q: tag, tab: 'rejected' }, { offset: 0, limit: 5 });
      expect(rows.map((r: any) => r.user.id)).toEqual([rejected.id]);
    });
  });

  describe('document decisions', () => {
    it('approving the last document verifies the provider, emits events and emails "profile approved" in Arabic', async () => {
      const { user, documents } = await provider(`Samira ${uid()}`, [[ID, A], [RC, A], [TAX, P]], { language: Language.Ar });
      const verified: any[] = [];
      const listener = (payload: unknown) => verified.push(payload);
      t.get(EventEmitter2).on('provider.verified', listener);
      const res = await request(t.http).post(`/api/v1/admin/documents/${documents[2]!.id}/approve`).set(admin.headers).expect(200);
      t.get(EventEmitter2).off('provider.verified', listener);

      expect(res.body.data).toMatchObject({
        document: { id: documents[2]!.id, status: 'approved', reviewedBy: { id: admin.user.id }, reviewedAt: expect.any(String) },
        verificationStatus: 'verified',
        previousVerificationStatus: 'pending',
        progress: { approved: 3, rejected: 0, waiting: 0, missing: 0 },
      });
      expect((await reloadUser(user.id)).verificationStatus).toBe(VerificationStatus.Verified);
      expect(verified).toEqual([{ userId: user.id, email: user.email, name: user.fullName, lang: 'ar' }]);
      expect(lastMailTo(user.email)!.subject).toBe('تمت الموافقة على ملفك');
      const audit = await db().getRepository(AuditLog).findOneByOrFail({ action: 'document.approved', objectId: documents[2]!.id });
      expect(audit.changes).toMatchObject({ verificationStatus: { from: 'pending', to: 'verified' } });

      const again = await request(t.http).post(`/api/v1/admin/documents/${documents[2]!.id}/approve`).set(admin.headers).set('Accept-Language', 'ar');
      expectError(again, 409, 'DOCUMENT_INVALID_TRANSITION');
      expect(again.body.message).toBe('لا يمكن نقل هذا المستند من "approved" إلى "approved".');

      const undo = await request(t.http).post(`/api/v1/admin/documents/${documents[2]!.id}/undo`).set(admin.headers).expect(200);
      expect(undo.body.data).toMatchObject({ document: { status: 'pending', reviewedBy: null }, verificationStatus: 'pending', previousVerificationStatus: 'verified' });
      expectError(await request(t.http).post(`/api/v1/admin/documents/${documents[2]!.id}/undo`).set(admin.headers), 409, 'DOCUMENT_INVALID_TRANSITION');
    });

    it('rejecting needs a message, marks the provider rejected and emails the reason', async () => {
      const { user, documents } = await provider(`Houda ${uid()}`, [[ID, P], [RC, P], [TAX, P]]);
      const missing = await request(t.http).post(`/api/v1/admin/documents/${documents[0]!.id}/reject`).set(admin.headers).send({ reasonCode: 'blurry', message: '' });
      expectError(missing, 400, 'VALIDATION_FAILED');
      expect(missing.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['reasonCode', 'message']));

      const res = await request(t.http)
        .post(`/api/v1/admin/documents/${documents[0]!.id}/reject`)
        .set(admin.headers)
        .send({ reasonCode: DocumentRejectReason.NameMismatch, message: 'The name does not match the account.' })
        .expect(200);
      expect(res.body.data).toMatchObject({
        document: { status: 'rejected', rejectReason: 'name_mismatch', rejectNote: 'The name does not match the account.' },
        verificationStatus: 'rejected',
      });
      expect((await reloadUser(user.id)).verificationStatus).toBe(VerificationStatus.Rejected);
      const mail = lastMailTo(user.email)!;
      expect(mail.subject).toBe('A document needs to be sent again');
      expect(mail.text).toContain('The name does not match the account.');
      expect(await db().getRepository(AuditLog).findOneBy({ action: 'document.rejected', objectId: documents[0]!.id })).not.toBeNull();
    });

    it('refuses decisions on previous versions; 404 for unknown documents; 401/403', async () => {
      const { user } = await provider(`Old ${uid()}`, [[ID, P]]);
      const old = await makeUserDocument(db(), { userId: user.id, type: ID, status: P, isCurrent: false });
      expectError(await request(t.http).post(`/api/v1/admin/documents/${old.id}/approve`).set(admin.headers), 409, 'DOCUMENT_INVALID_TRANSITION');
      expectError(await request(t.http).post(`/api/v1/admin/documents/${MISSING}/approve`).set(admin.headers), 404, 'DOCUMENT_NOT_FOUND');
      expectError(await request(t.http).post('/api/v1/admin/documents/nope/undo').set(admin.headers), 404, 'DOCUMENT_NOT_FOUND');
      expectError(await request(t.http).post(`/api/v1/admin/documents/${old.id}/approve`), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).post(`/api/v1/admin/documents/${old.id}/reject`).set(client.headers).send({}), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('POST /admin/users/:id/documents', () => {
    it('uploads a new current version, recomputes and serves it through the signed URL', async () => {
      const { user, documents } = await provider(`Bilal ${uid()}`, [[ID, A], [RC, A], [TAX, R]]);
      expect(user.verificationStatus).toBe(VerificationStatus.Rejected);
      const content = pdf('nif');
      const res = await request(t.http)
        .post(`/api/v1/admin/users/${user.id}/documents`)
        .set(admin.headers)
        .field('type', 'tax_card')
        .attach('file', content, { filename: 'nif.pdf', contentType: 'application/pdf' })
        .expect(201);
      expect(res.body.data).toMatchObject({
        document: { type: 'tax_card', status: 'pending', isCurrent: true, mimeType: 'application/pdf', sizeBytes: content.length, fileName: 'nif.pdf' },
        verificationStatus: 'pending',
        previousVerificationStatus: 'rejected',
      });
      expect((await db().getRepository(UserDocument).findOneByOrFail({ id: documents[2]!.id })).isCurrent).toBe(false);
      expect(await db().getRepository(AuditLog).findOneBy({ action: 'document.uploaded', objectId: res.body.data.document.id })).not.toBeNull();

      const url = new URL(res.body.data.document.viewUrl);
      const download = await request(t.http).get(`${url.pathname}${url.search}`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(download.status).toBe(200);
      expect(Buffer.compare(download.body, content)).toBe(0);

      const detail = await request(t.http).get(`/api/v1/admin/verifications/${user.id}`).query({ tab: 'resubmitted' }).set(admin.headers).expect(200);
      expect(detail.body.data).toMatchObject({ status: 'resubmitted', neighbours: { position: expect.any(Number) } });
      expect(detail.body.data.documents[2].previous[0]).toMatchObject({ status: 'rejected' });
    });

    it('400 without file or with a bad type; 415 for other files; 413 above the limit; 422 for a client; 404', async () => {
      const { user } = await provider(`Upload ${uid()}`, []);
      const path = `/api/v1/admin/users/${user.id}/documents`;
      expectError(await request(t.http).post(path).set(admin.headers).field('type', 'tax_card'), 400, 'VALIDATION_FAILED');
      expectError(
        await request(t.http).post(path).set(admin.headers).field('type', 'passport').attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' }),
        400,
        'VALIDATION_FAILED',
      );
      expectError(
        await request(t.http).post(path).set(admin.headers).field('type', 'tax_card').attach('file', Buffer.from('hello world'), { filename: 'a.pdf', contentType: 'application/pdf' }),
        415,
        'FILE_TYPE_NOT_ALLOWED',
      );
      const big = Buffer.concat([pdf(), Buffer.alloc(6 * 1024 * 1024, 32)]);
      expectError(
        await request(t.http).post(path).set(admin.headers).field('type', 'tax_card').attach('file', big, { filename: 'big.pdf', contentType: 'application/pdf' }),
        413,
        'FILE_TOO_LARGE',
      );
      const client = await makeUser(db());
      expectError(
        await request(t.http).post(`/api/v1/admin/users/${client.id}/documents`).set(admin.headers).field('type', 'tax_card').attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' }),
        422,
        'NOT_A_PROVIDER',
      );
      expectError(
        await request(t.http).post(`/api/v1/admin/users/${MISSING}/documents`).set(admin.headers).field('type', 'tax_card').attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' }),
        404,
        'USER_NOT_FOUND',
      );
    });
  });
});
