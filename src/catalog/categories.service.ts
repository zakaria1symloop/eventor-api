import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, In, type DataSource, type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { likeContains } from '../common/dto/transforms.js';
import { AppException } from '../common/errors/app.exception.js';
import { paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction } from '../database/transaction.js';
import { Category } from './entities/category.entity.js';
import { deletedSlug, hasMissingTranslation, reorderPositions, slugify, SLUG_MAX_LENGTH } from './catalog.policy.js';
import {
  CATEGORY_SORT_FIELDS,
  type CategoriesQueryDto,
  type CategoryDto,
  type CategoryFiltersDto,
  type CategoryPositionDto,
  type CategoryTabCountsDto,
  type CreateCategoryDto,
  type UpdateCategoryDto,
} from './dto/categories.dto.js';

const EDITABLE = ['slug', 'nameEn', 'nameAr', 'descriptionEn', 'descriptionAr', 'icon', 'isVisible'] as const;

/** CAT-01 / CAT-02. The table is small (tens of rows); counts come from grouped queries. */
@Injectable()
export class CategoriesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  filtered(filters: CategoryFiltersDto, em: EntityManager = this.dataSource.manager): SelectQueryBuilder<Category> {
    const qb = em.getRepository(Category).createQueryBuilder('category');
    if (filters.tab === 'shown') qb.andWhere('category.isVisible = 1');
    if (filters.tab === 'hidden') qb.andWhere('category.isVisible = 0');
    if (filters.q) {
      const like = likeContains(filters.q);
      qb.andWhere(
        new Brackets((w) =>
          w.where('category.nameEn LIKE :like', { like }).orWhere('category.nameAr LIKE :like').orWhere('category.slug LIKE :like'),
        ),
      );
    }
    return qb;
  }

  async list(query: CategoriesQueryDto): Promise<Paginated<CategoryDto, CategoryTabCountsDto>> {
    const [field, direction] = Object.entries(toOrder(query.sort, CATEGORY_SORT_FIELDS, ['position', 'ASC']))[0]!;
    const [rows, total] = await this.filtered(query)
      .orderBy(`category.${field}`, direction)
      .addOrderBy('category.position', 'ASC')
      .addOrderBy('category.createdAt', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();

    // Tab counters honour the search but not the tab itself.
    const grouped: { visible: number | string; total: string }[] = await this.filtered({ q: query.q })
      .select('category.isVisible', 'visible')
      .addSelect('COUNT(*)', 'total')
      .groupBy('category.isVisible')
      .getRawMany();
    const shown = Number(grouped.find((g) => Number(g.visible) === 1)?.total ?? 0);
    const hidden = Number(grouped.find((g) => Number(g.visible) === 0)?.total ?? 0);

    return paginateWithCounts(await this.withCounts(rows), total, query, { all: shown + hidden, shown, hidden });
  }

  async get(id: string, em: EntityManager = this.dataSource.manager): Promise<CategoryDto> {
    const category = await em.getRepository(Category).findOneBy({ id });
    if (!category) throw AppException.of('CATEGORY_NOT_FOUND');
    return (await this.withCounts([category], em))[0]!;
  }

  /** Counts for a page of categories: three grouped queries, whatever the page size. */
  async withCounts(categories: Category[], em: EntityManager = this.dataSource.manager): Promise<CategoryDto[]> {
    if (categories.length === 0) return [];
    const ids = categories.map((c) => c.id);
    const toMap = (rows: { id: string; n: string }[]) => new Map(rows.map((r) => [r.id, Number(r.n)]));
    const [services, providers, bookings] = await Promise.all([
      em.query(
        'SELECT category_id AS id, COUNT(*) AS n FROM services WHERE deleted_at IS NULL AND category_id IN (?) GROUP BY category_id',
        [ids],
      ),
      em.query(
        `SELECT pp.category_id AS id, COUNT(*) AS n FROM provider_profiles pp
         JOIN users u ON u.id = pp.user_id AND u.deleted_at IS NULL
         WHERE pp.deleted_at IS NULL AND pp.category_id IN (?) GROUP BY pp.category_id`,
        [ids],
      ),
      em.query(
        `SELECT s.category_id AS id, COUNT(*) AS n FROM bookings b
         JOIN services s ON s.id = b.service_id
         WHERE b.deleted_at IS NULL AND b.created_at >= ? AND s.category_id IN (?) GROUP BY s.category_id`,
        [new Date(Date.now() - 30 * 86_400_000), ids],
      ),
    ]).then((results) => results.map(toMap));

    return categories.map((c) => ({
      id: c.id,
      slug: c.slug,
      nameEn: c.nameEn,
      nameAr: c.nameAr,
      descriptionEn: c.descriptionEn,
      descriptionAr: c.descriptionAr,
      icon: c.icon,
      position: c.position,
      isVisible: c.isVisible,
      servicesCount: services.get(c.id) ?? 0,
      providersCount: providers.get(c.id) ?? 0,
      bookings30dCount: bookings.get(c.id) ?? 0,
      missingTranslation: hasMissingTranslation(c),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  async create(dto: CreateCategoryDto): Promise<CategoryDto> {
    this.assertHasName(dto.nameEn, dto.nameAr);
    return runInTransaction(this.dataSource, async (em) => {
      const repository = em.getRepository(Category);
      const slug = dto.slug ?? (await this.freeSlug(em, slugify(dto.nameEn || dto.nameAr)));
      if (dto.slug) await this.assertSlugFree(em, dto.slug);
      const { max } = (await repository.createQueryBuilder('c').withDeleted().select('MAX(c.position)', 'max').getRawOne<{ max: number | null }>()) ?? {
        max: null,
      };
      const category = await repository.save(
        repository.create({
          slug,
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          descriptionEn: dto.descriptionEn ?? null,
          descriptionAr: dto.descriptionAr ?? null,
          icon: dto.icon,
          position: max === null ? 0 : Number(max) + 1,
          isVisible: dto.isVisible ?? true,
        }),
      );
      await this.audit.log(
        {
          action: 'category.created',
          objectType: 'category',
          objectId: category.id,
          objectLabel: category.nameEn || category.nameAr,
          level: AuditLevel.Normal,
          changes: Object.fromEntries(EDITABLE.map((f) => [f, { from: null, to: category[f] }])),
        },
        em,
      );
      return this.get(category.id, em);
    });
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<CategoryDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const repository = em.getRepository(Category);
      const category = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!category) throw AppException.of('CATEGORY_NOT_FOUND');

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of EDITABLE) {
        const next = dto[field];
        if (next !== undefined && next !== category[field]) {
          changes[field] = { from: category[field], to: next };
        }
      }
      if (Object.keys(changes).length === 0) return this.get(id, em);

      this.assertHasName(dto.nameEn ?? category.nameEn, dto.nameAr ?? category.nameAr);
      if (changes.slug) await this.assertSlugFree(em, dto.slug!, id);
      Object.assign(category, Object.fromEntries(Object.entries(changes).map(([f, c]) => [f, c.to])));
      await repository.save(category);

      const onlyVisibility = Object.keys(changes).length === 1 && changes.isVisible;
      await this.audit.log(
        {
          action: onlyVisibility ? (category.isVisible ? 'category.shown' : 'category.hidden') : 'category.updated',
          objectType: 'category',
          objectId: category.id,
          objectLabel: category.nameEn || category.nameAr,
          level: AuditLevel.Normal,
          changes,
        },
        em,
      );
      return this.get(id, em);
    });
  }

  async reorder(ids: string[]): Promise<CategoryPositionDto[]> {
    return runInTransaction(this.dataSource, async (em) => {
      const repository = em.getRepository(Category);
      const current = await repository.find({ where: { id: In(ids) }, select: { id: true, position: true }, lock: { mode: 'pessimistic_write' } });
      const moves = reorderPositions(current, ids);
      for (const move of moves) {
        await repository.update(move.id, { position: move.position });
      }
      if (moves.length > 0) {
        const before = new Map(current.map((c) => [c.id, c.position]));
        await this.audit.log(
          {
            action: 'category.reordered',
            objectType: 'category',
            objectId: null,
            objectLabel: `${moves.length} categories`,
            level: AuditLevel.Info,
            changes: Object.fromEntries(moves.map((m) => [m.id, { from: before.get(m.id), to: m.position }])),
          },
          em,
        );
      }
      const after = new Map(current.map((c) => [c.id, c.position]));
      moves.forEach((m) => after.set(m.id, m.position));
      return ids.map((id) => ({ id, position: after.get(id)! }));
    });
  }

  /**
   * Soft-deletes a category. With services or providers it needs `moveTo`; they
   * are moved in the same transaction. The slug is freed for reuse.
   */
  async remove(id: string, moveTo: string | undefined): Promise<{ movedServices: number; movedProviders: number }> {
    return runInTransaction(this.dataSource, async (em) => {
      const repository = em.getRepository(Category);
      const category = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!category) throw AppException.of('CATEGORY_NOT_FOUND');

      const [{ n: services }] = await em.query('SELECT COUNT(*) AS n FROM services WHERE deleted_at IS NULL AND category_id = ?', [id]);
      const [{ n: providers }] = await em.query('SELECT COUNT(*) AS n FROM provider_profiles WHERE deleted_at IS NULL AND category_id = ?', [id]);
      const servicesCount = Number(services);
      const providersCount = Number(providers);

      let movedServices = 0;
      let movedProviders = 0;
      let target: Category | null = null;
      if (moveTo !== undefined) {
        target = moveTo === id ? null : await repository.findOne({ where: { id: moveTo }, lock: { mode: 'pessimistic_read' } });
        if (!target) throw new AppException(422, 'CATEGORY_MOVE_TARGET_INVALID', { moveTo });
        // Deleted services and profiles move too, so nothing is left pointing at a deleted category.
        movedServices = (await em.query('UPDATE services SET category_id = ? WHERE category_id = ?', [target.id, id])).affectedRows;
        movedProviders = (await em.query('UPDATE provider_profiles SET category_id = ? WHERE category_id = ?', [target.id, id])).affectedRows;
      } else if (servicesCount > 0 || providersCount > 0) {
        throw AppException.of('CATEGORY_HAS_SERVICES', { servicesCount, providersCount });
      }

      await repository.update(id, { slug: deletedSlug(category.slug, id) });
      await repository.softDelete(id);
      await this.audit.log(
        {
          action: 'category.deleted',
          objectType: 'category',
          objectId: id,
          objectLabel: category.nameEn || category.nameAr,
          level: AuditLevel.Sensitive,
          changes: {
            slug: { from: category.slug, to: null },
            ...(target ? { movedTo: { id: target.id, label: target.nameEn || target.nameAr }, movedServices, movedProviders } : {}),
          },
        },
        em,
      );
      return { movedServices, movedProviders };
    });
  }

  private assertHasName(nameEn: string, nameAr: string): void {
    if (!nameEn && !nameAr) {
      throw new AppException(400, 'VALIDATION_FAILED', [
        { field: 'nameEn', code: 'IS_NOT_EMPTY', message: 'nameEn or nameAr is required' },
        { field: 'nameAr', code: 'IS_NOT_EMPTY', message: 'nameEn or nameAr is required' },
      ]);
    }
  }

  private async assertSlugFree(em: EntityManager, slug: string, exceptId?: string): Promise<void> {
    const existing = await em.getRepository(Category).findOne({ where: { slug }, withDeleted: true, select: { id: true } });
    if (existing && existing.id !== exceptId) throw AppException.of('SLUG_TAKEN', { slug });
  }

  private async freeSlug(em: EntityManager, base: string): Promise<string> {
    for (let n = 1; n < 1000; n++) {
      const suffix = n === 1 ? '' : `-${n}`;
      const candidate = `${base.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
      if (!(await em.getRepository(Category).exists({ where: { slug: candidate }, withDeleted: true }))) return candidate;
    }
    throw AppException.of('SLUG_TAKEN', { slug: base });
  }
}
