import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { Wilaya } from '../../catalog/entities/wilaya.entity.js';
import { Service } from './service.entity.js';

@Entity('service_wilayas')
export class ServiceWilaya {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  serviceId: string;

  @PrimaryColumn({ type: 'tinyint', unsigned: true })
  wilayaCode: number;

  @ManyToOne(() => Service, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service>;

  @ManyToOne(() => Wilaya, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'wilaya_code' })
  wilaya: Relation<Wilaya>;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
