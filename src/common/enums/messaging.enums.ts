export enum ConversationKind {
  Direct = 'direct',
  Support = 'support',
  Dispute = 'dispute',
}

export enum ConversationStatus {
  Open = 'open',
  Closed = 'closed',
}

export enum ConversationClosedScope {
  All = 'all',
  OneParticipant = 'one_participant',
}

export enum ParticipantRole {
  Client = 'client',
  Provider = 'provider',
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

export enum DevicePlatform {
  Android = 'android',
  Ios = 'ios',
  Web = 'web',
}
