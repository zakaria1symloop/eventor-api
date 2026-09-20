import request from 'supertest';
import { AcademicRequestsService } from '../src/academic/academic-requests.service.js';
import { AcademicRequest } from '../src/academic/entities/academic-request.entity.js';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { Booking } from '../src/bookings/entities/booking.entity.js';
import { AcademicRequestStatus } from '../src/common/enums/academic.enums.js';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { MailService } from '../src/mail/mail.service.js';
import { User } from '../src/users/entities/user.entity.js';
import {
  createApp,
  expectError,
  loginAs,
  makeAcademicRequest,
  makeBooking,
  makeCategory,
  makeFile,
  makeForm,
  makeProvider,
  makeService,
  makeUser,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const BASE = '/api/v1/admin/academic-requests';
const MISSING = '00000000-0000-4000-8000-000000000000';
const DAY = 86_400_000;

let dayCounter = 0;
const futureDate = () => {
  dayCounter += 1;
  return new Date(Date.UTC(2032, 0, 1) + dayCounter * DAY).toISOString().slice(0, 10);
};

describe('Admin academic requests (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;
  let client: LoggedIn;

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin);
    client = await loginAs(t, UserRole.Client);
  });

  afterAll(async () => {
    await t?.close();
  });

  const db = () => t.dataSource;
  const reload = (id: string) => db().getRepository(AcademicRequest).findOneByOrFail({ id });
  const audited = (action: string, objectId: string) => db().getRepository(AuditLog).findOneBy({ action, objectId });
  const lastMailTo = (email: string) => [...t.get(MailService).outbox].reverse().find((m) => m.to === email);
  const post = (path: string, body: Record<string, unknown> = {}) => request(t.http).post(`${BASE}/${path}`).set(admin.headers).send(body);

  async function bookableService() {
    const { user: provider } = await makeProvider(db());
    const service = await makeService(db(), { providerId: provider.id, basePrice: '30000.00', maxEventsPerDay: 5 });
    await db().query('INSERT INTO service_wilayas (service_id, wilaya_code, created_at) VALUES (?, 16, NOW())', [service.id]);
    return { provider, service };
  }

  const makeRequest = (overrides: Record<string, unknown> = {}) =>
    makeAcademicRequest(db(), { reference: `ACR-8${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, title: `Science Day ${uid()}`, institutionName: "Université d'Alger 1", eventDate: futureDate(), wilayaCode: 16, attendees: 300, ...overrides } as never);

  describe('GET /admin/academic-requests', () => {
    it('lists with tab counts, filters, search, sort and pagination', async () => {
      const tag = uid();
      const { form, version } = await makeForm(db());
      const common = { formId: form.id, formVersionId: version.id, institutionName: `USTHB ${tag}` };
      const a = await makeRequest({ ...common, eventDate: '2032-03-01', wilayaCode: 16, assignedAdminId: admin.user.id, submittedAt: new Date(Date.now() - 3 * DAY) });
      const b = await makeRequest({ ...common, eventDate: '2032-04-01', wilayaCode: 31, status: AcademicRequestStatus.Approved, submittedAt: new Date(Date.now() - 2 * DAY) });
      const c = await makeRequest({ ...common, eventDate: '2032-05-01', wilayaCode: 16, status: AcademicRequestStatus.Rejected, submittedAt: new Date(Date.now() - DAY) });
      const list = (query: Record<string, unknown>) => request(t.http).get(BASE).set(admin.headers).query({ q: tag, ...query }).expect(200);
      const ids = (res: request.Response) => res.body.data.map((r: any) => r.id);

      const all = await list({});
      expect(all.body.meta).toMatchObject({ total: 3, counts: { all: 3, pending: 1, approved: 1, rejected: 1, changes_requested: 0, in_progress: 0, completed: 0, cancelled: 0 } });
      expect(ids(all)).toEqual([c.id, b.id, a.id]);
      expect(all.body.data[2]).toMatchObject({
        reference: a.reference,
        institutionName: `USTHB ${tag}`,
        requester: { email: a.requesterEmail, userId: null },
        eventDate: '2032-03-01',
        wilaya: { code: 16 },
        form: { id: form.id, version: 1 },
        assignedAdmin: { id: admin.user.id },
        proposalsCount: 0,
        bookingsCount: 0,
      });
      expect(ids(await list({ tab: 'approved' }))).toEqual([b.id]);
      expect((await list({ tab: 'approved' })).body.meta.counts.all).toBe(3);
      expect(ids(await list({ wilaya: 31 }))).toEqual([b.id]);
      expect(ids(await list({ eventDateFrom: '2032-03-15', eventDateTo: '2032-04-15' }))).toEqual([b.id]);
      expect(ids(await list({ assignedAdminId: 'me' }))).toEqual([a.id]);
      expect(ids(await list({ assignedAdminId: 'unassigned' }))).toEqual([c.id, b.id]);
      expect(ids(await list({ formId: form.id, sort: 'eventDate:asc' }))).toEqual([a.id, b.id, c.id]);
      expect(ids(await request(t.http).get(BASE).set(admin.headers).query({ q: a.reference }).expect(200))).toEqual([a.id]);
      const page = await list({ limit: 2, page: 2 });
      expect(page.body.meta).toMatchObject({ page: 2, limit: 2, totalPages: 2 });
      expectError(await request(t.http).get(BASE).set(admin.headers).query({ sort: 'title:asc' }), 400, 'SORT_FIELD_NOT_ALLOWED');
      expectError(await request(t.http).get(BASE).set(admin.headers).query({ assignedAdminId: 'someone' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(BASE), 401, 'AUTH_TOKEN_MISSING');
      expectError(await request(t.http).get(BASE).set(client.headers), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('GET /admin/academic-requests/:id', () => {
    it('renders answers with the request version, attachments, needs, allowed actions and timeline', async () => {
      const category = await makeCategory(db(), { nameEn: 'Sound & lights' });
      const { form, version } = await makeForm(db());
      await db().query('UPDATE form_versions SET `schema` = ? WHERE id = ?', [
        JSON.stringify({
          fields: [
            { key: 'title', type: 'short_text', label_en: 'Title', label_ar: 'العنوان', maps_to: 'title' },
            { key: 'kind', type: 'dropdown', label_en: 'Kind', label_ar: 'النوع', options: [{ value: 'academic', label_en: 'Scientific day', label_ar: 'يوم علمي' }] },
            { key: 'wilaya', type: 'wilaya', label_en: 'Wilaya', label_ar: 'الولاية' },
            { key: 'needs', type: 'service_categories', label_en: 'Needs', label_ar: 'الاحتياجات' },
            { key: 'programme', type: 'file', label_en: 'Programme', label_ar: 'البرنامج' },
          ],
        }),
        version.id,
      ]);
      const file = await makeFile(db(), { purpose: 'attachment' as never, originalName: 'programme.pdf' });
      const req = await makeRequest({ formId: form.id, formVersionId: version.id, answers: { title: 'Science Day 2026', kind: 'academic', wilaya: 16, needs: [category.id], programme: [file.id] } });
      await db().query('INSERT INTO academic_request_attachments (id, created_at, request_id, file_id, field_key) VALUES (UUID(), NOW(6), ?, ?, ?)', [req.id, file.id, 'programme']);
      await db().query('INSERT INTO academic_request_needs (id, created_at, request_id, category_id, note) VALUES (UUID(), NOW(6), ?, ?, NULL)', [req.id, category.id]);

      const res = await request(t.http).get(`${BASE}/${req.reference}`).set(admin.headers).expect(200);
      const d = res.body.data;
      expect(d.answers.map((a: any) => [a.key, a.displayValue])).toEqual([
        ['title', 'Science Day 2026'],
        ['kind', 'Scientific day'],
        ['wilaya', expect.stringMatching(/^16 /)],
        ['needs', 'Sound & lights'],
        ['programme', 'programme.pdf'],
      ]);
      expect(d.attachments).toEqual([expect.objectContaining({ fileId: file.id, fieldKey: 'programme', fileName: 'programme.pdf', url: expect.stringContaining(`/files/${file.id}?`) })]);
      expect(d.needs).toEqual([{ category: { id: category.id, nameEn: 'Sound & lights', nameAr: category.nameAr }, note: null }]);
      expect(d).toMatchObject({ status: 'pending', proposals: [], bookings: [], requestedChanges: null, changedFields: [], allowedActions: ['assign', 'request_changes', 'approve', 'reject', 'cancel', 'propose'] });
      expect((await request(t.http).get(`${BASE}/${req.id}`).set(admin.headers).expect(200)).body.data.id).toBe(req.id);
      expectError(await request(t.http).get(`${BASE}/${MISSING}`).set(admin.headers), 404, 'ACADEMIC_REQUEST_NOT_FOUND');
      const ar = await request(t.http).get(`${BASE}/ACR-999999`).set(admin.headers).set('Accept-Language', 'ar');
      expectError(ar, 404, 'ACADEMIC_REQUEST_NOT_FOUND');
      expect(ar.body.message).toBe('الطلب الأكاديمي غير موجود.');
      expectError(await request(t.http).get(`${BASE}/nope`).set(admin.headers), 404, 'ACADEMIC_REQUEST_NOT_FOUND');
    });
  });

  describe('POST …/assign', () => {
    it('assigns me by default or another admin; refuses unknown admins and final requests', async () => {
      const req = await makeRequest();
      const res = await post(`${req.id}/assign`).expect(200);
      expect(res.body.data.assignedAdmin).toEqual({ id: admin.user.id, fullName: admin.user.fullName });
      const other = await makeUser(db(), { role: UserRole.Admin });
      await post(`${req.id}/assign`, { adminId: other.id }).expect(200);
      expect((await reload(req.id)).assignedAdminId).toBe(other.id);
      expect(await audited('academic_request.assigned', req.id)).toBeTruthy();
      expectError(await post(`${req.id}/assign`, { adminId: client.user.id }), 404, 'ADMIN_NOT_FOUND');
      expectError(await post(`${req.id}/assign`, { adminId: 'x' }), 400, 'VALIDATION_FAILED');
      const done = await makeRequest({ status: AcademicRequestStatus.Completed });
      expectError(await post(`${done.id}/assign`), 409, 'ACADEMIC_REQUEST_INVALID_TRANSITION');
      expectError(await post(`${MISSING}/assign`), 404, 'ACADEMIC_REQUEST_NOT_FOUND');
    });
  });

  describe('POST …/request-changes', () => {
    it('pending → changes_requested with an emailed single-use edit link', async () => {
      const req = await makeRequest();
      const res = await post(`${req.id}/request-changes`, { fields: ['title'], message: 'Please give the exact title.' }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'changes_requested', requestedChanges: { fields: ['title'], message: 'Please give the exact title.', requestedBy: { id: admin.user.id }, linkExpiresAt: expect.any(String), resubmittedAt: null } });
      expect(res.body.data.allowedActions).toEqual(['assign', 'reject', 'cancel', 'propose']);
      expect(lastMailTo(req.requesterEmail)!.text).toMatch(/\/f\/form-[0-9a-f]+\/edit\?token=/);
      expect(await audited('academic_request.changes_requested', req.id)).toMatchObject({ note: 'Please give the exact title.' });
      expectError(await post(`${req.id}/request-changes`, { fields: ['title'], message: 'Again please.' }), 409, 'ACADEMIC_REQUEST_INVALID_TRANSITION');
      const other = await makeRequest();
      const unknown = await post(`${other.id}/request-changes`, { fields: ['title', 'color'], message: 'Fix it please.' });
      expectError(unknown, 422, 'ACADEMIC_REQUEST_FIELDS_INVALID');
      expect(unknown.body.details).toEqual({ fields: ['color'] });
      const bad = await post(`${other.id}/request-changes`, { fields: [], extra: 1 });
      expectError(bad, 400, 'VALIDATION_FAILED');
      expect(bad.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['fields', 'message', 'extra']));
    });
  });

  describe('approve / reject / cancel', () => {
    it('approves with proposals and emails the requester in their language', async () => {
      const { service } = await bookableService();
      const req = await makeRequest();
      await db().query("INSERT INTO audit_logs (id, created_at, action, object_type, object_id, level, source, changes) VALUES (UUID(), NOW(6), 'academic_request.submitted', 'academic_request', ?, 'normal', 'web', ?)", [
        req.id,
        JSON.stringify({ lang: 'ar' }),
      ]);
      const res = await post(`${req.id}/approve`, { message: 'We propose a sound provider.', serviceIds: [service.id] }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'approved', decisionMessage: 'We propose a sound provider.', decidedBy: { id: admin.user.id }, proposals: [{ service: { id: service.id } }] });
      expect(lastMailTo(req.requesterEmail)).toMatchObject({ subject: `تمت الموافقة على طلبك ${req.reference}`, text: expect.stringContaining(service.titleEn) });
      expect(await audited('academic_request.approved', req.id)).toBeTruthy();
      expectError(await post(`${req.id}/approve`), 409, 'ACADEMIC_REQUEST_INVALID_TRANSITION');
      expectError(await post(`${(await makeRequest()).id}/approve`, { serviceIds: [MISSING] }), 404, 'SERVICE_NOT_FOUND');
    });

    it('rejects pending or changes_requested requests (final)', async () => {
      const req = await makeRequest({ status: AcademicRequestStatus.ChangesRequested });
      const res = await post(`${req.id}/reject`, { reason: 'out_of_scope', message: 'We cannot support this event.' }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'rejected', rejectReason: 'out_of_scope', decisionMessage: 'We cannot support this event.', allowedActions: [] });
      expect(lastMailTo(req.requesterEmail)!.text).toContain('We cannot support this event.');
      expect(await audited('academic_request.rejected', req.id)).toBeTruthy();
      expectError(await post(`${req.id}/reject`, { reason: 'again', message: 'Again no.' }), 409, 'ACADEMIC_REQUEST_INVALID_TRANSITION');
      expectError(await post(`${req.id}/reject`, { reason: 'x'.repeat(61) }), 400, 'VALIDATION_FAILED');
    });

    it('cancels open requests and their pending bookings', async () => {
      const req = await makeRequest({ status: AcademicRequestStatus.InProgress });
      const pending = await makeBooking(db(), { academicRequestId: req.id, status: BookingStatus.Pending });
      const accepted = await makeBooking(db(), { academicRequestId: req.id, status: BookingStatus.Accepted });
      const res = await post(`${req.id}/cancel`, { reason: 'requester_withdrew' }).expect(200);
      expect(res.body.data.status).toBe('cancelled');
      expect((await db().getRepository(Booking).findOneByOrFail({ id: pending.id })).status).toBe('cancelled');
      expect((await db().getRepository(Booking).findOneByOrFail({ id: accepted.id })).status).toBe('accepted');
      expect(await audited('academic_request.cancelled', req.id)).toMatchObject({ changes: expect.objectContaining({ cancelledBookings: [pending.id] }) });
      expect(lastMailTo(req.requesterEmail)!.subject).toContain('cancelled');
      expectError(await post(`${req.id}/cancel`, { reason: 'again' }), 409, 'ACADEMIC_REQUEST_INVALID_TRANSITION');
      expectError(await post(`${req.id}/cancel`, {}), 400, 'VALIDATION_FAILED');
    });
  });

  describe('proposals', () => {
    it('adds and removes proposals with their guards', async () => {
      const { service } = await bookableService();
      const req = await makeRequest({ status: AcademicRequestStatus.Approved });
      const res = await post(`${req.id}/proposals`, { serviceId: service.id, note: 'Covers the amphitheatre.' }).expect(201);
      const proposal = res.body.data.proposals[0];
      expect(proposal).toMatchObject({ note: 'Covers the amphitheatre.', proposedBy: { id: admin.user.id }, booking: null, service: { id: service.id, basePrice: '30000.00', provider: { id: service.providerId } } });
      expect(await audited('academic_request.proposal_added', req.id)).toBeTruthy();
      expectError(await post(`${req.id}/proposals`, { serviceId: service.id }), 409, 'PROPOSAL_EXISTS');
      expectError(await post(`${req.id}/proposals`, { serviceId: MISSING }), 404, 'SERVICE_NOT_FOUND');
      expectError(await post(`${req.id}/proposals`, { serviceId: 'x' }), 400, 'VALIDATION_FAILED');
      expectError(await post(`${(await makeRequest({ status: AcademicRequestStatus.Rejected })).id}/proposals`, { serviceId: service.id }), 409, 'ACADEMIC_REQUEST_INVALID_TRANSITION');

      const removed = await request(t.http).delete(`${BASE}/${req.id}/proposals/${proposal.id}`).set(admin.headers).expect(200);
      expect(removed.body.data.proposals).toEqual([]);
      expect(await audited('academic_request.proposal_removed', req.id)).toBeTruthy();
      await post(`${req.id}/proposals`, { serviceId: service.id }).expect(201);
      expectError(await request(t.http).delete(`${BASE}/${req.id}/proposals/${MISSING}`).set(admin.headers), 404, 'PROPOSAL_NOT_FOUND');
    });
  });

  describe('POST …/proposals/:proposalId/book', () => {
    it('creates the client account and the booking, moves the request to in_progress; a second booking reuses the account', async () => {
      const first = await bookableService();
      const second = await bookableService();
      const email = `requester.${uid()}@univ-alger.dz`;
      const req = await makeRequest({ status: AcademicRequestStatus.Approved, requesterEmail: email, requesterName: 'Nadia Hamdi', requesterPhone: '+213555123456', attendees: 350 });
      const withProposals = await post(`${req.id}/proposals`, { serviceId: first.service.id }).expect(201);
      await post(`${req.id}/proposals`, { serviceId: second.service.id }).expect(201);
      const [p1, p2] = (await request(t.http).get(`${BASE}/${req.id}`).set(admin.headers).expect(200)).body.data.proposals;
      expect(withProposals.body.data.proposals).toHaveLength(1);

      expectError(await post(`${req.id}/proposals/${p1.id}/book`, { startTime: '9am' }), 400, 'VALIDATION_FAILED');
      const res = await post(`${req.id}/proposals/${p1.id}/book`, { startTime: '09:00', endTime: '17:00' }).expect(201);
      const d = res.body.data;
      expect(d.status).toBe('in_progress');
      expect(d.bookings).toHaveLength(1);
      expect(d.proposals.find((p: any) => p.id === p1.id).booking).toMatchObject({ id: d.bookings[0].id, status: 'pending' });

      const user = await db().getRepository(User).findOneByOrFail({ email });
      expect(user).toMatchObject({ role: 'client', fullName: 'Nadia Hamdi', phone: '+213555123456' });
      expect(d.requester.userId).toBe(user.id);
      const booking = await db().getRepository(Booking).findOneByOrFail({ id: d.bookings[0].id });
      expect(booking).toMatchObject({ clientId: user.id, serviceId: first.service.id, academicRequestId: req.id, guests: 350, eventType: 'academic', status: 'pending', wilayaCode: 16 });
      expect(lastMailTo(email)).toBeTruthy();
      expect([...t.get(MailService).outbox].some((m) => m.to === email && /password/i.test(m.subject + m.text))).toBe(true);
      expect(await audited('academic_request.booked', req.id)).toMatchObject({ changes: expect.objectContaining({ clientCreated: true }) });
      expectError(await post(`${req.id}/proposals/${p1.id}/book`), 409, 'PROPOSAL_BOOKED');
      expectError(await request(t.http).delete(`${BASE}/${req.id}/proposals/${p1.id}`).set(admin.headers), 409, 'PROPOSAL_BOOKED');

      await post(`${req.id}/proposals/${p2.id}/book`, { eventDate: futureDate() }).expect(201);
      expect(await db().getRepository(User).countBy({ email })).toBe(1);
      expect(await db().getRepository(Booking).countBy({ academicRequestId: req.id })).toBe(2);
    });

    it('guards: request status, requester email of another role, missing event date, unknown proposal', async () => {
      const { service } = await bookableService();
      const pending = await makeRequest();
      const p = (await post(`${pending.id}/proposals`, { serviceId: service.id }).expect(201)).body.data.proposals[0];
      expectError(await post(`${pending.id}/proposals/${p.id}/book`), 409, 'ACADEMIC_REQUEST_INVALID_TRANSITION');

      const provider = await makeUser(db(), { role: UserRole.Provider });
      const other = await makeRequest({ status: AcademicRequestStatus.Approved, requesterEmail: provider.email });
      const po = (await post(`${other.id}/proposals`, { serviceId: service.id }).expect(201)).body.data.proposals[0];
      expectError(await post(`${other.id}/proposals/${po.id}/book`), 422, 'REQUESTER_NOT_CLIENT');
      expect(await db().getRepository(Booking).countBy({ academicRequestId: other.id })).toBe(0);

      const undated = await makeRequest({ status: AcademicRequestStatus.Approved, eventDate: null });
      const pu = (await post(`${undated.id}/proposals`, { serviceId: service.id }).expect(201)).body.data.proposals[0];
      expectError(await post(`${undated.id}/proposals/${pu.id}/book`), 400, 'VALIDATION_FAILED');
      expectError(await post(`${undated.id}/proposals/${MISSING}/book`, { eventDate: futureDate() }), 404, 'PROPOSAL_NOT_FOUND');
    });
  });

  describe('completion job', () => {
    it('completes in_progress requests once every booking is completed or cancelled and the date passed', async () => {
      const due = await makeRequest({ status: AcademicRequestStatus.InProgress, eventDate: '2020-01-10' });
      await makeBooking(db(), { academicRequestId: due.id, status: BookingStatus.Completed, eventDate: '2020-01-10' });
      await makeBooking(db(), { academicRequestId: due.id, status: BookingStatus.Cancelled, eventDate: '2020-01-11' });
      const open = await makeRequest({ status: AcademicRequestStatus.InProgress, eventDate: '2020-01-10' });
      await makeBooking(db(), { academicRequestId: open.id, status: BookingStatus.Accepted, eventDate: '2020-01-10' });
      const future = await makeRequest({ status: AcademicRequestStatus.InProgress, eventDate: '2020-01-10' });
      await makeBooking(db(), { academicRequestId: future.id, status: BookingStatus.Completed, eventDate: futureDate() });

      const jobs = t.get(AcademicRequestsService);
      expect(await jobs.completeDue()).toBeGreaterThanOrEqual(1);
      expect((await reload(due.id)).status).toBe('completed');
      expect((await reload(open.id)).status).toBe('in_progress');
      expect((await reload(future.id)).status).toBe('in_progress');
      expect(await audited('academic_request.completed', due.id)).toMatchObject({ actorId: null, source: 'system' });
      await jobs.completeDue();
      expect(await db().getRepository(AuditLog).countBy({ action: 'academic_request.completed', objectId: due.id })).toBe(1);
    });
  });
});
