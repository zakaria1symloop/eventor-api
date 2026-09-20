import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { MessageKind, MessageStatus } from '../../common/enums/moderation.enums.js';
import { uuidRef } from '../../database/columns.js';
import { StoredFile } from '../../files/entities/stored-file.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { Conversation } from './conversation.entity.js';

/** Content is append-only; only `status` (moderation) changes. */
@Entity('messages')
@Index(['conversationId', 'createdAt'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Relation<Conversation>;

  @Column(uuidRef())
  conversationId: string;

  /** Null = system message. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sender_id' })
  sender: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  senderId: string | null;

  @Column({ type: 'enum', enum: MessageKind })
  kind: MessageKind;

  /** Null for an attachment without text. */
  @Column({ type: 'text', nullable: true })
  body: string | null;

  @ManyToOne(() => StoredFile, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'file_id' })
  file: Relation<StoredFile> | null;

  @Column(uuidRef({ nullable: true }))
  fileId: string | null;

  /** `verification`, `request:<id>`. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  context: string | null;

  @Column({ type: 'enum', enum: MessageStatus, default: MessageStatus.Visible })
  status: MessageStatus;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'moderated_by_id' })
  moderatedBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  moderatedById: string | null;

  @Column({ type: 'datetime', nullable: true })
  moderatedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
