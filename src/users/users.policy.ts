import { BookingStatus } from '../common/enums/booking.enums.js';
import { UserRole, UserStatus, VerificationStatus } from '../common/enums/user.enums.js';

/** Stored phone format: `+213` then 9 digits, the first not 0. */
export const PHONE_PATTERN = /^\+213[1-9]\d{8}$/;

/**
 * Normalises an Algerian phone number to `+213XXXXXXXXX`.
 * Accepts `0XXXXXXXXX`, `+213XXXXXXXXX`, `00213XXXXXXXXX` and `213XXXXXXXXX`,
 * with spaces, dots, dashes or parentheses. Returns null when it is not one.
 */
export function normalisePhone(value: string): string | null {
  const compact = value.trim().replace(/[\s.\-()]/g, '');
  let national: string | null = null;
  if (/^0[1-9]\d{8}$/.test(compact)) national = compact.slice(1);
  else if (/^\+213[1-9]\d{8}$/.test(compact)) national = compact.slice(4);
  else if (/^00213[1-9]\d{8}$/.test(compact)) national = compact.slice(5);
  else if (/^213[1-9]\d{8}$/.test(compact)) national = compact.slice(3);
  return national ? `+213${national}` : null;
}

/** class-transformer helper: normalised phone, or the raw value so the validator reports it. */
export const toPhone = ({ value }: { value: unknown }): unknown => {
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  if (value.trim() === '') return null;
  return normalisePhone(value) ?? value;
};

/** Case- and space-insensitive comparison for type-to-confirm dialogs. */
export function typedNameMatches(typed: string, fullName: string): boolean {
  const norm = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return norm(typed) !== '' && norm(typed) === norm(fullName);
}

/** Providers need verification; other roles never do. */
export function initialVerificationStatus(role: UserRole, skipVerification: boolean | undefined): VerificationStatus {
  if (role !== UserRole.Provider) return VerificationStatus.NotRequired;
  return skipVerification ? VerificationStatus.Verified : VerificationStatus.Pending;
}

/**
 * Visibility rule for a provider's published services and packs (status-rules
 * §3/§4): shown only while the provider is active and verified. Blocking hides
 * them without touching the rows, so unblocking shows them again.
 */
export function providerOffersVisible(user: { status: UserStatus; verificationStatus: VerificationStatus }): boolean {
  return user.status === UserStatus.Active && user.verificationStatus === VerificationStatus.Verified;
}

export type BookingChoice = 'cancel' | 'keep';

export interface BlockImpactInput {
  role: UserRole;
  /** Published services / packs (hidden by the block). */
  publishedServices: number;
  publishedPacks: number;
  /** Booking counts by status for the user (as client or provider). */
  bookings: { status: BookingStatus; upcoming: boolean; count: number }[];
  openConversations: number;
}

export interface BlockImpact {
  servicesCount: number;
  packsCount: number;
  pendingBookings: number;
  upcomingBookings: number;
  conversations: number;
}

/** USR-07 impact box. Clients own no services or packs; upcoming = accepted with a date from today. */
export function computeBlockImpact(input: BlockImpactInput): BlockImpact {
  const isProvider = input.role === UserRole.Provider;
  const sum = (predicate: (row: BlockImpactInput['bookings'][number]) => boolean) =>
    input.bookings.filter(predicate).reduce((total, row) => total + row.count, 0);
  return {
    servicesCount: isProvider ? input.publishedServices : 0,
    packsCount: isProvider ? input.publishedPacks : 0,
    pendingBookings: sum((b) => b.status === BookingStatus.Pending),
    upcomingBookings: sum((b) => b.status === BookingStatus.Accepted && b.upcoming),
    conversations: input.openConversations,
  };
}

/** Pending bookings are cancelled only when the admin chose `cancel`. */
export function bookingsToCancel(choice: BookingChoice, pendingBookingIds: string[]): string[] {
  return choice === 'cancel' ? pendingBookingIds : [];
}

/** Soft delete is refused while there is an accepted upcoming booking or an open dispute. */
export function activeItemsBlockingDelete(counts: { upcomingBookings: number; openDisputes: number }): typeof counts | null {
  return counts.upcomingBookings > 0 || counts.openDisputes > 0 ? counts : null;
}

/** Days after a soft delete before personal data is anonymised. */
export const ANONYMISE_AFTER_DAYS = 30;

/** Fields written over personal data by the anonymisation job. */
export function anonymisedFields(id: string): {
  fullName: string;
  email: string;
  phone: null;
  passwordHash: null;
  avatarFileId: null;
  blockedMessage: null;
  lastActiveAt: null;
} {
  return {
    fullName: 'Deleted user',
    email: `deleted-${id}@anonymised.eventor.invalid`,
    phone: null,
    passwordHash: null,
    avatarFileId: null,
    blockedMessage: null,
    lastActiveAt: null,
  };
}

/**
 * Applied the moment an account is deleted: `email` and `phone` are unique across
 * deleted rows too, so keeping them until the 30-day anonymisation would block a new
 * sign-up or an admin invitation with the same address. The rest waits for the job.
 */
export function releasedContactFields(id: string): { email: string; phone: null } {
  const { email, phone } = anonymisedFields(id);
  return { email, phone };
}

/** A temporary password that satisfies the password policy (letters and digits, 14 characters). */
export function generateTemporaryPassword(random: (max: number) => number): string {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  const chars = [letters[random(letters.length)]!, digits[random(digits.length)]!];
  while (chars.length < 14) chars.push(all[random(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
