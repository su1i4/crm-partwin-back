import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { D, money } from '../../common/utils/decimal';
import { baseNormalize } from '../../common/utils/text-search';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { ScopeService } from '../auth/scope.service';
import { CategoriesService } from '../catalog/categories.service';
import { Product } from '../catalog/entities/product.entity';
import { CostRecalcService } from './cost-recalc.service';

/** Остатки, остатки на дату, оборотная ведомость, движения товара (ТЗ 7.1, 7.7, 20.2). */
@Injectable()
export class StockQueryService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly scope: ScopeService,
    private readonly ctx: RequestContext,
    private readonly categories: CategoriesService,
    private readonly recalc: CostRecalcService,
  ) {}

  private get canCost() {
    return this.ctx.can('products.view_cost');
  }

  private async warehouseFilter(tx: TenantTx, warehouseId?: string, storeId?: string): Promise<string[] | null> {
    if (warehouseId) {
      await this.scope.assertWarehouse(tx, warehouseId);
      return [warehouseId];
    }
    const allowed = await this.scope.warehouseIds(tx);
    const rows = await tx.query<{ id: string }>(
      `SELECT id FROM warehouses WHERE tenant_id = $1 AND deleted_at IS NULL AND type <> 'transit'
          AND ($2::uuid IS NULL OR store_id = $2) AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
      [tx.tenantId, storeId ?? null, allowed],
    );
    if (storeId) this.scope.assertStore(storeId);
    return rows.map((r) => r.id);
  }

  /** Текущие остатки: физический, резерв (этап 3–4), доступно, место, ожидается/в пути. */
  async balances(q: { warehouseId?: string; storeId?: string; q?: string; categoryId?: string; onlyPositive?: boolean; onlyNegative?: boolean; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      const whs = await this.warehouseFilter(tx, q.warehouseId, q.storeId);
      const params: unknown[] = [tx.tenantId, whs];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const w = ['b.tenant_id = $1', 'b.warehouse_id = ANY($2::uuid[])'];
      if (q.onlyPositive !== false && !q.onlyNegative) w.push('b.qty <> 0');
      if (q.onlyNegative) w.push('b.qty < 0');
      if (q.categoryId) w.push(`pr.category_id = ANY(${p(await this.categories.subtreeIds(tx, q.categoryId))}::uuid[])`);
      if (q.q) {
        for (const tok of baseNormalize(q.q).split(' ').filter(Boolean).slice(0, 5)) w.push(`pr.search_text LIKE ${p(`%${tok}%`)}`);
      }
      const where = w.join(' AND ');
      const [{ total }] = await tx.query(
        `SELECT count(DISTINCT b.product_id)::int AS total FROM stock_balances b JOIN products pr ON pr.id = b.product_id WHERE ${where}`,
        params,
      );
      const rows = await tx.query(
        `SELECT pr.id AS "productId", pr.name, pr.sku, pr.base_unit AS "baseUnit", br.name AS "brandName",
                (SELECT n.number FROM part_numbers n WHERE n.tenant_id = pr.tenant_id AND n.product_id = pr.id ORDER BY (n.type = 'manufacturer') DESC LIMIT 1) AS "mainNumber",
                sum(b.qty) AS qty, sum(b.cost_amount) AS amount,
                jsonb_agg(jsonb_build_object('warehouseId', b.warehouse_id, 'qty', b.qty,
                   'place', (SELECT place FROM product_places pl WHERE pl.tenant_id = b.tenant_id AND pl.product_id = b.product_id AND pl.warehouse_id = b.warehouse_id))) AS warehouses
           FROM stock_balances b JOIN products pr ON pr.id = b.product_id LEFT JOIN brands br ON br.id = pr.brand_id
          WHERE ${where}
          GROUP BY pr.id, br.name ORDER BY pr.name LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      const ids = rows.map((r: any) => r.productId);
      const transit = ids.length
        ? await tx.query(
            `SELECT b.product_id, sum(b.qty) AS qty FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id AND w.type = 'transit'
              WHERE b.tenant_id = $1 AND b.product_id = ANY($2::uuid[]) GROUP BY b.product_id`,
            [tx.tenantId, ids],
          )
        : [];
      const pending = await this.recalc.pending(tx);
      return {
        items: rows.map((r: any) => ({
          ...r,
          qty: D(r.qty).toFixed(),
          reserved: '0',
          available: D(r.qty).toFixed(),
          inTransit: D(transit.find((t: any) => t.product_id === r.productId)?.qty ?? 0).toFixed(),
          expected: '0',
          amount: this.canCost ? money(r.amount).toFixed(2) : null,
          unitCost: this.canCost && D(r.qty).gt(0) ? D(r.amount).div(r.qty).toFixed(2) : null,
        })),
        total,
        costRecalcPending: pending.count > 0,
      };
    });
  }

  /** Остаток на дату: снимок конца ближайшего прошлого закрытого месяца + движения после него (ТЗ 7.7). */
  async atDate(q: { date: string; warehouseId?: string; storeId?: string; productId?: string; page: number; limit: number }) {
    const at = new Date(q.date);
    if (Number.isNaN(at.getTime())) throw Errors.bad('BAD_DATE', 'Некорректная дата');
    return this.tenantTx.run(async (tx) => {
      const whs = await this.warehouseFilter(tx, q.warehouseId, q.storeId);
      const [snap] = await tx.query(
        `SELECT max(period_end) AS pe FROM period_closes WHERE tenant_id = $1 AND status = 'closed' AND period_end <= $2`,
        [tx.tenantId, at],
      );
      const pe: Date | null = snap?.pe ?? null;
      const rows = await tx.query(
        `WITH base AS (
           SELECT warehouse_id, product_id, qty, cost_amount FROM stock_snapshots
            WHERE tenant_id = $1 AND $3::timestamptz IS NOT NULL AND period_end = $3 AND warehouse_id = ANY($2::uuid[])
           UNION ALL
           SELECT warehouse_id, product_id, qty, cost_amount FROM stock_movements
            WHERE tenant_id = $1 AND warehouse_id = ANY($2::uuid[]) AND moved_at <= $4
              AND ($3::timestamptz IS NULL OR moved_at >= $3))
         SELECT b.product_id AS "productId", p.name, p.sku, b.warehouse_id AS "warehouseId", sum(b.qty) AS qty, sum(b.cost_amount) AS amount
           FROM base b JOIN products p ON p.id = b.product_id
          WHERE ($5::uuid IS NULL OR b.product_id = $5)
          GROUP BY b.product_id, p.name, p.sku, b.warehouse_id HAVING sum(b.qty) <> 0
          ORDER BY p.name LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        [tx.tenantId, whs, pe, at, q.productId ?? null],
      );
      return {
        date: at,
        fromSnapshot: pe,
        items: rows.map((r: any) => ({ ...r, qty: D(r.qty).toFixed(), amount: this.canCost ? money(r.amount).toFixed(2) : null })),
      };
    });
  }

  /** Оборотная ведомость: начало, приход, расход, конец — количество и сумма. */
  async turnover(q: { from: string; to: string; warehouseId?: string; storeId?: string; categoryId?: string; page: number; limit: number }) {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (!(from < to)) throw Errors.bad('BAD_PERIOD', 'Неверный период');
    return this.tenantTx.run(async (tx) => {
      const whs = await this.warehouseFilter(tx, q.warehouseId, q.storeId);
      const cats = q.categoryId ? await this.categories.subtreeIds(tx, q.categoryId) : null;
      const rows = await tx.query(
        `SELECT p.id AS "productId", p.name, p.sku, p.base_unit AS "baseUnit",
                coalesce(sum(m.qty) FILTER (WHERE m.moved_at < $3), 0) AS "openQty",
                coalesce(sum(m.cost_amount) FILTER (WHERE m.moved_at < $3), 0) AS "openAmount",
                coalesce(sum(m.qty) FILTER (WHERE m.moved_at >= $3 AND m.qty > 0), 0) AS "inQty",
                coalesce(sum(m.cost_amount) FILTER (WHERE m.moved_at >= $3 AND m.qty > 0), 0) AS "inAmount",
                coalesce(-sum(m.qty) FILTER (WHERE m.moved_at >= $3 AND m.qty < 0), 0) AS "outQty",
                coalesce(-sum(m.cost_amount) FILTER (WHERE m.moved_at >= $3 AND m.qty < 0), 0) AS "outAmount",
                coalesce(sum(m.qty), 0) AS "closeQty", coalesce(sum(m.cost_amount), 0) AS "closeAmount"
           FROM stock_movements m JOIN products p ON p.id = m.product_id
          WHERE m.tenant_id = $1 AND m.warehouse_id = ANY($2::uuid[]) AND m.moved_at < $4
            AND ($5::uuid[] IS NULL OR p.category_id = ANY($5::uuid[]))
          GROUP BY p.id
         HAVING coalesce(sum(m.qty), 0) <> 0 OR count(*) FILTER (WHERE m.moved_at >= $3) > 0
          ORDER BY p.name LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        [tx.tenantId, whs, from, to, cats],
      );
      const hide = !this.canCost;
      return {
        from,
        to,
        items: rows.map((r: any) => {
          const out: any = { ...r };
          for (const k of ['openQty', 'inQty', 'outQty', 'closeQty']) out[k] = D(r[k]).toFixed();
          for (const k of ['openAmount', 'inAmount', 'outAmount', 'closeAmount']) out[k] = hide ? null : money(r[k]).toFixed(2);
          return out;
        }),
      };
    });
  }

  /** Все движения товара с нарастающим остатком (вкладка «Движения» карточки). */
  async productMovements(productId: string, q: { warehouseId?: string; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getById(productId);
      const whs = await this.warehouseFilter(tx, q.warehouseId);
      const rows = await tx.query(
        `SELECT m.id, m.moved_at AS "movedAt", m.kind, m.qty, m.cost_amount AS "costAmount", m.warehouse_id AS "warehouseId", w.name AS "warehouseName",
                d.id AS "documentId", d.number, d.type, sum(m.qty) OVER (PARTITION BY m.warehouse_id ORDER BY m.moved_at, m.seq) AS balance
           FROM stock_movements m JOIN documents d ON d.id = m.document_id JOIN warehouses w ON w.id = m.warehouse_id
          WHERE m.tenant_id = $1 AND m.product_id = $2 AND m.warehouse_id = ANY($3::uuid[])
          ORDER BY m.moved_at DESC, m.seq DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        [tx.tenantId, productId, whs],
      );
      return rows.map((r: any) => ({ ...r, qty: D(r.qty).toFixed(), balance: D(r.balance).toFixed(), costAmount: this.canCost ? money(r.costAmount).toFixed(2) : null }));
    });
  }

  /** Серийные экземпляры товара (вкладка «Экземпляры»). */
  async serials(productId: string, status?: string) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getById(productId);
      const allowed = await this.scope.warehouseIds(tx);
      const rows = await tx.query(
        `SELECT s.id, s.serial_number AS "serialNumber", s.inventory_number AS "inventoryNumber", s.condition, s.note, s.photo_file_ids AS "photoFileIds",
                s.price, s.status, s.warehouse_id AS "warehouseId", w.name AS "warehouseName", s.place, s.source_document_id AS "sourceDocumentId", s.version
           FROM serial_items s LEFT JOIN warehouses w ON w.id = s.warehouse_id
          WHERE s.tenant_id = $1 AND s.product_id = $2 AND s.deleted_at IS NULL AND ($3::text IS NULL OR s.status = $3)
          ORDER BY s.created_at DESC`,
        [tx.tenantId, productId, status ?? null],
      );
      return allowed === null ? rows : rows.filter((r: any) => !r.warehouseId || allowed.includes(r.warehouseId));
    });
  }
}
