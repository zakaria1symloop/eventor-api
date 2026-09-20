import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ExportRegistry } from '../exports/export-registry.js';
import { MailService } from '../mail/mail.service.js';
import { AdminConversationsController, AdminMessagesController } from './admin-conversations.controller.js';
import { ConversationFiltersDto } from './dto/messaging.dto.js';
import { MessagingGateway } from './messaging.gateway.js';
import { MESSAGING_EVENTS, type SupportMessageEmailedEvent } from './messaging.events.js';
import { MessagingService } from './messaging.service.js';

/** Email copies of support messages sent from MSG-02. */
@Injectable()
export class MessagingMailListener {
  constructor(private readonly mail: MailService) {}

  @OnEvent(MESSAGING_EVENTS.supportMessageEmailed)
  async onSupportMessage(event: SupportMessageEmailedEvent): Promise<void> {
    for (const recipient of event.recipients) {
      if (!recipient.email) continue;
      await this.mail.enqueue({ to: recipient.email, template: 'support-message', lang: recipient.lang, data: { name: recipient.name, body: event.body } });
    }
  }
}

/** Module 11: conversations, moderation, support messages and the `/admin` socket (MSG-01…MSG-03). */
@Module({
  controllers: [AdminConversationsController, AdminMessagesController],
  providers: [MessagingService, MessagingGateway, MessagingMailListener],
  exports: [MessagingService, MessagingGateway],
})
export class MessagingModule implements OnModuleInit {
  constructor(
    private readonly messaging: MessagingService,
    private readonly exports: ExportRegistry,
  ) {}

  onModuleInit(): void {
    type Row = Awaited<ReturnType<MessagingService['exportRows']>>[number];
    this.exports.register<ConversationFiltersDto, Row>({
      resource: 'conversations',
      screens: 'MSG-01',
      filters: ConversationFiltersDto,
      columns: [
        { key: 'id', header: 'Conversation id', value: (c) => c.id },
        { key: 'kind', header: 'Kind', value: (c) => c.kind },
        { key: 'status', header: 'Status', value: (c) => c.status },
        { key: 'participants', header: 'Participants', value: (c) => c.participants },
        { key: 'booking', header: 'Booking', value: (c) => c.bookingReference },
        { key: 'messagesCount', header: 'Messages', value: (c) => c.messagesCount },
        { key: 'reportsOpen', header: 'Open reports', value: (c) => c.reportsOpen },
        { key: 'closedReason', header: 'Closed reason', value: (c) => c.closedReason },
        { key: 'createdAt', header: 'Created (UTC)', value: (c) => c.createdAt },
        { key: 'lastMessageAt', header: 'Last message (UTC)', value: (c) => c.lastMessageAt },
      ],
      count: (filters) => this.messaging.exportCount(filters),
      fetch: (filters, page) => this.messaging.exportRows(filters, page),
    });
  }
}
