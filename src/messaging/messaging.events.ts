import type { Lang } from '../common/i18n/language.js';
import type { AdminMessageDto } from './dto/messaging.dto.js';

export const MESSAGING_EVENTS = {
  /** A message was inserted (any sender, including system messages). Pushed to `/admin` sockets. */
  messageCreated: 'message.created',
  /** A message was hidden, shown again or deleted by an admin. */
  messageUpdated: 'message.updated',
  /** Status, participants or read state changed. */
  conversationUpdated: 'conversation.updated',
  /** An admin wrote to users from MSG-02 and asked for an email copy. */
  supportMessageEmailed: 'conversation.support_message_emailed',
} as const;

export interface MessageCreatedEvent {
  conversationId: string;
  message: AdminMessageDto;
}

export interface MessageUpdatedEvent {
  conversationId: string;
  message: AdminMessageDto;
}

export interface ConversationUpdatedEvent {
  conversationId: string;
  reason: 'created' | 'message' | 'read' | 'closed' | 'reopened' | 'moderated' | 'participant_joined';
}

export interface SupportMessageEmailedEvent {
  conversationId: string;
  body: string;
  recipients: { userId: string; email: string; name: string; lang: Lang }[];
}
