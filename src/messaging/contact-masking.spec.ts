import { maskContacts, preview, visibleBody } from './contact-masking.js';

describe('maskContacts', () => {
  it.each([
    ['Appelez-moi au 0555 12 34 56', 'Appelez-moi au [phone hidden]'],
    ['call 0661234567 please', 'call [phone hidden] please'],
    ['my number: +213 555 12 34 56', 'my number: [phone hidden]'],
    ['+213(0)770-12-34-56', '[phone hidden]'],
    ['00213 6 61 23 45 67 ok', '[phone hidden] ok'],
    ['رقمي ٠٥٥٥١٢٣٤٥٦', 'رقمي [phone hidden]'],
    ['fixe 021 23 45 67', 'fixe [phone hidden]'],
    ['0555.12.34.56', '[phone hidden]'],
  ])('masks the phone in %j', (input, expected) => {
    expect(maskContacts(input)).toEqual({ masked: expected, kinds: ['phone'] });
  });

  it('masks emails, links and handles', () => {
    expect(maskContacts('écrivez à amina.benali@gmail.com').masked).toBe('écrivez à [email hidden]');
    expect(maskContacts('see https://studio-lumiere.dz/portfolio').masked).toBe('see [link hidden]');
    expect(maskContacts('go to www.djamine.com now').masked).toBe('go to [link hidden] now');
    expect(maskContacts('wa.me/213555123456').kinds).toEqual(['url']);
    expect(maskContacts('t.me/studiolumiere').masked).toBe('[link hidden]');
    expect(maskContacts('insta: @studio.lumiere').masked).toBe('[handle hidden]');
    expect(maskContacts('ajoute moi sur telegram karim_b').masked).toBe('ajoute moi sur [handle hidden]');
    expect(maskContacts('mon site studiolumiere.dz').masked).toBe('mon site [link hidden]');
  });

  it('reports several kinds in order', () => {
    const result = maskContacts('mail karim@studio.dz or whatsapp 0770 11 22 33');
    expect(result.kinds).toEqual(['email', 'phone']);
    expect(result.masked).toBe('mail [email hidden] or whatsapp [phone hidden]');
  });

  it('leaves ordinary text alone (prices, dates, guest counts, times)', () => {
    for (const text of [
      'Le prix est 45000 DA pour 150 invités',
      'Rendez-vous le 20/12/2026 à 18:30',
      'السعر 120000 دينار',
      'We are 2 people, budget 350 000 DZD',
      'Reference EVT-002041',
      'OK merci beaucoup !',
    ]) {
      expect(maskContacts(text)).toEqual({ masked: null, kinds: [] });
    }
    expect(maskContacts(null)).toEqual({ masked: null, kinds: [] });
  });
});

describe('visibleBody / preview', () => {
  it('shows the masked text until unmasked', () => {
    const message = { body: 'call 0555123456', bodyMasked: 'call [phone hidden]' };
    expect(visibleBody(message, false)).toBe('call [phone hidden]');
    expect(visibleBody(message, true)).toBe('call 0555123456');
    expect(visibleBody({ body: 'hi', bodyMasked: null }, false)).toBe('hi');
  });

  it('shortens to one line', () => {
    expect(preview('a\n  b')).toBe('a b');
    expect(preview('x'.repeat(130))).toHaveLength(120);
    expect(preview(null)).toBeNull();
  });
});
