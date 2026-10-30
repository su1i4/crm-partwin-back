import { Injectable } from '@nestjs/common';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { CATEGORY_PRESET, CategoryPreset } from '../../database/seeds/presets/categories.preset';
import { COMMON_ATTRIBUTES, PART_TYPE_PRESET } from '../../database/seeds/presets/part-types.preset';
import { Category } from './entities/category.entity';
import { Attribute, PartType } from './entities/part-type.entity';

/** Пресеты каталога: дерево категорий (ТЗ 4.6), типы деталей и атрибуты (ТЗ 4.5). Повторный запуск не плодит дубли. */
@Injectable()
export class CatalogPresetsService {
  async apply(tx: TenantTx): Promise<{ categories: number; partTypes: number; attributes: number }> {
    const result = { categories: 0, partTypes: 0, attributes: 0 };

    // Категории
    const existing = await tx.repo(Category).find({ withDeleted: true });
    const byCode = new Map(existing.filter((c) => c.presetCode).map((c) => [c.presetCode!, c]));
    const walk = async (nodes: CategoryPreset[], parent: Category | null, level: number) => {
      let sort = 0;
      for (const node of nodes) {
        sort += 10;
        let cat = byCode.get(node.code);
        if (!cat) {
          cat = await tx.repo(Category).insert({
            parentId: parent?.id ?? null,
            name: node.name,
            level,
            sort,
            presetCode: node.code,
            settings: node.settings ?? {},
            path: '/',
          });
          cat.path = `${parent ? parent.path : '/'}${cat.id}/`;
          await tx.query(`UPDATE categories SET path = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, cat.id, cat.path]);
          result.categories++;
        }
        if (node.children?.length) await walk(node.children, cat, level + 1);
      }
    };
    await walk(CATEGORY_PRESET, null, 0);

    // Атрибуты для всех деталей
    const attrs = await tx.repo(Attribute).find({ withDeleted: true });
    const hasAttr = (typeId: string | null, code: string) => attrs.some((a) => a.partTypeId === typeId && a.code === code);
    let sort = 0;
    for (const a of COMMON_ATTRIBUTES) {
      sort += 10;
      if (hasAttr(null, a.code)) continue;
      await tx.repo(Attribute).insert({ ...a, partTypeId: null, isSystem: true, sort, options: a.options ?? [] });
      result.attributes++;
    }

    // Типы деталей
    const types = await tx.repo(PartType).find({ withDeleted: true });
    let tSort = 0;
    for (const t of PART_TYPE_PRESET) {
      tSort += 10;
      let type = types.find((x) => x.code === t.code);
      if (!type) {
        type = await tx.repo(PartType).insert({ code: t.code, name: t.name, isSystem: true, sort: tSort });
        result.partTypes++;
      }
      let aSort = 0;
      for (const a of t.attributes) {
        aSort += 10;
        if (hasAttr(type.id, a.code)) continue;
        await tx.repo(Attribute).insert({ ...a, partTypeId: type.id, isSystem: true, sort: aSort, options: a.options ?? [] });
        result.attributes++;
      }
    }
    return result;
  }
}
