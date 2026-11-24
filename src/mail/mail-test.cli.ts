/**
 * `pnpm mail:test <to> [--lang ar]` (or `mail:test:prod` on the server, from
 * `dist/`): sends **one** real "Your verification code" mail (code 000000)
 * through the configured SMTP account, the way the app sends it, and prints
 * who it was sent as and what the server answered (BUG-B1, acceptance B-01).
 * Use it after changing SMTP_* / MAIL_FROM, with a Gmail address and a
 * disposable inbox, to see the sender and the body. Writes nothing to the database.
 */
import 'reflect-metadata';
import nodemailer from 'nodemailer';
import { validateEnv } from '../config/env.js';
import { gmailSenderWarning, mailAddress } from './mail-sender.js';
import { renderMail } from './templates/index.js';

try {
  process.loadEnvFile();
} catch {
  // Variables come from the environment.
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const to = argv.find((a) => !a.startsWith('--') && a !== 'ar' && a !== 'en');
  const lang = argv.includes('ar') ? 'ar' : 'en';
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('Usage: mail:test <recipient@example.com> [--lang ar]');
  const env = validateEnv(process.env);
  if (!env.SMTP_HOST) throw new Error('SMTP_HOST is empty: mails are only logged, nothing to test.');

  const warning = gmailSenderWarning(env);
  if (warning) console.warn(`WARNING ${warning}`);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  await transport.verify();
  const mail = renderMail('verification-code', lang, { name: 'Eventor test', code: '000000', minutes: 15 });
  const info = await transport.sendMail({ from: env.MAIL_FROM, to, subject: mail.subject, html: mail.html, text: mail.text });
  console.log(
    JSON.stringify(
      {
        from: env.MAIL_FROM,
        sentAs: env.SMTP_HOST.toLowerCase() === 'smtp.gmail.com' && env.SMTP_USER ? mailAddress(env.SMTP_USER) : mailAddress(env.MAIL_FROM),
        to,
        lang,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
        messageId: info.messageId,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
