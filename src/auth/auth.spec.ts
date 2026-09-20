import { AppException } from '../common/errors/app.exception.js';
import { assertPasswordStrong, isPasswordStrong } from './password.policy.js';
import {
  createKeyedToken,
  createRefreshToken,
  decideRotation,
  deviceLabel,
  hashToken,
  parseKeyedToken,
  parseRefreshToken,
} from './refresh-token.js';

const SESSION_ID = '7c4a2f10-1b2c-4d3e-8f90-0a1b2c3d4e5f';

describe('password policy', () => {
  it.each(['Sunflower42x', 'motdepasse9', 'كلمةسرقوية12', 'Admin12345!'])('accepts %s', (password) => {
    expect(isPasswordStrong(password)).toBe(true);
  });

  it.each([
    ['too short', 'Abc12345'],
    ['no digit', 'OnlyLettersHere'],
    ['no letter', '1234567890123'],
    ['common', 'Password123'],
    ['too long', `a1${'x'.repeat(200)}`],
  ])('refuses a password that is %s', (_, password) => {
    expect(isPasswordStrong(password)).toBe(false);
  });

  it('throws PASSWORD_WEAK', () => {
    try {
      assertPasswordStrong('short1');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('PASSWORD_WEAK');
      expect((error as AppException).getStatus()).toBe(422);
    }
  });
});

describe('refresh tokens', () => {
  it('round-trips the session id and remember flag', () => {
    const { token, hash } = createRefreshToken(SESSION_ID, true);
    expect(parseRefreshToken(token)).toEqual({ sessionId: SESSION_ID, remember: true, token });
    expect(hash).toBe(hashToken(token));
    expect(hash).toHaveLength(64);
  });

  it('refuses malformed tokens', () => {
    expect(parseRefreshToken('nope')).toBeNull();
    expect(parseRefreshToken(undefined)).toBeNull();
    expect(parseRefreshToken(`${SESSION_ID}.2.${'a'.repeat(43)}`)).toBeNull();
  });

  it('produces a different token on each rotation', () => {
    expect(createRefreshToken(SESSION_ID, false).token).not.toBe(createRefreshToken(SESSION_ID, false).token);
  });

  describe('decideRotation', () => {
    const future = new Date(Date.now() + 60_000);
    const current = createRefreshToken(SESSION_ID, false);
    const previous = createRefreshToken(SESSION_ID, false);

    it('rotates the current token', () => {
      expect(decideRotation({ tokenHash: current.hash, revokedAt: null, expiresAt: future }, current.token)).toBe('rotate');
    });

    it('detects reuse of an already-rotated token', () => {
      expect(decideRotation({ tokenHash: current.hash, revokedAt: null, expiresAt: future }, previous.token)).toBe(
        'reuse_detected',
      );
    });

    it('refuses revoked, expired and unknown sessions', () => {
      expect(decideRotation({ tokenHash: current.hash, revokedAt: new Date(), expiresAt: future }, current.token)).toBe('invalid');
      expect(decideRotation({ tokenHash: current.hash, revokedAt: null, expiresAt: new Date(0) }, current.token)).toBe('invalid');
      expect(decideRotation(null, current.token)).toBe('invalid');
    });
  });

  it('parses keyed single-use tokens', () => {
    const { token } = createKeyedToken(SESSION_ID);
    expect(parseKeyedToken(token)).toEqual({ id: SESSION_ID, token });
    expect(parseKeyedToken('abc')).toBeNull();
  });

  it('labels devices from the user agent', () => {
    expect(
      deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'),
    ).toBe('Chrome on Windows');
    expect(deviceLabel(null)).toBeNull();
  });
});
