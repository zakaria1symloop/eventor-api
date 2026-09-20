import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { Category } from '../../catalog/entities/category.entity.js';
import { AcademicRequest } from './academic-request.entity.js';

@Entity('academic_request_needs')
export class AcademicRequestNeed extends AppendOnlyEntity {
  @ManyToOne(() => AcademicRequest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request: Relation<AcademicRequest>;

  @Column(uuidRef())
  requestId: string;

  @ManyToOne(() => Category, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category: Relation<Category>;

  @Column(uuidRef())
  categoryId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note: string | null;
}
