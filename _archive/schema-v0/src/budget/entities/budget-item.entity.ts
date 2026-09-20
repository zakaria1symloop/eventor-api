import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { money, uuidRef } from '../../database/columns.js';
import { Booking } from '../../bookings/entities/booking.entity.js';
import { Category } from '../../catalog/entities/category.entity.js';
import { Budget } from './budget.entity.js';

@Entity('budget_items')
export class BudgetItem extends AbstractEntity {
  @ManyToOne(() => Budget, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'budget_id' })
  budget: Relation<Budget>;

  @Column(uuidRef())
  budgetId: string;

  @ManyToOne(() => Category, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category: Relation<Category> | null;

  @Column(uuidRef({ nullable: true }))
  categoryId: string | null;

  @Column({ type: 'varchar', length: 120 })
  label: string;

  @Column(money({ default: 0 }))
  plannedAmount: string;

  @Column(money({ default: 0 }))
  spentAmount: string;

  @ManyToOne(() => Booking, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id' })
  booking: Relation<Booking> | null;

  @Column(uuidRef({ nullable: true }))
  bookingId: string | null;

  @Column({ type: 'int', default: 0 })
  position: number;
}
