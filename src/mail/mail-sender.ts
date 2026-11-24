/**
 * BUG-B1: Gmail SMTP (`smtp.gmail.com`) always sends as the account it signs in
 * with. A `MAIL_FROM` with another address is silently replaced by `SMTP_USER`,
 * which is how mails went out under a personal address. The Workspace relay
 * (`smtp-relay.gmail.com`) is not concerned: it may send as the domain's addresses.
 */

/** The bare address of `Name <address>` or `address`, lower-cased. */
export function mailAddress(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1]! : value).trim().toLowerCase();
}

/** A warning when Gmail would rewrite the sender; null when the sender is what MAIL_FROM says. */
export function gmailSenderWarning(env: { SMTP_HOST: string; SMTP_USER: string; MAIL_FROM: string }): string | null {
  if (env.SMTP_HOST.trim().toLowerCase() !== 'smtp.gmail.com' || !env.SMTP_USER) return null;
  const from = mailAddress(env.MAIL_FROM);
  const user = mailAddress(env.SMTP_USER);
  if (from === user) return null;
  return `MAIL_FROM is ${from} but Gmail signs in as ${user}: Gmail will send every mail as ${user}. Set MAIL_FROM to "Eventor <${user}>".`;
}
