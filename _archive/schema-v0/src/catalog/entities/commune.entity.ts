import { Column, Entity, JoinColumn, ManyToOne, Unique, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { wilayaRef } from '../../database/columns.js';
import { Wilaya } from './wilaya.entity.js';

@Entity('communes')
@Unique(['wilayaCode', 'name'])
export class Commune extends AbstractEntity {
  @ManyToOne(() => Wilaya, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'wilaya_code' })
  wilaya: Relation<Wilaya>;

  @Column(wilayaRef())
  wilayaCode: number;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  @Column({ type: 'varchar', length: 80 })
  nameAr: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  postalCode: string | null;
}
