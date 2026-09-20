export enum ReviewStatus {
  Published = 'published',
  Hidden = 'hidden',
  Redacted = 'redacted',
}

export enum ReportTargetType {
  Review = 'review',
  Message = 'message',
  Service = 'service',
  User = 'user',
  Pack = 'pack',
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

export enum ConversationKind {
  Direct = 'direct',
  Support = 'support',
}

export enum ConversationStatus {
  Open = 'open',
  Closed = 'closed',
}

export enum ClosedScope {
  All = 'all',
  OneParticipant = 'one_participant',
}

export enum ParticipantRole {
  Client = 'client',
  Provider = 'provider',
  Academic = 'academic',
  Support = 'support',
}

export enum MessageKind {
  Text = 'text',
  Attachment = 'attachment',
  System = 'system',
}

export enum MessageStatus {
  Visible = 'visible',
  Hidden = 'hidden',
  Deleted = 'deleted',
}
