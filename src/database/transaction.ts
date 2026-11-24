import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

/** Registers work to run only once the surrounding transaction has committed. */
export type AfterCommit = (callback: () => unknown) => void;

export type IsolationLevel = 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Isolation for every transaction that books, accepts or moves a booking (BUG-M2).
 *
 * Those transactions serialise per provider with `SELECT … FROM users … FOR UPDATE`
 * (`BookingsService.isAvailable`), then count the bookings already on the slot
 * with plain SELECTs. Under MySQL's default REPEATABLE READ, a plain SELECT reads
 * the snapshot taken at the transaction's *first* read, which happens before the
 * lock is granted, so it misses a booking another request committed while this
 * one was waiting for the lock. Two requests for the same slot sent in the same
 * second were both created that way (M-08). READ COMMITTED gives each statement a
 * fresh snapshot, so whatever is read after the lock is up to date.
 */
export const BOOKING_ISOLATION: IsolationLevel = 'READ COMMITTED';

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
  isolation?: IsolationLevel,
): Promise<T> {
  const callbacks: (() => unknown)[] = [];
  const run = (em: EntityManager) =>
    work(em, (callback) => {
      callbacks.push(callback);
    });
  // Without a level the database default applies (REPEATABLE READ on MySQL).
  const result = isolation ? await dataSource.transaction(isolation, run) : await dataSource.transaction(run);

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
