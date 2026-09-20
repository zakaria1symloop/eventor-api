import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserRole } from '../enums/user.enums.js';

/** Per-request values any service can read without passing the request around. */
export interface RequestContextStore {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  /** Set by JwtAuthGuard once the token is verified. */
  userId: string | null;
  userRole: UserRole | null;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export function runWithRequestContext<T>(store: RequestContextStore, fn: () => T): T {
  return storage.run(store, fn);
}

export function getRequestContext(): RequestContextStore | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
