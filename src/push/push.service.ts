import { Inject, Injectable, Logger } from '@nestjs/common';
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
  /** Tokens FCM reports as unregistered; callers delete them from `device_tokens`. */
  invalidTokens: string[];
}

/** Implemented by the FCM HTTP v1 client later; swap in PushModule. */
export interface PushProvider {
  send(targets: PushTarget[], message: PushMessage): Promise<PushSendResult>;
}

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/** Stub: logs instead of calling FCM. Titles only, never message bodies. */
export class LoggingPushProvider implements PushProvider {
  private readonly logger = new Logger('Push');

  constructor(private readonly projectId: string) {}

  async send(targets: PushTarget[], message: PushMessage): Promise<PushSendResult> {
    this.logger.log(
      `[push stub${this.projectId ? ` ${this.projectId}` : ''}] ${targets.length} device(s): "${message.title}"`,
    );
    return { sent: targets.length, invalidTokens: [] };
  }
}

@Injectable()
export class PushService {
  constructor(@Inject(PUSH_PROVIDER) private readonly provider: PushProvider) {}

  async send(targets: PushTarget[], message: PushMessage): Promise<PushSendResult> {
    if (targets.length === 0) {
      return { sent: 0, invalidTokens: [] };
    }
    return this.provider.send(targets, message);
  }
}

export function pushProviderFactory(env: Env): PushProvider {
  return new LoggingPushProvider(env.FCM_PROJECT_ID);
}

export const pushProvider = {
  provide: PUSH_PROVIDER,
  inject: [envConfig.KEY],
  useFactory: pushProviderFactory,
};
