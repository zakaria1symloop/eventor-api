export enum DisputeType {
  ProviderNoShow = 'provider_no_show',
  ClientNoShow = 'client_no_show',
  ServiceNotAsDescribed = 'service_not_as_described',
  IncompleteOrLate = 'incomplete_or_late',
  PriceDisagreement = 'price_disagreement',
  CancellationDisagreement = 'cancellation_disagreement',
  DamageOrSafety = 'damage_or_safety',
  Behaviour = 'behaviour',
  Other = 'other',
}

export enum DisputeStatus {
  Open = 'open',
  InReview = 'in_review',
  Resolved = 'resolved',
  Closed = 'closed',
}

export enum DisputeBookingOutcome {
  Completed = 'completed',
  Cancelled = 'cancelled',
  Unchanged = 'unchanged',
}

export enum DisputeEvidenceKind {
  File = 'file',
  ChatSnapshot = 'chat_snapshot',
  Note = 'note',
}

export enum ReviewStatus {
  Published = 'published',
  Hidden = 'hidden',
  Redacted = 'redacted',
}

export enum ReviewReplyStatus {
  Published = 'published',
  Hidden = 'hidden',
}

export enum ReportTargetType {
  Review = 'review',
  ReviewReply = 'review_reply',
  Message = 'message',
  Service = 'service',
  Pack = 'pack',
  User = 'user',
}

export enum ReportReason {
  Inappropriate = 'inappropriate',
  Spam = 'spam',
  ContactOutside = 'contact_outside',
  Harassment = 'harassment',
  Fake = 'fake',
  Other = 'other',
}

export enum ReportStatus {
  Open = 'open',
  Resolved = 'resolved',
  Dismissed = 'dismissed',
}
