import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Nightly roll-up; one value per `(day, metric, dimension)`. */
@Entity('stats_daily')
export class StatsDaily {
  @PrimaryColumn({ type: 'date' })
  day: string;

  @PrimaryColumn({ type: 'varchar', length: 60 })
  metric: string;

  /** `''` when the metric has no dimension. */
  @PrimaryColumn({ type: 'varchar', length: 80, default: '' })
  dimension: string;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  value: string;
}
