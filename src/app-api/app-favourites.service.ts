import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { AppException } from '../common/errors/app.exception.js';
import type { Lang } from '../common/i18n/language.js';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import { runInTransaction } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { Favourite } from '../services/entities/favourite.entity.js';
import { PACK_VISIBLE_SQL } from '../packs/packs.policy.js';
import { SERVICE_VISIBLE_SQL } from '../services/services.policy.js';
import { toCategoryRef } from './app-refs.js';
import { pickText } from './app.policy.js';
import { FileVariantKind } from '../common/enums/file.enums.js';
import type { AppFavouriteDto, AppFavouritesQueryDto, CreateFavouriteDto } from './dto/app-me.dto.js';

/**
 * Screen 17 "Favorites": a client's saved services and packs. Rows survive the
 * target becoming invisible (`available: false`) so the list does not silently
 * shrink; the card is greyed out instead.
 */
@Injectable()
export class AppFavouritesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly files: FilesService,
  ) {}

  /**
   * The caller's favourite rows over these targets: `service_id`/`pack_id` →
   * favourite row id, for `isFavourite` and `favouriteId` on cards.
   */
  async marked(userId: string | null | undefined, serviceIds: string[], packIds: string[] = []): Promise<Map<string, string>> {
    if (!userId || (serviceIds.length === 0 && packIds.length === 0)) return new Map();
    const rows = await this.dataSource.query(
      `SELECT id, service_id, pack_id FROM favourites
       WHERE user_id = ? AND deleted_at IS NULL AND (service_id IN (?) OR pack_id IN (?))`,
      [userId, serviceIds.length > 0 ? serviceIds : [''], packIds.length > 0 ? packIds : ['']],
    );
    return new Map(rows.map((row: any) => [row.service_id ?? row.pack_id, row.id]));
  }

  /**
   * Remove by **target** (`?serviceId=` / `?packId=`), so un-saving from a card
   * needs no favourite row id. Idempotent: nothing to remove is still a 204.
   */
  async removeByTarget(auth: AuthUser, target: { serviceId?: string; packId?: string }): Promise<void> {
    const isService = Boolean(target.serviceId);
    const isPack = Boolean(target.packId);
    if (isService === isPack) throw AppException.of('FAVOURITE_TARGET_INVALID');
    const repository = this.dataSource.getRepository(Favourite);
    const row = await repository.findOneBy(
      isService ? { userId: auth.id, serviceId: target.serviceId! } : { userId: auth.id, packId: target.packId! },
    );
    if (!row) return;
    await repository.softDelete(row.id);
    await this.recount(row.serviceId);
  }

  async list(auth: AuthUser, query: AppFavouritesQueryDto, lang: Lang): Promise<Paginated<AppFavouriteDto>> {
    const where = ['f.user_id = ?', 'f.deleted_at IS NULL'];
    const params: unknown[] = [auth.id];
    if (query.categoryId) {
      // Packs have no category of their own, so a category chip shows services only.
      where.push('s.category_id = ?');
      params.push(query.categoryId);
    }
    if (query.kind === 'service') where.push('f.service_id IS NOT NULL');
    if (query.kind === 'pack') where.push('f.pack_id IS NOT NULL');
    const sql = where.join(' AND ');

    const from = `FROM favourites f
      LEFT JOIN services s ON s.id = f.service_id
      LEFT JOIN packs p ON p.id = f.pack_id
      LEFT JOIN users u ON u.id = COALESCE(s.provider_id, p.provider_id)
      LEFT JOIN provider_profiles pp ON pp.user_id = u.id AND pp.deleted_at IS NULL
      LEFT JOIN categories c ON c.id = s.category_id AND c.deleted_at IS NULL
      WHERE ${sql}`;

    const [rows, [total]] = await Promise.all([
      this.dataSource.query(
        `SELECT f.id, f.service_id, f.pack_id, f.created_at,
                s.title_en, s.title_ar, s.base_price, s.avg_rating AS s_rating, s.rating_count AS s_rating_count,
                p.name_en, p.name_ar, p.price, p.avg_rating AS p_rating, p.rating_count AS p_rating_count,
                c.id AS cat_id, c.slug AS cat_slug, c.name_en AS cat_name_en, c.name_ar AS cat_name_ar, c.icon AS cat_icon,
                COALESCE(pp.business_name, u.full_name) AS provider_name,
                (SELECT sp.file_id FROM service_photos sp WHERE sp.service_id = s.id ORDER BY sp.position, sp.created_at LIMIT 1) AS service_cover,
                (SELECT ph.file_id FROM pack_photos ph WHERE ph.pack_id = p.id ORDER BY ph.position, ph.created_at LIMIT 1) AS pack_cover,
                CASE WHEN f.service_id IS NOT NULL THEN ${SERVICE_VISIBLE_SQL} ELSE ${PACK_VISIBLE_SQL} END AS available
         ${from} ORDER BY f.created_at DESC, f.id DESC LIMIT ? OFFSET ?`,
        [...params, query.limit, (query.page - 1) * query.limit],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS n ${from}`, params),
    ]);

    return paginate(rows.map((row: any) => this.toDto(lang, row)), Number(total.n), query);
  }

  private toDto(lang: Lang, row: any): AppFavouriteDto {
    const isService = row.service_id !== null;
    const coverId = isService ? row.service_cover : row.pack_cover;
    const titleEn = isService ? row.title_en : row.name_en;
    const titleAr = isService ? row.title_ar : row.name_ar;
    return {
      id: row.id,
      kind: isService ? 'service' : 'pack',
      targetId: isService ? row.service_id : row.pack_id,
      title: pickText(lang, titleEn, titleAr),
      titleEn: titleEn ?? '',
      titleAr: titleAr ?? '',
      providerName: row.provider_name ?? '',
      category: toCategoryRef(lang, row.cat_id ? { id: row.cat_id, slug: row.cat_slug, name_en: row.cat_name_en, name_ar: row.cat_name_ar, icon: row.cat_icon } : null),
      fromPrice: String(isService ? row.base_price : row.price),
      coverUrl: coverId ? this.files.signedUrl(coverId, { variant: FileVariantKind.Thumb }) : null,
      avgRating: String(isService ? row.s_rating : row.p_rating),
      ratingCount: Number(isService ? row.s_rating_count : row.p_rating_count),
      available: Number(row.available) === 1,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  /** Idempotent: favouriting twice returns the existing row rather than 409. */
  async add(auth: AuthUser, dto: CreateFavouriteDto, lang: Lang): Promise<AppFavouriteDto> {
    const isService = Boolean(dto.serviceId);
    const isPack = Boolean(dto.packId);
    if (isService === isPack) throw AppException.of('FAVOURITE_TARGET_INVALID');

    const id = await runInTransaction(this.dataSource, async (em) => {
      if (isService) {
        const [row] = await em.query('SELECT id FROM services WHERE id = ? AND deleted_at IS NULL', [dto.serviceId]);
        if (!row) throw AppException.of('SERVICE_NOT_FOUND');
      } else {
        const [row] = await em.query('SELECT id FROM packs WHERE id = ? AND deleted_at IS NULL', [dto.packId]);
        if (!row) throw AppException.of('PACK_NOT_FOUND');
      }
      const repository = em.getRepository(Favourite);
      const existing = await repository.findOne({
        where: isService ? { userId: auth.id, serviceId: dto.serviceId! } : { userId: auth.id, packId: dto.packId! },
        withDeleted: true,
      });
      if (existing) {
        if (existing.deletedAt) await repository.restore(existing.id);
        return existing.id;
      }
      const created = await repository.save(
        repository.create({ userId: auth.id, serviceId: dto.serviceId ?? null, packId: dto.packId ?? null }),
      );
      return created.id;
    });

    await this.recount(dto.serviceId);
    const page = await this.list(auth, { page: 1, limit: 100 } as AppFavouritesQueryDto, lang);
    const found = page.data.find((row) => row.id === id);
    if (!found) throw AppException.of('FAVOURITE_NOT_FOUND');
    return found;
  }

  async remove(auth: AuthUser, id: string): Promise<void> {
    const repository = this.dataSource.getRepository(Favourite);
    const row = await repository.findOneBy({ id, userId: auth.id });
    if (!row) throw AppException.of('FAVOURITE_NOT_FOUND');
    await repository.softDelete(row.id);
    await this.recount(row.serviceId);
  }

  /** `services.favourites_count` is a cached counter shown on the admin list. */
  private async recount(serviceId: string | null | undefined): Promise<void> {
    if (!serviceId) return;
    await this.dataSource.query(
      'UPDATE services SET favourites_count = (SELECT COUNT(*) FROM favourites f WHERE f.service_id = ? AND f.deleted_at IS NULL) WHERE id = ?',
      [serviceId, serviceId],
    );
  }
}
