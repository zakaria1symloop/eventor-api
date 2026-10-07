import { createPrivateKey, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { envConfig, type Env } from '../config/env.js';

export interface PushMessage {
  title: string;
  body: string;
  /** String values only (FCM data payload). */
  data?: Record<string, string>;
}

export interface PushTarget {
  token: string;
  platform: 'android' | 'ios' | 'web';
}

export interface PushSendResult {
  sent: number;
  /** Tokens FCM reports as unregistered or malformed; PushService soft-deletes them from `device_tokens`. */
  invalidTokens: string[];
}

export type PushDriver = 'fcm' | 'log';

export interface PushProvider {
  readonly driver: PushDriver;
  send(targets: PushTarget[], message: PushMessage): Promise<PushSendResult>;
}

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/** The Android notification channel every push uses; the app creates it at start (mobile-api.md §12). */
export const ANDROID_CHANNEL_ID = 'eventor_default';

/** Without Firebase credentials: logs instead of calling FCM. Titles only, never message bodies. */
export class LoggingPushProvider implements PushProvider {
  readonly driver = 'log' as const;
  private readonly logger = new Logger('Push');

  constructor(private readonly projectId: string) {}

  async send(targets: PushTarget[], message: PushMessage): Promise<PushSendResult> {
    this.logger.log(
      `[push stub${this.projectId ? ` ${this.projectId}` : ''}] ${targets.length} device(s): "${message.title}"`,
    );
    return { sent: targets.length, invalidTokens: [] };
  }
}

/** The fields of a Firebase service-account key (Project settings → Service accounts → Generate new private key). */
export interface ServiceAccount {
  project_id?: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 10_000;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * One FCM v1 message: the OS shows `notification` while the app is in the
 * background or closed; `data` carries `type` and the ids the app routes on
 * when the user taps it. Notifications about the same chat or booking replace
 * each other on Android and are grouped on iOS.
 */
export function fcmMessage(token: string, message: PushMessage): Record<string, unknown> {
  const data = message.data ?? {};
  const group = data.conversationId ?? data.bookingId;
  return {
    token,
    notification: { title: clip(message.title, 120), body: clip(message.body, 400) },
    data,
    android: {
      priority: 'HIGH',
      notification: { channel_id: ANDROID_CHANNEL_ID, sound: 'default', ...(group ? { tag: group } : {}) },
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: 'default', ...(group ? { 'thread-id': group } : {}) } },
    },
  };
}

const ERROR_HINTS: Record<string, string> = {
  SENDER_ID_MISMATCH: 'the app is registered in another Firebase project than this key',
  THIRD_PARTY_AUTH_ERROR: 'iOS: upload the APNs auth key in Firebase → Project settings → Cloud Messaging',
  PERMISSION_DENIED: 'enable the Firebase Cloud Messaging API for this project and use its own service-account key',
  QUOTA_EXCEEDED: 'too many pushes, FCM asks to slow down',
  UNAVAILABLE: 'FCM is temporarily unavailable',
};

/**
 * Reads an FCM v1 error. Only `UNREGISTERED` and a malformed token mark the
 * token invalid — a wrong project or key must never wipe every device.
 */
export function fcmError(status: number, body: unknown): { tokenInvalid: boolean; description: string } {
  const error = (body as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } } | null)?.error;
  const code = error?.details?.find((d) => d.errorCode)?.errorCode ?? error?.status ?? `HTTP ${status}`;
  const tokenInvalid = code === 'UNREGISTERED' || (code === 'INVALID_ARGUMENT' && /registration token/i.test(error?.message ?? ''));
  const hint = ERROR_HINTS[code];
  return { tokenInvalid, description: `${code}${error?.message ? `: ${error.message}` : ''}${hint ? ` (${hint})` : ''}` };
}

/**
 * FCM HTTP v1 with a service-account key: a JWT signed with the key is traded
 * for an OAuth access token (cached for its hour), then one request per device.
 * No Firebase SDK needed.
 */
export class FcmPushProvider implements PushProvider {
  readonly driver = 'fcm' as const;
  private readonly logger = new Logger('Push');
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    readonly projectId: string,
    private readonly account: ServiceAccount,
    private readonly http: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 300_000) return this.accessToken.value;
    const tokenUrl = this.account.token_uri || GOOGLE_TOKEN_URL;
    const now = Math.floor(Date.now() / 1000);
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: this.account.client_email, scope: FCM_SCOPE, aud: tokenUrl, iat: now, exp: now + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key, 'base64url');
    const res = await this.http(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`Google refused the service-account key (HTTP ${res.status}: ${body.error_description ?? body.error ?? 'no access token'})`);
    }
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async send(targets: PushTarget[], message: PushMessage): Promise<PushSendResult> {
    const accessToken = await this.token();
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`;
    const result: PushSendResult = { sent: 0, invalidTokens: [] };
    for (let i = 0; i < targets.length; i += 20) {
      await Promise.all(
        targets.slice(i, i + 20).map(async (target) => {
          try {
            const res = await this.http(url, {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: fcmMessage(target.token, message) }),
              signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (res.ok) {
              result.sent++;
              return;
            }
            if (res.status === 401) this.accessToken = null;
            const error = fcmError(res.status, await res.json().catch(() => null));
            if (error.tokenInvalid) result.invalidTokens.push(target.token);
            else this.logger.warn(`FCM refused a push to a ${target.platform} device: ${error.description}`);
          } catch (error) {
            this.logger.warn(`FCM unreachable: ${(error as Error).message}`);
          }
        }),
      );
    }
    return result;
  }
}

@Injectable()
export class PushService {
  private readonly logger = new Logger('Push');

  constructor(
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** `fcm` when Firebase credentials are configured; `log` means pushes only reach the server log. */
  get driver(): PushDriver {
    return this.provider.driver;
  }

  /** Sends and waits for FCM. Never throws; tokens FCM rejects are soft-deleted (the app re-registers them). */
  async send(targets: PushTarget[], message: PushMessage): Promise<PushSendResult> {
    if (targets.length === 0) {
      return { sent: 0, invalidTokens: [] };
    }
    try {
      const result = await this.provider.send(targets, message);
      if (result.invalidTokens.length) {
        await this.dataSource.query('UPDATE device_tokens SET deleted_at = ? WHERE token IN (?) AND deleted_at IS NULL', [new Date(), result.invalidTokens]);
      }
      return result;
    } catch (error) {
      this.logger.warn(`Push failed: ${(error as Error).message}`);
      return { sent: 0, invalidTokens: [] };
    }
  }

  /** Fire and forget: the request that caused a notification never waits for FCM. */
  dispatch(targets: PushTarget[], message: PushMessage): void {
    void this.send(targets, message);
  }
}

/** Reads the Firebase service-account key file; throws a readable reason when it is not one. */
export function loadServiceAccount(path: string): ServiceAccount {
  const json = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServiceAccount>;
  if (typeof json.client_email !== 'string' || typeof json.private_key !== 'string') {
    throw new Error('not a service-account key (client_email or private_key missing)');
  }
  try {
    createPrivateKey(json.private_key);
  } catch {
    throw new Error('private_key is not a valid PEM key (generate a new key in the Firebase console)');
  }
  return json as ServiceAccount;
}

/**
 * FCM when `FCM_CREDENTIALS_PATH` points to a service-account key
 * (`FCM_PROJECT_ID` defaults to the key's project), the logging stub
 * otherwise. A broken key logs the reason and keeps the API running on the
 * stub; `GET /health/ready` then reports `push: "log"`.
 */
export function pushProviderFactory(env: Env): PushProvider {
  if (!env.FCM_CREDENTIALS_PATH) return new LoggingPushProvider(env.FCM_PROJECT_ID);
  try {
    const account = loadServiceAccount(env.FCM_CREDENTIALS_PATH);
    const projectId = env.FCM_PROJECT_ID || account.project_id;
    if (!projectId) throw new Error('FCM_PROJECT_ID is empty and the key has no project_id');
    return new FcmPushProvider(projectId, account);
  } catch (error) {
    new Logger('Push').error(`FCM disabled, pushes are only logged. ${env.FCM_CREDENTIALS_PATH}: ${(error as Error).message}`);
    return new LoggingPushProvider(env.FCM_PROJECT_ID);
  }
}

export const pushProvider = {
  provide: PUSH_PROVIDER,
  inject: [envConfig.KEY],
  useFactory: pushProviderFactory,
};
