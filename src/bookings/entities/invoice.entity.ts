import { Column, Entity, JoinColumn, ManyToOne, Unique, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { money, uuidRef } from '../../database/columns.js';
import { StoredFile } from '../../files/entities/stored-file.entity.js';
import { Booking } from './booking.entity.js';

/**
 * Immutable snapshot issued by Eventor; no payment status. A price change voids
 * the old version (soft delete) and issues version + 1.
 */
@Entity('invoices')
@Unique(['bookingId', 'version'])
export class Invoice extends AbstractEntity {
  @ManyToOne(() => Booking, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id' })
  booking: Relation<Booking>;

  @Column(uuidRef())
  bookingId: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  /** INV-2026-0318 */
  @Column({ type: 'varchar', length: 20, unique: true })
  number: string;

  @Column({ type: 'datetime' })
  issuedAt: Date;

  @Column({ type: 'char', length: 3, default: 'DZD' })
  currency: string;

  @Column(money())
  subtotal: string;

  @Column(money())
  discountTotal: string;

  @Column(money())
  total: string;

  @Column({ type: 'decimal', precision: 5, scale: 2 })
  feePercent: string;

  @Column(money())
  feeAmount: string;

  @Column(money())
  providerAmount: string;

  @Column({ type: 'json' })
  issuer: Record<string, unknown>;

  @Column({ type: 'json' })
  snapshot: Record<string, unknown>;

  @ManyToOne(() => StoredFile, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'pdf_file_id' })
  pdfFile: Relation<StoredFile> | null;

  @Column(uuidRef({ nullable: true }))
  pdfFileId: string | null;

  @Column({ type: 'datetime', nullable: true })
  sentToClientAt: Date | null;
}
