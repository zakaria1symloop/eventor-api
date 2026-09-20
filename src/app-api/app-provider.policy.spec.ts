import { describe, expect, it } from 'vitest';
import { UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { assertProviderLive, isProviderLive, providerHomeState, REQUIRED_DOCUMENTS, verificationSteps, VERIFICATION_STEPS } from './app-provider.policy.js';

const live = { status: UserStatus.Active, verificationStatus: VerificationStatus.Verified };

describe('assertProviderLive', () => {
  it('lets a verified, active provider through', () => {
    expect(() => assertProviderLive(live)).not.toThrow();
    expect(isProviderLive(live)).toBe(true);
  });

  it('refuses a provider whose profile is still under review', () => {
    expect(() => assertProviderLive({ ...live, verificationStatus: VerificationStatus.Pending })).toThrow(expect.objectContaining({ code: 'PROVIDER_NOT_VERIFIED' }));
    expect(isProviderLive({ ...live, verificationStatus: VerificationStatus.Pending })).toBe(false);
  });

  it('refuses a rejected profile', () => {
    expect(() => assertProviderLive({ ...live, verificationStatus: VerificationStatus.Rejected })).toThrow(expect.objectContaining({ code: 'PROVIDER_NOT_VERIFIED' }));
  });

  it('refuses a blocked account before looking at the verification', () => {
    expect(() => assertProviderLive({ status: UserStatus.Blocked, verificationStatus: VerificationStatus.Verified })).toThrow(expect.objectContaining({ code: 'ACCOUNT_BLOCKED' }));
  });
});

describe('providerHomeState', () => {
  it('sends a verified provider to screen 21 and everybody else to 21a', () => {
    expect(providerHomeState(live)).toBe('verified');
    expect(providerHomeState({ ...live, verificationStatus: VerificationStatus.Pending })).toBe('pending');
    expect(providerHomeState({ ...live, verificationStatus: VerificationStatus.Rejected })).toBe('rejected');
    expect(providerHomeState({ status: UserStatus.Blocked, verificationStatus: VerificationStatus.Verified })).toBe('blocked');
  });
});

describe('verificationSteps (screen 21a)', () => {
  it('always returns the four steps in order', () => {
    expect(verificationSteps({ documentsSubmitted: 0, status: VerificationStatus.Pending }).map((s) => s.key)).toEqual([...VERIFICATION_STEPS]);
  });

  it('marks the account as created from the start, and nothing else', () => {
    const steps = verificationSteps({ documentsSubmitted: 0, status: VerificationStatus.Pending });
    expect(steps.filter((s) => s.done).map((s) => s.key)).toEqual(['account_created']);
    expect(steps.find((s) => s.current)?.key).toBe('documents_submitted');
  });

  it(`needs all ${REQUIRED_DOCUMENTS} documents before the "submitted" step is done`, () => {
    expect(verificationSteps({ documentsSubmitted: REQUIRED_DOCUMENTS - 1, status: VerificationStatus.Pending })[1]!.done).toBe(false);
    expect(verificationSteps({ documentsSubmitted: REQUIRED_DOCUMENTS, status: VerificationStatus.Pending })[1]!.done).toBe(true);
  });

  it('stops at "under review" while the documents are being checked', () => {
    const steps = verificationSteps({ documentsSubmitted: REQUIRED_DOCUMENTS, status: VerificationStatus.Pending });
    expect(steps.find((s) => s.current)?.key).toBe('approved');
    expect(steps.at(-1)!.done).toBe(false);
  });

  it('undoes "under review" when the documents were rejected', () => {
    const steps = verificationSteps({ documentsSubmitted: REQUIRED_DOCUMENTS, status: VerificationStatus.Rejected });
    expect(steps.find((s) => s.key === 'under_review')!.done).toBe(false);
    expect(steps.find((s) => s.current)?.key).toBe('under_review');
  });

  it('marks everything done once the account is verified, with no current step', () => {
    const steps = verificationSteps({ documentsSubmitted: REQUIRED_DOCUMENTS, status: VerificationStatus.Verified });
    expect(steps.every((s) => s.done)).toBe(true);
    expect(steps.some((s) => s.current)).toBe(false);
  });
});
