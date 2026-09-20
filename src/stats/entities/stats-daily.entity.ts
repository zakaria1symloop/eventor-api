import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Filled nightly from bookings, reviews and users. */
@Entity('stats_daily')
export class StatsDaily {
  @PrimaryColumn({ type: 'date' })
  day: string;

  @PrimaryColumn({ type: 'varchar', length: 60 })
  metric: string;

  @PrimaryColumn({ type: 'varchar', length: 80, default: '' })
  dimension: string;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  value: string;
}
