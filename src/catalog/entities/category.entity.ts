import { Column, Entity } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';

@Entity('categories')
export class Category extends AbstractEntity {
  @Column({ type: 'varchar', length: 80, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 120 })
  nameEn: string;

  @Column({ type: 'varchar', length: 120 })
  nameAr: string;

  @Column({ type: 'text', nullable: true })
  descriptionEn: string | null;

  @Column({ type: 'text', nullable: true })
  descriptionAr: string | null;

  @Column({ type: 'varchar', length: 40 })
  icon: string;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'boolean', default: true })
  isVisible: boolean;
}
