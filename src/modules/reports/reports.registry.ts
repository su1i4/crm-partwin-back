import { dayjs } from '../../common/utils/dates';
import { QUALITY_LABELS } from '../catalog/entities/product.entity';
import { C, dayEnd, dayStart, localDay, num, productFilter, r2, ReportColumn, ReportCtx, ReportDef, ReportResult, Sql, storeFilter, sumTotals } from './report-kit';

const SALE_SIGN = `CASE WHEN d.type = 'sale' THEN 1 ELSE -1 END`;
const POSTED_SALES = `d.type IN ('sale', 'sale_return') AND d.status = 'posted' AND d.deleted_at IS NULL`;

const GROUPS: Record<string, { key: string; name: string; label: string }> = {
  product: { key: 'p.id', name: `p.name || coalesce(' · ' || p.sku, '')`, label: 'Товар' },
  category: { key: 'cat.id', name: `coalesce(cat.name, 'Без группы')`, label: 'Группа' },
  brand: { key: 'b.id', name: `coalesce(b.name, 'Без бренда')`, label: 'Бренд' },
  quality: { key: 'p.quality_class', name: 'p.quality_class', label: 'Класс качества' },
  store: { key: 's.store_id', name: `coalesce(st.name, '—')`, label: 'Точка' },
  seller: { key: 's.seller_id', name: `coalesce(u.name, '—')`, label: 'Продавец' },
  customer: { key: 's.customer_id', name: `coalesce(cp.name, 'Розничный покупатель')`, label: 'Клиент' },
  day: { key: 's.day', name: `to_char(s.day, 'YYYY-MM-DD')`, label: 'День' },
  month: { key: `to_char(s.day, 'YYYY-MM')`, name: `to_char(s.day, 'YYYY-MM')`, label: 'Месяц' },
};
const VEHICLE_GROUPS: Record<string, { key: string; name: string; label: string }> = {
  make: { key: 'mk.id', name: `coalesce(mk.name, 'Машина не указана')`, label: 'Марка' },
  model: { key: 'mo.id', name: `coalesce(mk.name || ' ' || mo.name, mk.name, 'Машина не указана')`, label: 'Модель' },
};
const groupOptions = (keys: string[]) => keys.map((k) => ({ value: k, label: (GROUPS[k] ?? VEHICLE_GROUPS[k])!.label }));

const RPT_JOINS = `FROM rpt_sales_daily s JOIN products p ON p.id = s.product_id
  LEFT JOIN categories cat ON cat.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN stores st ON st.id = s.store_id
  LEFT JOIN memberships m ON m.id = s.seller_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN counterparties cp ON cp.id = s.customer_id`;

/** WHERE по отчётной таблице продаж: период, точка, продавец, клиент, товар. */
function rptWhere(q: Sql, c: ReportCtx) {
  const f = c.f;
  let w = `s.tenant_id = $1 AND s.day >= ${q.p(f.from)}::date AND s.day <= ${q.p(f.to)}::date` + storeFilter(q, c, 's.store_id') + productFilter(q, f);
  if (f.sellerId) w += ` AND s.seller_id = ${q.p(f.sellerId)}`;
  if (f.customerId) w += ` AND s.customer_id = ${q.p(f.customerId)}`;
  return w;
}

function finishMoney(rows: any[], cols: ReportColumn[], c: ReportCtx): ReportResult {
  for (const r of rows) {
    for (const k of Object.keys(r)) if (r[k] !== null && typeof r[k] === 'string' && /^-?\d+(\.\d+)?$/.test(r[k]) && k !== 'key' && k !== 'name') r[k] = num(r[k]);
    if ('profit' in r && 'revenue' in r) r.margin = r.revenue ? r2((r.profit / r.revenue) * 100) : null;
  }
  const visible = c.canSeeCost ? cols : cols.filter((x) => !['cost', 'profit', 'margin'].includes(x.key));
  if (!c.canSeeCost) for (const r of rows) delete r.cost, delete r.profit, delete r.margin;
  const totals = sumTotals(rows, visible);
  if ('profit' in totals && totals.revenue) totals.margin = r2((totals.profit / totals.revenue) * 100);
  return { columns: visible, rows, totals };
}

/** Продажи / прибыль с группировкой (по отчётной таблице; марка и модель — по машине в чеке). */
async function salesBy(c: ReportCtx, profit: boolean): Promise<ReportResult> {
  const g = c.f.groupBy ?? 'product';
  const q = new Sql(c.tx.tenantId);
  const cols = [C('name', (GROUPS[g] ?? VEHICLE_GROUPS[g] ?? GROUPS.product).label), C('qty', 'Кол-во', 'qty'), C('revenue', 'Выручка', 'money')];
  if (!profit) cols.push(C('discount', 'Скидки', 'money'), C('returns', 'Возвраты', 'money'));
  cols.push(C('cost', 'Себестоимость', 'money'), C('profit', 'Прибыль', 'money'), C('margin', 'Маржа, %', 'percent'));
  let rows: any[];
  if (VEHICLE_GROUPS[g]) {
    const vg = VEHICLE_GROUPS[g];
    let w = `d.tenant_id = $1 AND ${POSTED_SALES} AND d.doc_date >= ${dayStart(q, c.f.from)} AND d.doc_date < ${dayEnd(q, c.f.to)}` + storeFilter(q, c, 'd.store_id') + productFilter(q, c.f);
    if (c.f.sellerId) w += ` AND r.seller_membership_id = ${q.p(c.f.sellerId)}`;
    rows = await c.tx.query(
      `SELECT ${vg.key} AS key, ${vg.name} AS name, sum(${SALE_SIGN} * l.base_qty) AS qty, sum(${SALE_SIGN} * l.amount) AS revenue,
              sum(CASE WHEN d.type = 'sale' THEN coalesce(l.line_discount, 0) + coalesce(l.receipt_discount, 0) + coalesce(l.promo_discount, 0) ELSE 0 END) AS discount,
              sum(CASE WHEN d.type = 'sale_return' THEN l.amount ELSE 0 END) AS returns,
              sum(${SALE_SIGN} * l.cost_amount) AS cost, sum(${SALE_SIGN} * (l.amount - l.cost_amount)) AS profit
         FROM documents d JOIN document_lines l ON l.document_id = d.id JOIN products p ON p.id = l.product_id
         JOIN receipts r ON r.document_id = d.id LEFT JOIN customer_vehicles v ON v.id = r.customer_vehicle_id
         LEFT JOIN global_vehicle_makes mk ON mk.id = v.make_id LEFT JOIN global_vehicle_models mo ON mo.id = v.model_id
        WHERE ${w} GROUP BY 1, 2 ORDER BY revenue DESC NULLS LAST LIMIT ${c.f.limit}`,
      q.params,
    );
  } else {
    const gg = GROUPS[g] ?? GROUPS.product;
    rows = await c.tx.query(
      `SELECT ${gg.key} AS key, ${gg.name} AS name, sum(s.qty) AS qty, sum(s.revenue) AS revenue, sum(s.discount) AS discount,
              sum(s.returned_amount) AS returns, sum(s.cost) AS cost, sum(s.revenue - s.cost) AS profit
         ${RPT_JOINS} WHERE ${rptWhere(q, c)} GROUP BY 1, 2
        ORDER BY ${g === 'day' || g === 'month' ? '1' : 'revenue DESC NULLS LAST'} LIMIT ${c.f.limit}`,
      q.params,
    );
    if (g === 'quality') for (const r of rows) r.name = (QUALITY_LABELS as any)[r.name] ?? r.name;
  }
  return finishMoney(rows, cols, c);
}

const PERIOD: ReportDef['filters'] = ['from', 'to', 'storeId'];
const PRODUCT: ReportDef['filters'] = ['categoryId', 'brandId', 'qualityClass', 'makeId', 'modelId', 'productId'];

export const REPORTS: ReportDef[] = [
  // ── Продажи ──────────────────────────────────────────────
  {
    code: 'sales.by',
    group: 'sales',
    title: 'Продажи',
    permission: 'reports.sales',
    filters: [...PERIOD, ...PRODUCT, 'sellerId', 'customerId', 'groupBy'],
    groupBy: groupOptions(['product', 'category', 'brand', 'quality', 'make', 'model', 'store', 'seller', 'customer', 'day', 'month']),
    run: (c) => salesBy(c, false),
  },
  {
    code: 'sales.by_time',
    group: 'sales',
    title: 'Продажи по часам и дням недели',
    permission: 'reports.sales',
    filters: [...PERIOD, 'sellerId', 'groupBy'],
    groupBy: [{ value: 'hour', label: 'Час' }, { value: 'weekday', label: 'День недели' }],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const byHour = (c.f.groupBy ?? 'hour') === 'hour';
      const part = byHour ? `extract(hour FROM r.completed_at AT TIME ZONE 'Asia/Bishkek')` : `extract(isodow FROM r.completed_at AT TIME ZONE 'Asia/Bishkek')`;
      let w = `r.tenant_id = $1 AND r.status = 'completed' AND r.completed_at >= ${dayStart(q, c.f.from)} AND r.completed_at < ${dayEnd(q, c.f.to)}` + storeFilter(q, c, 'r.store_id');
      if (c.f.sellerId) w += ` AND r.seller_membership_id = ${q.p(c.f.sellerId)}`;
      const rows = await c.tx.query(
        `SELECT ${part}::int AS slot, count(*) FILTER (WHERE r.kind = 'sale')::int AS receipts,
                sum(CASE WHEN r.kind = 'sale' THEN r.total ELSE -r.total END) AS revenue
           FROM receipts r WHERE ${w} GROUP BY 1 ORDER BY 1`,
        q.params,
      );
      const WD = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
      for (const r of rows) {
        r.name = byHour ? `${String(r.slot).padStart(2, '0')}:00` : WD[r.slot];
        r.revenue = num(r.revenue);
        r.avg = r.receipts ? r2(r.revenue / r.receipts) : 0;
      }
      const cols = [C('name', byHour ? 'Час' : 'День недели'), C('receipts', 'Чеков', 'int'), C('revenue', 'Выручка', 'money'), C('avg', 'Средний чек', 'money')];
      return { columns: cols, rows, totals: sumTotals(rows, cols) };
    },
  },
  {
    code: 'sales.discounts',
    group: 'sales',
    title: 'Скидки',
    permission: 'reports.sales',
    filters: [...PERIOD, 'sellerId'],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      let w = `r.tenant_id = $1 AND r.kind = 'sale' AND r.status = 'completed' AND r.discount_total > 0 AND r.completed_at >= ${dayStart(q, c.f.from)} AND r.completed_at < ${dayEnd(q, c.f.to)}` + storeFilter(q, c, 'r.store_id');
      if (c.f.sellerId) w += ` AND r.seller_membership_id = ${q.p(c.f.sellerId)}`;
      const rows = await c.tx.query(
        `SELECT coalesce(u.name, '—') AS name, count(*)::int AS receipts, sum(r.subtotal) AS subtotal, sum(r.discount_total) AS discount,
                count(*) FILTER (WHERE r.approvals @> '[{"action":"discount"}]')::int AS "overLimit"
           FROM receipts r LEFT JOIN memberships m ON m.id = r.seller_membership_id LEFT JOIN users u ON u.id = m.user_id
          WHERE ${w} GROUP BY 1 ORDER BY discount DESC`,
        q.params,
      );
      for (const r of rows) {
        r.subtotal = num(r.subtotal);
        r.discount = num(r.discount);
        r.percent = r.subtotal ? r2((r.discount / r.subtotal) * 100) : 0;
      }
      const cols = [C('name', 'Продавец'), C('receipts', 'Чеков со скидкой', 'int'), C('subtotal', 'Сумма до скидки', 'money'), C('discount', 'Скидки', 'money'), C('percent', 'Скидка, %', 'percent'), C('overLimit', 'Сверх лимита (с PIN)', 'int')];
      return { columns: cols, rows, totals: sumTotals(rows, cols) };
    },
  },
  {
    code: 'sales.free_items',
    group: 'sales',
    title: 'Свободные позиции',
    permission: 'reports.sales',
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT d.doc_date AS "date", r.number, coalesce(l.extra->'free'->>'name', l.extra->>'name') AS name, l.qty, l.amount, coalesce(u.name, '—') AS seller
           FROM documents d JOIN document_lines l ON l.document_id = d.id JOIN receipts r ON r.document_id = d.id
           LEFT JOIN memberships m ON m.id = r.seller_membership_id LEFT JOIN users u ON u.id = m.user_id
          WHERE d.tenant_id = $1 AND d.type = 'sale' AND d.status = 'posted' AND l.extra ? 'free'
            AND d.doc_date >= ${dayStart(q, c.f.from)} AND d.doc_date < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'd.store_id')}
          ORDER BY d.doc_date DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      const cols = [C('date', 'Когда', 'datetime'), C('number', 'Чек'), C('name', 'Что продали'), C('qty', 'Кол-во', 'qty'), C('amount', 'Сумма', 'money'), C('seller', 'Продавец')];
      for (const r of rows) (r.qty = num(r.qty)), (r.amount = num(r.amount));
      return { columns: cols, rows, totals: sumTotals(rows, cols), note: 'Позиции без карточки товара — завести в каталог, если продаются часто' };
    },
  },

  // ── Прибыль ──────────────────────────────────────────────
  {
    code: 'profit.by',
    group: 'profit',
    title: 'Валовая прибыль и маржа',
    permission: 'reports.profit',
    needsCost: true,
    filters: [...PERIOD, ...PRODUCT, 'sellerId', 'groupBy'],
    groupBy: [...groupOptions(['product', 'category', 'brand', 'seller', 'store', 'day', 'month']), { value: 'receipt', label: 'Чек' }],
    async run(c) {
      if (c.f.groupBy !== 'receipt') return salesBy(c, true);
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT r.id AS key, r.number AS name, min(d.doc_date) AS "date", sum(${SALE_SIGN} * l.amount) AS revenue, sum(${SALE_SIGN} * l.cost_amount) AS cost,
                sum(${SALE_SIGN} * (l.amount - l.cost_amount)) AS profit
           FROM documents d JOIN document_lines l ON l.document_id = d.id JOIN receipts r ON r.document_id = d.id JOIN products p ON p.id = l.product_id
          WHERE d.tenant_id = $1 AND ${POSTED_SALES} AND d.doc_date >= ${dayStart(q, c.f.from)} AND d.doc_date < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'd.store_id')}${productFilter(q, c.f)}
          GROUP BY r.id, r.number ORDER BY min(d.doc_date) DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      return finishMoney(rows, [C('name', 'Чек'), C('date', 'Когда', 'datetime'), C('revenue', 'Выручка', 'money'), C('cost', 'Себестоимость', 'money'), C('profit', 'Прибыль', 'money'), C('margin', 'Маржа, %', 'percent')], c);
    },
  },
  {
    code: 'profit.below_cost',
    group: 'profit',
    title: 'Продажи ниже себестоимости',
    permission: 'reports.profit',
    needsCost: true,
    filters: [...PERIOD, ...PRODUCT],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT d.doc_date AS "date", r.number, p.name, l.base_qty AS qty, l.amount, l.cost_amount AS cost, l.cost_amount - l.amount AS loss, coalesce(u.name, '—') AS seller
           FROM documents d JOIN document_lines l ON l.document_id = d.id JOIN products p ON p.id = l.product_id
           LEFT JOIN receipts r ON r.document_id = d.id LEFT JOIN memberships m ON m.id = r.seller_membership_id LEFT JOIN users u ON u.id = m.user_id
          WHERE d.tenant_id = $1 AND d.type = 'sale' AND d.status = 'posted' AND l.amount < l.cost_amount AND p.status <> 'system'
            AND d.doc_date >= ${dayStart(q, c.f.from)} AND d.doc_date < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'd.store_id')}${productFilter(q, c.f)}
          ORDER BY loss DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) for (const k of ['qty', 'amount', 'cost', 'loss']) r[k] = num(r[k]);
      const cols = [C('date', 'Когда', 'datetime'), C('number', 'Чек'), C('name', 'Товар'), C('qty', 'Кол-во', 'qty'), C('amount', 'Продали за', 'money'), C('cost', 'Себестоимость', 'money'), C('loss', 'Убыток', 'money'), C('seller', 'Продавец')];
      return { columns: cols, rows, totals: sumTotals(rows, cols) };
    },
  },
  {
    code: 'profit.negative_stock',
    group: 'profit',
    title: 'Продажи в минус',
    permission: 'reports.profit',
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT d.doc_date AS "date", d.number, d.total_amount AS total, st.name AS store
           FROM documents d LEFT JOIN stores st ON st.id = d.store_id
          WHERE d.tenant_id = $1 AND d.type = 'sale' AND d.status = 'posted' AND d.has_negative
            AND d.doc_date >= ${dayStart(q, c.f.from)} AND d.doc_date < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'd.store_id')}
          ORDER BY d.doc_date DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) r.total = num(r.total);
      const cols = [C('date', 'Когда', 'datetime'), C('number', 'Документ'), C('total', 'Сумма', 'money'), C('store', 'Точка')];
      return { columns: cols, rows, totals: sumTotals(rows, cols), note: 'Себестоимость таких продаж уточнится, когда товар оприходуют' };
    },
  },

  // ── Склад ────────────────────────────────────────────────
  {
    code: 'stock.on_date',
    group: 'stock',
    title: 'Остатки на дату',
    permission: 'reports.stock',
    filters: ['date', 'storeId', 'warehouseId', ...PRODUCT],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const date = c.f.date ?? c.f.to;
      let w = `sm.tenant_id = $1 AND sm.moved_at < ${dayEnd(q, date)}` + productFilter(q, c.f);
      if (c.f.warehouseId) w += ` AND sm.warehouse_id = ${q.p(c.f.warehouseId)}`;
      w += storeFilter(q, c, 'wh.store_id');
      const rows = await c.tx.query(
        `SELECT p.id AS key, p.name, p.sku, sum(sm.qty) AS qty, sum(sm.cost_amount) AS cost
           FROM stock_movements sm JOIN products p ON p.id = sm.product_id JOIN warehouses wh ON wh.id = sm.warehouse_id
          WHERE ${w} GROUP BY p.id, p.name, p.sku HAVING sum(sm.qty) <> 0 OR sum(sm.cost_amount) <> 0 ORDER BY p.name LIMIT ${c.f.limit}`,
        q.params,
      );
      const cols = [C('name', 'Товар'), C('sku', 'Артикул'), C('qty', 'Остаток', 'qty'), C('cost', 'Сумма по себестоимости', 'money')];
      return finishMoney(rows, cols, c);
    },
  },
  {
    code: 'stock.turnover',
    group: 'stock',
    title: 'Оборотная ведомость',
    permission: 'reports.stock',
    filters: ['from', 'to', 'storeId', 'warehouseId', ...PRODUCT],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const s = dayStart(q, c.f.from);
      const e = dayEnd(q, c.f.to);
      let w = `sm.tenant_id = $1 AND sm.moved_at < ${e}` + productFilter(q, c.f);
      if (c.f.warehouseId) w += ` AND sm.warehouse_id = ${q.p(c.f.warehouseId)}`;
      w += storeFilter(q, c, 'wh.store_id');
      const rows = await c.tx.query(
        `SELECT p.id AS key, p.name,
                sum(sm.qty) FILTER (WHERE sm.moved_at < ${s}) AS "openQty", sum(sm.cost_amount) FILTER (WHERE sm.moved_at < ${s}) AS "openCost",
                sum(sm.qty) FILTER (WHERE sm.moved_at >= ${s} AND sm.qty > 0) AS "inQty", sum(sm.cost_amount) FILTER (WHERE sm.moved_at >= ${s} AND (sm.qty > 0 OR (sm.qty = 0 AND sm.cost_amount > 0))) AS "inCost",
                -sum(sm.qty) FILTER (WHERE sm.moved_at >= ${s} AND sm.qty < 0) AS "outQty", -sum(sm.cost_amount) FILTER (WHERE sm.moved_at >= ${s} AND (sm.qty < 0 OR (sm.qty = 0 AND sm.cost_amount < 0))) AS "outCost",
                sum(sm.qty) AS "closeQty", sum(sm.cost_amount) AS "closeCost"
           FROM stock_movements sm JOIN products p ON p.id = sm.product_id JOIN warehouses wh ON wh.id = sm.warehouse_id
          WHERE ${w} GROUP BY p.id, p.name ORDER BY p.name LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) for (const k of Object.keys(r)) if (k !== 'key' && k !== 'name') r[k] = num(r[k]);
      let cols = [C('name', 'Товар'), C('openQty', 'Начало', 'qty'), C('openCost', 'Начало, сом', 'money'), C('inQty', 'Приход', 'qty'), C('inCost', 'Приход, сом', 'money'), C('outQty', 'Расход', 'qty'), C('outCost', 'Расход, сом', 'money'), C('closeQty', 'Конец', 'qty'), C('closeCost', 'Конец, сом', 'money')];
      if (!c.canSeeCost) {
        cols = cols.filter((x) => x.type !== 'money');
        for (const r of rows) for (const k of ['openCost', 'inCost', 'outCost', 'closeCost']) delete r[k];
      }
      return { columns: cols, rows, totals: sumTotals(rows, cols) };
    },
  },
  {
    code: 'stock.movement',
    group: 'stock',
    title: 'Движение товара',
    permission: 'reports.stock',
    filters: ['from', 'to', 'productId', 'warehouseId'],
    async run(c) {
      if (!c.f.productId) return { columns: [], rows: [], note: 'Выберите товар' };
      const q = new Sql(c.tx.tenantId);
      let w = `sm.tenant_id = $1 AND sm.product_id = ${q.p(c.f.productId)}`;
      if (c.f.warehouseId) w += ` AND sm.warehouse_id = ${q.p(c.f.warehouseId)}`;
      w += storeFilter(q, c, 'wh.store_id');
      const s = dayStart(q, c.f.from);
      const [open] = await c.tx.query(`SELECT coalesce(sum(sm.qty), 0) AS q FROM stock_movements sm JOIN warehouses wh ON wh.id = sm.warehouse_id WHERE ${w} AND sm.moved_at < ${s}`, q.params);
      const e = dayEnd(q, c.f.to);
      const rows = await c.tx.query(
        `SELECT sm.moved_at AS "date", d.type, d.number, wh.name AS warehouse, sm.qty, sm.cost_amount AS cost
           FROM stock_movements sm JOIN warehouses wh ON wh.id = sm.warehouse_id LEFT JOIN documents d ON d.id = sm.document_id
          WHERE ${w} AND sm.moved_at >= ${s} AND sm.moved_at < ${e} ORDER BY sm.moved_at, sm.seq LIMIT ${c.f.limit}`,
        q.params,
      );
      let bal = num(open.q);
      for (const r of rows) {
        r.qty = num(r.qty);
        r.cost = num(r.cost);
        bal = r2(bal + r.qty);
        r.balance = bal;
      }
      const cols = [C('date', 'Когда', 'datetime'), C('type', 'Документ'), C('number', 'Номер'), C('warehouse', 'Склад'), C('qty', 'Кол-во', 'qty'), ...(c.canSeeCost ? [C('cost', 'Сумма', 'money')] : []), C('balance', 'Остаток', 'qty')];
      if (!c.canSeeCost) for (const r of rows) delete r.cost;
      return { columns: cols, rows, totals: { openQty: num(open.q), closeQty: bal } };
    },
  },
  {
    code: 'stock.stale',
    group: 'stock',
    title: 'Залежалые товары',
    permission: 'reports.stock',
    filters: ['days', 'storeId', 'warehouseId', ...PRODUCT],
    async run(c) {
      const days = c.f.days ?? 90;
      const q = new Sql(c.tx.tenantId);
      let w = `sb.tenant_id = $1` + productFilter(q, c.f);
      if (c.f.warehouseId) w += ` AND sb.warehouse_id = ${q.p(c.f.warehouseId)}`;
      w += storeFilter(q, c, 'wh.store_id');
      const rows = await c.tx.query(
        `WITH st AS (SELECT sb.product_id, sum(sb.qty) AS qty, sum(sb.cost_amount) AS cost FROM stock_balances sb JOIN warehouses wh ON wh.id = sb.warehouse_id JOIN products p ON p.id = sb.product_id
                      WHERE ${w} GROUP BY sb.product_id HAVING sum(sb.qty) > 0),
              last AS (SELECT l.product_id, max(d.doc_date) AS last_sale FROM document_lines l JOIN documents d ON d.id = l.document_id
                        WHERE d.tenant_id = $1 AND d.type = 'sale' AND d.status = 'posted' AND l.product_id IN (SELECT product_id FROM st) GROUP BY l.product_id)
         SELECT p.id AS key, p.name, p.sku, st.qty, st.cost, last.last_sale AS "lastSale",
                (current_date - coalesce(last.last_sale, p.created_at)::date) AS days
           FROM st JOIN products p ON p.id = st.product_id LEFT JOIN last ON last.product_id = st.product_id
          WHERE coalesce(last.last_sale, p.created_at) < now() - (${q.p(String(days))} || ' days')::interval
          ORDER BY st.cost DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      const res = finishMoney(rows, [C('name', 'Товар'), C('sku', 'Артикул'), C('qty', 'Остаток', 'qty'), C('cost', 'Заморожено, сом', 'money'), C('lastSale', 'Последняя продажа', 'date'), C('days', 'Дней без продаж', 'int')], c);
      res.note = `Не продавались ${days} дней и больше`;
      return res;
    },
  },
  {
    code: 'stock.abc_xyz',
    group: 'stock',
    title: 'ABC и XYZ',
    permission: 'reports.stock',
    filters: [...PERIOD, ...PRODUCT],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT p.id AS key, p.name, sum(s.revenue) AS revenue, sum(s.qty) AS qty,
                array_agg(s.qty ORDER BY s.day) AS daily, array_agg(s.day ORDER BY s.day) AS days
           ${RPT_JOINS} WHERE ${rptWhere(q, c)} GROUP BY p.id, p.name HAVING sum(s.revenue) > 0 ORDER BY revenue DESC`,
        q.params,
      );
      const total = rows.reduce((a: number, r: any) => a + num(r.revenue), 0);
      const weeks = Math.max(1, Math.ceil((dayjs(c.f.to).diff(dayjs(c.f.from), 'day') + 1) / 7));
      let cum = 0;
      for (const r of rows) {
        r.revenue = num(r.revenue);
        r.qty = num(r.qty);
        cum += r.revenue;
        r.share = r2((r.revenue / total) * 100);
        r.abc = cum / total <= 0.8 ? 'A' : cum / total <= 0.95 ? 'B' : 'C';
        // XYZ — стабильность спроса по неделям: коэффициент вариации
        const byWeek = new Array(weeks).fill(0);
        (r.days as string[]).forEach((d, i) => {
          const w = Math.min(weeks - 1, Math.floor(dayjs(d).diff(dayjs(c.f.from), 'day') / 7));
          byWeek[w] += num((r.daily as string[])[i]);
        });
        const mean = byWeek.reduce((a, x) => a + x, 0) / weeks;
        const sd = Math.sqrt(byWeek.reduce((a, x) => a + (x - mean) ** 2, 0) / weeks);
        r.cv = mean ? r2((sd / mean) * 100) : null;
        r.xyz = r.cv === null ? 'Z' : r.cv <= 10 ? 'X' : r.cv <= 25 ? 'Y' : 'Z';
        r.class = r.abc + r.xyz;
        delete r.daily;
        delete r.days;
      }
      const cols = [C('name', 'Товар'), C('revenue', 'Выручка', 'money'), C('share', 'Доля, %', 'percent'), C('qty', 'Кол-во', 'qty'), C('abc', 'ABC'), C('cv', 'Вариация, %', 'percent'), C('xyz', 'XYZ'), C('class', 'Класс')];
      return { columns: cols, rows: rows.slice(0, c.f.limit), totals: sumTotals(rows, cols), note: 'A — 80% выручки, B — следующие 15%, C — остальное. X — спрос ровный (вариация по неделям ≤ 10%), Y — ≤ 25%, Z — нерегулярный' };
    },
  },
  {
    code: 'stock.days_left',
    group: 'stock',
    title: 'Оборачиваемость: на сколько дней хватит',
    permission: 'reports.stock',
    filters: [...PERIOD, ...PRODUCT],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const days = dayjs(c.f.to).diff(dayjs(c.f.from), 'day') + 1;
      const rows = await c.tx.query(
        `WITH sold AS (SELECT s.product_id, sum(s.qty) AS qty, sum(s.cost) AS cost ${RPT_JOINS} WHERE ${rptWhere(q, c)} GROUP BY s.product_id),
              st AS (SELECT sb.product_id, sum(sb.qty) AS qty, sum(sb.cost_amount) AS cost FROM stock_balances sb JOIN warehouses wh ON wh.id = sb.warehouse_id
                      WHERE sb.tenant_id = $1${storeFilter(q, c, 'wh.store_id')} GROUP BY sb.product_id)
         SELECT p.id AS key, p.name, coalesce(st.qty, 0) AS stock, sold.qty AS sold, sold.cost AS "soldCost", st.cost AS "stockCost"
           FROM sold JOIN products p ON p.id = sold.product_id LEFT JOIN st ON st.product_id = sold.product_id
          WHERE sold.qty > 0 ORDER BY p.name LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) {
        r.stock = num(r.stock);
        r.sold = num(r.sold);
        r.perDay = r2(r.sold / days);
        r.daysLeft = r.perDay > 0 ? Math.floor(r.stock / r.perDay) : null;
        // Оборачиваемость в днях: средний остаток (≈ текущий) / себестоимость продаж в день
        r.turnoverDays = num(r.soldCost) > 0 ? Math.round(num(r.stockCost) / (num(r.soldCost) / days)) : null;
        delete r.soldCost;
        delete r.stockCost;
      }
      rows.sort((a: any, b: any) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
      return { columns: [C('name', 'Товар'), C('stock', 'Остаток', 'qty'), C('sold', `Продано за ${days} дн.`, 'qty'), C('perDay', 'В день', 'qty'), C('daysLeft', 'Хватит на, дней', 'int'), C('turnoverDays', 'Оборачиваемость, дней', 'int')], rows };
    },
  },

  // ── Автозапчасти ─────────────────────────────────────────
  {
    code: 'parts.neighbors',
    group: 'parts',
    title: 'Что брали у соседей',
    permission: 'reports.sales',
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT coalesce(np.part_number, '') || ' ' || np.name AS name, count(*)::int AS times, sum(np.qty) AS qty, sum(np.purchase_price * np.qty) AS bought,
                sum(np.sale_price * np.qty) AS sold, string_agg(DISTINCT n.name, ', ') AS neighbors, bool_or(np.product_id IS NOT NULL) AS "inCatalog"
           FROM neighbor_purchases np LEFT JOIN counterparties n ON n.id = np.neighbor_id
          WHERE np.tenant_id = $1 AND np.created_at >= ${dayStart(q, c.f.from)} AND np.created_at < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'np.store_id')}
          GROUP BY np.part_number, np.name ORDER BY times DESC, sold DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) (r.qty = num(r.qty)), (r.bought = num(r.bought)), (r.sold = num(r.sold)), (r.margin = r2(r.sold - r.bought));
      const cols = [C('name', 'Деталь'), C('times', 'Раз', 'int'), C('qty', 'Кол-во', 'qty'), C('bought', 'Взяли за', 'money'), C('sold', 'Продали за', 'money'), C('margin', 'Заработали', 'money'), C('neighbors', 'У кого')];
      return { columns: cols, rows, totals: sumTotals(rows, cols), note: 'Часто берёте у соседа — пора держать в наличии' };
    },
  },
  {
    code: 'parts.not_fit',
    group: 'parts',
    title: 'Возвраты «не подошло» по моделям',
    permission: 'reports.sales',
    filters: ['from', 'to'],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT i.vehicle_title AS vehicle, p.name AS product, count(*)::int AS returns, bool_and(i.resolved) AS resolved
           FROM product_fit_issues i JOIN products p ON p.id = i.product_id
          WHERE i.tenant_id = $1 AND i.created_at >= ${dayStart(q, c.f.from)} AND i.created_at < ${dayEnd(q, c.f.to)}
          GROUP BY i.vehicle_title, p.name ORDER BY returns DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      const cols = [C('vehicle', 'Машина'), C('product', 'Товар'), C('returns', 'Возвратов', 'int')];
      return { columns: cols, rows, totals: sumTotals(rows, cols) };
    },
  },
  {
    code: 'parts.warranty',
    group: 'parts',
    title: 'Гарантийные обращения по брендам и поставщикам',
    permission: 'reports.sales',
    filters: ['from', 'to', 'groupBy'],
    groupBy: [{ value: 'brand', label: 'Бренд' }, { value: 'supplier', label: 'Поставщик' }],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const bySupplier = c.f.groupBy === 'supplier';
      const rows = await c.tx.query(
        `SELECT ${bySupplier ? `coalesce(s.name, 'Не указан')` : `coalesce(b.name, 'Без бренда')`} AS name, count(*)::int AS claims,
                count(*) FILTER (WHERE w.decision IN ('refund', 'replace', 'repair'))::int AS accepted,
                count(*) FILTER (WHERE w.decision = 'reject')::int AS rejected, sum(w.qty) AS qty
           FROM warranty_claims w JOIN products p ON p.id = w.product_id LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN counterparties s ON s.id = w.supplier_id
          WHERE w.tenant_id = $1 AND w.deleted_at IS NULL AND w.created_at >= ${dayStart(q, c.f.from)} AND w.created_at < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'w.store_id')}
          GROUP BY 1 ORDER BY claims DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) r.qty = num(r.qty);
      const cols = [C('name', bySupplier ? 'Поставщик' : 'Бренд'), C('claims', 'Обращений', 'int'), C('qty', 'Штук', 'qty'), C('accepted', 'Признано', 'int'), C('rejected', 'Отказано', 'int')];
      return { columns: cols, rows, totals: sumTotals(rows, cols) };
    },
  },
  {
    code: 'parts.catalog_gaps',
    group: 'parts',
    title: '«Дозаполнить» каталог',
    permission: 'reports.stock',
    filters: [...PRODUCT],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT p.id AS key, p.name, p.sku,
                NOT EXISTS (SELECT 1 FROM part_numbers n WHERE n.tenant_id = p.tenant_id AND n.product_id = p.id) AS "noNumber",
                NOT EXISTS (SELECT 1 FROM product_photos ph WHERE ph.tenant_id = p.tenant_id AND ph.product_id = p.id) AS "noPhoto",
                (p.kind = 'part' AND NOT EXISTS (SELECT 1 FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id)) AS "noApplicability",
                p.category_id IS NULL AS "noCategory", p.brand_id IS NULL AS "noBrand",
                NOT EXISTS (SELECT 1 FROM prices pr WHERE pr.tenant_id = p.tenant_id AND pr.product_id = p.id) AS "noPrice",
                p.quick_created AS "quickCreated"
           FROM products p
          WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.status = 'active' AND p.merged_into_id IS NULL${productFilter(q, c.f)}`,
        q.params,
      );
      const flags = ['noNumber', 'noPhoto', 'noApplicability', 'noCategory', 'noBrand', 'noPrice'];
      const out = rows
        .map((r: any) => ({ ...r, gaps: flags.filter((f) => r[f]).length }))
        .filter((r: any) => r.gaps > 0 || r.quickCreated)
        .sort((a: any, b: any) => Number(b.quickCreated) - Number(a.quickCreated) || b.gaps - a.gaps)
        .slice(0, c.f.limit);
      const totals: Record<string, number> = { products: rows.length };
      for (const f of flags) totals[f] = rows.filter((r: any) => r[f]).length;
      return {
        columns: [C('name', 'Товар'), C('sku', 'Артикул'), C('quickCreated', 'Создан на кассе'), C('noNumber', 'Нет номера'), C('noPhoto', 'Нет фото'), C('noApplicability', 'Нет применимости'), C('noCategory', 'Нет группы'), C('noBrand', 'Нет бренда'), C('noPrice', 'Нет цены'), C('gaps', 'Пробелов', 'int')],
        rows: out,
        totals,
      };
    },
  },

  // ── Закупки ──────────────────────────────────────────────
  {
    code: 'purchases.by_supplier',
    group: 'purchases',
    title: 'Закупки по поставщикам',
    permission: 'reports.stock',
    needsCost: true,
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT coalesce(cp.name, 'Без поставщика') AS name, count(DISTINCT d.id) FILTER (WHERE d.type = 'receiving')::int AS receivings,
                sum(l.cost_amount) FILTER (WHERE d.type = 'receiving') AS purchased, sum(l.cost_amount) FILTER (WHERE d.type = 'supplier_return') AS returned,
                count(DISTINCT l.product_id) FILTER (WHERE d.type = 'receiving')::int AS products
           FROM documents d JOIN document_lines l ON l.document_id = d.id LEFT JOIN counterparties cp ON cp.id = d.counterparty_id
          WHERE d.tenant_id = $1 AND d.type IN ('receiving', 'supplier_return') AND d.status = 'posted' AND d.deleted_at IS NULL
            AND d.doc_date >= ${dayStart(q, c.f.from)} AND d.doc_date < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'd.store_id')}
          GROUP BY 1 ORDER BY purchased DESC NULLS LAST LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) (r.purchased = num(r.purchased)), (r.returned = num(r.returned)), (r.net = r2(r.purchased - r.returned));
      const cols = [C('name', 'Поставщик'), C('receivings', 'Приёмок', 'int'), C('products', 'Товаров', 'int'), C('purchased', 'Закуплено, сом', 'money'), C('returned', 'Возвращено, сом', 'money'), C('net', 'Итого, сом', 'money')];
      return { columns: cols, rows, totals: sumTotals(rows, cols) };
    },
  },
  {
    code: 'purchases.price_dynamics',
    group: 'purchases',
    title: 'Динамика закупочных цен',
    permission: 'reports.stock',
    needsCost: true,
    filters: [...PERIOD, ...PRODUCT],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT p.id AS key, p.name, count(*)::int AS receivings,
                (array_agg(l.unit_cost ORDER BY d.doc_date))[1] AS first, (array_agg(l.unit_cost ORDER BY d.doc_date DESC))[1] AS last,
                min(l.unit_cost) AS min, max(l.unit_cost) AS max
           FROM documents d JOIN document_lines l ON l.document_id = d.id JOIN products p ON p.id = l.product_id
          WHERE d.tenant_id = $1 AND d.type = 'receiving' AND d.status = 'posted' AND d.deleted_at IS NULL
            AND d.doc_date >= ${dayStart(q, c.f.from)} AND d.doc_date < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'd.store_id')}${productFilter(q, c.f)}
          GROUP BY p.id, p.name ORDER BY p.name LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) {
        for (const k of ['first', 'last', 'min', 'max']) r[k] = r2(num(r[k]));
        r.change = r.first ? r2(((r.last - r.first) / r.first) * 100) : null;
      }
      rows.sort((a: any, b: any) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0));
      return { columns: [C('name', 'Товар'), C('receivings', 'Приёмок', 'int'), C('first', 'Первая цена', 'money'), C('last', 'Последняя', 'money'), C('min', 'Мин.', 'money'), C('max', 'Макс.', 'money'), C('change', 'Изменение, %', 'percent')], rows, note: 'Себестоимость единицы в сомах (с доп. расходами)' };
    },
  },
  {
    code: 'purchases.orders',
    group: 'purchases',
    title: 'Выполнение заказов поставщиками',
    permission: 'reports.stock',
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT coalesce(s.name, '—') AS name, count(DISTINCT o.id)::int AS orders, sum(l.qty * l.factor) AS ordered, sum(l.received_qty) AS received,
                count(DISTINCT o.id) FILTER (WHERE o.expected_at IS NOT NULL AND coalesce(o.closed_at, now()) > o.expected_at + interval '1 day')::int AS late,
                avg(extract(epoch FROM (o.closed_at - o.sent_at)) / 86400) FILTER (WHERE o.closed_at IS NOT NULL AND o.sent_at IS NOT NULL) AS "avgDays"
           FROM purchase_orders o JOIN purchase_order_lines l ON l.order_id = o.id LEFT JOIN counterparties s ON s.id = o.supplier_id
          WHERE o.tenant_id = $1 AND o.deleted_at IS NULL AND o.status NOT IN ('draft', 'cancelled')
            AND o.created_at >= ${dayStart(q, c.f.from)} AND o.created_at < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'o.store_id')}
          GROUP BY 1 ORDER BY orders DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) {
        r.ordered = num(r.ordered);
        r.received = num(r.received);
        r.fill = r.ordered ? r2((r.received / r.ordered) * 100) : null;
        r.avgDays = r.avgDays === null ? null : r2(num(r.avgDays));
      }
      return { columns: [C('name', 'Поставщик'), C('orders', 'Заказов', 'int'), C('ordered', 'Заказано', 'qty'), C('received', 'Пришло', 'qty'), C('fill', 'Полнота, %', 'percent'), C('late', 'С опозданием', 'int'), C('avgDays', 'Срок, дней', 'qty')], rows };
    },
  },

  // ── Клиенты ──────────────────────────────────────────────
  {
    code: 'customers.new_repeat',
    group: 'customers',
    title: 'Новые и повторные клиенты',
    permission: 'reports.sales',
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const s = dayStart(q, c.f.from);
      const e = dayEnd(q, c.f.to);
      const rows = await c.tx.query(
        `WITH firsts AS (SELECT customer_id, min(completed_at) AS first_at FROM receipts WHERE tenant_id = $1 AND kind = 'sale' AND status = 'completed' AND customer_id IS NOT NULL GROUP BY customer_id),
              per AS (SELECT r.customer_id, count(*) AS receipts, sum(r.total) AS revenue FROM receipts r
                       WHERE r.tenant_id = $1 AND r.kind = 'sale' AND r.status = 'completed' AND r.customer_id IS NOT NULL AND r.completed_at >= ${s} AND r.completed_at < ${e}${storeFilter(q, c, 'r.store_id')}
                       GROUP BY r.customer_id)
         SELECT CASE WHEN f.first_at >= ${s} THEN 'Новые' ELSE 'Повторные' END AS name, count(*)::int AS customers, sum(per.receipts)::int AS receipts, sum(per.revenue) AS revenue
           FROM per JOIN firsts f ON f.customer_id = per.customer_id GROUP BY 1 ORDER BY 1`,
        q.params,
      );
      const q2 = new Sql(c.tx.tenantId);
      const [anon] = await c.tx.query(
        `SELECT count(*)::int AS receipts, coalesce(sum(r.total), 0) AS revenue FROM receipts r
          WHERE r.tenant_id = $1 AND r.kind = 'sale' AND r.status = 'completed' AND r.customer_id IS NULL AND r.completed_at >= ${dayStart(q2, c.f.from)} AND r.completed_at < ${dayEnd(q2, c.f.to)}${storeFilter(q2, c, 'r.store_id')}`,
        q2.params,
      );
      rows.push({ name: 'Без карточки клиента', customers: null, receipts: anon.receipts, revenue: anon.revenue });
      for (const r of rows) r.revenue = num(r.revenue);
      const cols = [C('name', 'Клиенты'), C('customers', 'Человек', 'int'), C('receipts', 'Чеков', 'int'), C('revenue', 'Выручка', 'money')];
      return { columns: cols, rows, totals: sumTotals(rows, cols) };
    },
  },
  {
    code: 'customers.lapsed',
    group: 'customers',
    title: 'Давно не покупали',
    permission: 'reports.sales',
    filters: ['days', 'storeId'],
    async run(c) {
      const days = c.f.days ?? 60;
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT cp.id AS key, cp.name, cp.phone, max(r.completed_at) AS "lastAt", count(*)::int AS receipts, sum(r.total) AS revenue,
                (current_date - max(r.completed_at)::date) AS days
           FROM receipts r JOIN counterparties cp ON cp.id = r.customer_id
          WHERE r.tenant_id = $1 AND r.kind = 'sale' AND r.status = 'completed'${storeFilter(q, c, 'r.store_id')}
          GROUP BY cp.id, cp.name, cp.phone HAVING max(r.completed_at) < now() - (${q.p(String(days))} || ' days')::interval
          ORDER BY revenue DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) r.revenue = num(r.revenue);
      return { columns: [C('name', 'Клиент'), C('phone', 'Телефон'), C('lastAt', 'Последняя покупка', 'date'), C('days', 'Дней назад', 'int'), C('receipts', 'Чеков всего', 'int'), C('revenue', 'Купил всего', 'money')], rows, note: `Не покупали ${days} дней и больше — напомнить о себе` };
    },
  },
  {
    code: 'customers.top',
    group: 'customers',
    title: 'Топ клиентов',
    permission: 'reports.sales',
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT s.customer_id AS key, cp.name, cp.phone, sum(s.revenue) AS revenue, sum(s.cost) AS cost, sum(s.revenue - s.cost) AS profit
           ${RPT_JOINS} WHERE ${rptWhere(q, c)} AND s.customer_id IS NOT NULL GROUP BY s.customer_id, cp.name, cp.phone ORDER BY revenue DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      return finishMoney(rows, [C('name', 'Клиент'), C('phone', 'Телефон'), C('revenue', 'Выручка', 'money'), C('cost', 'Себестоимость', 'money'), C('profit', 'Прибыль', 'money'), C('margin', 'Маржа, %', 'percent')], c);
    },
  },
  {
    code: 'customers.debts_aging',
    group: 'customers',
    title: 'Долги и возраст долгов',
    permission: 'customers.debts',
    filters: ['storeId', 'groupBy'],
    groupBy: [{ value: 'receivable', label: 'Нам должны' }, { value: 'payable', label: 'Мы должны' }],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const dir = c.f.groupBy === 'payable' ? 'payable' : 'receivable';
      const rows = await c.tx.query(
        `SELECT cp.id AS key, cp.name, d.currency, sum(d.remaining) AS total,
                sum(d.remaining) FILTER (WHERE coalesce(d.due_date, d.opened_at::date) >= current_date) AS current,
                sum(d.remaining) FILTER (WHERE current_date - coalesce(d.due_date, d.opened_at::date) BETWEEN 1 AND 30) AS d30,
                sum(d.remaining) FILTER (WHERE current_date - coalesce(d.due_date, d.opened_at::date) BETWEEN 31 AND 60) AS d60,
                sum(d.remaining) FILTER (WHERE current_date - coalesce(d.due_date, d.opened_at::date) BETWEEN 61 AND 90) AS d90,
                sum(d.remaining) FILTER (WHERE current_date - coalesce(d.due_date, d.opened_at::date) > 90) AS d90plus,
                min(coalesce(d.due_date, d.opened_at::date)) AS oldest
           FROM debt_items d JOIN counterparties cp ON cp.id = d.counterparty_id
          WHERE d.tenant_id = $1 AND d.direction = ${q.p(dir)} AND d.remaining > 0 AND d.kind <> 'prepayment'${storeFilter(q, c, 'd.store_id')}
          GROUP BY cp.id, cp.name, d.currency ORDER BY total DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) for (const k of ['total', 'current', 'd30', 'd60', 'd90', 'd90plus']) r[k] = num(r[k]);
      const cols = [C('name', dir === 'payable' ? 'Кому' : 'Кто'), C('currency', 'Валюта'), C('total', 'Всего', 'money'), C('current', 'Не просрочено', 'money'), C('d30', '1–30 дн.', 'money'), C('d60', '31–60', 'money'), C('d90', '61–90', 'money'), C('d90plus', 'Больше 90', 'money'), C('oldest', 'Самый старый с', 'date')];
      return { columns: cols, rows, totals: sumTotals(rows, cols), note: 'Возраст — от срока оплаты, без срока — от даты долга. Суммы в валюте долга' };
    },
  },
  {
    code: 'customers.hanging',
    group: 'customers',
    title: 'Висит на подборе',
    permission: 'requests.read',
    filters: ['storeId'],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT r.number, coalesce(cp.name, r.customer_name) AS customer, coalesce(r.customer_phone, cp.phone) AS phone, r.vehicle_text AS vehicle, r.status,
                u.name AS assignee, r.created_at AS "createdAt", (current_date - r.created_at::date) AS days, r.due_at AS "dueAt"
           FROM customer_requests r LEFT JOIN counterparties cp ON cp.id = r.customer_id
           LEFT JOIN memberships m ON m.id = r.assignee_id LEFT JOIN users u ON u.id = m.user_id
          WHERE r.tenant_id = $1 AND r.deleted_at IS NULL AND r.status IN ('new', 'selecting')${storeFilter(q, c, 'r.store_id')}
          ORDER BY r.created_at LIMIT ${c.f.limit}`,
        q.params,
      );
      return { columns: [C('number', 'Заявка'), C('customer', 'Клиент'), C('phone', 'Телефон'), C('vehicle', 'Машина'), C('status', 'Статус'), C('assignee', 'Кто подбирает'), C('createdAt', 'Создана', 'datetime'), C('days', 'Дней', 'int')], rows };
    },
  },

  // ── Сотрудники ───────────────────────────────────────────
  {
    code: 'staff.sales',
    group: 'staff',
    title: 'Продажи и маржа по продавцам',
    permission: 'reports.staff',
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT s.seller_id AS key, coalesce(u.name, '—') AS name, sum(s.revenue) AS revenue, sum(s.cost) AS cost, sum(s.revenue - s.cost) AS profit,
                sum(s.returned_amount) AS returns, sum(s.discount) AS discount
           ${RPT_JOINS} WHERE ${rptWhere(q, c)} GROUP BY s.seller_id, u.name ORDER BY revenue DESC`,
        q.params,
      );
      const q2 = new Sql(c.tx.tenantId);
      const counts = await c.tx.query(
        `SELECT seller_membership_id AS id, count(*)::int AS n FROM receipts r
          WHERE r.tenant_id = $1 AND r.kind = 'sale' AND r.status = 'completed' AND r.completed_at >= ${dayStart(q2, c.f.from)} AND r.completed_at < ${dayEnd(q2, c.f.to)}${storeFilter(q2, c, 'r.store_id')}
          GROUP BY 1`,
        q2.params,
      );
      for (const r of rows) {
        r.receipts = counts.find((x: any) => x.id === r.key)?.n ?? 0;
        r.avg = r.receipts ? r2(num(r.revenue) / r.receipts) : 0;
      }
      return finishMoney(rows, [C('name', 'Продавец'), C('receipts', 'Чеков', 'int'), C('revenue', 'Выручка', 'money'), C('avg', 'Средний чек', 'money'), C('discount', 'Скидки', 'money'), C('returns', 'Возвраты', 'money'), C('cost', 'Себестоимость', 'money'), C('profit', 'Прибыль', 'money'), C('margin', 'Маржа, %', 'percent')], c);
    },
  },
  {
    code: 'staff.shift_diffs',
    group: 'staff',
    title: 'Расхождения смен',
    permission: 'reports.staff',
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT s.number, rg.name AS register, s.opened_at AS "openedAt", s.closed_at AS "closedAt", u.name AS "closedBy", s.diff, s.auto_closed AS "autoClosed"
           FROM shifts s JOIN registers rg ON rg.id = s.register_id LEFT JOIN users u ON u.id = s.closed_by
          WHERE s.tenant_id = $1 AND s.status = 'closed' AND s.closed_at >= ${dayStart(q, c.f.from)} AND s.closed_at < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 's.store_id')}
            AND EXISTS (SELECT 1 FROM jsonb_each_text(coalesce(s.diff, '{}'::jsonb)) x WHERE x.value::numeric <> 0)
          ORDER BY s.closed_at DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) r.diffText = Object.entries(r.diff ?? {}).filter(([, v]) => Number(v) !== 0).map(([k, v]) => `${Number(v) > 0 ? '+' : ''}${v} ${k}`).join(', ');
      return { columns: [C('number', 'Смена', 'int'), C('register', 'Касса'), C('openedAt', 'Открыта', 'datetime'), C('closedAt', 'Закрыта', 'datetime'), C('closedBy', 'Закрыл'), C('diffText', 'Расхождение')], rows };
    },
  },
  {
    code: 'staff.deleted_lines',
    group: 'staff',
    title: 'Удалённые строки чеков',
    permission: 'reports.staff',
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT a.created_at AS "date", coalesce(u.name, '—') AS "user", a.summary
           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.tenant_id = $1 AND a.action IN ('receipt.line_delete', 'receipt.cancel') AND a.created_at >= ${dayStart(q, c.f.from)} AND a.created_at < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'a.store_id')}
          ORDER BY a.created_at DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      return { columns: [C('date', 'Когда', 'datetime'), C('user', 'Кто'), C('summary', 'Что')], rows };
    },
  },
  {
    code: 'staff.over_limit_discounts',
    group: 'staff',
    title: 'Скидки сверх лимита',
    permission: 'reports.staff',
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rows = await c.tx.query(
        `SELECT r.completed_at AS "date", r.number, coalesce(u.name, '—') AS seller, ap->>'name' AS approver, r.subtotal, r.discount_total AS discount
           FROM receipts r CROSS JOIN LATERAL jsonb_array_elements(r.approvals) ap
           LEFT JOIN memberships m ON m.id = r.seller_membership_id LEFT JOIN users u ON u.id = m.user_id
          WHERE r.tenant_id = $1 AND r.status = 'completed' AND ap->>'action' = 'discount'
            AND r.completed_at >= ${dayStart(q, c.f.from)} AND r.completed_at < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'r.store_id')}
          ORDER BY r.completed_at DESC LIMIT ${c.f.limit}`,
        q.params,
      );
      for (const r of rows) (r.subtotal = num(r.subtotal)), (r.discount = num(r.discount));
      const cols = [C('date', 'Когда', 'datetime'), C('number', 'Чек'), C('seller', 'Продавец'), C('approver', 'Разрешил'), C('subtotal', 'Сумма', 'money'), C('discount', 'Скидка', 'money')];
      return { columns: cols, rows, totals: sumTotals(rows, cols) };
    },
  },
  {
    code: 'staff.motivation',
    group: 'staff',
    title: 'Мотивация: план-факт и начисления',
    permission: 'reports.staff',
    filters: ['from', 'to'],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const months = new Set<string>();
      for (let d = dayjs(c.f.from); !d.isAfter(dayjs(c.f.to)); d = d.add(1, 'day')) months.add(d.format('YYYY-MM'));
      const rows = await c.tx.query(
        `SELECT m.id AS key, u.name, coalesce(r.base_monthly, 0) AS base, coalesce(r.percent, 0) AS percent, coalesce(r.basis, 'sales') AS basis, r.plan_monthly AS plan,
                coalesce((SELECT sum(s.revenue) FROM rpt_sales_daily s WHERE s.tenant_id = m.tenant_id AND s.seller_id = m.id AND s.day BETWEEN ${q.p(c.f.from)}::date AND ${q.p(c.f.to)}::date), 0) AS sales,
                coalesce((SELECT sum(s.revenue - s.cost) FROM rpt_sales_daily s WHERE s.tenant_id = m.tenant_id AND s.seller_id = m.id AND s.day BETWEEN $2::date AND $3::date), 0) AS margin,
                coalesce((SELECT sum(e.amount_kgs) FROM expenses e JOIN expense_articles a ON a.id = e.article_id
                           WHERE e.tenant_id = m.tenant_id AND e.membership_id = m.id AND a.kind = 'salary' AND e.status = 'posted' AND e.expense_date BETWEEN $2::date AND $3::date), 0) AS paid
           FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN salary_rules r ON r.tenant_id = m.tenant_id AND r.membership_id = m.id
          WHERE m.tenant_id = $1 AND m.status = 'active' ORDER BY u.name`,
        q.params,
      );
      const out = rows
        .map((r: any) => {
          const n = months.size;
          const sales = num(r.sales);
          const margin = num(r.margin);
          const bonus = r2(((r.basis === 'margin' ? margin : sales) * num(r.percent)) / 100);
          const accrued = r2(num(r.base) * n + bonus);
          const plan = r.plan === null ? null : num(r.plan) * n;
          return {
            key: r.key,
            name: r.name,
            sales,
            ...(c.canSeeCost ? { margin } : {}),
            plan,
            planPercent: plan ? r2((sales / plan) * 100) : null,
            rule: `${num(r.base) ? `${num(r.base)} + ` : ''}${num(r.percent)}% от ${r.basis === 'margin' ? 'маржи' : 'продаж'}`,
            base: r2(num(r.base) * n),
            bonus,
            accrued,
            paid: num(r.paid),
            toPay: r2(accrued - num(r.paid)),
          };
        })
        .filter((r: any) => r.accrued || r.paid || r.sales);
      const cols = [C('name', 'Сотрудник'), C('rule', 'Условия'), C('sales', 'Продажи', 'money'), ...(c.canSeeCost ? [C('margin', 'Маржа', 'money')] : []), C('plan', 'План', 'money'), C('planPercent', 'Выполнение, %', 'percent'), C('base', 'Оклад', 'money'), C('bonus', 'Процент', 'money'), C('accrued', 'Начислено', 'money'), C('paid', 'Выплачено', 'money'), C('toPay', 'К выплате', 'money')];
      return { columns: cols, rows: out, totals: sumTotals(out, cols), note: 'Оклад — за каждый месяц периода. Выплата — расход по статье «Зарплата» на сотрудника' };
    },
  },

  // ── Деньги ───────────────────────────────────────────────
  {
    code: 'money.cash_flow',
    group: 'money',
    title: 'Движение денег',
    permission: 'reports.money',
    filters: [...PERIOD, 'groupBy'],
    groupBy: [{ value: 'account', label: 'Счёт' }, { value: 'kind', label: 'Вид операции' }, { value: 'article', label: 'Статья расходов' }],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const g = c.f.groupBy ?? 'account';
      const s = dayStart(q, c.f.from);
      const e = dayEnd(q, c.f.to);
      const sf = storeFilter(q, c, 'coalesce(a.store_id, rg.store_id)');
      const KIND: Record<string, string> = { sale: 'Продажи', refund: 'Возвраты покупателям', debt_in: 'Оплата долгов клиентами', debt_out: 'Оплата долгов поставщикам', cash_in: 'Внесение', cash_out: 'Изъятие', transfer: 'Перемещения', exchange: 'Обмен валюты', fee: 'Комиссия эквайринга', shift_diff: 'Расхождения смен', not_received: 'Переводы не поступили', expense: 'Расходы', owner_withdrawal: 'Изъятие собственника' };
      const key = g === 'kind' ? 'm.kind' : g === 'article' ? `coalesce(ea.name, 'Не расход')` : 'a.id';
      const name = g === 'kind' ? 'm.kind' : g === 'article' ? `coalesce(ea.name, 'Не расход')` : `a.name || ' (' || a.currency || ')'`;
      const rows = await c.tx.query(
        `SELECT ${key}::text AS key, ${name} AS name,
                sum(m.amount_kgs) FILTER (WHERE m.moved_at < ${s}) AS opening,
                sum(m.amount_kgs) FILTER (WHERE m.moved_at >= ${s} AND m.amount_kgs > 0) AS income,
                -sum(m.amount_kgs) FILTER (WHERE m.moved_at >= ${s} AND m.amount_kgs < 0) AS outcome,
                sum(m.amount_kgs) AS closing
           FROM money_movements m JOIN money_accounts a ON a.id = m.account_id LEFT JOIN registers rg ON rg.id = a.register_id
           LEFT JOIN expenses ex ON ex.id = m.operation_id AND m.kind IN ('expense', 'owner_withdrawal') LEFT JOIN expense_articles ea ON ea.id = ex.article_id
          WHERE m.tenant_id = $1 AND m.moved_at < ${e}${sf}${g === 'account' ? '' : ` AND m.moved_at >= ${s}`}
          GROUP BY 1, 2 ORDER BY 2`,
        q.params,
      );
      for (const r of rows) {
        for (const k of ['opening', 'income', 'outcome', 'closing']) r[k] = num(r[k]);
        if (g === 'kind') r.name = KIND[r.name] ?? r.name;
      }
      const cols = g === 'account'
        ? [C('name', 'Счёт'), C('opening', 'На начало, сом', 'money'), C('income', 'Приход', 'money'), C('outcome', 'Расход', 'money'), C('closing', 'На конец, сом', 'money')]
        : [C('name', g === 'kind' ? 'Вид' : 'Статья'), C('income', 'Приход', 'money'), C('outcome', 'Расход', 'money')];
      if (g !== 'account') for (const r of rows) delete r.opening, delete r.closing;
      return { columns: cols, rows, totals: sumTotals(rows, cols), note: 'В сомах по курсу на момент операции; перемещения между своими счетами — и приход, и расход' };
    },
  },
  {
    code: 'money.pnl',
    group: 'money',
    title: 'Прибыль',
    permission: 'reports.profit',
    needsCost: true,
    filters: [...PERIOD],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const [s] = await c.tx.query(
        `SELECT coalesce(sum(s.revenue), 0) AS revenue, coalesce(sum(s.cost), 0) AS cost FROM rpt_sales_daily s
          WHERE s.tenant_id = $1 AND s.day >= ${q.p(c.f.from)}::date AND s.day <= ${q.p(c.f.to)}::date${storeFilter(q, c, 's.store_id')}`,
        q.params,
      );
      const q2 = new Sql(c.tx.tenantId);
      const exp = await c.tx.query(
        `SELECT a.name, a.kind, sum(e.amount_kgs) AS amount FROM expenses e JOIN expense_articles a ON a.id = e.article_id
          WHERE e.tenant_id = $1 AND e.status = 'posted' AND e.expense_date >= ${q2.p(c.f.from)}::date AND e.expense_date <= ${q2.p(c.f.to)}::date${storeFilter(q2, c, 'e.store_id')}
          GROUP BY a.name, a.kind ORDER BY amount DESC`,
        q2.params,
      );
      const fx = await fxDiffs(c);
      const revenue = num(s.revenue);
      const cost = num(s.cost);
      const rows: any[] = [
        { line: 'Выручка', amount: revenue, level: 0 },
        { line: 'Себестоимость проданного', amount: -cost, level: 0 },
        { line: 'Валовая прибыль', amount: r2(revenue - cost), level: 1, bold: true },
      ];
      let expenses = 0;
      for (const e of exp.filter((x: any) => x.kind !== 'owner')) {
        rows.push({ line: `Расход: ${e.name}`, amount: -num(e.amount), level: 0 });
        expenses += num(e.amount);
      }
      rows.push({ line: 'Курсовые разницы', amount: fx.total, level: 0 });
      const net = r2(revenue - cost - expenses + fx.total);
      rows.push({ line: 'Чистая прибыль', amount: net, level: 1, bold: true });
      const owner = exp.filter((x: any) => x.kind === 'owner').reduce((a: number, x: any) => a + num(x.amount), 0);
      rows.push({ line: 'Изъятие собственника (не расход)', amount: -owner, level: 2 });
      return {
        columns: [C('line', 'Статья'), C('amount', 'Сумма, сом', 'money')],
        rows,
        totals: { revenue, cost, gross: r2(revenue - cost), expenses: r2(expenses), fx: fx.total, net, margin: revenue ? r2((net / revenue) * 100) : null, ownerWithdrawals: r2(owner) },
        note: 'Выручка − себестоимость − расходы ± курсовые разницы. Бонусы мастерам войдут сюда с программой лояльности (этап 8)',
      };
    },
  },
  {
    code: 'money.payment_calendar',
    group: 'money',
    title: 'Платёжный календарь',
    permission: 'reports.money',
    filters: ['days', 'storeId'],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const days = c.f.days ?? 30;
      const rates = c.settings.rates ?? {};
      const rows = await c.tx.query(
        `SELECT CASE WHEN coalesce(d.due_date, d.opened_at::date) < current_date THEN NULL ELSE coalesce(d.due_date, d.opened_at::date) END AS day,
                d.direction, d.currency, sum(d.remaining) AS amount, count(*)::int AS n
           FROM debt_items d
          WHERE d.tenant_id = $1 AND d.remaining > 0 AND d.kind <> 'prepayment' AND coalesce(d.due_date, d.opened_at::date) <= current_date + ${q.p(days)}::int${storeFilter(q, c, 'd.store_id')}
          GROUP BY 1, 2, 3`,
        q.params,
      );
      const byDay = new Map<string, any>();
      for (const r of rows) {
        const k = r.day ? dayjs(r.day).format('YYYY-MM-DD') : 'overdue';
        const row = byDay.get(k) ?? { day: k === 'overdue' ? 'Просрочено' : k, inflow: 0, outflow: 0 };
        const kgs = num(r.amount) * (r.currency === 'KGS' ? 1 : num(rates[r.currency]));
        if (r.direction === 'receivable') row.inflow = r2(row.inflow + kgs);
        else row.outflow = r2(row.outflow + kgs);
        byDay.set(k, row);
      }
      const list = [...byDay.entries()].sort(([a], [b]) => (a === 'overdue' ? -1 : b === 'overdue' ? 1 : a.localeCompare(b))).map(([, v]) => v);
      let cum = 0;
      for (const r of list) {
        r.net = r2(r.inflow - r.outflow);
        cum = r2(cum + r.net);
        r.cumulative = cum;
      }
      const cols = [C('day', 'Дата'), C('inflow', 'Ждём от клиентов', 'money'), C('outflow', 'Платим поставщикам', 'money'), C('net', 'Сальдо', 'money'), C('cumulative', 'Нарастающим', 'money')];
      return { columns: cols, rows: list, totals: sumTotals(list, cols), note: `По срокам долгов на ${days} дней вперёд; валюта — по курсу магазина` };
    },
  },
  {
    code: 'money.business_balance',
    group: 'money',
    title: 'Баланс бизнеса',
    permission: 'reports.money',
    needsCost: true,
    filters: ['storeId'],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rates = c.settings.rates ?? {};
      const kgs = (amount: unknown, cur: string) => num(amount) * (cur === 'KGS' ? 1 : num(rates[cur]));
      const money = await c.tx.query(
        `SELECT a.currency, sum(m.amount) AS amount FROM money_movements m JOIN money_accounts a ON a.id = m.account_id LEFT JOIN registers rg ON rg.id = a.register_id
          WHERE m.tenant_id = $1${storeFilter(q, c, 'coalesce(a.store_id, rg.store_id)')} GROUP BY a.currency`,
        q.params,
      );
      const q2 = new Sql(c.tx.tenantId);
      const [stock] = await c.tx.query(
        `SELECT coalesce(sum(sb.cost_amount), 0) AS cost FROM stock_balances sb JOIN warehouses wh ON wh.id = sb.warehouse_id WHERE sb.tenant_id = $1${storeFilter(q2, c, 'wh.store_id')}`,
        q2.params,
      );
      const q3 = new Sql(c.tx.tenantId);
      const debts = await c.tx.query(
        `SELECT d.direction, d.currency, sum(d.remaining) AS amount FROM debt_items d WHERE d.tenant_id = $1 AND d.remaining > 0${storeFilter(q3, c, 'd.store_id')} GROUP BY 1, 2`,
        q3.params,
      );
      const cash = r2(money.reduce((a: number, r: any) => a + kgs(r.amount, r.currency), 0));
      const recv = r2(debts.filter((d: any) => d.direction === 'receivable').reduce((a: number, r: any) => a + kgs(r.amount, r.currency), 0));
      const pay = r2(debts.filter((d: any) => d.direction === 'payable').reduce((a: number, r: any) => a + kgs(r.amount, r.currency), 0));
      const rows = [
        { line: 'Деньги (все счета)', amount: cash },
        { line: 'Товар по себестоимости', amount: r2(num(stock.cost)) },
        { line: 'Нам должны', amount: recv },
        { line: 'Мы должны (поставщикам, соседям, авансы клиентов)', amount: -pay },
        { line: 'Капитал бизнеса', amount: r2(cash + num(stock.cost) + recv - pay), bold: true },
      ];
      return { columns: [C('line', 'Статья'), C('amount', 'Сумма, сом', 'money')], rows, note: 'Валюта — по текущему курсу магазина' };
    },
  },
  {
    code: 'money.who_has',
    group: 'money',
    title: 'У кого сколько денег',
    permission: 'reports.money',
    filters: ['storeId'],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const rates = c.settings.rates ?? {};
      const TYPES: Record<string, string> = { cash: 'Касса', safe: 'Сейф', bank: 'Банк', wallet: 'Кошелёк', acquiring: 'Эквайринг', accountable: 'Подотчёт' };
      const rows = await c.tx.query(
        `SELECT a.id AS key, a.type, a.name, a.currency, u.name AS holder, st.name AS store,
                coalesce(sum(m.amount), 0) AS balance, coalesce(sum(m.amount) FILTER (WHERE m.verify_status = 'unverified'), 0) AS unverified
           FROM money_accounts a LEFT JOIN money_movements m ON m.account_id = a.id
           LEFT JOIN registers rg ON rg.id = a.register_id LEFT JOIN stores st ON st.id = coalesce(a.store_id, rg.store_id)
           LEFT JOIN memberships hm ON hm.id = a.holder_membership_id LEFT JOIN users u ON u.id = hm.user_id
          WHERE a.tenant_id = $1 AND a.deleted_at IS NULL${storeFilter(q, c, 'coalesce(a.store_id, rg.store_id)')}
          GROUP BY a.id, a.type, a.name, a.currency, u.name, st.name HAVING a.is_active OR coalesce(sum(m.amount), 0) <> 0
          ORDER BY array_position(ARRAY['cash','safe','wallet','accountable','acquiring','bank'], a.type::text), a.name`,
        q.params,
      );
      for (const r of rows) {
        r.typeLabel = TYPES[r.type] ?? r.type;
        r.balance = num(r.balance);
        r.unverified = num(r.unverified);
        r.balanceKgs = r2(r.balance * (r.currency === 'KGS' ? 1 : num(rates[r.currency])));
      }
      const cols = [C('typeLabel', 'Где'), C('name', 'Счёт'), C('holder', 'У кого'), C('store', 'Точка'), C('currency', 'Валюта'), C('balance', 'Остаток', 'money'), C('unverified', 'Из них не сверено', 'money'), C('balanceKgs', 'В сомах', 'money')];
      return { columns: cols, rows, totals: { balanceKgs: r2(rows.reduce((a: number, r: any) => a + r.balanceKgs, 0)) } };
    },
  },
  {
    code: 'money.unverified',
    group: 'money',
    title: 'Несверенные переводы',
    permission: 'money.verify_transfers',
    filters: [...PERIOD, 'groupBy'],
    groupBy: [{ value: 'day', label: 'День' }, { value: 'seller', label: 'Продавец' }, { value: 'account', label: 'Кошелёк' }],
    async run(c) {
      const q = new Sql(c.tx.tenantId);
      const g = c.f.groupBy ?? 'day';
      const name = g === 'seller' ? `coalesce(u.name, '—')` : g === 'account' ? 'a.name' : `to_char(${localDay('m.moved_at')}, 'YYYY-MM-DD')`;
      const rows = await c.tx.query(
        `SELECT ${name} AS name, count(*)::int AS transfers, sum(m.amount) AS amount, min(m.moved_at) AS oldest
           FROM money_movements m JOIN money_accounts a ON a.id = m.account_id
           LEFT JOIN memberships mm ON mm.id = m.membership_id LEFT JOIN users u ON u.id = mm.user_id
          WHERE m.tenant_id = $1 AND m.verify_status = 'unverified' AND m.moved_at >= ${dayStart(q, c.f.from)} AND m.moved_at < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'a.store_id')}
          GROUP BY 1 ORDER BY ${g === 'day' ? '1 DESC' : 'amount DESC'}`,
        q.params,
      );
      for (const r of rows) r.amount = num(r.amount);
      const cols = [C('name', g === 'seller' ? 'Продавец' : g === 'account' ? 'Кошелёк' : 'День'), C('transfers', 'Переводов', 'int'), C('amount', 'Сумма', 'money'), C('oldest', 'Самый ранний', 'datetime')];
      return { columns: cols, rows, totals: sumTotals(rows, cols) };
    },
  },
  {
    code: 'money.fx',
    group: 'money',
    title: 'Курсовые разницы',
    permission: 'reports.money',
    filters: ['from', 'to'],
    async run(c) {
      const fx = await fxDiffs(c);
      const cols = [C('month', 'Месяц'), C('source', 'Откуда'), C('currency', 'Валюта'), C('amount', 'Разница, сом', 'money')];
      return { columns: cols, rows: fx.rows, totals: { amount: fx.total }, note: 'Обмен валюты в кассе — разница фактического курса с курсом магазина; переоценка валютных долгов — по курсу НБКР на конец месяца' };
    },
  },
];

/** Курсовые разницы: обмен в кассе (факт против курса магазина) + переоценка долгов. */
async function fxDiffs(c: ReportCtx) {
  const q = new Sql(c.tx.tenantId);
  const ex = await c.tx.query(
    `SELECT to_char(${localDay('o.created_at')}, 'YYYY-MM') AS month, CASE WHEN fa.currency = 'KGS' THEN ta.currency ELSE fa.currency END AS currency,
            sum(CASE WHEN fa.currency <> 'KGS' THEN o.to_amount - o.amount * o.shop_rate ELSE o.to_amount * o.shop_rate - o.amount END) AS amount
       FROM money_operations o JOIN money_accounts fa ON fa.id = o.from_account_id JOIN money_accounts ta ON ta.id = o.to_account_id
      WHERE o.tenant_id = $1 AND o.type = 'exchange' AND o.shop_rate IS NOT NULL AND o.created_at >= ${dayStart(q, c.f.from)} AND o.created_at < ${dayEnd(q, c.f.to)}${storeFilter(q, c, 'o.store_id')}
      GROUP BY 1, 2`,
    q.params,
  );
  const q2 = new Sql(c.tx.tenantId);
  const rv = await c.tx.query(
    `SELECT month, currency, sum(diff_kgs) AS amount FROM fx_revaluations
      WHERE tenant_id = $1 AND month >= ${q2.p(c.f.from.slice(0, 7))} AND month <= ${q2.p(c.f.to.slice(0, 7))} GROUP BY 1, 2`,
    q2.params,
  );
  const rows = [
    ...ex.map((r: any) => ({ month: r.month, source: 'Обмен в кассе', currency: r.currency, amount: r2(num(r.amount)) })),
    ...rv.map((r: any) => ({ month: r.month, source: 'Переоценка долгов', currency: r.currency, amount: r2(num(r.amount)) })),
  ].sort((a, b) => a.month.localeCompare(b.month));
  return { rows, total: r2(rows.reduce((a, r) => a + r.amount, 0)) };
}

export const REPORT_GROUPS: Record<ReportDef['group'], string> = {
  sales: 'Продажи',
  profit: 'Прибыль',
  stock: 'Склад',
  parts: 'Автозапчасти',
  purchases: 'Закупки',
  customers: 'Клиенты',
  staff: 'Сотрудники',
  money: 'Деньги',
};

/** Отчёты, которые уже есть отдельными страницами (ТЗ 20.2) — в каталоге со ссылкой. */
export const EXTERNAL_REPORTS = [
  { code: 'parts.unfound', group: 'parts', title: 'Что спрашивают, но нет', path: '/search/unfound', permission: 'reports.sales' },
  { code: 'sales.stale_price', group: 'sales', title: 'Продажи по устаревшей цене', path: '/pos/reports/stale-prices', permission: 'reports.sales' },
  { code: 'sales.offline', group: 'sales', title: 'Офлайн-чеки с пометками', path: '/pos/reports/offline', permission: 'reports.sales' },
];
