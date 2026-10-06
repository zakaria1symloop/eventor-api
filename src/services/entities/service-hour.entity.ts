import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { Service } from './service.entity.js';

/**
 * Bookable hours of a service, per weekday (ISO: 1 = Monday … 7 = Sunday). A
 * service with no rows can be booked at any hour. An end at or before the start
 * runs past midnight (20:00 → 02:00). Replaced as a whole set on each save.
 */
@Entity('service_hours')
@Index(['serviceId', 'weekday'])
export class ServiceHour extends AppendOnlyEntity {
  @ManyToOne(() => Service, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service>;

  @Column(uuidRef())
  serviceId: string;

  @Column({ type: 'tinyint', unsigned: true })
  weekday: number;

  @Column({ type: 'time' })
  startTime: string;

  @Column({ type: 'time' })
  endTime: string;
}
