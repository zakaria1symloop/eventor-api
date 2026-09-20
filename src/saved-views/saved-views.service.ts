import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, Not, type DataSource, type EntityManager } from 'typeorm';
import { SavedView } from '../admin/entities/saved-view.entity.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { runInTransaction } from '../database/transaction.js';
import type { CreateSavedViewDto, SavedViewDto, SavedViewsQueryDto, UpdateSavedViewDto } from './dto/saved-views.dto.js';

/** Saved list filters: private to the owner, or shared with every admin. */
@Injectable()
export class SavedViewsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** Small per-admin lists: no pagination, no index beyond the owner FK. */
  async list(auth: AuthUser, query: SavedViewsQueryDto): Promise<SavedViewDto[]> {
    const qb = this.dataSource
      .getRepository(SavedView)
      .createQueryBuilder('view')
      .innerJoin('view.owner', 'owner')
      .addSelect(['owner.id', 'owner.fullName'])
      .withDeleted()
      .where('view.deletedAt IS NULL')
      .andWhere(new Brackets((w) => w.where('view.ownerId = :me', { me: auth.id }).orWhere('view.isShared = 1')))
      .orderBy('view.name', 'ASC')
      .addOrderBy('view.id', 'ASC');
    if (query.resource) qb.andWhere('view.resource = :resource', { resource: query.resource });
    return (await qb.getMany()).map((view) => this.toDto(auth, view));
  }

  async create(auth: AuthUser, dto: CreateSavedViewDto): Promise<SavedViewDto> {
    return runInTransaction(this.dataSource, async (em) => {
      await this.assertNameFree(em, auth.id, dto.resource, dto.name);
      const repository = em.getRepository(SavedView);
      const view = await repository.save(
        repository.create({ ownerId: auth.id, resource: dto.resource, name: dto.name, query: dto.query, isShared: dto.isShared ?? false }),
      );
      await this.audit.log(
        {
          action: 'saved_view.created',
          objectType: 'saved_view',
          objectId: view.id,
          objectLabel: view.name,
          level: AuditLevel.Info,
          changes: { resource: view.resource, isShared: view.isShared },
        },
        em,
      );
      return this.load(auth, em, view.id);
    });
  }

  async update(auth: AuthUser, id: string, dto: UpdateSavedViewDto): Promise<SavedViewDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const view = await this.loadOwned(auth, em, id);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (dto.name !== undefined && dto.name !== view.name) {
        await this.assertNameFree(em, auth.id, view.resource, dto.name, view.id);
        changes.name = { from: view.name, to: dto.name };
        view.name = dto.name;
      }
      if (dto.isShared !== undefined && dto.isShared !== view.isShared) {
        changes.isShared = { from: view.isShared, to: dto.isShared };
        view.isShared = dto.isShared;
      }
      if (dto.query !== undefined && JSON.stringify(dto.query) !== JSON.stringify(view.query)) {
        changes.query = { from: view.query, to: dto.query };
        view.query = dto.query;
      }
      if (Object.keys(changes).length > 0) {
        await em.getRepository(SavedView).save(view);
        await this.audit.log(
          { action: 'saved_view.updated', objectType: 'saved_view', objectId: view.id, objectLabel: view.name, level: AuditLevel.Info, changes },
          em,
        );
      }
      return this.load(auth, em, view.id);
    });
  }

  async remove(auth: AuthUser, id: string): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const view = await this.loadOwned(auth, em, id);
      await em.getRepository(SavedView).softDelete(view.id);
      await this.audit.log(
        { action: 'saved_view.deleted', objectType: 'saved_view', objectId: view.id, objectLabel: view.name, level: AuditLevel.Info },
        em,
      );
    });
  }

  /** 404 when missing or not visible to me; 403 NOT_OWNER for another admin's shared view. */
  private async loadOwned(auth: AuthUser, em: EntityManager, id: string): Promise<SavedView> {
    const view = await em.getRepository(SavedView).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!view || (view.ownerId !== auth.id && !view.isShared)) throw AppException.of('SAVED_VIEW_NOT_FOUND');
    if (view.ownerId !== auth.id) throw AppException.of('NOT_OWNER');
    return view;
  }

  private async assertNameFree(em: EntityManager, ownerId: string, resource: string, name: string, exceptId?: string): Promise<void> {
    const taken = await em.getRepository(SavedView).exists({
      where: { ownerId, resource, name, ...(exceptId ? { id: Not(exceptId) } : {}) },
    });
    if (taken) throw AppException.of('SAVED_VIEW_NAME_TAKEN');
  }

  private async load(auth: AuthUser, em: EntityManager, id: string): Promise<SavedViewDto> {
    const view = await em.getRepository(SavedView).findOneOrFail({ where: { id }, relations: { owner: true }, withDeleted: true });
    return this.toDto(auth, view);
  }

  private toDto(auth: AuthUser, view: SavedView): SavedViewDto {
    return {
      id: view.id,
      resource: view.resource,
      name: view.name,
      query: view.query,
      isShared: view.isShared,
      owner: { id: view.owner.id, fullName: view.owner.fullName },
      isOwner: view.ownerId === auth.id,
      createdAt: view.createdAt.toISOString(),
      updatedAt: view.updatedAt.toISOString(),
    };
  }
}
