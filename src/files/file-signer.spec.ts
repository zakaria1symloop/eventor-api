import { FileSigner } from './file-signer.js';

describe('FileSigner', () => {
  const signer = new FileSigner('test-secret-at-least-16-chars');
  const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const now = Date.UTC(2026, 8, 16, 10, 0, 0);
  const exp = Math.floor(now / 1000) + 900;

  it('accepts its own signature before expiry', () => {
    const sig = signer.sign(id, null, exp);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signer.verify(id, undefined, exp, sig, now)).toBe('valid');
  });

  it('reports an expired signature', () => {
    const sig = signer.sign(id, null, exp);
    expect(signer.verify(id, null, exp, sig, now + 901_000)).toBe('expired');
  });

  it('rejects a changed id, variant, expiry or secret', () => {
    const sig = signer.sign(id, 'thumb', exp);
    expect(signer.verify(id, 'thumb', exp, sig, now)).toBe('valid');
    expect(signer.verify(id.replace('7c9e', '7c9f'), 'thumb', exp, sig, now)).toBe('invalid');
    expect(signer.verify(id, 'medium', exp, sig, now)).toBe('invalid');
    expect(signer.verify(id, null, exp, sig, now)).toBe('invalid');
    expect(signer.verify(id, 'thumb', exp + 3600, sig, now)).toBe('invalid');
    expect(new FileSigner('another-secret-16-chars').verify(id, 'thumb', exp, sig, now)).toBe('invalid');
  });

  it('rejects missing or malformed parameters', () => {
    expect(signer.verify(id, null, undefined, 'x', now)).toBe('invalid');
    expect(signer.verify(id, null, exp, undefined, now)).toBe('invalid');
    expect(signer.verify(id, null, exp, 'short', now)).toBe('invalid');
    expect(signer.verify(id, null, 1.5, signer.sign(id, null, 1.5), now)).toBe('invalid');
  });

  it('refuses an empty secret', () => {
    expect(() => new FileSigner('')).toThrow();
  });
});
