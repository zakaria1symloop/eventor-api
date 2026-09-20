import { BookingStatus } from '../common/enums/booking.enums.js';
import { UserRole, UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { isPasswordStrong } from '../auth/password.policy.js';
import {
  activeItemsBlockingDelete,
  bookingsToCancel,
  computeBlockImpact,
  generateTemporaryPassword,
  initialVerificationStatus,
  normalisePhone,
  providerOffersVisible,
  toPhone,
  typedNameMatches,
} from './users.policy.js';

describe('normalisePhone', () => {
  it.each([
    ['0550123456', '+213550123456'],
    ['0661 23 45 67', '+213661234567'],
    ['07-71-23-45-67', '+213771234567'],
    ['+213550123456', '+213550123456'],
    ['+213 550 12 34 56', '+213550123456'],
    ['00213550123456', '+213550123456'],
    ['213550123456', '+213550123456'],
    ['021 23 45 67 8', '+213212345678'],
    ['021234567', null],
  ])('%s → %s', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });

  it('rejects wrong lengths, a leading 0 after the country code and other countries', () => {
    expect(normalisePhone('055012345')).toBeNull();
    expect(normalisePhone('05501234567')).toBeNull();
    expect(normalisePhone('+2130550123456')).toBeNull();
    expect(normalisePhone('+33612345678')).toBeNull();
    expect(normalisePhone('abc')).toBeNull();
  });

  it('toPhone keeps invalid input for the validator and maps empty to null', () => {
    expect(toPhone({ value: '0550123456' })).toBe('+213550123456');
    expect(toPhone({ value: '12' })).toBe('12');
    expect(toPhone({ value: '  ' })).toBeNull();
    expect(toPhone({ value: null })).toBeNull();
  });
});

describe('computeBlockImpact', () => {
  const bookings = [
    { status: BookingStatus.Pending, upcoming: true, count: 2 },
    { status: BookingStatus.Pending, upcoming: false, count: 1 },
    { status: BookingStatus.Accepted, upcoming: true, count: 4 },
    { status: BookingStatus.Accepted, upcoming: false, count: 7 },
  ];

  it('counts published offers, pending bookings, upcoming accepted bookings and open conversations for a provider', () => {
    expect(
      computeBlockImpact({ role: UserRole.Provider, publishedServices: 12, publishedPacks: 2, bookings, openConversations: 8 }),
    ).toEqual({ servicesCount: 12, packsCount: 2, pendingBookings: 3, upcomingBookings: 4, conversations: 8 });
  });

  it('never reports services or packs for a client', () => {
    expect(
      computeBlockImpact({ role: UserRole.Client, publishedServices: 5, publishedPacks: 1, bookings: [], openConversations: 0 }),
    ).toEqual({ servicesCount: 0, packsCount: 0, pendingBookings: 0, upcomingBookings: 0, conversations: 0 });
  });

  it('cancels pending bookings only when asked', () => {
    expect(bookingsToCancel('cancel', ['a', 'b'])).toEqual(['a', 'b']);
    expect(bookingsToCancel('keep', ['a', 'b'])).toEqual([]);
  });
});

describe('account rules', () => {
  it('refuses delete while there are upcoming bookings or open disputes', () => {
    expect(activeItemsBlockingDelete({ upcomingBookings: 0, openDisputes: 0 })).toBeNull();
    expect(activeItemsBlockingDelete({ upcomingBookings: 1, openDisputes: 0 })).toEqual({ upcomingBookings: 1, openDisputes: 0 });
    expect(activeItemsBlockingDelete({ upcomingBookings: 0, openDisputes: 2 })).not.toBeNull();
  });

  it('matches the typed name ignoring case and extra spaces', () => {
    expect(typedNameMatches('  karim   BELKACEM ', 'Karim Belkacem')).toBe(true);
    expect(typedNameMatches('Karim', 'Karim Belkacem')).toBe(false);
    expect(typedNameMatches('', '')).toBe(false);
  });

  it('sets the initial verification status by role', () => {
    expect(initialVerificationStatus(UserRole.Client, true)).toBe(VerificationStatus.NotRequired);
    expect(initialVerificationStatus(UserRole.Provider, false)).toBe(VerificationStatus.Pending);
    expect(initialVerificationStatus(UserRole.Provider, true)).toBe(VerificationStatus.Verified);
  });

  it('shows provider offers only while active and verified', () => {
    expect(providerOffersVisible({ status: UserStatus.Active, verificationStatus: VerificationStatus.Verified })).toBe(true);
    expect(providerOffersVisible({ status: UserStatus.Blocked, verificationStatus: VerificationStatus.Verified })).toBe(false);
    expect(providerOffersVisible({ status: UserStatus.Active, verificationStatus: VerificationStatus.Pending })).toBe(false);
  });

  it('generates temporary passwords that pass the password policy', () => {
    let seed = 7;
    const random = (max: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % max;
    };
    for (let i = 0; i < 50; i++) {
      const password = generateTemporaryPassword(random);
      expect(password).toHaveLength(14);
      expect(isPasswordStrong(password)).toBe(true);
    }
  });
});
