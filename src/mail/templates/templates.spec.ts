import { describe, expect, it } from 'vitest';
import { gmailSenderWarning, mailAddress } from '../mail-sender.js';
import { MAIL_TEMPLATES, renderMail, type MailTemplateData, type MailTemplateName } from './index.js';
import { acceptsReplies, NO_REPLY_FOOTER, REPLY_FOOTER, withReplyFooter } from './layout.js';

const URL = 'https://admin.example.test/set-password?token=abc123';

/** One sample per template and what its plain-text part must carry (BUG-B1). Typed: a new template must be added here. */
const SAMPLES: { [K in MailTemplateName]: { data: MailTemplateData<K>; carries: string[] } } = {
  'verification-code': { data: { name: 'Amel', code: '482913', minutes: 15 }, carries: ['482913'] },
  'account-deletion-code': { data: { name: 'Amel', code: '771204', minutes: 15 }, carries: ['771204'] },
  'password-reset': { data: { name: 'Amel', url: URL, minutes: 60 }, carries: [URL] },
  'admin-invitation': { data: { name: 'Amel', invitedBy: 'Karim', url: URL }, carries: [URL] },
  'export-ready': { data: { name: 'Amel', resource: 'bookings', rowCount: 12, url: URL, days: 7 }, carries: [URL] },
  'user-invitation': { data: { name: 'Amel', url: URL, days: 7 }, carries: [URL] },
  'account-blocked': { data: { name: 'Amel', message: 'After several reports.', until: '2026-12-01' }, carries: ['After several reports.'] },
  'account-unblocked': { data: { name: 'Amel' }, carries: ['Amel'] },
  'provider-verified': { data: { name: 'Amel' }, carries: ['Amel'] },
  'document-rejected': { data: { name: 'Amel', document: 'National ID', reason: 'blurry', message: 'Please upload a sharper photo.' }, carries: ['Please upload a sharper photo.'] },
  'service-hidden': { data: { name: 'Amel', title: 'Wedding DJ', reason: 'misleading', message: 'Fix the price.', allowResubmit: true }, carries: ['Wedding DJ'] },
  'service-shown': { data: { name: 'Amel', title: 'Wedding DJ' }, carries: ['Wedding DJ'] },
  'pack-needs-attention': { data: { name: 'Amel', pack: 'Gold wedding' }, carries: ['Gold wedding'] },
  'booking-update': { data: { name: 'Amel', subject: 'Booking EVT-000123 accepted', lines: ['Your booking is confirmed.'] }, carries: ['Your booking is confirmed.'] },
  'case-update': { data: { name: 'Amel', subject: 'Dispute DSP-0001', lines: ['A decision was made.'], url: URL, urlLabel: 'Open' }, carries: ['A decision was made.', URL] },
  invoice: { data: { name: 'Amel', number: 'INV-2026-0105', reference: 'EVT-000123', total: '30000.00' }, carries: ['INV-2026-0105'] },
  'support-message': { data: { name: 'Amel', body: 'We are looking into it.' }, carries: ['We are looking into it.'] },
  notification: { data: { title: 'New review', body: 'Someone reviewed your service.', url: URL }, carries: ['Someone reviewed your service.', URL] },
};

describe('mail templates: every mail has a plain-text part with its content (BUG-B1)', () => {
  it('covers every template', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(MAIL_TEMPLATES).sort());
  });

  for (const name of Object.keys(SAMPLES) as MailTemplateName[]) {
    for (const lang of ['en', 'ar'] as const) {
      it(`${name} (${lang})`, () => {
        const { data, carries } = SAMPLES[name] as { data: never; carries: string[] };
        const mail = renderMail(name, lang, data);
        expect(mail.subject.trim()).not.toBe('');
        for (const value of carries) {
          expect(mail.text).toContain(value);
          expect(mail.html).toContain(value.replace(/&/g, '&amp;'));
        }
      });
    }
  }
});

describe('footer follows the sender (#20 follow-up)', () => {
  it('invites replies from a real inbox, never from a no-reply address', () => {
    expect(acceptsReplies('Eventor <eventorsupport@gmail.com>')).toBe(true);
    expect(acceptsReplies('Eventor <no-reply@eventor.dz>')).toBe(false);
    expect(acceptsReplies('noreply@eventor.dz')).toBe(false);
  });

  it('swaps the footer in both parts and both languages, nothing else', () => {
    for (const lang of ['en', 'ar'] as const) {
      const mail = renderMail('verification-code', lang, { name: 'Amel', code: '482913', minutes: 15 });
      const replied = withReplyFooter(mail, lang);
      expect(replied.text).toContain(REPLY_FOOTER[lang]);
      expect(replied.text).not.toContain(NO_REPLY_FOOTER[lang]);
      expect(replied.html).toContain(REPLY_FOOTER[lang]);
      expect(replied.text).toContain('482913');
      expect(replied.subject).toBe(mail.subject);
    }
  });
});

describe('gmailSenderWarning (BUG-B1: who the mail really comes from)', () => {
  const env = { SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'eventorsupport@gmail.com', MAIL_FROM: 'Eventor <eventorsupport@gmail.com>' };

  it('is quiet when MAIL_FROM is the Gmail account itself (any case)', () => {
    expect(gmailSenderWarning(env)).toBeNull();
    expect(gmailSenderWarning({ ...env, MAIL_FROM: 'Eventor <EventorSupport@gmail.com>' })).toBeNull();
  });

  it('warns when Gmail would replace MAIL_FROM by the signed-in account', () => {
    expect(gmailSenderWarning({ ...env, MAIL_FROM: 'Eventor <no-reply@eventor.dz>' })).toContain('send every mail as eventorsupport@gmail.com');
  });

  it('ignores other hosts and the console driver', () => {
    expect(gmailSenderWarning({ ...env, SMTP_HOST: 'smtp-relay.gmail.com', MAIL_FROM: 'no-reply@eventor.dz' })).toBeNull();
    expect(gmailSenderWarning({ ...env, SMTP_HOST: '' })).toBeNull();
  });

  it('reads the bare address', () => {
    expect(mailAddress('Eventor <EventorSupport@gmail.com>')).toBe('eventorsupport@gmail.com');
    expect(mailAddress(' x@y.dz ')).toBe('x@y.dz');
  });
});
