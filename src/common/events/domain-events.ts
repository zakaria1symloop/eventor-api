import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AfterCommit } from '../../database/transaction.js';

/**
 * Domain events (`booking.accepted`, `file.processing_failed`, …). Services
 * emit them after the transaction commits; listeners (`@OnEvent`) create
 * notifications and queue jobs. Services never send email or push directly.
 *
 * Each module declares its event names and payloads in `<module>.events.ts`.
 */
@Injectable()
export class DomainEvents {
  constructor(private readonly emitter: EventEmitter2) {}

  /** Emits after `afterCommit` fires; listeners are awaited, errors logged by runInTransaction. */
  emitAfterCommit<T extends object>(afterCommit: AfterCommit, name: string, payload: T): void {
    afterCommit(() => this.emitter.emitAsync(name, payload));
  }

  /** Emits now; only for writes that are not inside a transaction. */
  async emit<T extends object>(name: string, payload: T): Promise<void> {
    await this.emitter.emitAsync(name, payload);
  }
}
