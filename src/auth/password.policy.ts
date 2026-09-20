import { AppException } from '../common/errors/app.exception.js';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Passwords that meet the length/letter/digit rule but are still guessed first. */
const COMMON_PASSWORDS = new Set([
  'password123',
  'password1234',
  'passw0rd123',
  'qwerty12345',
  'qwerty123456',
  'azerty12345',
  'azerty123456',
  'abc1234567',
  'abcd123456',
  'a123456789',
  '123456789a',
  '1234567890a',
  'iloveyou123',
  'welcome123',
  'welcome1234',
  'admin12345',
  'admin123456',
  'administrator1',
  'eventor123',
  'eventor2026',
  'letmein1234',
  'football123',
  'princess123',
  'sunshine123',
  'algerie2026',
  'algeria123',
  'dzair12345',
]);

/** tech-decisions (Auth): ≥ 10 characters, at least one letter and one digit, not a common password. */
export function isPasswordStrong(password: string): boolean {
  if (typeof password !== 'string') return false;
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return false;
  if (!/\p{L}/u.test(password) || !/\p{Nd}/u.test(password)) return false;
  return !COMMON_PASSWORDS.has(password.toLowerCase());
}

/** Throws 422 PASSWORD_WEAK when the password breaks the policy. */
export function assertPasswordStrong(password: string): void {
  if (!isPasswordStrong(password)) {
    throw AppException.of('PASSWORD_WEAK', { minLength: PASSWORD_MIN_LENGTH });
  }
}
