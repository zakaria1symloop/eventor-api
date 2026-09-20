import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { InstitutionType } from '../../common/enums/user.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from './user.entity.js';

@Entity('academic_profiles')
export class AcademicProfile extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column(uuidRef({ unique: true }))
  userId: string;

  @Column({ type: 'varchar', length: 190 })
  institutionName: string;

  @Column({ type: 'enum', enum: InstitutionType })
  institutionType: InstitutionType;

  @Column({ type: 'varchar', length: 190, nullable: true })
  faculty: string | null;

  @Column({ type: 'varchar', length: 120 })
  contactName: string;

  @Column({ type: 'varchar', length: 20 })
  contactPhone: string;
}
