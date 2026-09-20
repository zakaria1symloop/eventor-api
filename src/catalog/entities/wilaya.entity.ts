import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { WilayaRegion } from '../../common/enums/catalog.enums.js';

/** The 58 wilayas, keyed by their official code. */
@Entity('wilayas')
export class Wilaya {
  @PrimaryColumn({ type: 'tinyint', unsigned: true })
  code: number;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  @Column({ type: 'varchar', length: 80 })
  nameAr: string;

  @Column({ type: 'enum', enum: WilayaRegion })
  region: WilayaRegion;

  @Column({ type: 'boolean', default: true })
  isOpen: boolean;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
