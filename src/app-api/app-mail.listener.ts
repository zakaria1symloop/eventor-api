import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MailService } from '../mail/mail.service.js';
import { APP_AUTH_EVENTS, type AppCodeSentEvent } from './app.events.js';

/** Turns app auth events into emails (EN/AR, the recipient's language). */
@Injectable()
export class AppMailListener {
  constructor(private readonly mail: MailService) {}

  @OnEvent(APP_AUTH_EVENTS.codeSent)
  async onCodeSent(event: AppCodeSentEvent): Promise<void> {
    await this.mail.enqueue({
      to: event.email,
      template: 'verification-code',
      lang: event.lang,
      data: { name: event.name, code: event.code, minutes: event.minutes },
    });
  }
}
