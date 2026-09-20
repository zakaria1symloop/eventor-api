import { autoReportReason, containsInsult, detectFlags } from './flag-detection.js';

describe('detectFlags', () => {
  it('returns nothing for a clean comment (FR / EN / AR)', () => {
    expect(detectFlags('Photos magnifiques, équipe très professionnelle !')).toEqual([]);
    expect(detectFlags('Great DJ, the guests danced all night.')).toEqual([]);
    expect(detectFlags('خدمة ممتازة وتنظيم رائع')).toEqual([]);
    expect(detectFlags(null)).toEqual([]);
  });

  it('finds phone numbers in local and international formats', () => {
    expect(detectFlags('Appelez-moi au 0661 20 41 02 pour moins cher')).toEqual(['phone']);
    expect(detectFlags('call +213 661 204 102')).toEqual(['phone']);
    expect(detectFlags('رقمي ٠٦٦١٢٠٤١٠٢')).toEqual(['phone']);
  });

  it('finds emails, links and handles', () => {
    expect(detectFlags('écrivez à studio.lumiere@gmail.com')).toEqual(['email']);
    expect(detectFlags('see www.studiolumiere.dz or wa.me/213661204102')).toEqual(['link']);
    expect(detectFlags('insta: studiolumiere')).toEqual(['handle']);
  });

  it('finds insults on whole words, accents and case ignored', () => {
    expect(detectFlags('Une vraie ARNAQUE, escroc !')).toEqual(['insult']);
    expect(detectFlags('هذا نصاب')).toEqual(['insult']);
    expect(detectFlags('total scam')).toEqual(['insult']);
    expect(containsInsult('Scampi were delicious')).toBe(false);
  });

  it('combines flags in a stable order', () => {
    expect(detectFlags('Escroc, rappelez le 0555 12 34 56 ou mail x.y@gmail.com')).toEqual(['phone', 'email', 'insult']);
  });
});

describe('autoReportReason', () => {
  it('prefers contact_outside, then inappropriate', () => {
    expect(autoReportReason(['phone', 'insult'])).toBe('contact_outside');
    expect(autoReportReason(['insult'])).toBe('inappropriate');
    expect(autoReportReason([])).toBeNull();
  });
});
