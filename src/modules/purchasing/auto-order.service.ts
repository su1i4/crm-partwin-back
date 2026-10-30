import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { dayjs } from '../../common/utils/dates';
import { D, Decimal } from '../../common/utils/decimal';
import { normalizePartNumber, partNumberSkeleton } from '../../common/utils/part-number';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { CategoriesService } from '../catalog/categories.service';
import { Product } from '../catalog/entities/product.entity';
import { Counterparty } from '../counterparties/entities/counterparty.entity';
import { PartNumber } from '../parts/entities/part-number.entity';
import { SettingsService } from '../settings/settings.service';
import { Store } from '../stores/entities/store.entity';
import { StockRule, SupplierProduct } from './entities/purchasing.entity';
import { PurchaseOrdersService } from './purchase-orders.service';

const q3 = (v: Decimal) => v.toDecimalPlaces(3, Decimal.ROUND_UP);

export interface AutoOrderQuery {
  storeId?: string;
  supplierId?: string;
  categoryId?: string;
  makeId?: string;
  /** Продажи за N дней (по умолчанию — из настроек) */
  days?: number;
  coverDays?: number;
  /** Товары без мин./макс., но с продажами */
  includeWithoutRules?: boolean;
}

/**
 * Автозаказ (ТЗ 10.4): мин./макс. (сезонные), продажи за N дней и тот же период прошлого года, срок поставки,
 * кратность и мин. партия, уже ожидаемое по заказам. Результат — черновики заказов по поставщикам.
 */
@Injectable()
export class AutoOrderService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
    private readonly categories: CategoriesService,
    private readonly orders: PurchaseOrdersService,
    private readonly audit: AuditService,
  ) {}

  // ── Поставщики товара и правила запаса ───────────────────

  supplierProducts(productId: string) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getById(productId);
      return tx.query(
        `SELECT sp.id, sp.supplier_id AS "supplierId", c.name AS "supplierName", sp.supplier_code AS "supplierCode", sp.multiplicity, sp.min_qty AS "minQty",
                sp.lead_days AS "leadDays", sp.preferred, sp.last_price AS "lastPrice", sp.last_currency AS "lastCurrency", sp.last_purchase_at AS "lastPurchaseAt"
           FROM supplier_products sp JOIN counterparties c ON c.id = sp.supplier_id
          WHERE sp.tenant_id = $1 AND sp.product_id = $2 AND sp.deleted_at IS NULL ORDER BY sp.preferred DESC, c.name`,
        [tx.tenantId, productId],
      );
    });
  }

  /** Поставщики товара: код поставщика (ищется в едином поиске), кратность, мин. партия, срок. */
  setSupplierProducts(productId: string, items: { supplierId: string; supplierCode?: string | null; multiplicity?: string; minQty?: string; leadDays?: number | null; preferred?: boolean }[]) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getById(productId);
      if (items.filter((i) => i.preferred).length > 1) throw Errors.bad('ONE_PREFERRED', 'Основной поставщик — один');
      const existing = await tx.repo(SupplierProduct).find({ where: { productId }, withDeleted: true });
      for (const i of items) {
        await tx.repo(Counterparty, 'Поставщик').getById(i.supplierId);
        const e = existing.find((x) => x.supplierId === i.supplierId);
        const data = {
          supplierCode: i.supplierCode?.trim() || null,
          multiplicity: D(i.multiplicity ?? 1),
          minQty: D(i.minQty ?? 0),
          leadDays: i.leadDays ?? null,
          preferred: i.preferred ?? false,
        };
        if (data.multiplicity.lte(0)) throw Errors.bad('BAD_MULTIPLICITY', 'Кратность больше нуля');
        if (e) await tx.query(`UPDATE supplier_products SET supplier_code = $3, multiplicity = $4, min_qty = $5, lead_days = $6, preferred = $7, deleted_at = NULL, version = version + 1 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, e.id, data.supplierCode, data.multiplicity.toFixed(), data.minQty.toFixed(), data.leadDays, data.preferred]);
        else await tx.repo(SupplierProduct).insert({ productId, supplierId: i.supplierId, ...data });
      }
      const keep = new Set(items.map((i) => i.supplierId));
      for (const e of existing) if (!keep.has(e.supplierId) && !e.deletedAt) await tx.query(`UPDATE supplier_products SET deleted_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, e.id]);
      // Коды поставщиков — номера товара для поиска (ТЗ 4.2)
      await tx.repo(PartNumber).hardDelete({ productId, type: 'supplier' });
      const codes = items.filter((i) => i.supplierCode?.trim()).map((i) => {
        const n = normalizePartNumber(i.supplierCode!);
        return { productId, brandId: null, number: i.supplierCode!.trim(), normalized: n, skeleton: partNumberSkeleton(n), type: 'supplier' as const, supplierId: i.supplierId };
      });
      if (codes.length) await tx.repo(PartNumber).insertMany(codes);
      return this.supplierProductsInTx(tx, productId);
    });
  }

  private supplierProductsInTx(tx: TenantTx, productId: string) {
    return tx.repo(SupplierProduct).find({ where: { productId }, order: { preferred: 'DESC' } });
  }

  stockRules(productId: string) {
    return this.tenantTx.run((tx) => tx.repo(StockRule).find({ where: { productId }, order: { storeKey: 'ASC' } }));
  }

  setStockRules(productId: string, rules: { storeId?: string | null; minQty?: string | null; maxQty?: string | null; summerMin?: string | null; summerMax?: string | null; winterMin?: string | null; winterMax?: string | null; supplierId?: string | null }[]) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getById(productId);
      const keys = new Set<string>();
      for (const r of rules) {
        const key = r.storeId ?? '';
        if (keys.has(key)) throw Errors.bad('DUPLICATE_RULE', 'Правило для точки указано дважды');
        keys.add(key);
        if (r.storeId) this.scope.assertStore(r.storeId);
        if (r.supplierId) await tx.repo(Counterparty, 'Поставщик').getById(r.supplierId);
        for (const [a, b] of [['minQty', 'maxQty'], ['summerMin', 'summerMax'], ['winterMin', 'winterMax']] as const) {
          if (r[a] && r[b] && D(r[a]!).gt(r[b]!)) throw Errors.bad('MIN_GT_MAX', 'Минимум больше максимума');
        }
      }
      await tx.repo(StockRule).hardDelete({ productId });
      if (rules.length) {
        await tx.repo(StockRule).insertMany(
          rules.map((r) => ({
            productId,
            storeId: r.storeId ?? null,
            storeKey: r.storeId ?? '',
            minQty: r.minQty ? D(r.minQty) : null,
            maxQty: r.maxQty ? D(r.maxQty) : null,
            summerMin: r.summerMin ? D(r.summerMin) : null,
            summerMax: r.summerMax ? D(r.summerMax) : null,
            winterMin: r.winterMin ? D(r.winterMin) : null,
            winterMax: r.winterMax ? D(r.winterMax) : null,
            supplierId: r.supplierId ?? null,
          })),
        );
      }
      return tx.repo(StockRule).find({ where: { productId } });
    });
  }

  /** История закупочных цен товара (ТЗ 10.5: «цена в накладной другая — запись в историю»). */
  purchaseHistory(productId: string) {
    return this.tenantTx.run(async (tx) =>
      tx.query(
        `SELECT d.id AS "documentId", d.number, d.doc_date AS "date", c.name AS supplier, l.price, d.currency, l.unit_cost AS "unitCostKgs",
                l.extra->>'orderPrice' AS "orderPrice", l.qty
           FROM document_lines l JOIN documents d ON d.id = l.document_id LEFT JOIN counterparties c ON c.id = d.counterparty_id
          WHERE l.tenant_id = $1 AND l.product_id = $2 AND d.type = 'receiving' AND d.status = 'posted' AND l.price IS NOT NULL
          ORDER BY d.doc_date DESC LIMIT 100`,
        [tx.tenantId, productId],
      ),
    );
  }

  // ── Расчёт ───────────────────────────────────────────────

  preview(q: AutoOrderQuery) {
    return this.tenantTx.run((tx) => this.compute(tx, q));
  }

  private async compute(tx: TenantTx, q: AutoOrderQuery) {
    const s = await this.settings.get(tx);
    const storeId = q.storeId ?? this.scope.currentStoreId() ?? (await tx.query(`SELECT id FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [tx.tenantId]))[0]?.id;
    if (!storeId) throw Errors.bad('NO_STORE', 'Нет точки');
    this.scope.assertStore(storeId);
    const store = await tx.repo(Store, 'Точка').getById(storeId);
    const days = q.days ?? s.autoOrderSalesDays;
    const cover = q.coverDays ?? s.autoOrderCoverDays;
    const month = dayjs().tz(store.timezone).month() + 1;
    const summer = s.summerMonths.includes(month);

    // Кандидаты: товары с правилом запаса (на точку или все) + (по желанию) товары с продажами
    const params: unknown[] = [tx.tenantId, storeId];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const w = [`p.tenant_id = $1`, `p.deleted_at IS NULL`, `p.status = 'active'`, `p.kind = 'goods'`, `NOT p.no_stock_control`];
    if (q.categoryId) w.push(`p.category_id = ANY(${p(await this.categories.subtreeIds(tx, q.categoryId))}::uuid[])`);
    if (q.makeId) w.push(`EXISTS (SELECT 1 FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id AND a.make_id = ${p(q.makeId)})`);
    const since = dayjs().subtract(days, 'day').toDate();
    const sold = q.includeWithoutRules
      ? `OR EXISTS (SELECT 1 FROM stock_movements m JOIN documents d ON d.id = m.document_id JOIN warehouses wh ON wh.id = m.warehouse_id
                     WHERE m.tenant_id = p.tenant_id AND m.product_id = p.id AND d.type = 'sale' AND wh.store_id = $2 AND m.moved_at >= ${p(since)})`
      : '';
    const products = await tx.query(
      `SELECT p.id, p.name, p.sku, p.brand_id AS "brandId",
              (SELECT pn.number FROM part_numbers pn WHERE pn.tenant_id = p.tenant_id AND pn.product_id = p.id AND pn.type = 'manufacturer' LIMIT 1) AS number,
              (SELECT pn.normalized FROM part_numbers pn WHERE pn.tenant_id = p.tenant_id AND pn.product_id = p.id AND pn.type = 'manufacturer' LIMIT 1) AS normalized,
              (SELECT u.id FROM product_units u WHERE u.tenant_id = p.tenant_id AND u.product_id = p.id AND u.is_base LIMIT 1) AS "unitId"
         FROM products p
        WHERE ${w.join(' AND ')} AND (EXISTS (SELECT 1 FROM stock_rules r WHERE r.tenant_id = p.tenant_id AND r.product_id = p.id AND (r.store_id = $2 OR r.store_id IS NULL)) ${sold})
        LIMIT 5000`,
      params,
    );
    if (!products.length) return { storeId, season: summer ? 'summer' : 'winter', days, coverDays: cover, lines: [], groups: [] };
    const ids = products.map((x: any) => x.id);
    const t = tx.tenantId;
    const rules = await tx.query(`SELECT * FROM stock_rules WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND (store_id = $3 OR store_id IS NULL) ORDER BY (store_id IS NULL)`, [t, ids, storeId]);
    const stock = await tx.query(
      `SELECT b.product_id, sum(b.qty) AS q FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
        WHERE b.tenant_id = $1 AND b.product_id = ANY($2::uuid[]) AND w.store_id = $3 AND w.type IN ('sales_floor', 'storage') GROUP BY 1`,
      [t, ids, storeId],
    );
    const salesSql = `SELECT m.product_id, -sum(m.qty) AS q FROM stock_movements m JOIN documents d ON d.id = m.document_id JOIN warehouses w ON w.id = m.warehouse_id
                       WHERE m.tenant_id = $1 AND m.product_id = ANY($2::uuid[]) AND w.store_id = $3 AND d.type IN ('sale', 'sale_return') AND m.moved_at >= $4 AND m.moved_at < $5 GROUP BY 1`;
    const now = new Date();
    const sales = await tx.query(salesSql, [t, ids, storeId, since, now]);
    // Тот же период прошлого года — вперёд от «сегодня год назад» (сезонность: шины, АКБ, антифриз)
    const lyFrom = dayjs().subtract(1, 'year').toDate();
    const lyTo = dayjs().subtract(1, 'year').add(days, 'day').toDate();
    const lastYear = await tx.query(salesSql, [t, ids, storeId, lyFrom, lyTo]);
    const expected = await this.orders.expected(tx, ids, storeId);
    const sp = await tx.query(`SELECT * FROM supplier_products WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND deleted_at IS NULL`, [t, ids]);
    const lastSupplier = await tx.query(
      `SELECT DISTINCT ON (l.product_id) l.product_id, d.counterparty_id, l.price, d.currency FROM document_lines l JOIN documents d ON d.id = l.document_id
        WHERE l.tenant_id = $1 AND l.product_id = ANY($2::uuid[]) AND d.type = 'receiving' AND d.status = 'posted' AND d.counterparty_id IS NOT NULL
        ORDER BY l.product_id, d.doc_date DESC`,
      [t, ids],
    );
    const plRows = await tx.query(
      `SELECT DISTINCT ON (r.product_id, r.supplier_id) r.product_id, r.supplier_id, r.price, r.currency, r.lead_days, r.multiplicity, r.stock_qty
         FROM price_list_rows r JOIN price_lists l ON l.id = r.price_list_id AND l.deleted_at IS NULL AND l.is_active
        WHERE r.tenant_id = $1 AND r.product_id = ANY($2::uuid[]) ORDER BY r.product_id, r.supplier_id, r.price NULLS LAST`,
      [t, ids],
    );
    const suppliers = new Map((await tx.query(`SELECT id, name, supplier_terms FROM counterparties WHERE tenant_id = $1 AND roles && ARRAY['supplier', 'neighbor']::text[]`, [t])).map((c: any) => [c.id, c]));
    const pick = <T>(rows: T[], f: (r: any) => boolean) => rows.filter(f);
    const num = (rows: any[], id: string) => D(rows.find((r) => r.product_id === id)?.q ?? 0);

    const lines: any[] = [];
    for (const prod of products) {
      const rule = rules.find((r: any) => r.product_id === prod.id);
      const seasonal = (k: 'Min' | 'Max') => {
        const v = rule ? (summer ? rule[`summer_${k.toLowerCase()}`] : rule[`winter_${k.toLowerCase()}`]) : null;
        return v !== null && v !== undefined ? D(v) : rule && rule[`${k.toLowerCase()}_qty`] !== null ? D(rule[`${k.toLowerCase()}_qty`]) : null;
      };
      const min = seasonal('Min');
      const max = seasonal('Max');
      const st = num(stock, prod.id);
      const exp = expected.get(prod.id) ?? D(0);
      const sN = Decimal.max(num(sales, prod.id), 0);
      const ly = Decimal.max(num(lastYear, prod.id), 0);
      const daily = Decimal.max(sN, ly).div(days);
      // Поставщик: правило → основной → дешёвый прайс с наличием → последний, у кого брали
      const sps = pick(sp, (r) => r.product_id === prod.id);
      const pls = pick(plRows, (r) => r.product_id === prod.id && (r.stock_qty === null || D(r.stock_qty).gt(0))).sort((a, b) => Number(a.price ?? 1e12) - Number(b.price ?? 1e12));
      const last = lastSupplier.find((r: any) => r.product_id === prod.id);
      const supplierId: string | null = rule?.supplier_id ?? sps.find((x) => x.preferred)?.supplier_id ?? sps[0]?.supplier_id ?? pls[0]?.supplier_id ?? last?.counterparty_id ?? null;
      if (q.supplierId && supplierId !== q.supplierId) continue;
      const spRow = sps.find((x) => x.supplier_id === supplierId);
      const plRow = pls.find((x) => x.supplier_id === supplierId) ?? plRows.find((x: any) => x.product_id === prod.id && x.supplier_id === supplierId);
      const sup = supplierId ? suppliers.get(supplierId) : null;
      const lead = Number(spRow?.lead_days ?? plRow?.lead_days ?? sup?.supplier_terms?.leadTimeDays ?? 7);
      const reorderPoint = Decimal.max(min ?? 0, daily.mul(lead));
      const target = Decimal.max(max ?? 0, daily.mul(lead + cover), min ?? 0);
      const available = st.plus(exp);
      if (available.gt(reorderPoint) || (min === null && max === null && daily.isZero())) continue;
      let need = target.minus(available);
      if (need.lte(0)) continue;
      const mult = D(spRow?.multiplicity ?? plRow?.multiplicity ?? 1);
      const minQty = D(spRow?.min_qty ?? 0);
      need = q3(need.div(mult)).ceil().mul(mult);
      if (need.lt(minQty)) need = minQty;
      const price = spRow?.last_price ?? plRow?.price ?? (last?.counterparty_id === supplierId ? last?.price : null) ?? null;
      lines.push({
        productId: prod.id,
        name: prod.name,
        number: prod.number,
        sku: prod.sku,
        unitId: prod.unitId,
        supplierId,
        supplierName: sup?.name ?? null,
        qty: need.toFixed(),
        price: price !== null ? D(price).toFixed(2) : null,
        currency: spRow?.last_currency ?? plRow?.currency ?? sup?.supplier_terms?.currency ?? 'KGS',
        explain: {
          stock: st.toFixed(),
          expected: exp.toFixed(),
          salesLastDays: sN.toFixed(),
          salesLastYear: ly.toFixed(),
          dailyDemand: daily.toDecimalPlaces(3).toFixed(),
          min: min?.toFixed() ?? null,
          max: max?.toFixed() ?? null,
          season: rule && (rule.summer_min !== null || rule.winter_min !== null || rule.summer_max !== null || rule.winter_max !== null) ? (summer ? 'summer' : 'winter') : null,
          leadDays: lead,
          reorderPoint: reorderPoint.toDecimalPlaces(3).toFixed(),
          target: target.toDecimalPlaces(3).toFixed(),
          multiplicity: mult.toFixed(),
          minQty: minQty.toFixed(),
        },
      });
    }
    const groups = new Map<string, any>();
    for (const l of lines) {
      const k = l.supplierId ?? 'none';
      const g = groups.get(k) ?? { supplierId: l.supplierId, supplierName: l.supplierName ?? 'Без поставщика', lines: [] as any[], total: D(0) };
      g.lines.push(l);
      if (l.price) g.total = g.total.plus(D(l.price).mul(l.qty));
      groups.set(k, g);
    }
    return { storeId, season: summer ? 'summer' : 'winter', days, coverDays: cover, lines, groups: [...groups.values()].map((g) => ({ ...g, total: g.total.toFixed(2) })) };
  }

  /** Создать черновики заказов, сгруппированные по поставщикам. */
  create(dto: { storeId?: string; warehouseId?: string; lines: { productId: string; supplierId: string; qty: string; price?: string | null; unitId?: string; currency?: string; explain?: Record<string, any> }[] }) {
    return this.tenantTx.run(async (tx) => {
      const groups = new Map<string, typeof dto.lines>();
      for (const l of dto.lines) {
        if (!l.supplierId) throw Errors.bad('SUPPLIER_REQUIRED', 'Укажите поставщика для каждой строки');
        groups.set(l.supplierId, [...(groups.get(l.supplierId) ?? []), l]);
      }
      const created = [];
      for (const [supplierId, lines] of groups) {
        const o = await this.orders.createInTx(tx, {
          supplierId,
          storeId: dto.storeId,
          warehouseId: dto.warehouseId ?? null,
          currency: lines[0].currency,
          source: 'auto',
          comment: 'Автозаказ',
          lines: lines.map((l) => ({ productId: l.productId, unitId: l.unitId, qty: l.qty, price: l.price ?? null, extra: l.explain ? { autoOrder: l.explain } : {} })),
        });
        created.push(await this.orders.viewInTx(tx, o.id));
      }
      await this.audit.log(tx, { action: 'auto_order.create', entityType: 'purchase_order', summary: `Автозаказ: ${created.length} черновиков` });
      return created;
    });
  }
}
