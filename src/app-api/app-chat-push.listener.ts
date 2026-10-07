import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { ConversationKind, MessageKind } from '../common/enums/messaging.enums.js';
import { UserRole } from '../common/enums/user.enums.js';
import { MESSAGING_EVENTS, type MessageCreatedEvent } from '../messaging/messaging.events.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AppMessagesService } from './app-messages.service.js';

/**
 * 📱 `message.new`: a push to the other participants' phones for each chat
 * message, its text masked for each reader exactly like the socket's
 * `message:new`. No notification row (chats have their own unread counts).
 * Dispute chats are covered by `dispute.message`, and system messages by the
 * booking notifications, so both are skipped.
 */
@Injectable()
export class AppChatPushListener {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly messages: AppMessagesService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(MESSAGING_EVENTS.messageCreated)
  async onMessageCreated(event: MessageCreatedEvent): Promise<void> {
    const sender = event.message.sender;
    if (!sender || event.message.kind === MessageKind.System) return;
    const [conversation]: { kind: ConversationKind }[] = await this.dataSource.query('SELECT kind FROM conversations WHERE id = ?', [event.conversationId]);
    if (!conversation || conversation.kind === ConversationKind.Dispute) return;
    const payload = await this.messages.socketMessage(event.conversationId, event.message.id);
    if (!payload) return;
    // The name the chat list shows: business name for a provider, "Eventor support" for an admin.
    let name: string | null = null;
    if (sender.role !== UserRole.Admin) {
      const [profile] = await this.dataSource.query('SELECT business_name FROM provider_profiles WHERE user_id = ? AND deleted_at IS NULL', [sender.id]);
      name = profile?.business_name || sender.fullName;
    }
    await this.notifications.push(
      payload.recipients.filter((id) => id !== sender.id),
      'message.new',
      (userId, lang) => {
        const message = payload.message(userId);
        const ar = lang === 'ar';
        return {
          title: name ?? (ar ? 'دعم Eventor' : 'Eventor support'),
          body: message.body || (message.kind === MessageKind.Attachment ? (ar ? '📷 صورة' : '📷 Photo') : ''),
          data: { conversationId: event.conversationId, messageId: event.message.id, conversationKind: conversation.kind },
        };
      },
    );
  }
}
