import { UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';

/**
 * The provider side of the app (`/app/provider/**`): who may publish and accept,
 * and the "Profile under review" state screen 21a draws. Pure functions, so the
 * home endpoint and the write endpoints cannot drift apart.
 */

/**
 * status-rules §2 / §3: only an active **and** verified provider publishes a
 * service or a pack, or accepts a booking. A pending one keeps read access and
 * gets screen 21a. Blocked accounts are stopped earlier by the guard, but the
 * check is repeated here because policies are called from jobs too.
 */
export function assertProviderLive(input: { status: UserStatus; verificationStatus: VerificationStatus }): void {
  if (input.status !== UserStatus.Active) throw AppException.of('ACCOUNT_BLOCKED');
  if (input.verificationStatus !== VerificationStatus.Verified) {
    throw AppException.of('PROVIDER_NOT_VERIFIED', { verificationStatus: input.verificationStatus });
  }
}

export function isProviderLive(input: { status: UserStatus; verificationStatus: VerificationStatus }): boolean {
  return input.status === UserStatus.Active && input.verificationStatus === VerificationStatus.Verified;
}

/** The three steps of "Profile under review" on screen 21a, in order. */
export const VERIFICATION_STEPS = ['account_created', 'documents_submitted', 'under_review', 'approved'] as const;
export type VerificationStep = (typeof VERIFICATION_STEPS)[number];

export interface VerificationStepState {
  key: VerificationStep;
  done: boolean;
  /** The step the spinner sits on; at most one is `current`. */
  current: boolean;
}

/**
 * Screen 21a "Profile under review": account created → documents submitted →
 * in progress → approved. `documentsRequired` is 3 (national id, register or
 * artisan card, tax card) per status-rules §2.
 */
export const REQUIRED_DOCUMENTS = 3;

export function verificationSteps(input: {
  documentsSubmitted: number;
  status: VerificationStatus;
}): VerificationStepState[] {
  const submitted = input.documentsSubmitted >= REQUIRED_DOCUMENTS;
  const approved = input.status === VerificationStatus.Verified;
  const done: Record<VerificationStep, boolean> = {
    account_created: true,
    documents_submitted: submitted,
    under_review: submitted && input.status !== VerificationStatus.Rejected,
    approved,
  };
  const first = VERIFICATION_STEPS.find((key) => !done[key]) ?? null;
  return VERIFICATION_STEPS.map((key) => ({ key, done: done[key], current: key === first }));
}

/**
 * What screen 21 / 21a shows above the fold. `pending` draws 21a with the
 * steps; `rejected` draws it with the rejection banner; `verified` draws the
 * full home; `blocked` is only reachable while a session is still alive.
 */
export type ProviderHomeState = 'verified' | 'pending' | 'rejected' | 'blocked';

export function providerHomeState(input: { status: UserStatus; verificationStatus: VerificationStatus }): ProviderHomeState {
  if (input.status !== UserStatus.Active) return 'blocked';
  if (input.verificationStatus === VerificationStatus.Verified) return 'verified';
  if (input.verificationStatus === VerificationStatus.Rejected) return 'rejected';
  return 'pending';
}
