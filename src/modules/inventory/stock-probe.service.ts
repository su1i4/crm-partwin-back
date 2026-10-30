import { Injectable } from '@nestjs/common';
import { TenantTx } from '../../database/tenant/tenant-tx';

export interface StockInfo {
  productId: string;
  warehouseId: string;
  storeId: string | null;
  qty: string;
  reserved: string;
  location: string | null;
}

/**
 * Остатки для каталога и поиска. Регистры остатков появятся на этапе 2 (stock_balances);
 * до этого методы честно возвращают «нет движений / нет остатка».
 */
@Injectable()
export class StockProbeService {
  private tablesChecked = new Map<string, { at: number; exists: boolean }>();

  private async tableExists(tx: TenantTx, table: string): Promise<boolean> {
    const hit = this.tablesChecked.get(table);
    if (hit && Date.now() - hit.at < 60_000) return hit.exists;
    const [{ reg }] = await tx.query(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
    this.tablesChecked.set(table, { at: Date.now(), exists: !!reg });
    return !!reg;
  }

  /** Есть ли у товара движения (нельзя менять базовую единицу, коэффициент упаковки, удалять). */
  async hasMovements(tx: TenantTx, productId: string, unitId?: string): Promise<boolean> {
    if (!(await this.tableExists(tx, 'stock_movements'))) return false;
    const rows = await tx.query(
      `SELECT 1 FROM stock_movements WHERE tenant_id = $1 AND product_id = $2 ${unitId ? 'AND unit_id = $3' : ''} LIMIT 1`,
      unitId ? [tx.tenantId, productId, unitId] : [tx.tenantId, productId],
    );
    return rows.length > 0;
  }

  /** Остатки товаров по складам. */
  async balances(tx: TenantTx, productIds: string[]): Promise<StockInfo[]> {
    if (!productIds.length || !(await this.tableExists(tx, 'stock_balances'))) return [];
    const rows = await tx.query(
      `SELECT b.product_id, b.warehouse_id, w.store_id, sum(b.qty) AS qty
         FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
        WHERE b.tenant_id = $1 AND b.product_id = ANY($2::uuid[]) AND b.qty <> 0
          AND w.type NOT IN ('transit', 'customer') AND w.deleted_at IS NULL
        GROUP BY b.product_id, b.warehouse_id, w.store_id`,
      [tx.tenantId, productIds],
    );
    return rows.map((r: any) => ({
      productId: r.product_id,
      warehouseId: r.warehouse_id,
      storeId: r.store_id,
      qty: r.qty,
      reserved: '0',
      location: null,
    }));
  }
}
