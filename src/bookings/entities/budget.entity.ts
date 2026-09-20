import { Column, Entity, JoinColumn, OneToOne, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { money, uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

/** Private to the client. Written by the future mobile API. */
@Entity('budgets')
export class Budget extends AbstractEntity {
  @OneToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client: Relation<User>;

  @Column(uuidRef({ unique: true }))
  clientId: string;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  @Column({ type: 'date', nullable: true })
  eventDate: string | null;

  @Column(money({ default: 0 }))
  totalAmount: string;
}
