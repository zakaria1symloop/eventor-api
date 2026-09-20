import { DocumentStatus, DocumentType } from '../common/enums/file.enums.js';
import { VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';

/** The three documents a provider needs, in review order (VER-02). */
export const REQUIRED_DOCUMENT_TYPES: readonly DocumentType[] = [
  DocumentType.NationalId,
  DocumentType.CommercialRegisterOrArtisanCard,
  DocumentType.TaxCard,
];

export const VERIFICATION_TABS = ['waiting', 'resubmitted', 'approved', 'rejected', 'incomplete', 'all'] as const;
export type VerificationTab = (typeof VERIFICATION_TABS)[number];
export type VerificationRowStatus = Exclude<VerificationTab, 'all'>;

/**
 * `users.verification_status` from the current documents (status-rules §2):
 * any rejected → rejected; all three approved → verified; otherwise pending.
 */
export function deriveVerificationStatus(currentDocuments: { type: DocumentType; status: DocumentStatus }[]): VerificationStatus {
  if (currentDocuments.some((d) => d.status === DocumentStatus.Rejected)) return VerificationStatus.Rejected;
  const approved = new Set(currentDocuments.filter((d) => d.status === DocumentStatus.Approved).map((d) => d.type));
  return REQUIRED_DOCUMENT_TYPES.every((type) => approved.has(type)) ? VerificationStatus.Verified : VerificationStatus.Pending;
}

/** One entry per required type, `missing` when there is no current document. */
export function documentSummary(currentDocuments: { type: DocumentType; status: DocumentStatus }[]): {
  items: { type: DocumentType; status: DocumentStatus | 'missing' }[];
  progress: { approved: number; rejected: number; waiting: number; missing: number };
} {
  const byType = new Map(currentDocuments.map((d) => [d.type, d.status]));
  const items = REQUIRED_DOCUMENT_TYPES.map((type) => ({ type, status: byType.get(type) ?? ('missing' as const) }));
  const count = (status: DocumentStatus | 'missing') => items.filter((i) => i.status === status).length;
  return {
    items,
    progress: {
      approved: count(DocumentStatus.Approved),
      rejected: count(DocumentStatus.Rejected),
      waiting: count(DocumentStatus.Pending),
      missing: count('missing'),
    },
  };
}

/**
 * VER-01 tab of one provider (exclusive):
 * verified → approved; rejected → rejected; a pending current document that
 * replaces an older version → resubmitted; any other pending document → waiting;
 * nothing to review → incomplete.
 */
export function verificationTabOf(input: {
  verificationStatus: VerificationStatus;
  pendingCurrent: number;
  pendingResubmitted: number;
}): VerificationRowStatus {
  if (input.verificationStatus === VerificationStatus.Verified) return 'approved';
  if (input.verificationStatus === VerificationStatus.Rejected) return 'rejected';
  if (input.pendingResubmitted > 0) return 'resubmitted';
  if (input.pendingCurrent > 0) return 'waiting';
  return 'incomplete';
}

export type DocumentAction = 'approve' | 'reject' | 'undo';

/** pending → approved | rejected; approved | rejected → pending (undo). Only current versions. */
export function assertDocumentTransition(document: { status: DocumentStatus; isCurrent: boolean }, action: DocumentAction): DocumentStatus {
  const to =
    action === 'approve' ? DocumentStatus.Approved : action === 'reject' ? DocumentStatus.Rejected : DocumentStatus.Pending;
  const allowed = action === 'undo' ? document.status !== DocumentStatus.Pending : document.status === DocumentStatus.Pending;
  if (!document.isCurrent || !allowed) {
    throw AppException.of('DOCUMENT_INVALID_TRANSITION', { from: document.isCurrent ? document.status : 'previous_version', to });
  }
  return to;
}

/** Previous / next user id around `userId` in an ordered queue. */
export function queueNeighbours(orderedIds: string[], userId: string): { prevUserId: string | null; nextUserId: string | null; position: number | null; total: number } {
  const index = orderedIds.indexOf(userId);
  if (index === -1) return { prevUserId: null, nextUserId: null, position: null, total: orderedIds.length };
  return {
    prevUserId: index > 0 ? orderedIds[index - 1]! : null,
    nextUserId: index < orderedIds.length - 1 ? orderedIds[index + 1]! : null,
    position: index + 1,
    total: orderedIds.length,
  };
}
