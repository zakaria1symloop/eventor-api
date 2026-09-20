import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer, type OnGatewayConnection, type OnGatewayInit } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import type { DataSource } from 'typeorm';
import { Session } from '../auth/entities/session.entity.js';
import { TokenService } from '../auth/token.service.js';
import { UserRole, UserStatus } from '../common/enums/user.enums.js';
import { User } from '../users/entities/user.entity.js';
import { NOTIFICATION_EVENTS, type AdminNotificationCreatedEvent } from '../notifications/notifications.service.js';
import { MESSAGING_EVENTS, type ConversationUpdatedEvent, type MessageCreatedEvent, type MessageUpdatedEvent } from './messaging.events.js';

export const ADMIN_ROOM = 'admin';
export const conversationRoom = (id: string) => `conversation:${id}`;
/** Every socket of one admin (per-admin events such as `notification:new`). */
export const userRoom = (id: string) => `user:${id}`;

/** The access token from `auth.token`, an `Authorization: Bearer` header or `?token=`. */
export function socketToken(socket: Pick<Socket, 'handshake'>): string | null {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === 'string' && auth.token) return auth.token.replace(/^Bearer\s+/i, '');
  const header = socket.handshake.headers?.authorization;
  if (typeof header === 'string' && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '');
  const query = socket.handshake.query?.token;
  return typeof query === 'string' && query ? query : null;
}

/**
 * Live updates for MSG-01 on namespace `/admin` (same port and CORS policy as
 * the API). Connect with the admin access token; every socket joins `admin`,
 * and `conversation:join` adds `conversation:<id>`.
 *
 * Server events: `message:new` and `message:updated` (AdminMessageDto, to
 * `admin` and the conversation room), `conversation:updated`
 * (`{ conversationId, reason }`, to `admin`). A refused handshake fails with
 * `connect_error` whose `data.code` is the API error code (AUTH_TOKEN_MISSING,
 * AUTH_TOKEN_INVALID, AUTH_TOKEN_EXPIRED, AUTH_SESSION_REVOKED, ACCOUNT_BLOCKED, FORBIDDEN_ROLE).
 */
// CORS follows CORS_ORIGINS through CorsIoAdapter (app.setup.ts).
@WebSocketGateway({ namespace: '/admin' })
export class MessagingGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(MessagingGateway.name);

  @WebSocketServer()
  server: Namespace;

  constructor(
    private readonly tokens: TokenService,
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
    await socket.join([ADMIN_ROOM, userRoom((socket.data as { userId: string }).userId)]);
    socket.emit('ready', { userId: (socket.data as { userId: string }).userId });
  }

  /** Null when the socket belongs to an active admin with a live session; otherwise the error code. */
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
      const session = payload.sid ? await this.dataSource.getRepository(Session).findOneBy({ id: payload.sid }) : null;
      if (!session || session.userId !== payload.sub) return 'AUTH_TOKEN_INVALID';
      if (session.revokedAt || session.expiresAt.getTime() <= Date.now()) return 'AUTH_SESSION_REVOKED';
      const user = await this.dataSource.getRepository(User).findOneBy({ id: payload.sub });
      if (!user) return 'AUTH_SESSION_REVOKED';
      if (user.status === UserStatus.Blocked) return 'ACCOUNT_BLOCKED';
      if (user.role !== UserRole.Admin) return 'FORBIDDEN_ROLE';
      socket.data = { userId: user.id };
      return null;
    } catch (error) {
      this.logger.error(`Socket authentication failed: ${(error as Error).message}`);
      return 'INTERNAL_ERROR';
    }
  }

  @SubscribeMessage('conversation:join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: unknown }) {
    if (typeof body?.conversationId !== 'string') return { ok: false };
    await socket.join(conversationRoom(body.conversationId));
    return { ok: true, room: conversationRoom(body.conversationId) };
  }

  @SubscribeMessage('conversation:leave')
  async leave(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: unknown }) {
    if (typeof body?.conversationId !== 'string') return { ok: false };
    await socket.leave(conversationRoom(body.conversationId));
    return { ok: true };
  }

  @OnEvent(MESSAGING_EVENTS.messageCreated)
  onMessageCreated(event: MessageCreatedEvent): void {
    this.server?.to([ADMIN_ROOM, conversationRoom(event.conversationId)]).emit('message:new', event.message);
  }

  @OnEvent(MESSAGING_EVENTS.messageUpdated)
  onMessageUpdated(event: MessageUpdatedEvent): void {
    this.server?.to([ADMIN_ROOM, conversationRoom(event.conversationId)]).emit('message:updated', event.message);
  }

  @OnEvent(MESSAGING_EVENTS.conversationUpdated)
  onConversationUpdated(event: ConversationUpdatedEvent): void {
    this.server?.to(ADMIN_ROOM).emit('conversation:updated', event);
  }

  @OnEvent(NOTIFICATION_EVENTS.adminCreated)
  onAdminNotification(event: AdminNotificationCreatedEvent): void {
    this.server?.to(userRoom(event.userId)).emit('notification:new', event.notification);
  }
}
