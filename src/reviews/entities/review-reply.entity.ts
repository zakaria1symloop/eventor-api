import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  type Relation,
} from 'typeorm';
import { ReviewReplyStatus } from '../../common/enums/moderation.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';
import { Review } from './review.entity.js';

/** One public reply per review. */
@Entity('review_replies')
export class ReviewReply extends AbstractEntity {
  @OneToOne(() => Review, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'review_id' })
  review: Relation<Review>;

  @Column(uuidRef({ unique: true }))
  reviewId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider: Relation<User>;

  @Column(uuidRef())
  providerId: string;

  @Column({ type: 'text' })
  body: string;

  @Column({
    type: 'enum',
    enum: ReviewReplyStatus,
    default: ReviewReplyStatus.Published,
  })
  status: ReviewReplyStatus;

  @Column({ type: 'datetime', nullable: true })
  editedAt: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'moderated_by_id' })
  moderatedBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  moderatedById: string | null;
}
