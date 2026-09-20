import { DocumentStatus, DocumentType } from '../common/enums/file.enums.js';
import { VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import {
  assertDocumentTransition,
  deriveVerificationStatus,
  documentSummary,
  queueNeighbours,
  verificationTabOf,
} from './verification.policy.js';

const { NationalId: ID, CommercialRegisterOrArtisanCard: RC, TaxCard: TAX } = DocumentType;
const { Pending: P, Approved: A, Rejected: R } = DocumentStatus;

describe('deriveVerificationStatus', () => {
  it('is verified when the three documents are approved', () => {
    expect(deriveVerificationStatus([{ type: ID, status: A }, { type: RC, status: A }, { type: TAX, status: A }])).toBe(VerificationStatus.Verified);
  });

  it('is rejected when any document is rejected', () => {
    expect(deriveVerificationStatus([{ type: ID, status: A }, { type: RC, status: A }, { type: TAX, status: R }])).toBe(VerificationStatus.Rejected);
    expect(deriveVerificationStatus([{ type: ID, status: R }])).toBe(VerificationStatus.Rejected);
  });

  it('is pending otherwise (missing or pending documents)', () => {
    expect(deriveVerificationStatus([])).toBe(VerificationStatus.Pending);
    expect(deriveVerificationStatus([{ type: ID, status: A }, { type: RC, status: A }])).toBe(VerificationStatus.Pending);
    expect(deriveVerificationStatus([{ type: ID, status: A }, { type: RC, status: A }, { type: TAX, status: P }])).toBe(VerificationStatus.Pending);
  });
});

describe('documentSummary', () => {
  it('lists the three types in order with missing ones and counts progress', () => {
    expect(documentSummary([{ type: TAX, status: R }, { type: ID, status: A }])).toEqual({
      items: [
        { type: ID, status: A },
        { type: RC, status: 'missing' },
        { type: TAX, status: R },
      ],
      progress: { approved: 1, rejected: 1, waiting: 0, missing: 1 },
    });
  });
});

describe('verificationTabOf', () => {
  it('assigns exactly one tab', () => {
    expect(verificationTabOf({ verificationStatus: VerificationStatus.Verified, pendingCurrent: 0, pendingResubmitted: 0 })).toBe('approved');
    expect(verificationTabOf({ verificationStatus: VerificationStatus.Rejected, pendingCurrent: 2, pendingResubmitted: 0 })).toBe('rejected');
    expect(verificationTabOf({ verificationStatus: VerificationStatus.Pending, pendingCurrent: 2, pendingResubmitted: 1 })).toBe('resubmitted');
    expect(verificationTabOf({ verificationStatus: VerificationStatus.Pending, pendingCurrent: 2, pendingResubmitted: 0 })).toBe('waiting');
    expect(verificationTabOf({ verificationStatus: VerificationStatus.Pending, pendingCurrent: 0, pendingResubmitted: 0 })).toBe('incomplete');
  });
});

describe('assertDocumentTransition', () => {
  it('approves or rejects pending current documents and undoes decisions', () => {
    expect(assertDocumentTransition({ status: P, isCurrent: true }, 'approve')).toBe(A);
    expect(assertDocumentTransition({ status: P, isCurrent: true }, 'reject')).toBe(R);
    expect(assertDocumentTransition({ status: A, isCurrent: true }, 'undo')).toBe(P);
    expect(assertDocumentTransition({ status: R, isCurrent: true }, 'undo')).toBe(P);
  });

  it('refuses other moves and previous versions with DOCUMENT_INVALID_TRANSITION', () => {
    for (const [status, action] of [
      [A, 'approve'],
      [R, 'reject'],
      [A, 'reject'],
      [P, 'undo'],
    ] as const) {
      expect(() => assertDocumentTransition({ status, isCurrent: true }, action)).toThrow(AppException);
    }
    try {
      assertDocumentTransition({ status: P, isCurrent: false }, 'approve');
    } catch (error) {
      expect((error as AppException).code).toBe('DOCUMENT_INVALID_TRANSITION');
    }
  });
});

describe('queueNeighbours', () => {
  it('finds previous and next ids', () => {
    expect(queueNeighbours(['a', 'b', 'c'], 'b')).toEqual({ prevUserId: 'a', nextUserId: 'c', position: 2, total: 3 });
    expect(queueNeighbours(['a', 'b', 'c'], 'a')).toEqual({ prevUserId: null, nextUserId: 'b', position: 1, total: 3 });
    expect(queueNeighbours(['a'], 'z')).toEqual({ prevUserId: null, nextUserId: null, position: null, total: 1 });
  });
});
