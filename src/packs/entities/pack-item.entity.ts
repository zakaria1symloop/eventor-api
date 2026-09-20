import { Column, Entity, JoinColumn, ManyToOne, Unique, type Relation } from 'typeorm';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { Service } from '../../services/entities/service.entity.js';
import { Pack } from './pack.entity.js';

@Entity('pack_items')
@Unique(['packId', 'serviceId'])
export class PackItem extends AppendOnlyEntity {
  @ManyToOne(() => Pack, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pack_id' })
  pack: Relation<Pack>;

  @Column(uuidRef())
  packId: string;

  @ManyToOne(() => Service, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service>;

  @Column(uuidRef())
  serviceId: string;

  @Column({ type: 'int', default: 0 })
  position: number;
}
