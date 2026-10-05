import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { Budget } from '../bookings/entities/budget.entity.js';
import { BudgetItem } from '../bookings/entities/budget-item.entity.js';
import { AppException } from '../common/errors/app.exception.js';
import type { Lang } from '../common/i18n/language.js';
import { runInTransaction } from '../database/transaction.js';
import { toCategoryRef } from './app-refs.js';
import { assertBudgetOwner, budgetTotals, BUDGET_MAX_ITEMS } from './app.policy.js';
import type { AppBudgetDto, AppBudgetItemDto, CreateBudgetItemDto, PutBudgetDto, UpdateBudgetItemDto } from './dto/app-me.dto.js';

interface ItemRow {
  id: string;
  category_id: string | null;
  cat_slug: string | null;
  cat_name_en: string | null;
  cat_name_ar: string | null;
  cat_icon: string | null;
  label: string;
  planned_amount: string;
  spent_amount: string;
  booking_id: string | null;
  booking_reference: string | null;
  provider_name: string | null;
  position: number;
  created_at: Date;
}

/**
 * Screen 18 "Budget". The budget belongs to one client and to nobody else:
 * every read and write goes through `assertBudgetOwner`, so an admin token —
 * which cannot reach `/app/**` anyway — still could not read it here
 * (api-standards §4 Privacy). The dashboard has no budget endpoint at all.
 */
@Injectable()
export class AppBudgetService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async items(em: EntityManager, budgetId: string): Promise<ItemRow[]> {
    return em.query(
      `SELECT bi.id, bi.category_id, c.slug AS cat_slug, c.name_en AS cat_name_en, c.name_ar AS cat_name_ar, c.icon AS cat_icon,
              bi.label, bi.planned_amount, bi.spent_amount, bi.booking_id, b.reference AS booking_reference,
              COALESCE(pp.business_name, pu.full_name) AS provider_name, bi.position, bi.created_at
       FROM budget_items bi
       LEFT JOIN categories c ON c.id = bi.category_id AND c.deleted_at IS NULL
       LEFT JOIN bookings b ON b.id = bi.booking_id AND b.deleted_at IS NULL
       LEFT JOIN users pu ON pu.id = b.provider_id
       LEFT JOIN provider_profiles pp ON pp.user_id = b.provider_id AND pp.deleted_at IS NULL
       WHERE bi.budget_id = ? AND bi.deleted_at IS NULL
       ORDER BY bi.position, bi.created_at, bi.id`,
      [budgetId],
    );
  }

  private toItem(lang: Lang, row: ItemRow): AppBudgetItemDto {
    return {
      id: row.id,
      category: toCategoryRef(lang, row.category_id ? { id: row.category_id, slug: row.cat_slug!, name_en: row.cat_name_en!, name_ar: row.cat_name_ar!, icon: row.cat_icon! } : null),
      label: row.label,
      plannedAmount: String(row.planned_amount),
      spentAmount: String(row.spent_amount),
      bookingId: row.booking_id,
      bookingReference: row.booking_reference,
      providerName: row.provider_name,
      position: Number(row.position),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private async toDto(em: EntityManager, budget: Budget, lang: Lang): Promise<AppBudgetDto> {
    const rows = await this.items(em, budget.id);
    const items = rows.map((row) => this.toItem(lang, row));
    const totals = budgetTotals(String(budget.totalAmount), items.map((i) => ({ plannedAmount: i.plannedAmount, spentAmount: i.spentAmount, bookingId: i.bookingId })));
    return {
      id: budget.id,
      title: budget.title,
      eventDate: budget.eventDate,
      totalAmount: String(budget.totalAmount),
      plannedTotal: totals.planned,
      spentTotal: totals.spent,
      remaining: totals.remaining,
      spentPercent: totals.spentPercent,
      itemsCount: totals.itemsCount,
      bookedCount: totals.bookedCount,
      items,
      updatedAt: budget.updatedAt.toISOString(),
    };
  }

  /** The caller's budget, or 404 BUDGET_NOT_FOUND before they create one. */
  private async load(em: EntityManager, auth: AuthUser, lock = false): Promise<Budget> {
    const budget = await em.getRepository(Budget).findOne({
      where: { clientId: auth.id },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!budget) throw AppException.of('BUDGET_NOT_FOUND');
    assertBudgetOwner(budget.clientId, auth.id);
    return budget;
  }

  async get(auth: AuthUser, lang: Lang): Promise<AppBudgetDto> {
    const em = this.dataSource.manager;
    return this.toDto(em, await this.load(em, auth), lang);
  }

  /** Header summary for `GET /app/home`; never throws when there is no budget. */
  async summary(auth: { id: string }): Promise<{ exists: boolean; spentTotal: string; totalAmount: string; spentPercent: number; bookedCount: number; itemsCount: number }> {
    const budget = await this.dataSource.getRepository(Budget).findOneBy({ clientId: auth.id });
    if (!budget) {
      return { exists: false, spentTotal: '0.00', totalAmount: '0.00', spentPercent: 0, bookedCount: 0, itemsCount: 0 };
    }
    const rows = await this.items(this.dataSource.manager, budget.id);
    const totals = budgetTotals(String(budget.totalAmount), rows.map((r) => ({ plannedAmount: String(r.planned_amount), spentAmount: String(r.spent_amount), bookingId: r.booking_id })));
    return {
      exists: true,
      spentTotal: totals.spent,
      totalAmount: String(budget.totalAmount),
      spentPercent: totals.spentPercent,
      bookedCount: totals.bookedCount,
      itemsCount: totals.itemsCount,
    };
  }

  /** Creates the budget on first call, updates it afterwards (one per client). */
  async put(auth: AuthUser, dto: PutBudgetDto, lang: Lang): Promise<AppBudgetDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const repository = em.getRepository(Budget);
      const existing = await repository.findOne({ where: { clientId: auth.id }, lock: { mode: 'pessimistic_write' } });
      if (existing) {
        assertBudgetOwner(existing.clientId, auth.id);
        await repository.update(existing.id, {
          title: dto.title,
          eventDate: dto.eventDate ?? null,
          totalAmount: dto.totalAmount,
        });
        return this.toDto(em, await repository.findOneByOrFail({ id: existing.id }), lang);
      }
      const budget = await repository.save(
        repository.create({ clientId: auth.id, title: dto.title, eventDate: dto.eventDate ?? null, totalAmount: dto.totalAmount }),
      );
      return this.toDto(em, budget, lang);
    });
  }

  /** A booking may only be linked to the budget of its own client. */
  private async assertBooking(em: EntityManager, auth: AuthUser, bookingId: string | null | undefined): Promise<void> {
    if (!bookingId) return;
    const [row] = await em.query('SELECT id FROM bookings WHERE id = ? AND client_id = ? AND deleted_at IS NULL', [bookingId, auth.id]);
    if (!row) throw AppException.of('BOOKING_NOT_FOUND');
  }

  /**
   * One budget line per booking, so an amount is never counted twice
   * (409 `BUDGET_BOOKING_ALREADY_LINKED` with the line already holding it).
   * A cancelled booking keeps its line and its link — the client decides.
   */
  private async assertBookingNotLinked(em: EntityManager, budgetId: string, bookingId: string | null | undefined, exceptItemId?: string): Promise<void> {
    if (!bookingId) return;
    const [row] = await em.query(
      `SELECT id FROM budget_items WHERE budget_id = ? AND booking_id = ? AND deleted_at IS NULL${exceptItemId ? ' AND id <> ?' : ''} LIMIT 1`,
      exceptItemId ? [budgetId, bookingId, exceptItemId] : [budgetId, bookingId],
    );
    if (row) throw AppException.of('BUDGET_BOOKING_ALREADY_LINKED', { bookingId, itemId: row.id });
  }

  private async assertCategory(em: EntityManager, categoryId: string | null | undefined): Promise<void> {
    if (!categoryId) return;
    const [row] = await em.query('SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL', [categoryId]);
    if (!row) throw AppException.of('CATEGORY_NOT_FOUND');
  }

  async addItem(auth: AuthUser, dto: CreateBudgetItemDto, lang: Lang): Promise<AppBudgetDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const budget = await this.load(em, auth, true);
      const repository = em.getRepository(BudgetItem);
      const count = await repository.count({ where: { budgetId: budget.id } });
      if (count >= BUDGET_MAX_ITEMS) throw AppException.of('BUDGET_ITEM_LIMIT', { max: BUDGET_MAX_ITEMS });
      await this.assertCategory(em, dto.categoryId);
      await this.assertBooking(em, auth, dto.bookingId);
      await this.assertBookingNotLinked(em, budget.id, dto.bookingId);

      await repository.save(
        repository.create({
          budgetId: budget.id,
          categoryId: dto.categoryId ?? null,
          label: dto.label,
          plannedAmount: dto.plannedAmount ?? '0.00',
          spentAmount: dto.spentAmount ?? '0.00',
          bookingId: dto.bookingId ?? null,
          position: count,
        }),
      );
      return this.toDto(em, budget, lang);
    });
  }

  async updateItem(auth: AuthUser, itemId: string, dto: UpdateBudgetItemDto, lang: Lang): Promise<AppBudgetDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const budget = await this.load(em, auth, true);
      const repository = em.getRepository(BudgetItem);
      const item = await repository.findOneBy({ id: itemId, budgetId: budget.id });
      if (!item) throw AppException.of('BUDGET_ITEM_NOT_FOUND');
      if (dto.categoryId !== undefined) await this.assertCategory(em, dto.categoryId);
      if (dto.bookingId !== undefined) {
        await this.assertBooking(em, auth, dto.bookingId);
        await this.assertBookingNotLinked(em, budget.id, dto.bookingId, item.id);
      }

      await repository.update(item.id, {
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId ?? null } : {}),
        ...(dto.plannedAmount !== undefined ? { plannedAmount: dto.plannedAmount } : {}),
        ...(dto.spentAmount !== undefined ? { spentAmount: dto.spentAmount } : {}),
        ...(dto.bookingId !== undefined ? { bookingId: dto.bookingId ?? null } : {}),
      });
      return this.toDto(em, budget, lang);
    });
  }

  /**
   * Deletes the budget and its lines for good (they are private and `client_id`
   * is unique, so a soft-deleted row would block the next `PUT`). Linked
   * bookings are untouched. Home shows "Plan your budget" again.
   */
  async remove(auth: AuthUser): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const budget = await this.load(em, auth, true);
      await em.query('DELETE FROM budget_items WHERE budget_id = ?', [budget.id]);
      await em.query('DELETE FROM budgets WHERE id = ?', [budget.id]);
    });
  }

  async removeItem(auth: AuthUser, itemId: string, lang: Lang): Promise<AppBudgetDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const budget = await this.load(em, auth, true);
      const repository = em.getRepository(BudgetItem);
      const item = await repository.findOneBy({ id: itemId, budgetId: budget.id });
      if (!item) throw AppException.of('BUDGET_ITEM_NOT_FOUND');
      await repository.softDelete(item.id);
      // Renumber so `position` stays dense for the screen's ordering.
      const rest = await repository.find({ where: { budgetId: budget.id }, order: { position: 'ASC', createdAt: 'ASC' } });
      for (const [position, row] of rest.entries()) {
        if (row.position !== position) await repository.update(row.id, { position });
      }
      return this.toDto(em, budget, lang);
    });
  }
}
