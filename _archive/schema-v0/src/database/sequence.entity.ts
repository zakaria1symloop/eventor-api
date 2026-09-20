import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Counters for human references (`booking`, `academic_request`,
 * `invoice_<year>`). Select the row `FOR UPDATE` in the transaction that
 * allocates the reference.
 */
@Entity('sequences')
export class Sequence {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  name: string;

  @Column({ type: 'int', unsigned: true, default: 0 })
  value: number;
}
