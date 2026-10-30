import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { normalizePartNumber } from '../../common/utils/part-number';
import { baseNormalize } from '../../common/utils/text-search';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { ScopeService } from '../auth/scope.service';
import { PricesService } from '../pricing/prices.service';
import { CategoriesService } from './categories.service';
import { ProductListQueryDto } from './dto/product.dto';
import { QUALITY_LABELS } from './entities/product.entity';

const SORTS: Record<string, string> = {
  name: 'p.name',
  sku: 'p.sku',
  createdAt: 'p.created_at',
  updatedAt: 'p.updated_at',
};

/** Список товаров каталога с фильтрами (ТЗ 4.8, 6.3, 23.3). */
@Injectable()
export class ProductsQueryService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly categories: CategoriesService,
    private readonly prices: PricesService,
    private readonly scope: ScopeService,
  ) {}

  async list(q: ProductListQueryDto) {
    return this.tenantTx.run(async (tx) => {
      const { where, params } = await this.buildWhere(tx, q);
      const sortField = q.sort?.replace(/^-/, '');
      const order = sortField && SORTS[sortField] ? `${SORTS[sortField]} ${q.sort!.startsWith('-') ? 'DESC' : 'ASC'}` : 'p.name ASC';
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM products p WHERE ${where}`, params);
      const rows = await tx.query(
        `SELECT p.id, p.sku, p.name, p.kind, p.quality_class AS "qualityClass", p.status, p.no_stock_control AS "noStockControl",
                p.is_serial AS "isSerial", p.price_negotiable AS "priceNegotiable", p.quick_created AS "quickCreated",
                p.base_unit AS "baseUnit", p.tags, p.version, p.updated_at AS "updatedAt",
                b.id AS "brandId", b.name AS "brandName", c.id AS "categoryId", c.name AS "categoryName",
                (SELECT n.number FROM part_numbers n WHERE n.tenant_id = p.tenant_id AND n.product_id = p.id
                  ORDER BY (n.type = 'manufacturer') DESC, n.created_at LIMIT 1) AS "mainNumber",
                (SELECT ph.file_id FROM product_photos ph WHERE ph.tenant_id = p.tenant_id AND ph.product_id = p.id
                  ORDER BY ph.sort LIMIT 1) AS "photoFileId"
           FROM products p
           LEFT JOIN brands b ON b.id = p.brand_id
           LEFT JOIN categories c ON c.id = p.category_id
          WHERE ${where}
          ORDER BY ${order}
          LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      const priceMap = await this.prices.retailMap(tx, rows.map((r: any) => r.id), this.scope.currentStoreId());
      return {
        items: rows.map((r: any) => ({
          ...r,
          qualityLabel: QUALITY_LABELS[r.qualityClass as keyof typeof QUALITY_LABELS],
          retailPrice: priceMap.get(r.id)?.price ?? null,
          retailCurrency: priceMap.get(r.id)?.currency ?? null,
        })),
        total,
      };
    });
  }

  /** Условие выборки — общее для списка, массовых операций и экспорта. */
  async buildWhere(tx: TenantTx, q: ProductListQueryDto): Promise<{ where: string; params: unknown[] }> {
    const params: unknown[] = [tx.tenantId];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const w: string[] = ['p.tenant_id = $1', 'p.deleted_at IS NULL'];
    const status = q.status ?? 'active';
    if (status !== 'all') w.push(`p.status = ${p(status)}`);
    else w.push(`p.status <> 'system'`);
    if (q.categoryId) w.push(`p.category_id = ANY(${p(await this.categories.subtreeIds(tx, q.categoryId))}::uuid[])`);
    if (q.brandId) w.push(`p.brand_id = ${p(q.brandId)}`);
    if (q.partTypeId) w.push(`p.part_type_id = ${p(q.partTypeId)}`);
    if (q.qualityClass) w.push(`p.quality_class = ${p(q.qualityClass)}`);
    if (q.kind) w.push(`p.kind = ${p(q.kind)}`);
    if (q.tag) w.push(`${p(q.tag)} = ANY(p.tags)`);
    if (q.quickCreated !== undefined) w.push(`p.quick_created = ${p(q.quickCreated)}`);
    if (q.noStockControl !== undefined) w.push(`p.no_stock_control = ${p(q.noStockControl)}`);
    if (q.attributes) {
      let attrs: unknown;
      try {
        attrs = JSON.parse(q.attributes);
      } catch {
        throw Errors.bad('BAD_FILTER', 'attributes — JSON-объект');
      }
      if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) throw Errors.bad('BAD_FILTER', 'attributes — JSON-объект');
      w.push(`p.attributes @> ${p(JSON.stringify(attrs))}::jsonb`);
    }
    // По машине: точное поколение + товары с менее точной меткой на эту модель (ТЗ 5.2, «применимость не уточнена»)
    if (q.generationId) {
      w.push(`EXISTS (SELECT 1 FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id
                 AND (a.generation_id = ${p(q.generationId)}
                      OR (a.generation_id IS NULL AND a.model_id = (SELECT model_id FROM global_vehicle_generations WHERE id = $${params.length}
                            UNION SELECT model_id FROM tenant_vehicle_generations WHERE id = $${params.length} LIMIT 1))))`);
    } else if (q.modelId) {
      w.push(`EXISTS (SELECT 1 FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id AND a.model_id = ${p(q.modelId)})`);
    } else if (q.makeId) {
      w.push(`EXISTS (SELECT 1 FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id AND a.make_id = ${p(q.makeId)})`);
    }
    if (q.vehicleBranch) {
      const universalCats = `(SELECT c.id FROM categories c WHERE c.tenant_id = p.tenant_id AND c.deleted_at IS NULL AND EXISTS (
          SELECT 1 FROM categories u WHERE u.tenant_id = c.tenant_id AND (u.settings->>'universal')::boolean
             AND c.path LIKE u.path || '%'))`;
      const noApp = `NOT EXISTS (SELECT 1 FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id)`;
      if (q.vehicleBranch === 'universal') w.push(`${noApp} AND p.category_id IN ${universalCats}`);
      else w.push(`${noApp} AND (p.category_id IS NULL OR p.category_id NOT IN ${universalCats}) AND p.kind = 'goods'`);
    }
    if (q.missing) {
      for (const m of q.missing.split(',').map((s) => s.trim())) {
        if (m === 'price') w.push(`NOT p.price_negotiable AND NOT EXISTS (SELECT 1 FROM prices pr WHERE pr.tenant_id = p.tenant_id AND pr.product_id = p.id)`);
        else if (m === 'photo') w.push(`NOT EXISTS (SELECT 1 FROM product_photos ph WHERE ph.tenant_id = p.tenant_id AND ph.product_id = p.id)`);
        else if (m === 'number') w.push(`NOT EXISTS (SELECT 1 FROM part_numbers n WHERE n.tenant_id = p.tenant_id AND n.product_id = p.id)`);
        else if (m === 'category') w.push(`p.category_id IS NULL`);
        else if (m === 'applicability') w.push(`NOT EXISTS (SELECT 1 FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id)`);
        else if (m === 'stock') w.push(`p.no_stock_control`);
        else throw Errors.bad('BAD_FILTER', `Неизвестный фильтр missing: ${m}`);
      }
    }
    if (q.q) {
      const text = baseNormalize(q.q);
      const num = normalizePartNumber(q.q);
      const tokens = text.split(' ').filter((t) => t.length > 0).slice(0, 8);
      const textCond = tokens.map((t) => `p.search_text ILIKE ${p(`%${t}%`)}`).join(' AND ');
      const numCond =
        num.length >= 3
          ? `EXISTS (SELECT 1 FROM part_numbers n WHERE n.tenant_id = p.tenant_id AND n.product_id = p.id AND n.normalized LIKE ${p(`${num}%`)})`
          : 'false';
      w.push(`((${textCond || 'true'}) OR ${numCond} OR p.sku = ${p(q.q.trim())})`);
    }
    return { where: w.join(' AND '), params };
  }
}
