import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer, type OnGatewayConnection, type OnGatewayInit } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import type { DataSource } from 'typeorm';
import { Session } from '../auth/entities/session.entity.js';
import { TokenService } from '../auth/token.service.js';
import { SessionAudience } from '../common/enums/auth.enums.js';
import { UserRole, UserStatus } from '../common/enums/user.enums.js';
import { BOOKING_EVENTS, type BookingEvent, type BookingStatusChangedEvent } from '../bookings/bookings.events.js';
import { MESSAGING_EVENTS, type ConversationUpdatedEvent, type MessageCreatedEvent } from '../messaging/messaging.events.js';
import { NOTIFICATION_EVENTS, type UserNotificationCreatedEvent } from '../notifications/notifications.service.js';
import { User } from '../users/entities/user.entity.js';
import { socketToken } from '../messaging/messaging.gateway.js';
import { AppMessagesService } from './app-messages.service.js';

/** One room per signed-in user; every socket of that account joins it. */
export const appUserRoom = (userId: string) => `user:${userId}`;
/** One room per chat the app opened, so screen 15 only gets its own messages. */
export const appConversationRoom = (id: string) => `conversation:${id}`;

interface SocketData {
  userId: string;
  role: UserRole;
}

/**
 * Live updates for the mobile app, on namespace **`/app`** (same port and CORS
 * policy as the API). Connect with the **app** access token — a dashboard token
 * is refused, exactly as on `/app/**` over HTTP.
 *
 * ```ts
 * io(`${API_URL}/app`, { auth: { token: accessToken } })
 * ```
 *
 * Every socket joins `user:<your id>`. `conversation:join` adds
 * `conversation:<id>` after checking you are a participant, so a room cannot be
 * joined by guessing an id.
 *
 * Server events:
 * - `message:new` — an app message, already masked for **you** (screen 15).
 * - `conversation:updated` — `{ conversationId, reason }`, refresh screen 14.
 * - `booking:updated` — `{ bookingId, reference, status }` for both parties; `status` is always the current one.
 * - `notification:new` — the same row `GET /app/me/notifications` returns.
 *
 * A refused handshake fails with `connect_error` whose `data.code` is the API
 * error code (`AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`,
 * `AUTH_SESSION_REVOKED`, `ACCOUNT_BLOCKED`, `FORBIDDEN_AUDIENCE`).
 */
@WebSocketGateway({ namespace: '/app' })
export class AppGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(AppGateway.name);

  @WebSocketServer()
  server: Namespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly messages: AppMessagesService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      void this.authenticate(socket).then((code) => {
        if (!code) return next();
        const error = new Error(code) as Error & { data?: unknown };
        error.data = { code };
        next(error);
      });
    });
  }

  async handleConnection(socket: Socket): Promise<void> {
    const data = socket.data as SocketData;
    await socket.join(appUserRoom(data.userId));
    socket.emit('ready', { userId: data.userId, role: data.role });
  }

  /** Null when the socket belongs to an active client or provider with a live **app** session. */
  private async authenticate(socket: Socket): Promise<string | null> {
    const token = socketToken(socket);
    if (!token) return 'AUTH_TOKEN_MISSING';
    let payload;
    try {
      payload = await this.tokens.verifyAccessToken(token);
    } catch (error) {
      return (error as { name?: string }).name === 'TokenExpiredError' ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID';
    }
    try {
      if (payload.aud !== SessionAudience.App) return 'FORBIDDEN_AUDIENCE';
      const session = payload.sid ? await this.dataSource.getRepository(Session).findOneBy({ id: payload.sid }) : null;
      if (!session || session.userId !== payload.sub) return 'AUTH_TOKEN_INVALID';
      if (session.revokedAt || session.expiresAt.getTime() <= Date.now()) return 'AUTH_SESSION_REVOKED';
      const user = await this.dataSource.getRepository(User).findOneBy({ id: payload.sub });
      if (!user) return 'AUTH_SESSION_REVOKED';
      if (user.status === UserStatus.Blocked) return 'ACCOUNT_BLOCKED';
      if (user.role === UserRole.Admin) return 'FORBIDDEN_ROLE';
      socket.data = { userId: user.id, role: user.role } satisfies SocketData;
      return null;
    } catch (error) {
      this.logger.error(`App socket authentication failed: ${(error as Error).message}`);
      return 'INTERNAL_ERROR';
    }
  }

  @SubscribeMessage('conversation:join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: unknown }) {
    if (typeof body?.conversationId !== 'string') return { ok: false, code: 'VALIDATION_FAILED' };
    const { userId } = socket.data as SocketData;
    const [row] = await this.dataSource.query('SELECT id FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [body.conversationId, userId]);
    if (!row) return { ok: false, code: 'NOT_A_PARTICIPANT' };
    await socket.join(appConversationRoom(body.conversationId));
    return { ok: true, room: appConversationRoom(body.conversationId) };
  }

  @SubscribeMessage('conversation:leave')
  async leave(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: unknown }) {
    if (typeof body?.conversationId !== 'string') return { ok: false, code: 'VALIDATION_FAILED' };
    await socket.leave(appConversationRoom(body.conversationId));
    return { ok: true };
  }

  /**
   * Masking depends on who is reading, so the message is rendered once per
   * participant and sent to that participant's own room.
   */
  @OnEvent(MESSAGING_EVENTS.messageCreated)
  async onMessageCreated(event: MessageCreatedEvent): Promise<void> {
    if (!this.server) return;
    const payload = await this.messages.socketMessage(event.conversationId, event.message.id);
    if (!payload) return;
    for (const userId of payload.recipients) {
      this.server.to(appUserRoom(userId)).emit('message:new', payload.message(userId));
      this.server.to(appUserRoom(userId)).emit('conversation:updated', { conversationId: event.conversationId, reason: 'message' });
    }
  }

  @OnEvent(MESSAGING_EVENTS.conversationUpdated)
  async onConversationUpdated(event: ConversationUpdatedEvent): Promise<void> {
    if (!this.server) return;
    const rows: { user_id: string }[] = await this.dataSource.query('SELECT user_id FROM conversation_participants WHERE conversation_id = ?', [event.conversationId]);
    for (const row of rows) this.server.to(appUserRoom(row.user_id)).emit('conversation:updated', event);
  }

  @OnEvent(NOTIFICATION_EVENTS.userCreated)
  onNotification(event: UserNotificationCreatedEvent): void {
    this.server?.to(appUserRoom(event.userId)).emit('notification:new', event.notification);
  }

  /** Both parties see a booking move without polling the Bookings tab. */
  @OnEvent('booking.*')
  async onBooking(event: BookingEvent & Partial<BookingStatusChangedEvent>): Promise<void> {
    if (!this.server || !event?.bookingId) return;
    // Only status changes carry `to`; created / cancelled / rescheduled events don't, and they
    // are emitted after commit, so the row already holds the status to send.
    let status: string | null = event.to ?? null;
    if (!status) {
      const [row]: { status: string }[] = await this.dataSource.query('SELECT status FROM bookings WHERE id = ?', [event.bookingId]);
      status = row?.status ?? null;
    }
    const payload = { bookingId: event.bookingId, reference: event.reference, status };
    for (const userId of [event.clientId, event.providerId]) {
      if (userId) this.server.to(appUserRoom(userId)).emit('booking:updated', payload);
    }
  }
}

/** Re-exported so tests and docs can name the events without a magic string. */
export const APP_SOCKET_EVENTS = {
  ready: 'ready',
  messageNew: 'message:new',
  conversationUpdated: 'conversation:updated',
  bookingUpdated: 'booking:updated',
  notificationNew: 'notification:new',
} as const;

export const APP_BOOKING_EVENT_NAMES = Object.values(BOOKING_EVENTS);
