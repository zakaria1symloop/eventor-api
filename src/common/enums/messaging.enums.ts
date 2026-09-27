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

/**
 * One ceiling for every message body, wherever it is sent from (app chat,
 * dispute chat, admin support message). Exposed to the app in
 * `GET /app/config` as `limits.messageMaxLength`.
 */
export const MESSAGE_MAX_LENGTH = 4000;

export enum DevicePlatform {
  Android = 'android',
  Ios = 'ios',
  Web = 'web',
}
