import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

export type SequenceName = 'booking' | 'academic_request' | 'dispute' | 'invoice';

const PREFIX: Record<Exclude<SequenceName, 'invoice'>, string> = {
  booking: 'EVT',
  academic_request: 'ACR',
  dispute: 'DSP',
};

/** The `sequences.name` row a sequence uses; invoices restart every year. */
export function sequenceRowName(name: SequenceName, year: number): string {
  return name === 'invoice' ? `invoice_${year}` : name;
}

/** EVT-000123, ACR-000142, DSP-000031, INV-2026-0318. Wider numbers are not truncated. */
export function formatReference(name: SequenceName, value: number, year: number): string {
  if (name === 'invoice') {
    return `INV-${year}-${String(value).padStart(4, '0')}`;
  }
  return `${PREFIX[name]}-${String(value).padStart(6, '0')}`;
}

/**
 * Allocates human references from `sequences`. Inside a transaction the row is
 * read with `SELECT … FOR UPDATE`, so concurrent allocations queue up and a
 * rolled-back transaction gives its number back.
 */
@Injectable()
export class SequencesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Pass the caller's transaction EntityManager so the number is committed with
   * the row that uses it. Without one, a short transaction of its own is used.
   */
  async next(name: SequenceName, em?: EntityManager, now = new Date()): Promise<string> {
    if (!em) {
      return this.dataSource.transaction((tx) => this.next(name, tx, now));
    }

    const year = now.getUTCFullYear();
    const row = sequenceRowName(name, year);

    const lock = (): Promise<{ value: number | string }[]> =>
      em.query('SELECT `value` FROM `sequences` WHERE `name` = ? FOR UPDATE', [row]);

    // Lock first: an INSERT IGNORE on an existing row takes a shared lock, and two
    // transactions upgrading shared locks to FOR UPDATE would deadlock.
    let locked = await lock();
    if (locked.length === 0) {
      // First reference of a new invoice year: create the row, then lock it.
      await em.query('INSERT IGNORE INTO `sequences` (`name`, `value`) VALUES (?, 0)', [row]);
      locked = await lock();
    }
    const value = Number(locked[0]?.value ?? 0) + 1;
    await em.query('UPDATE `sequences` SET `value` = ? WHERE `name` = ?', [value, row]);

    return formatReference(name, value, year);
  }
}
