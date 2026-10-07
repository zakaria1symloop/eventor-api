/**
 * FCM HTTP v1 without a network: `fetch` is a fake that answers like Google's
 * OAuth and FCM endpoints, and the service-account key is a real RSA key
 * generated here, so the JWT the provider signs is verified for real.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import {
  ANDROID_CHANNEL_ID,
  FcmPushProvider,
  PushService,
  fcmError,
  fcmMessage,
  pushProviderFactory,
  type PushProvider,
  type ServiceAccount,
} from './push.service.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account: ServiceAccount = {
  project_id: 'eventor-test',
  client_email: 'push@eventor-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fcmFailure = (status: number, statusText: string, errorCode: string | null, message: string) =>
  json(status, { error: { code: status, message, status: statusText, details: errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : [] } });

/** Answers the token exchange, then each FCM send from `answers` (by device token), 200 by default. */
function fakeGoogle(answers: Record<string, () => Response> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const http = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    if (String(url) === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.test', expires_in: 3599, token_type: 'Bearer' });
    const token = JSON.parse(String(init!.body)).message.token as string;
    return answers[token]?.() ?? json(200, { name: `projects/eventor-test/messages/${token}` });
  });
  return { http: http as unknown as typeof fetch, calls };
}

describe('fcmMessage', () => {
  it('shows a notification on both platforms and carries the routing data', () => {
    const message = fcmMessage('tok-1', { title: 'Booking confirmed', body: 'See you on 2026-11-14', data: { type: 'booking.accepted', bookingId: 'b-1' } });
    expect(message).toEqual({
      token: 'tok-1',
      notification: { title: 'Booking confirmed', body: 'See you on 2026-11-14' },
      data: { type: 'booking.accepted', bookingId: 'b-1' },
      android: { priority: 'HIGH', notification: { channel_id: ANDROID_CHANNEL_ID, sound: 'default', tag: 'b-1' } },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', 'thread-id': 'b-1' } } },
    });
  });

  it('groups a chat by conversation and clips long texts', () => {
    const message = fcmMessage('tok-1', { title: 'Amina', body: 'x'.repeat(1000), data: { conversationId: 'c-1', bookingId: 'b-1' } }) as any;
    expect(message.android.notification.tag).toBe('c-1');
    expect(message.apns.payload.aps['thread-id']).toBe('c-1');
    expect(message.notification.body).toHaveLength(400);
    expect(message.notification.body.endsWith('…')).toBe(true);
  });
});

describe('fcmError', () => {
  it('marks unregistered and malformed tokens invalid', () => {
    expect(fcmError(404, { error: { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } }).tokenInvalid).toBe(true);
    expect(fcmError(400, { error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token', details: [{ errorCode: 'INVALID_ARGUMENT' }] } }).tokenInvalid).toBe(true);
  });

  it('keeps the token on configuration errors and explains them', () => {
    const mismatch = fcmError(403, { error: { status: 'PERMISSION_DENIED', message: 'SenderId mismatch', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } });
    expect(mismatch.tokenInvalid).toBe(false);
    expect(mismatch.description).toContain('another Firebase project');
    expect(fcmError(404, { error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' } }).tokenInvalid).toBe(false);
    expect(fcmError(400, { error: { status: 'INVALID_ARGUMENT', message: "Invalid value at 'message.data[0].value'", details: [{ errorCode: 'INVALID_ARGUMENT' }] } }).tokenInvalid).toBe(false);
    expect(fcmError(502, null)).toEqual({ tokenInvalid: false, description: 'HTTP 502' });
  });
});

describe('FcmPushProvider', () => {
  it('signs a JWT with the service-account key and reuses the access token', async () => {
    const google = fakeGoogle();
    const provider = new FcmPushProvider('eventor-test', account, google.http);
    await provider.send([{ token: 'tok-1', platform: 'android' }], { title: 'a', body: 'b' });
    await provider.send([{ token: 'tok-2', platform: 'ios' }], { title: 'a', body: 'b' });

    const exchanges = google.calls.filter((c) => c.url === 'https://oauth2.googleapis.com/token');
    expect(exchanges).toHaveLength(1);
    const form = new URLSearchParams(String(exchanges[0]!.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion')!.split('.');
    expect(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature!, 'base64url')).toBe(true);
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
    });
  });

  it('sends one request per device and reports the tokens FCM rejects', async () => {
    const google = fakeGoogle({
      'tok-gone': () => fcmFailure(404, 'NOT_FOUND', 'UNREGISTERED', 'Requested entity was not found.'),
      'tok-busy': () => fcmFailure(503, 'UNAVAILABLE', 'UNAVAILABLE', 'The service is currently unavailable.'),
    });
    const provider = new FcmPushProvider('eventor-test', account, google.http);
    const result = await provider.send(
      [
        { token: 'tok-ok', platform: 'android' },
        { token: 'tok-gone', platform: 'ios' },
        { token: 'tok-busy', platform: 'android' },
      ],
      { title: 'New message', body: 'Hello', data: { type: 'message.new', conversationId: 'c-1' } },
    );
    expect(result).toEqual({ sent: 1, invalidTokens: ['tok-gone'] });
    const sends = google.calls.filter((c) => c.url.startsWith('https://fcm.googleapis.com/'));
    expect(sends).toHaveLength(3);
    expect(sends[0]!.url).toBe('https://fcm.googleapis.com/v1/projects/eventor-test/messages:send');
    expect((sends[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer ya29.test');
    expect(JSON.parse(String(sends[0]!.init.body)).message.data).toEqual({ type: 'message.new', conversationId: 'c-1' });
  });

  it('fails the whole send when Google refuses the key', async () => {
    const http = vi.fn(async () => json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' })) as unknown as typeof fetch;
    const provider = new FcmPushProvider('eventor-test', account, http);
    await expect(provider.send([{ token: 'tok-1', platform: 'android' }], { title: 'a', body: 'b' })).rejects.toThrow('Invalid JWT Signature.');
  });
});

describe('PushService', () => {
  const service = (provider: PushProvider) => {
    const query = vi.fn(async () => undefined);
    return { push: new PushService(provider, { query } as any), query };
  };

  it('soft-deletes the tokens FCM rejects', async () => {
    const { push, query } = service({ driver: 'fcm', send: async () => ({ sent: 1, invalidTokens: ['tok-gone'] }) });
    expect(await push.send([{ token: 'tok-ok', platform: 'android' }, { token: 'tok-gone', platform: 'ios' }], { title: 'a', body: 'b' })).toEqual({ sent: 1, invalidTokens: ['tok-gone'] });
    expect(query).toHaveBeenCalledWith('UPDATE device_tokens SET deleted_at = ? WHERE token IN (?) AND deleted_at IS NULL', [expect.any(Date), ['tok-gone']]);
  });

  it('never throws, and skips FCM without devices', async () => {
    const send = vi.fn(async () => {
      throw new Error('Google refused the service-account key');
    });
    const { push } = service({ driver: 'fcm', send });
    expect(await push.send([], { title: 'a', body: 'b' })).toEqual({ sent: 0, invalidTokens: [] });
    expect(send).not.toHaveBeenCalled();
    expect(await push.send([{ token: 'tok-1', platform: 'android' }], { title: 'a', body: 'b' })).toEqual({ sent: 0, invalidTokens: [] });
  });

  it('dispatch hands the push to the provider without waiting for it', () => {
    const send = vi.fn(() => new Promise<never>(() => undefined));
    const { push } = service({ driver: 'fcm', send });
    push.dispatch([{ token: 'tok-1', platform: 'android' }], { title: 'a', body: 'b' });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('pushProviderFactory', () => {
  const env = (overrides: Partial<Env>) => ({ FCM_PROJECT_ID: '', FCM_CREDENTIALS_PATH: '', ...overrides }) as Env;
  const keyFile = (content: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'eventor-fcm-')), 'firebase.json');
    writeFileSync(path, content);
    return path;
  };

  it('logs only, without a key', () => {
    expect(pushProviderFactory(env({})).driver).toBe('log');
  });

  it('uses FCM with the project of the key, unless FCM_PROJECT_ID overrides it', () => {
    const path = keyFile(JSON.stringify(account));
    const fromKey = pushProviderFactory(env({ FCM_CREDENTIALS_PATH: path }));
    expect(fromKey.driver).toBe('fcm');
    expect((fromKey as FcmPushProvider).projectId).toBe('eventor-test');
    expect((pushProviderFactory(env({ FCM_CREDENTIALS_PATH: path, FCM_PROJECT_ID: 'other' })) as FcmPushProvider).projectId).toBe('other');
  });

  it('keeps the API up on the stub when the key is missing or broken', () => {
    expect(pushProviderFactory(env({ FCM_CREDENTIALS_PATH: join(tmpdir(), 'no-such-key.json') })).driver).toBe('log');
    expect(pushProviderFactory(env({ FCM_CREDENTIALS_PATH: keyFile('{"type":"service_account"}') })).driver).toBe('log');
    expect(pushProviderFactory(env({ FCM_CREDENTIALS_PATH: keyFile(JSON.stringify({ ...account, private_key: 'not a key' })) })).driver).toBe('log');
  });
});
