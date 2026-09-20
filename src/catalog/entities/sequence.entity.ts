import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Counters for human references (`booking`, `academic_request`, `dispute`,
 * `invoice_<year>`). Allocated by SequencesService with `SELECT … FOR UPDATE`.
 */
@Entity('sequences')
export class Sequence {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  name: string;

  @Column({ type: 'int', unsigned: true, default: 0 })
  value: number;
}
