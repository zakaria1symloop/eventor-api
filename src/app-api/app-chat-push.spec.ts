/** Chat pushes (`message.new`): who gets them and what they show. Database and services are fakes. */
import { describe, expect, it, vi } from 'vitest';
import { ConversationKind, MessageKind } from '../common/enums/messaging.enums.js';
import { UserRole } from '../common/enums/user.enums.js';
import { AppChatPushListener } from './app-chat-push.listener.js';

const SENDER = 'client-1';
const OTHER = 'provider-1';

function setup(kind: ConversationKind, options: { businessName?: string; reader?: { body: string; kind: MessageKind } } = {}) {
  const dataSource = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT kind FROM conversations')) return [{ kind }];
      if (sql.startsWith('SELECT business_name')) return options.businessName ? [{ business_name: options.businessName }] : [];
      return [];
    }),
  };
  const messages = {
    socketMessage: vi.fn(async () => ({
      recipients: [SENDER, OTHER],
      message: (userId: string) => options.reader ?? { body: `Call me on [phone hidden] (for ${userId})`, kind: MessageKind.Text },
    })),
  };
  const notifications = { push: vi.fn(async () => undefined) };
  const listener = new AppChatPushListener(dataSource as any, messages as any, notifications as any);
  return { listener, calls: () => notifications.push.mock.calls as any[][], notifications };
}

const event = (sender: { id: string; role: UserRole } | null, kind = MessageKind.Text) => ({
  conversationId: 'c-1',
  message: { id: 'm-1', kind, sender: sender ? { ...sender, fullName: 'Amina Benali', avatarUrl: null } : null } as any,
});

describe('AppChatPushListener', () => {
  it('pushes the masked text to the other participant, titled with the sender name', async () => {
    const t = setup(ConversationKind.Direct);
    await t.listener.onMessageCreated(event({ id: SENDER, role: UserRole.Client }));
    const [userIds, type, build] = t.calls()[0]!;
    expect(userIds).toEqual([OTHER]);
    expect(type).toBe('message.new');
    expect(build(OTHER, 'en')).toEqual({
      title: 'Amina Benali',
      body: `Call me on [phone hidden] (for ${OTHER})`,
      data: { conversationId: 'c-1', messageId: 'm-1', conversationKind: 'direct' },
    });
  });

  it('names a provider by business name and shows a photo without caption', async () => {
    const t = setup(ConversationKind.Direct, { businessName: 'Studio Lumière', reader: { body: '', kind: MessageKind.Attachment } });
    await t.listener.onMessageCreated(event({ id: SENDER, role: UserRole.Provider }, MessageKind.Attachment));
    const build = t.calls()[0]![2];
    expect(build(OTHER, 'en')).toMatchObject({ title: 'Studio Lumière', body: '📷 Photo' });
    expect(build(OTHER, 'ar').body).toBe('📷 صورة');
  });

  it('titles a support reply "Eventor support" in the reader language', async () => {
    const t = setup(ConversationKind.Support);
    await t.listener.onMessageCreated(event({ id: 'admin-1', role: UserRole.Admin }));
    const [userIds, , build] = t.calls()[0]!;
    expect(userIds).toEqual([SENDER, OTHER]);
    expect(build(SENDER, 'en').title).toBe('Eventor support');
    expect(build(SENDER, 'ar').title).toBe('دعم Eventor');
  });

  it('skips dispute chats and system messages (they have their own notifications)', async () => {
    const dispute = setup(ConversationKind.Dispute);
    await dispute.listener.onMessageCreated(event({ id: SENDER, role: UserRole.Client }));
    const system = setup(ConversationKind.Direct);
    await system.listener.onMessageCreated(event(null, MessageKind.System));
    expect(dispute.notifications.push).not.toHaveBeenCalled();
    expect(system.notifications.push).not.toHaveBeenCalled();
  });
});
