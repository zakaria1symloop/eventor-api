import type { Lang } from '../common/i18n/language.js';
import type { DocumentRejectReason, DocumentType } from '../common/enums/file.enums.js';
import type { VerificationStatus } from '../common/enums/user.enums.js';

export const VERIFICATION_EVENTS = {
  /** The provider's verification status changed after a document decision or upload. */
  statusChanged: 'provider.verification_status_changed',
  /** All three documents approved: "Profile approved" (🔔📱✉️). */
  verified: 'provider.verified',
  documentRejected: 'document.rejected',
  documentUploaded: 'document.uploaded',
} as const;

export interface VerificationStatusChangedEvent {
  userId: string;
  from: VerificationStatus;
  to: VerificationStatus;
}

export interface ProviderVerifiedEvent {
  userId: string;
  email: string;
  name: string;
  lang: Lang;
}

export interface DocumentRejectedEvent extends ProviderVerifiedEvent {
  documentId: string;
  type: DocumentType;
  reasonCode: DocumentRejectReason;
  message: string;
}

export interface DocumentUploadedEvent {
  documentId: string;
  userId: string;
  type: DocumentType;
  uploadedById: string | null;
}
