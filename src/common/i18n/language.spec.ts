import { interpolate, resolveLanguage } from './language.js';

describe('resolveLanguage', () => {
  it.each([
    [undefined, 'en'],
    ['', 'en'],
    ['ar', 'ar'],
    ['AR-dz', 'ar'],
    ['fr-FR,ar;q=0.8,en;q=0.9', 'en'],
    ['fr-FR,ar;q=0.9,en;q=0.8', 'ar'],
    ['en;q=0, ar', 'ar'],
    ['de', 'en'],
  ])('%s → %s', (header, expected) => {
    expect(resolveLanguage(header)).toBe(expected);
  });

  it('uses the fallback (user language) when the header has no supported language', () => {
    expect(resolveLanguage('fr', 'ar')).toBe('ar');
    expect(resolveLanguage('en', 'ar')).toBe('en');
  });
});

describe('interpolate', () => {
  it('fills known placeholders and leaves unknown ones', () => {
    expect(interpolate('{a} of {b}', { a: 3 })).toBe('3 of {b}');
    expect(interpolate('no params', [1, 2])).toBe('no params');
  });
});
