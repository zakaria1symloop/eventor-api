import { Column, Entity, JoinColumn, ManyToOne, Unique, type Relation } from 'typeorm';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { Service } from '../../services/entities/service.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { AcademicRequest } from './academic-request.entity.js';

@Entity('academic_request_suggestions')
@Unique(['requestId', 'serviceId'])
export class AcademicRequestSuggestion extends AppendOnlyEntity {
  @ManyToOne(() => AcademicRequest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request: Relation<AcademicRequest>;

  @Column(uuidRef())
  requestId: string;

  @ManyToOne(() => Service, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service>;

  @Column(uuidRef())
  serviceId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'suggested_by_id' })
  suggestedBy: Relation<User>;

  @Column(uuidRef())
  suggestedById: string;

  @Column({ type: 'datetime', nullable: true })
  notifiedAt: Date | null;
}
