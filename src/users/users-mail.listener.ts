import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { envConfig, type Env } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import {
  USER_EVENTS,
  type UserBlockedEvent,
  type UserInvitedEvent,
  type UserPasswordResetLinkEvent,
  type UserUnblockedEvent,
} from './users.events.js';

/** Turns user account events into emails (EN/AR, the user's language). Links point to the public app. */
@Injectable()
export class UsersMailListener {
  constructor(
    private readonly mail: MailService,
    @Inject(envConfig.KEY) private readonly env: Env,
  ) {}

  private appUrl(path: string, token: string): string {
    return `${this.env.APP_PUBLIC_URL.replace(/\/$/, '')}/${path}?token=${encodeURIComponent(token)}`;
  }

  @OnEvent(USER_EVENTS.invited)
  async onInvited(event: UserInvitedEvent): Promise<void> {
    await this.mail.enqueue({
      to: event.email,
      template: 'user-invitation',
      lang: event.lang,
      data: { name: event.name, url: this.appUrl('set-password', event.token), days: event.days },
    });
  }

  @OnEvent(USER_EVENTS.passwordResetLinkSent)
  async onPasswordReset(event: UserPasswordResetLinkEvent): Promise<void> {
    await this.mail.enqueue({
      to: event.email,
      template: 'password-reset',
      lang: event.lang,
      data: { name: event.name, url: this.appUrl('reset-password', event.token), minutes: event.minutes },
    });
  }

  @OnEvent(USER_EVENTS.blocked)
  async onBlocked(event: UserBlockedEvent): Promise<void> {
    await this.mail.enqueue({
      to: event.email,
      template: 'account-blocked',
      lang: event.lang,
      data: { name: event.name, message: event.message, until: event.until ? event.until.slice(0, 10) : null },
    });
  }

  @OnEvent(USER_EVENTS.unblocked)
  async onUnblocked(event: UserUnblockedEvent): Promise<void> {
    await this.mail.enqueue({ to: event.email, template: 'account-unblocked', lang: event.lang, data: { name: event.name } });
  }
}
