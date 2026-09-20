import { Column, Entity, Index } from 'typeorm';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';

@Entity('login_attempts')
@Index(['email', 'createdAt'])
export class LoginAttempt extends AppendOnlyEntity {
  @Column({ type: 'varchar', length: 190 })
  email: string;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @Column({ type: 'boolean' })
  success: boolean;
}
