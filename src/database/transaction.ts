import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

/** Registers work to run only once the surrounding transaction has committed. */
export type AfterCommit = (callback: () => unknown) => void;

const logger = new Logger('Transaction');

/**
 * Runs `work` in one transaction. Callbacks passed to `afterCommit` (domain
 * events, queue jobs) run in order after COMMIT and never after a rollback, so
 * listeners never see data that was not saved. A failing callback is logged
 * and does not undo the committed transaction.
 *
 *   await runInTransaction(this.dataSource, async (em, afterCommit) => {
 *     await em.save(booking);
 *     await this.audit.log({ ... }, em);
 *     afterCommit(() => this.events.emitAsync('booking.accepted', { bookingId }));
 *   });
 */
export async function runInTransaction<T>(
  dataSource: DataSource,
  work: (em: EntityManager, afterCommit: AfterCommit) => Promise<T>,
): Promise<T> {
  const callbacks: (() => unknown)[] = [];
  const result = await dataSource.transaction((em) =>
    work(em, (callback) => {
      callbacks.push(callback);
    }),
  );

  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      logger.error(
        'An after-commit callback failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
  return result;
}
