import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { money, uuidRef } from '../../database/columns.js';
import { Service } from './service.entity.js';

@Entity('service_extras')
export class ServiceExtra extends AbstractEntity {
  @ManyToOne(() => Service, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service>;

  @Column(uuidRef())
  serviceId: string;

  @Column({ type: 'varchar', length: 120 })
  nameEn: string;

  @Column({ type: 'varchar', length: 120 })
  nameAr: string;

  @Column(money())
  price: string;

  @Column({ type: 'int', default: 0 })
  position: number;
}
