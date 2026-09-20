import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { VerificationCodePurpose } from '../../common/enums/auth.enums.js';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('verification_codes')
@Index(['destination', 'purpose', 'createdAt'])
export class VerificationCode extends AppendOnlyEntity {
  @ManyToOne(() => User, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  userId: string | null;

  @Column({ type: 'enum', enum: VerificationCodePurpose })
  purpose: VerificationCodePurpose;

  @Column({ type: 'varchar', length: 190 })
  destination: string;

  @Column({ type: 'varchar', length: 255 })
  codeHash: string;

  @Column({ type: 'tinyint', unsigned: true, default: 0 })
  attempts: number;

  @Column({ type: 'datetime' })
  expiresAt: Date;

  @Column({ type: 'datetime', nullable: true })
  consumedAt: Date | null;
}
