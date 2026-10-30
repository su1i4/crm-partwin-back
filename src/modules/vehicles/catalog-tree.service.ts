import { Injectable } from '@nestjs/common';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { SettingsService } from '../settings/settings.service';
import { VehicleDirectoryService } from './vehicle-directory.service';

/**
 * Каталог «по маркам» (ТЗ 6.3): дерево строится из применимости. Деталь к Toyota и Lexus видна в обеих ветках.
 * «Наши марки» — первыми, остальные — за «Другие марки». Плюс ветки «Универсальное» и «Без привязки к авто».
 */
@Injectable()
export class CatalogTreeService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly dir: VehicleDirectoryService,
    private readonly settings: SettingsService,
  ) {}

  async byMakes(depth?: 'make' | 'model' | 'generation') {
    return this.tenantTx.run(async (tx) => {
      const s = await this.settings.get(tx);
      const level = depth ?? (s.makeTreeDepth === 'modification' ? 'generation' : s.makeTreeDepth);
      const counts = await tx.query(
        `SELECT a.make_id, a.model_id, a.generation_id, count(DISTINCT a.product_id)::int AS n
           FROM product_applicability a JOIN products p ON p.id = a.product_id AND p.deleted_at IS NULL AND p.status = 'active'
          WHERE a.tenant_id = $1 GROUP BY GROUPING SETS ((a.make_id), (a.make_id, a.model_id), (a.make_id, a.model_id, a.generation_id))`,
        [tx.tenantId],
      );
      const [{ universal, novehicle }] = await tx.query(
        `WITH uc AS (SELECT c.id FROM categories c WHERE c.tenant_id = $1 AND c.deleted_at IS NULL AND EXISTS (
                       SELECT 1 FROM categories u WHERE u.tenant_id = c.tenant_id AND u.deleted_at IS NULL
                          AND (u.settings->>'universal')::boolean AND c.path LIKE u.path || '%'))
         SELECT count(*) FILTER (WHERE p.category_id IN (SELECT id FROM uc))::int AS universal,
                count(*) FILTER (WHERE (p.category_id IS NULL OR p.category_id NOT IN (SELECT id FROM uc)) AND p.kind = 'goods')::int AS novehicle
           FROM products p
          WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id)`,
        [tx.tenantId],
      );
      const full = await this.dir.full(tx);
      const ours = new Set(s.ourMakes);
      const makeCount = (id: string) => counts.find((c: any) => c.make_id === id && c.model_id === null && c.generation_id === null)?.n ?? 0;

      const makes = full.makes
        .map((mk) => {
          const node: any = { id: mk.id, code: mk.code, name: mk.name, count: makeCount(mk.id), ours: ours.has(mk.code) };
          if (level !== 'make') {
            node.models = full.models
              .filter((m) => m.makeId === mk.id)
              .map((md) => {
                const mNode: any = {
                  id: md.id,
                  name: md.name,
                  own: md.own,
                  count: counts.find((c: any) => c.model_id === md.id && c.generation_id === null && c.make_id === mk.id)?.n ?? 0,
                };
                if (level === 'generation') {
                  mNode.generations = full.generations
                    .filter((g) => g.modelId === md.id)
                    .map((g) => ({
                      id: g.id,
                      name: g.name,
                      years: g.yearFrom ? `${g.yearFrom}–${g.yearTo ?? 'н.в.'}` : null,
                      restyle: g.restyle,
                      own: g.own,
                      count: counts.find((c: any) => c.generation_id === g.id)?.n ?? 0,
                    }));
                }
                return mNode;
              });
          }
          return node;
        })
        .sort((a, b) => Number(b.ours) - Number(a.ours) || b.count - a.count || a.name.localeCompare(b.name));

      return {
        depth: level,
        ourMakes: makes.filter((m) => m.ours),
        otherMakes: makes.filter((m) => !m.ours),
        makeGroups: s.makeGroups,
        universal: { count: universal },
        noVehicle: { count: novehicle },
      };
    });
  }
}
