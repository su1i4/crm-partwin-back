import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { DocumentsService } from '../documents/documents.service';
import { StockProbeService } from '../inventory/stock-probe.service';
import { BrandsService } from './brands.service';
import { BulkUpdateDto } from './dto/dictionaries.dto';
import { ProductListQueryDto } from './dto/product.dto';
import { Category } from './entities/category.entity';
import { PartType } from './entities/part-type.entity';
import { Product, QUALITY_CLASSES } from './entities/product.entity';
import { ProductsQueryService } from './products-query.service';
import { ProductsService } from './products.service';
import { SearchTextService } from './search-text.service';
import { plainToInstance } from 'class-transformer';

/** Массовые операции и обслуживание каталога (ТЗ 4.7, 4.8). */
@Injectable()
export class CatalogOpsService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly query: ProductsQueryService,
    private readonly products: ProductsService,
    private readonly brands: BrandsService,
    private readonly searchText: SearchTextService,
    private readonly stock: StockProbeService,
    private readonly audit: AuditService,
    private readonly docs: DocumentsService,
  ) {}

  /** Массовое изменение по выбору или по фильтру. */
  async bulkUpdate(dto: BulkUpdateDto) {
    if (!dto.ids?.length && !dto.filter) throw Errors.bad('NO_SELECTION', 'Выберите товары или задайте фильтр');
    const s = dto.set ?? {};
    if (s.qualityClass && !(QUALITY_CLASSES as readonly string[]).includes(s.qualityClass)) throw Errors.bad('BAD_QUALITY', 'Неизвестный класс качества');
    if (s.status && !['active', 'archived'].includes(s.status)) throw Errors.bad('BAD_STATUS', 'Неизвестный статус');
    return this.tenantTx.run(async (tx) => {
      let ids: string[];
      if (dto.ids?.length) {
        ids = (await tx.repo(Product, 'Товар').getByIds(dto.ids)).map((p) => p.id);
      } else {
        const q = plainToInstance(ProductListQueryDto, { ...dto.filter, page: 1, limit: 1 });
        const { where, params } = await this.query.buildWhere(tx, q);
        ids = (await tx.query(`SELECT p.id FROM products p WHERE ${where} LIMIT 50001`, params)).map((r: any) => r.id);
        if (ids.length > 50000) throw Errors.bad('TOO_MANY', 'Больше 50 000 товаров — сузьте фильтр');
      }
      if (!ids.length) return { updated: 0 };

      if (s.categoryId) await tx.repo(Category, 'Категория').getById(s.categoryId);
      if (s.partTypeId) await tx.repo(PartType, 'Тип детали').getById(s.partTypeId);
      const brand = s.brand ? await this.brands.resolve(tx, s.brand, true) : null;
      if (s.attributes) {
        // Атрибуты проверяем по типу каждого товара группами
        const types = await tx.query(`SELECT DISTINCT part_type_id FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tx.tenantId, ids]);
        for (const t of types) await this.products.validateAttributes(tx, t.part_type_id, s.attributes, false);
      }

      const sets: string[] = ['updated_at = now()', 'version = version + 1'];
      const params: unknown[] = [tx.tenantId, ids];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      if (s.categoryId !== undefined) sets.push(`category_id = ${p(s.categoryId)}`);
      if (s.partTypeId !== undefined) sets.push(`part_type_id = ${p(s.partTypeId)}`);
      if (brand) sets.push(`brand_id = ${p(brand.id)}`);
      if (s.qualityClass) sets.push(`quality_class = ${p(s.qualityClass)}`);
      if (s.status) sets.push(`status = ${p(s.status)}`);
      if (s.attributes) sets.push(`attributes = attributes || ${p(JSON.stringify(s.attributes))}::jsonb`);
      if (s.addTags?.length) sets.push(`tags = (SELECT array(SELECT DISTINCT unnest(tags || ${p(s.addTags)}::text[])))`);
      if (s.removeTags?.length) sets.push(`tags = array(SELECT unnest(tags) EXCEPT SELECT unnest(${p(s.removeTags)}::text[]))`);
      if (s.noStockControl === true) sets.push(`no_stock_control = true`);
      if (s.priceNegotiable !== undefined) sets.push(`price_negotiable = ${p(s.priceNegotiable)}`);
      if (sets.length === 2) throw Errors.bad('NOTHING_TO_SET', 'Не выбрано, что менять');
      await tx.query(`UPDATE products SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`, params);
      if (brand) {
        // Номер производителя привязан к бренду
        await tx.query(
          `UPDATE part_numbers SET brand_id = $3 WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND type = 'manufacturer'`,
          [tx.tenantId, ids, brand.id],
        );
      }
      for (let i = 0; i < ids.length; i += 500) await this.searchText.rebuild(tx, ids.slice(i, i + 500));
      await this.audit.log(tx, {
        action: 'product.bulk_update',
        entityType: 'product',
        summary: `Массовое изменение ${ids.length} товаров`,
        after: { set: s, count: ids.length, ids: ids.slice(0, 1000) },
        important: true,
      });
      return { updated: ids.length };
    });
  }

  /**
   * Объединение дублей (ТЗ 4.8): дубль — в архив со ссылкой на основной; штрихкоды, номера, фото и применимость
   * переносятся. Проведённые документы не меняются. Перенос остатка «Пересортицей» — на этапе «Склад».
   */
  async merge(targetId: string, duplicateIds: string[]) {
    if (duplicateIds.includes(targetId)) throw Errors.bad('MERGE_SELF', 'Товар не может быть дублем сам себя');
    return this.tenantTx.run(async (tx) => {
      const target = await tx.repo(Product, 'Товар').getById(targetId);
      const dups = await tx.repo(Product, 'Дубль').getByIds(duplicateIds);
      if (target.kind !== 'goods' || dups.some((d) => d.kind !== target.kind)) throw Errors.bad('MERGE_KIND', 'Объединяются только обычные товары');
      // Остаток дубля переносится «Пересортицей» текущей датой; проведённые документы не меняются (ТЗ 4.8)
      const resortDocs: string[] = [];
      for (const d of dups) {
        if (d.isSerial || target.isSerial) {
          if (await this.stock.hasMovements(tx, d.id)) throw Errors.conflict('MERGE_SERIAL', `«${d.name}»: серийные товары с движениями не объединяются`);
          continue;
        }
        if (d.baseUnit !== target.baseUnit && (await this.stock.hasMovements(tx, d.id))) {
          throw Errors.conflict('MERGE_UNIT', `«${d.name}»: другая базовая единица (${d.baseUnit} ≠ ${target.baseUnit})`);
        }
        const bals = await tx.query(
          `SELECT b.warehouse_id, b.qty FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
            WHERE b.tenant_id = $1 AND b.product_id = $2 AND b.qty <> 0`,
          [tx.tenantId, d.id],
        );
        if (bals.some((b: any) => Number(b.qty) < 0)) throw Errors.conflict('MERGE_NEGATIVE', `У «${d.name}» остаток в минусе — сначала исправьте`);
        for (const b of bals) {
          const doc = await this.docs.createInTx(
            tx,
            { type: 'resort', warehouseId: b.warehouse_id, comment: `Объединение дубля ${d.sku} → ${target.sku}`, lines: [{ productId: d.id, productToId: target.id, qty: String(b.qty) }] },
            { system: true },
          );
          await this.docs.postInTx(tx, doc, { system: true });
          resortDocs.push(doc.id);
        }
      }
      const t = tx.tenantId;
      for (const d of dups) {
        await tx.query(
          `UPDATE product_barcodes b SET product_id = $2,
                  unit_id = (SELECT id FROM product_units WHERE tenant_id = $1 AND product_id = $2 AND is_base)
            WHERE b.tenant_id = $1 AND b.product_id = $3
              AND NOT EXISTS (SELECT 1 FROM product_barcodes x WHERE x.tenant_id = $1 AND x.product_id = $2 AND x.barcode = b.barcode)`,
          [t, targetId, d.id],
        );
        await tx.query(`DELETE FROM product_barcodes WHERE tenant_id = $1 AND product_id = $2`, [t, d.id]);
        await tx.query(
          `UPDATE part_numbers n SET product_id = $2 WHERE n.tenant_id = $1 AND n.product_id = $3
              AND NOT EXISTS (SELECT 1 FROM part_numbers x WHERE x.tenant_id = $1 AND x.product_id = $2
                               AND x.normalized = n.normalized AND x.brand_id IS NOT DISTINCT FROM n.brand_id)`,
          [t, targetId, d.id],
        );
        await tx.query(`DELETE FROM part_numbers WHERE tenant_id = $1 AND product_id = $2`, [t, d.id]);
        await tx.query(
          `UPDATE product_photos SET product_id = $2, sort = sort + 100 WHERE tenant_id = $1 AND product_id = $3`,
          [t, targetId, d.id],
        );
        await tx.query(
          `UPDATE product_applicability a SET product_id = $2 WHERE a.tenant_id = $1 AND a.product_id = $3
              AND NOT EXISTS (SELECT 1 FROM product_applicability x WHERE x.tenant_id = $1 AND x.product_id = $2
                 AND x.make_id = a.make_id AND x.model_id IS NOT DISTINCT FROM a.model_id
                 AND x.generation_id IS NOT DISTINCT FROM a.generation_id AND x.modification_id IS NOT DISTINCT FROM a.modification_id)`,
          [t, targetId, d.id],
        );
        await tx.query(`DELETE FROM product_applicability WHERE tenant_id = $1 AND product_id = $2`, [t, d.id]);
        await tx.query(`UPDATE kit_components SET component_id = $2 WHERE tenant_id = $1 AND component_id = $3`, [t, targetId, d.id]);
        d.status = 'archived';
        d.mergedIntoId = targetId;
        await tx.repo(Product).save(d);
      }
      // Не больше 10 фото
      await tx.query(
        `DELETE FROM product_photos WHERE tenant_id = $1 AND product_id = $2 AND id NOT IN (
           SELECT id FROM product_photos WHERE tenant_id = $1 AND product_id = $2 ORDER BY sort LIMIT 10)`,
        [t, targetId],
      );
      await this.searchText.rebuild(tx, [targetId, ...duplicateIds]);
      await this.audit.log(tx, {
        action: 'product.merge',
        entityType: 'product',
        entityId: targetId,
        summary: `Объединены дубли: ${dups.map((d) => d.sku).join(', ')} → ${target.sku}`,
        after: { duplicates: dups.map((d) => ({ id: d.id, sku: d.sku, name: d.name })), resortDocuments: resortDocs },
        important: true,
      });
      return this.products.cardInTx(tx, targetId);
    });
  }

  /**
   * «Дозаполнить» (ТЗ 4.7): товары без цены, остатка, фото, номера, категории, применимости.
   * Сортировка по числу продаж появится с кассой (этап 3); сейчас — сначала быстро созданные, затем новые.
   */
  async toFill(page = 1, limit = 50) {
    return this.tenantTx.run(async (tx) => {
      const base = `
        WITH f AS (
          SELECT p.id, p.sku, p.name, p.quick_created AS "quickCreated", p.created_at AS "createdAt",
                 (NOT p.price_negotiable AND NOT EXISTS (SELECT 1 FROM prices pr WHERE pr.tenant_id = p.tenant_id AND pr.product_id = p.id)) AS "noPrice",
                 p.no_stock_control AS "noStock",
                 NOT EXISTS (SELECT 1 FROM product_photos ph WHERE ph.tenant_id = p.tenant_id AND ph.product_id = p.id) AS "noPhoto",
                 NOT EXISTS (SELECT 1 FROM part_numbers n WHERE n.tenant_id = p.tenant_id AND n.product_id = p.id) AS "noNumber",
                 p.category_id IS NULL AS "noCategory",
                 NOT EXISTS (SELECT 1 FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id) AS "noApplicability",
                 0 AS "salesCount"
            FROM products p
           WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.status = 'active' AND p.kind = 'goods')
        SELECT * FROM f WHERE "noPrice" OR "noStock" OR "noPhoto" OR "noNumber" OR "noCategory" OR "noApplicability"`;
      const items = await tx.query(
        `${base} ORDER BY "salesCount" DESC, "quickCreated" DESC, "createdAt" DESC LIMIT $2 OFFSET $3`,
        [tx.tenantId, limit, (page - 1) * limit],
      );
      const [summary] = await tx.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE "noPrice")::int AS "noPrice", count(*) FILTER (WHERE "noStock")::int AS "noStock",
                count(*) FILTER (WHERE "noPhoto")::int AS "noPhoto", count(*) FILTER (WHERE "noNumber")::int AS "noNumber",
                count(*) FILTER (WHERE "noCategory")::int AS "noCategory", count(*) FILTER (WHERE "noApplicability")::int AS "noApplicability"
           FROM (${base}) x`,
        [tx.tenantId],
      );
      const keys = ['noPrice', 'noStock', 'noPhoto', 'noNumber', 'noCategory', 'noApplicability'];
      return {
        items: items.map((r: any) => ({ ...r, missing: keys.filter((k) => r[k]) })),
        total: summary.total,
        summary: keys.map((k) => ({ key: k, count: summary[k] })),
      };
    });
  }
}
