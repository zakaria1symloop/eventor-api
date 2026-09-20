import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { envConfig, type Env } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import {
  AUTH_EVENTS,
  type AdminInvitedEvent,
  type PasswordResetRequestedEvent,
} from './auth.events.js';

/** Turns auth events into emails (EN/AR, recipient's language). */
@Injectable()
export class AuthMailListener {
  constructor(
    private readonly mail: MailService,
    @Inject(envConfig.KEY) private readonly env: Env,
  ) {}

  private adminUrl(lang: string, path: string, token: string): string {
    return `${this.env.ADMIN_URL.replace(/\/$/, '')}/${lang}/${path}?token=${encodeURIComponent(token)}`;
  }

  @OnEvent(AUTH_EVENTS.passwordResetRequested)
  async onPasswordReset(event: PasswordResetRequestedEvent): Promise<void> {
    await this.mail.enqueue({
      to: event.email,
      template: 'password-reset',
      lang: event.lang,
      data: { name: event.name, url: this.adminUrl(event.lang, 'reset-password', event.token), minutes: event.minutes },
    });
  }

  @OnEvent(AUTH_EVENTS.adminInvited)
  async onAdminInvited(event: AdminInvitedEvent): Promise<void> {
    await this.mail.enqueue({
      to: event.email,
      template: 'admin-invitation',
      lang: event.lang,
      data: { name: event.name, invitedBy: event.invitedBy, url: this.adminUrl(event.lang, 'accept-invitation', event.token) },
    });
  }
}
