import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Lang } from '../common/i18n/language.js';
import { envConfig, type Env } from '../config/env.js';
import { JOBS } from '../queue/jobs.js';
import { QueueService } from '../queue/queue.service.js';
import {
  renderMail,
  type MailTemplateData,
  type MailTemplateName,
} from './templates/index.js';

export interface MailRequest<T extends MailTemplateName = MailTemplateName> {
  to: string;
  template: T;
  lang: Lang;
  data: MailTemplateData<T>;
  /** Files attached by path (kept serialisable for the queue), e.g. an invoice PDF under STORAGE_ROOT. */
  attachments?: { filename: string; path: string; contentType?: string }[];
}

/**
 * Email through the Google Workspace SMTP relay. Without SMTP_HOST (dev/test)
 * mails are rendered and logged instead of sent (no body in the log, only the
 * recipient and subject; codes and links stay out of log files).
 *
 * Listeners call `enqueue()`; the queue job calls `send()`.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  /** Mails "sent" without SMTP, for tests and local inspection. */
  readonly outbox: { to: string; subject: string; text: string; attachments: string[] }[] = [];

  constructor(
    @Inject(envConfig.KEY) private readonly env: Env,
    private readonly queue: QueueService,
  ) {
    this.transporter = env.SMTP_HOST
      ? nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE,
          auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
        })
      : null;
  }

  onModuleInit(): void {
    this.queue.registerHandler<MailRequest>(JOBS.sendMail, (request) => this.send(request));
  }

  /** `smtp` when SMTP is configured, `console` when mail only reaches the log/outbox. Shown by `/health/ready`. */
  get driver(): 'smtp' | 'console' {
    return this.transporter ? 'smtp' : 'console';
  }

  async enqueue<T extends MailTemplateName>(request: MailRequest<T>): Promise<void> {
    await this.queue.add(JOBS.sendMail, request, { attempts: 5 });
  }

  async send<T extends MailTemplateName>(request: MailRequest<T>): Promise<void> {
    const mail = renderMail(request.template, request.lang, request.data);

    if (!this.transporter) {
      this.outbox.push({ to: request.to, subject: mail.subject, text: mail.text, attachments: (request.attachments ?? []).map((a) => a.filename) });
      if (this.outbox.length > 100) this.outbox.shift();
      this.logger.log(`[dev mail] to=${request.to} template=${request.template} subject="${mail.subject}"`);
      return;
    }

    await this.transporter.sendMail({
      from: this.env.MAIL_FROM,
      to: request.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      attachments: request.attachments?.map((a) => ({ filename: a.filename, path: a.path, contentType: a.contentType })),
    });
  }
}
