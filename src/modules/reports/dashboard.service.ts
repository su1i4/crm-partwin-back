import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { dayjs, DEFAULT_TZ, localDateString } from '../../common/utils/dates';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { ScopeService } from '../auth/scope.service';
import { PriceResolverService } from '../pricing/price-resolver.service';
import { SettingsService } from '../settings/settings.service';
import { num, r2 } from './report-kit';

const TZ = DEFAULT_TZ;
const dayStartSql = (p: string) => `(${p}::date::timestamp AT TIME ZONE '${TZ}')`;
const dayEndSql = (p: string) => `((${p}::date + 1)::timestamp AT TIME ZONE '${TZ}')`;

export interface DayTiles {
  revenue: number;
  profit: number | null;
  receipts: number;
  avg: number;
}

/**
 * Дашборд (ТЗ 20.1): плитки «сегодня / вчера / тот же день прошлой недели», график, «Требует внимания»,
 * топ товаров дня, продажи по точкам, быстрые действия. Набор блоков — по правам.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
    private readonly resolver: PriceResolverService,
  ) {}

  /** Итоги дня по проведённым чекам (живые данные, не отчётная таблица). */
  async dayTiles(tx: TenantTx, day: string, stores: string[] | null, storeId?: string, withProfit = this.ctx.can('products.view_cost')): Promise<DayTiles> {
    const [r] = await tx.query(
      `SELECT coalesce(sum(CASE WHEN d.type = 'sale' THEN l.amount ELSE -l.amount END), 0) AS revenue,
              coalesce(sum(CASE WHEN d.type = 'sale' THEN l.amount - l.cost_amount ELSE l.cost_amount - l.amount END), 0) AS profit,
              count(DISTINCT d.id) FILTER (WHERE d.type = 'sale')::int AS receipts
         FROM documents d JOIN document_lines l ON l.document_id = d.id
        WHERE d.tenant_id = $1 AND d.type IN ('sale', 'sale_return') AND d.status = 'posted' AND d.deleted_at IS NULL
          AND d.doc_date >= ${dayStartSql('$2')} AND d.doc_date < ${dayEndSql('$2')}
          AND ($3::uuid[] IS NULL OR d.store_id = ANY($3)) AND ($4::uuid IS NULL OR d.store_id = $4)`,
      [tx.tenantId, day, stores, storeId ?? null],
    );
    const revenue = r2(num(r.revenue));
    return { revenue, profit: withProfit ? r2(num(r.profit)) : null, receipts: r.receipts, avg: r.receipts ? r2(revenue / r.receipts) : 0 };
  }

  async attention(tx: TenantTx, stores: string[] | null) {
    const s = await this.settings.get(tx);
    const p = [tx.tenantId, stores];
    const one = async (sql: string, params: unknown[] = p) => (await tx.query(sql, params))[0];
    const [belowMin, debts, transfers, requests, hanging, stuck, shifts, offline] = await Promise.all([
      one(
        `SELECT count(*)::int AS n FROM stock_rules r
          WHERE r.tenant_id = $1 AND r.deleted_at IS NULL AND r.min_qty > 0 AND ($2::uuid[] IS NULL OR r.store_id IS NULL OR r.store_id = ANY($2))
            AND coalesce((SELECT sum(b.qty) FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
                           WHERE b.tenant_id = r.tenant_id AND b.product_id = r.product_id AND (r.store_id IS NULL OR w.store_id = r.store_id)), 0) < r.min_qty`,
      ),
      one(
        `SELECT count(*)::int AS n, coalesce(sum(remaining), 0) AS amount FROM debt_items
          WHERE tenant_id = $1 AND direction = 'receivable' AND remaining > 0 AND due_date < current_date AND ($2::uuid[] IS NULL OR store_id IS NULL OR store_id = ANY($2))`,
      ),
      one(
        `SELECT count(*)::int AS n, coalesce(sum(m.amount), 0) AS amount FROM money_movements m JOIN money_accounts a ON a.id = m.account_id
          WHERE m.tenant_id = $1 AND m.verify_status = 'unverified' AND ($2::uuid[] IS NULL OR a.store_id IS NULL OR a.store_id = ANY($2))`,
      ),
      one(`SELECT count(*)::int AS n FROM customer_requests WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'new' AND ($2::uuid[] IS NULL OR store_id = ANY($2))`),
      one(
        `SELECT count(*)::int AS n FROM customer_requests WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'selecting'
            AND created_at < now() - interval '1 day' AND ($2::uuid[] IS NULL OR store_id = ANY($2))`,
      ),
      one(
        `SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1 AND type = 'transfer' AND status = 'posted' AND extra->>'transferState' = 'in_transit'
            AND doc_date < now() - ($3 || ' days')::interval AND ($2::uuid[] IS NULL OR store_id = ANY($2))`,
        [...p, String(s.transferStaleDays ?? 2)],
      ),
      one(
        `SELECT count(*)::int AS n FROM shifts WHERE tenant_id = $1 AND status = 'open' AND opened_at < ${dayStartSql('$3')} AND ($2::uuid[] IS NULL OR store_id = ANY($2))`,
        [...p, localDateString(new Date())],
      ),
      one(
        `SELECT count(*)::int AS n FROM devices WHERE tenant_id = $1 AND kind = 'pos' AND revoked_at IS NULL AND last_seen_at IS NOT NULL
            AND (last_sync_at IS NULL OR last_seen_at > last_sync_at + interval '30 minutes') AND ($2::uuid[] IS NULL OR store_id = ANY($2))`,
      ),
    ]);
    const items = [
      { key: 'below_min', title: 'Товары ниже минимума', count: belowMin.n, link: '/purchasing/auto-order' },
      { key: 'overdue_debts', title: 'Просроченные долги клиентов', count: debts.n, amount: r2(num(debts.amount)), link: '/reports/customers.debts_aging' },
      { key: 'unverified_transfers', title: 'Несверенные переводы', count: transfers.n, amount: r2(num(transfers.amount)), link: '/money/transfers', permission: 'money.verify_transfers' },
      { key: 'requests_new', title: 'Заявки без ответа', count: requests.n, link: '/requests?status=new', permission: 'requests.read' },
      { key: 'hanging_selection', title: 'Висит на подборе', count: hanging.n, link: '/reports/customers.hanging', permission: 'requests.read' },
      { key: 'stuck_transfers', title: 'Зависшие перемещения', count: stuck.n, link: '/documents?inTransit=true', permission: 'stock.transfer' },
      { key: 'open_shifts', title: 'Незакрытые смены', count: shifts.n, link: '/shifts?status=open', permission: 'pos.shift' },
      { key: 'offline_unsent', title: 'Кассы с неотправленными чеками', count: offline.n, link: '/pos-devices', permission: 'devices.manage' },
    ];
    return items.filter((i) => i.count > 0 && (!i.permission || this.ctx.can(i.permission as any))).map(({ permission: _p, ...i }) => i);
  }

  get(q: { period?: 'today' | 'week' | 'month'; storeId?: string }) {
    if (q.storeId) this.scope.assertStore(q.storeId);
    return this.tenantTx.run(async (tx) => {
      const stores = this.scope.storeIds();
      const today = localDateString(new Date());
      const can = (p: string) => this.ctx.can(p as any);
      const owner = can('dashboard.owner');
      const sales = owner || can('reports.sales');
      const out: Record<string, unknown> = { today, role: owner ? 'owner' : sales ? 'manager' : can('stock.receive') ? 'storekeeper' : 'seller' };

      if (sales) {
        const [t, y, w] = await Promise.all([
          this.dayTiles(tx, today, stores, q.storeId),
          this.dayTiles(tx, dayjs(today).subtract(1, 'day').format('YYYY-MM-DD'), stores, q.storeId),
          this.dayTiles(tx, dayjs(today).subtract(7, 'day').format('YYYY-MM-DD'), stores, q.storeId),
        ]);
        const delta = (a: number | null, b: number | null) => (a === null || b === null || !b ? null : r2(((a - b) / Math.abs(b)) * 100));
        out.tiles = (['revenue', 'profit', 'receipts', 'avg'] as const)
          .filter((k) => t[k] !== null)
          .map((k) => ({ key: k, today: t[k], yesterday: y[k], weekAgo: w[k], vsYesterday: delta(t[k], y[k]), vsWeekAgo: delta(t[k], w[k]) }));

        const period = q.period ?? 'today';
        if (period === 'today') {
          out.chart = await tx.query(
            `SELECT extract(hour FROM d.doc_date AT TIME ZONE '${TZ}')::int AS x, sum(CASE WHEN d.type = 'sale' THEN l.amount ELSE -l.amount END) AS revenue
               FROM documents d JOIN document_lines l ON l.document_id = d.id
              WHERE d.tenant_id = $1 AND d.type IN ('sale', 'sale_return') AND d.status = 'posted' AND d.deleted_at IS NULL
                AND d.doc_date >= ${dayStartSql('$2')} AND ($3::uuid[] IS NULL OR d.store_id = ANY($3)) AND ($4::uuid IS NULL OR d.store_id = $4)
              GROUP BY 1 ORDER BY 1`,
            [tx.tenantId, today, stores, q.storeId ?? null],
          );
        } else {
          const from = dayjs(today).subtract(period === 'week' ? 6 : 29, 'day').format('YYYY-MM-DD');
          out.chart = await tx.query(
            `SELECT to_char(g.day, 'YYYY-MM-DD') AS x, coalesce(sum(s.revenue), 0) AS revenue
               FROM generate_series($2::date, $3::date, interval '1 day') g(day)
               LEFT JOIN rpt_sales_daily s ON s.tenant_id = $1 AND s.day = g.day::date AND ($4::uuid[] IS NULL OR s.store_id = ANY($4)) AND ($5::uuid IS NULL OR s.store_id = $5)
              GROUP BY 1 ORDER BY 1`,
            [tx.tenantId, from, today, stores, q.storeId ?? null],
          );
        }
        for (const c of out.chart as any[]) c.revenue = r2(num(c.revenue));
        out.topProducts = (
          await tx.query(
            `SELECT p.id, p.name, sum(l.base_qty) AS qty, sum(l.amount) AS revenue
               FROM documents d JOIN document_lines l ON l.document_id = d.id JOIN products p ON p.id = l.product_id
              WHERE d.tenant_id = $1 AND d.type = 'sale' AND d.status = 'posted' AND d.deleted_at IS NULL AND p.status <> 'system'
                AND d.doc_date >= ${dayStartSql('$2')} AND ($3::uuid[] IS NULL OR d.store_id = ANY($3))
              GROUP BY p.id, p.name ORDER BY revenue DESC LIMIT 10`,
            [tx.tenantId, today, stores],
          )
        ).map((r: any) => ({ ...r, qty: num(r.qty), revenue: num(r.revenue) }));
        out.byStore = (
          await tx.query(
            `SELECT st.id, st.name, coalesce(sum(CASE WHEN d.type = 'sale' THEN l.amount ELSE -l.amount END), 0) AS revenue, count(DISTINCT d.id) FILTER (WHERE d.type = 'sale')::int AS receipts
               FROM stores st LEFT JOIN documents d ON d.store_id = st.id AND d.tenant_id = st.tenant_id AND d.type IN ('sale', 'sale_return') AND d.status = 'posted'
                    AND d.deleted_at IS NULL AND d.doc_date >= ${dayStartSql('$2')}
               LEFT JOIN document_lines l ON l.document_id = d.id
              WHERE st.tenant_id = $1 AND st.deleted_at IS NULL AND ($3::uuid[] IS NULL OR st.id = ANY($3))
              GROUP BY st.id, st.name ORDER BY revenue DESC`,
            [tx.tenantId, today, stores],
          )
        ).map((r: any) => ({ ...r, revenue: num(r.revenue) }));
      }

      out.attention = await this.attention(tx, stores);

      // Продавец: своя смена и свои заявки
      if (can('pos.use')) {
        const [shift] = await tx.query(
          `SELECT s.id, s.number, s.opened_at AS "openedAt", rg.name AS register,
                  (SELECT count(*)::int FROM receipts r WHERE r.shift_id = s.id AND r.kind = 'sale' AND r.status = 'completed') AS receipts,
                  (SELECT coalesce(sum(r.total), 0) FROM receipts r WHERE r.shift_id = s.id AND r.kind = 'sale' AND r.status = 'completed') AS revenue
             FROM shifts s JOIN registers rg ON rg.id = s.register_id
            WHERE s.tenant_id = $1 AND s.status = 'open' AND s.current_membership_id = $2 LIMIT 1`,
          [tx.tenantId, this.ctx.membershipId],
        );
        out.myShift = shift ? { ...shift, revenue: num(shift.revenue) } : null;
      }
      if (can('requests.read')) {
        out.myRequests = await tx.query(
          `SELECT id, number, status, coalesce(customer_name, '') AS customer, vehicle_text AS vehicle, due_at AS "dueAt" FROM customer_requests
            WHERE tenant_id = $1 AND deleted_at IS NULL AND assignee_id = $2 AND status NOT IN ('issued', 'refused') ORDER BY coalesce(due_at, created_at) LIMIT 20`,
          [tx.tenantId, this.ctx.membershipId],
        );
      }
      // Кладовщик: приёмки и задания
      if (can('stock.receive') || can('stock.inventory')) {
        const [w] = await tx.query(
          `SELECT count(*) FILTER (WHERE type = 'receiving' AND status = 'draft')::int AS "draftReceivings",
                  count(*) FILTER (WHERE type = 'transfer' AND status = 'posted' AND extra->>'transferState' = 'in_transit')::int AS "incomingTransfers"
             FROM documents WHERE tenant_id = $1 AND deleted_at IS NULL AND ($2::uuid[] IS NULL OR store_id = ANY($2))`,
          [tx.tenantId, stores],
        );
        const [inv] = await tx.query(`SELECT count(*)::int AS n FROM inventory_sheets WHERE tenant_id = $1 AND status <> 'done' AND (assigned_to IS NULL OR assigned_to = $2)`, [tx.tenantId, this.ctx.membershipId]);
        out.warehouse = { ...w, inventorySheets: inv.n };
      }
      // Владелец: деньги
      if (owner || can('reports.money')) {
        const rates = await this.resolver.rates(tx);
        const rows = await tx.query(
          `SELECT a.type, a.currency, coalesce(sum(m.amount), 0) AS amount FROM money_accounts a LEFT JOIN money_movements m ON m.account_id = a.id
            WHERE a.tenant_id = $1 AND a.deleted_at IS NULL AND ($2::uuid[] IS NULL OR a.store_id IS NULL OR a.store_id = ANY($2)) GROUP BY a.type, a.currency`,
          [tx.tenantId, stores],
        );
        const byType: Record<string, number> = {};
        for (const r of rows) byType[r.type] = r2((byType[r.type] ?? 0) + num(r.amount) * (r.currency === 'KGS' ? 1 : num((rates as any)[r.currency])));
        out.money = { byType, totalKgs: r2(Object.values(byType).reduce((a, x) => a + x, 0)) };
      }
      out.quickActions = [
        ...(can('pos.use') ? [{ key: 'sale', title: 'Продажа', link: '/pos' }] : []),
        ...(can('stock.receive') ? [{ key: 'receiving', title: 'Приёмка', link: '/documents/new?type=receiving' }] : []),
        ...(can('requests.write') ? [{ key: 'request', title: 'Заявка', link: '/requests/new' }] : []),
        ...(can('products.write') ? [{ key: 'product', title: 'Новый товар', link: '/products/new' }] : []),
      ];
      return out;
    });
  }
}
