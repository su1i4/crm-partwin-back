import { Injectable } from '@nestjs/common';
import { baseNormalize } from '../../common/utils/text-search';
import { TenantTx } from '../../database/tenant/tenant-tx';

/**
 * Собирает products.search_text: название, бренд, категория, тип детали, артикул, номера (как ввели и нормализованные),
 * значения «участвует в поиске» атрибутов (размеры — «35x52x7»), теги.
 * Вызывать после любого изменения карточки, номеров, бренда.
 */
@Injectable()
export class SearchTextService {
  async rebuild(tx: TenantTx, productIds: string[]): Promise<void> {
    if (!productIds.length) return;
    const searchable = await tx.query<{ code: string; value_type: string }>(
      `SELECT DISTINCT code, value_type FROM attributes WHERE tenant_id = $1 AND deleted_at IS NULL AND searchable`,
      [tx.tenantId],
    );
    const rows = await tx.query(
      `SELECT p.id, p.name, p.sku, p.attributes, p.tags, b.name AS brand, b.aliases AS brand_aliases,
              c.name AS category, t.name AS part_type,
              coalesce((SELECT string_agg(n.number || ' ' || n.normalized, ' ') FROM part_numbers n
                         WHERE n.tenant_id = p.tenant_id AND n.product_id = p.id), '') AS numbers,
              coalesce((SELECT string_agg(bc.barcode, ' ') FROM product_barcodes bc
                         WHERE bc.tenant_id = p.tenant_id AND bc.product_id = p.id), '') AS barcodes
         FROM products p
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN part_types t ON t.id = p.part_type_id
        WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[])`,
      [tx.tenantId, productIds],
    );
    for (const r of rows) {
      const attrs: string[] = [];
      for (const a of searchable) {
        const v = r.attributes?.[a.code];
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) attrs.push(v.join('x'), v.join(' '));
        else attrs.push(String(v));
      }
      const text = baseNormalize(
        [r.name, r.brand, ...(r.brand_aliases ?? []), r.category, r.part_type, r.sku, r.numbers, r.barcodes, ...attrs, ...(r.tags ?? [])]
          .filter(Boolean)
          .join(' '),
      ).slice(0, 4000);
      await tx.query(`UPDATE products SET search_text = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, r.id, text]);
    }
  }
}
