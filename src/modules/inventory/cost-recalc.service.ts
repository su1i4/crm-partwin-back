import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { D, Decimal, unitCost } from '../../common/utils/decimal';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { PeriodsService } from './periods.service';
import { StockLedgerService } from './stock-ledger.service';

const QUEUE = 'cost.recalc';

/**
 * Пересчёт себестоимости после проведения задним числом (ТЗ 7.3).
 * Для товара: состояние до даты Д + повтор всех движений после Д по порядку; расходы — по средней,
 * парные приходы (перемещение, пересортица) — по своему расходу. Закрытый период не трогается никогда.
 */
@Injectable()
export class CostRecalcService implements OnModuleInit {
  private readonly logger = new Logger(CostRecalcService.name);

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly jobs: JobsService,
    private readonly registry: OutboxRegistry,
    private readonly periods: PeriodsService,
    private readonly ledger: StockLedgerService,
  ) {}

  async onModuleInit() {
    this.registry.on('cost.recalc_requested', async (e) => {
      await this.jobs.send(QUEUE, { tenantId: e.tenantId }, { singletonKey: `recalc:${e.tenantId}`, retryLimit: 3, retryDelay: 5 });
    });
    await this.jobs.work<{ tenantId: string }>(
      QUEUE,
      async (d) => {
        await this.processTenant(d.tenantId);
      },
      { batchSize: 1 },
    );
  }

  /** Обработать очередь магазина. Возвращает число пересчитанных товаров. */
  async processTenant(tenantId: string): Promise<number> {
    let done = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      const next = await this.tenantTx.run(
        (tx) => tx.query(`SELECT product_id, from_date FROM cost_recalc_queue WHERE tenant_id = $1 ORDER BY from_date LIMIT 1`, [tenantId]),
        { tenantId, userId: null },
      );
      if (!next.length) break;
      const { product_id, from_date } = next[0];
      try {
        await this.tenantTx.run((tx) => this.recalcProduct(tx, product_id, new Date(from_date)), { tenantId, userId: null });
        done++;
      } catch (e) {
        this.logger.error(`Пересчёт ${product_id}: ${(e as Error).message}`);
        await this.tenantTx.run(
          (tx) =>
            tx.query(
              `UPDATE cost_recalc_queue SET attempts = attempts + 1, last_error = $3 WHERE tenant_id = $1 AND product_id = $2`,
              [tenantId, product_id, (e as Error).message.slice(0, 1000)],
            ),
          { tenantId, userId: null },
        );
        const [{ attempts }] = await this.tenantTx.run(
          (tx) => tx.query(`SELECT attempts FROM cost_recalc_queue WHERE tenant_id = $1 AND product_id = $2`, [tenantId, product_id]),
          { tenantId, userId: null },
        );
        if (attempts >= 5) break;
      }
    }
    return done;
  }

  async recalcProduct(tx: TenantTx, productId: string, requestedFrom: Date) {
    const t = tx.tenantId;
    // Блокируем товар — проведения по нему подождут
    await tx.query(`SELECT 1 FROM product_costs WHERE tenant_id = $1 AND product_id = $2 FOR UPDATE`, [t, productId]);
    const [q] = await tx.query(`SELECT from_date FROM cost_recalc_queue WHERE tenant_id = $1 AND product_id = $2 FOR UPDATE`, [t, productId]);
    const closed = await this.periods.closedUntil(tx);
    let from = q ? new Date(q.from_date) : requestedFrom;
    if (closed && from < closed) from = closed;

    const [start] = await tx.query(
      `SELECT coalesce(sum(qty), 0) AS qty, coalesce(sum(cost_amount), 0) AS amount FROM stock_movements
        WHERE tenant_id = $1 AND product_id = $2 AND moved_at < $3`,
      [t, productId, from],
    );
    let qty = D(start.qty);
    let amount = D(start.amount);
    let last = qty.gt(0) ? unitCost(amount.div(qty)) : D(0);
    if (last.isZero()) {
      const [lc] = await tx.query(
        `SELECT cost_amount, qty FROM stock_movements WHERE tenant_id = $1 AND product_id = $2 AND moved_at < $3 AND kind IN ('in','in_fixed') AND qty > 0
          ORDER BY moved_at DESC, seq DESC LIMIT 1`,
        [t, productId, from],
      );
      if (lc) last = unitCost(D(lc.cost_amount).div(lc.qty));
    }

    const moves = await tx.query(
      `SELECT m.id, m.kind, m.qty, m.cost_amount, m.pair_of_id, m.moved_at, m.document_id, m.line_id, m.warehouse_id,
              p.product_id AS pair_product, p.cost_amount AS pair_amount
         FROM stock_movements m LEFT JOIN stock_movements p ON p.id = m.pair_of_id
        WHERE m.tenant_id = $1 AND m.product_id = $2 AND m.moved_at >= $3
        ORDER BY m.moved_at, m.seq`,
      [t, productId, from],
    );
    const newAmount = new Map<string, Decimal>();
    const changed: { id: string; amount: Decimal }[] = [];
    for (const m of moves) {
      const mq = D(m.qty);
      let a: Decimal;
      if (m.kind === 'in') {
        a = D(m.cost_amount);
        if (mq.gt(0)) last = unitCost(a.div(mq));
      } else if (m.kind === 'out' || m.kind === 'transfer_out') {
        const avg = qty.gt(0) ? amount.div(qty) : last;
        a = mq.mul(avg);
      } else if (m.kind === 'in_fixed' || m.kind === 'transfer_in') {
        if (m.pair_of_id && newAmount.has(m.pair_of_id)) a = newAmount.get(m.pair_of_id)!.neg();
        else if (m.pair_of_id) a = D(m.pair_amount).neg();
        else a = D(m.cost_amount);
        if (m.kind === 'in_fixed' && mq.gt(0) && a.gt(0)) last = unitCost(a.div(mq));
      } else {
        a = D(m.cost_amount); // корректировки сохраняются как есть
      }
      newAmount.set(m.id, a);
      qty = qty.plus(mq);
      amount = amount.plus(a);
      if (qty.isZero()) amount = D(0);
      if (!a.eq(D(m.cost_amount))) changed.push({ id: m.id, amount: a });
    }

    if (changed.length) {
      await tx.query(
        `UPDATE stock_movements m SET cost_amount = x.amount FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, amount numeric)
          WHERE m.tenant_id = $1 AND m.id = x.id`,
        [t, JSON.stringify(changed.map((c) => ({ id: c.id, amount: c.amount.toFixed() })))],
      );
      // Строки документов: себестоимость строки = сумма её движений этого товара
      await tx.query(
        `UPDATE document_lines l SET cost_amount = abs(s.amount),
                unit_cost = CASE WHEN s.qty <> 0 THEN abs(s.amount / s.qty) ELSE l.unit_cost END
           FROM (SELECT line_id, sum(cost_amount) AS amount, sum(qty) AS qty FROM stock_movements
                  WHERE tenant_id = $1 AND product_id = $2 AND kind IN ('out', 'in_fixed') AND moved_at >= $3 GROUP BY line_id) s
          WHERE l.tenant_id = $1 AND l.id = s.line_id`,
        [t, productId, from],
      );
      // Зависимые приходы других товаров (пересортица A → B)
      const deps = await tx.query(
        `SELECT DISTINCT d.product_id, min(d.moved_at) AS from_date FROM stock_movements d
          WHERE d.tenant_id = $1 AND d.pair_of_id = ANY($2::uuid[]) AND d.product_id <> $3 GROUP BY d.product_id`,
        [t, changed.map((c) => c.id), productId],
      );
      for (const d of deps) {
        await tx.query(
          `UPDATE stock_movements d SET cost_amount = -m.cost_amount FROM stock_movements m
            WHERE d.tenant_id = $1 AND d.product_id = $2 AND m.id = d.pair_of_id AND m.id = ANY($3::uuid[])`,
          [t, d.product_id, changed.map((c) => c.id)],
        );
        await this.ledger.enqueue(tx, [d.product_id], new Date(d.from_date));
      }
    }

    // Остатки по складам и итог по товару = сумма движений
    await tx.query(
      `UPDATE stock_balances b SET cost_amount = CASE WHEN b.qty = 0 THEN 0 ELSE coalesce(s.amount, 0) END, updated_at = now()
         FROM (SELECT warehouse_id, sum(cost_amount) AS amount FROM stock_movements WHERE tenant_id = $1 AND product_id = $2 GROUP BY warehouse_id) s
        WHERE b.tenant_id = $1 AND b.product_id = $2 AND b.warehouse_id = s.warehouse_id AND b.location_id IS NULL`,
      [t, productId],
    );
    const [tot] = await tx.query(
      `SELECT coalesce(sum(qty), 0) AS qty, coalesce(sum(cost_amount), 0) AS amount FROM stock_movements WHERE tenant_id = $1 AND product_id = $2`,
      [t, productId],
    );
    const finalQty = D(tot.qty);
    const finalAmount = finalQty.isZero() ? D(0) : D(tot.amount);
    const finalLast = finalQty.gt(0) ? unitCost(finalAmount.div(finalQty)) : last;
    await tx.query(
      `UPDATE product_costs SET qty = $3, cost_amount = $4, last_unit_cost = $5, updated_at = now() WHERE tenant_id = $1 AND product_id = $2`,
      [t, productId, finalQty.toFixed(), finalAmount.toFixed(), finalLast.toFixed()],
    );
    await tx.query(`DELETE FROM cost_recalc_queue WHERE tenant_id = $1 AND product_id = $2`, [t, productId]);
    return { changed: changed.length };
  }

  /** Идёт ли пересчёт по товарам (отчёты по прибыли помечаются «идёт пересчёт»). */
  async pending(tx: TenantTx): Promise<{ count: number; fromDate: Date | null }> {
    const [r] = await tx.query(`SELECT count(*)::int AS n, min(from_date) AS d FROM cost_recalc_queue WHERE tenant_id = $1`, [tx.tenantId]);
    return { count: r.n, fromDate: r.d };
  }
}
