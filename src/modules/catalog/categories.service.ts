import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { Category, CategorySettings } from './entities/category.entity';

/** Дерево категорий (ТЗ 4.6). Настройки (гарантия, возврат, «парой», минус) наследуются вниз по дереву. */
@Injectable()
export class CategoriesService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return this.tenantTx.run(async (tx) => {
      const rows = await tx.query(
        `SELECT c.id, c.parent_id AS "parentId", c.name, c.path, c.level, c.sort, c.settings, c.preset_code AS "presetCode",
                c.version, (SELECT count(*)::int FROM products p WHERE p.tenant_id = c.tenant_id AND p.category_id = c.id
                             AND p.deleted_at IS NULL AND p.status = 'active') AS "productsCount"
           FROM categories c WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
          ORDER BY c.level, c.sort, c.name`,
        [tx.tenantId],
      );
      return rows;
    });
  }

  /** Категория и все потомки (для фильтра каталога). */
  async subtreeIds(tx: TenantTx, categoryId: string): Promise<string[]> {
    const c = await tx.repo(Category, 'Категория').getById(categoryId);
    const rows = await tx.query<{ id: string }>(
      `SELECT id FROM categories WHERE tenant_id = $1 AND deleted_at IS NULL AND path LIKE $2`,
      [tx.tenantId, `${c.path}%`],
    );
    return rows.map((r) => r.id);
  }

  /** Действующие настройки с наследованием от предков. */
  async effectiveSettings(tx: TenantTx, categoryId: string | null): Promise<CategorySettings> {
    if (!categoryId) return {};
    const c = await tx.repo(Category).findById(categoryId);
    if (!c) return {};
    const ids = c.path.split('/').filter(Boolean);
    const chain = await tx.repo(Category).findByIds(ids);
    const ordered = ids.map((id) => chain.find((x) => x.id === id)).filter(Boolean) as Category[];
    const out: CategorySettings = {};
    for (const node of ordered) {
      for (const [k, v] of Object.entries(node.settings ?? {})) if (v !== null && v !== undefined) (out as any)[k] = v;
    }
    return out;
  }

  async create(dto: { name: string; parentId?: string; sort?: number; settings?: CategorySettings }) {
    return this.tenantTx.run(async (tx) => {
      const parent = dto.parentId ? await tx.repo(Category, 'Категория').getById(dto.parentId) : null;
      const cat = await tx.repo(Category).insert({
        name: dto.name.trim(),
        parentId: parent?.id ?? null,
        level: parent ? parent.level + 1 : 0,
        sort: dto.sort ?? 0,
        settings: dto.settings ?? {},
        path: '/',
      });
      cat.path = `${parent ? parent.path : '/'}${cat.id}/`;
      await tx.query(`UPDATE categories SET path = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, cat.id, cat.path]);
      await this.audit.log(tx, { action: 'category.create', entityType: 'category', entityId: cat.id, after: cat });
      return cat;
    });
  }

  async update(id: string, dto: { version: number; name?: string; parentId?: string | null; sort?: number; settings?: CategorySettings }) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(Category, 'Категория').getById(id, { lock: { mode: 'pessimistic_write' } } as any);
      if (c.version !== dto.version) throw Errors.versionConflict();
      const before = { ...c };
      if (dto.name) c.name = dto.name.trim();
      if (dto.sort !== undefined) c.sort = dto.sort;
      if (dto.settings) c.settings = { ...c.settings, ...dto.settings };

      if (dto.parentId !== undefined && dto.parentId !== c.parentId) {
        const parent = dto.parentId ? await tx.repo(Category, 'Категория').getById(dto.parentId) : null;
        if (parent && parent.path.startsWith(c.path)) throw Errors.bad('CATEGORY_CYCLE', 'Нельзя перенести категорию внутрь себя');
        const oldPath = c.path;
        const newPath = `${parent ? parent.path : '/'}${c.id}/`;
        const levelDelta = (parent ? parent.level + 1 : 0) - c.level;
        await tx.query(
          `UPDATE categories SET path = $3 || substr(path, length($2) + 1), level = level + $4
            WHERE tenant_id = $1 AND path LIKE $2 || '%'`,
          [tx.tenantId, oldPath, newPath, levelDelta],
        );
        c.parentId = parent?.id ?? null;
        c.path = newPath;
        c.level += levelDelta;
      }
      const saved = await tx.repo(Category).save(c);
      await this.audit.log(tx, { action: 'category.update', entityType: 'category', entityId: id, before, after: saved });
      return saved;
    });
  }

  async remove(id: string, version: number) {
    await this.tenantTx.run(async (tx) => {
      const c = await tx.repo(Category, 'Категория').getById(id);
      if (c.version !== version) throw Errors.versionConflict();
      const children = await tx.repo(Category).count({ where: { parentId: id } });
      if (children) throw Errors.conflict('CATEGORY_HAS_CHILDREN', 'Сначала удалите или перенесите подкатегории');
      const [{ n }] = await tx.query(
        `SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND category_id = $2 AND deleted_at IS NULL`,
        [tx.tenantId, id],
      );
      if (n) throw Errors.conflict('CATEGORY_IN_USE', `В категории ${n} товаров. Перенесите их`);
      await tx.repo(Category).softDelete(id);
      await this.audit.log(tx, { action: 'category.delete', entityType: 'category', entityId: id, before: c });
    });
  }
}
