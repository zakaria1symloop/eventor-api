import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { money, uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

/** Private to the client; admins only see that one exists. */
@Entity('budgets')
export class Budget extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client: Relation<User>;

  @Column(uuidRef({ unique: true }))
  clientId: string;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ type: 'date', nullable: true })
  eventDate: string | null;

  @Column(money())
  totalAmount: string;
}
