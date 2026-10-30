import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { Product } from '../catalog/entities/product.entity';
import { Warehouse } from '../stores/entities/warehouse.entity';
import { ProductPlace } from './entities/stock.entity';

/** Место хранения уровня 1: «A-3», «Toyota — верхняя полка» (ТЗ 8.1). */
@Injectable()
export class PlacesService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  /** Подсказки из уже использованных значений — чтобы не плодить «А1», «а-1», «A 1». */
  async suggest(warehouseId: string, q?: string) {
    return this.tenantTx.run(async (tx) => {
      await this.scope.assertWarehouse(tx, warehouseId);
      return tx.query(
        `SELECT place, count(*)::int AS products FROM product_places
          WHERE tenant_id = $1 AND warehouse_id = $2 AND ($3::text IS NULL OR upper(place) LIKE upper($3) || '%')
          GROUP BY place ORDER BY products DESC, place LIMIT 30`,
        [tx.tenantId, warehouseId, q ?? null],
      );
    });
  }

  async set(warehouseId: string, productIds: string[], place: string | null) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Warehouse, 'Склад').getById(warehouseId);
      await this.scope.assertWarehouse(tx, warehouseId);
      await tx.repo(Product, 'Товар').getByIds(productIds);
      const clean = place ? normalizePlace(place) : null;
      if (clean && clean.length > 50) throw Errors.bad('PLACE_TOO_LONG', 'Место — до 50 символов');
      await this.setInTx(tx, warehouseId, productIds, clean);
      await this.audit.log(tx, { action: 'stock.place_set', entityType: 'warehouse', entityId: warehouseId, summary: `Место «${clean ?? '—'}» для ${productIds.length} товаров` });
      return { updated: productIds.length, place: clean };
    });
  }

  async setInTx(tx: TenantTx, warehouseId: string, productIds: string[], place: string | null) {
    if (!place) {
      await tx.query(`DELETE FROM product_places WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = ANY($3::uuid[])`, [tx.tenantId, warehouseId, productIds]);
      return;
    }
    await tx.query(
      `INSERT INTO product_places (tenant_id, created_by, warehouse_id, product_id, place)
       SELECT $1, $2, $3, x, $5 FROM unnest($4::uuid[]) x
       ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE SET place = EXCLUDED.place, updated_at = now()`,
      [tx.tenantId, tx.userId, warehouseId, productIds, place],
    );
  }

  async get(tx: TenantTx, warehouseId: string, productId: string) {
    return tx.repo(ProductPlace).findOne({ where: { warehouseId, productId } });
  }
}

/** «a-3 », «A 3» → «A-3»: верхний регистр, пробелы и дефисы схлопываются. */
export function normalizePlace(s: string) {
  return s.trim().replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-').toUpperCase();
}
