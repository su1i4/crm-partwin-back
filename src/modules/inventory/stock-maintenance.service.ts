import { Injectable, Logger, OnModuleInit } from '@nestjs/common';


import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Tenant } from '../tenants/entities/tenant.entity';

/**
 * Ночная сверка: кэш остатков = сумма движений (ТЗ 7.7). Расхождение — запись в журнал, уведомление и кнопка «Пересчитать».
 * Работает для всех магазинов по расписанию в 03:15 по Бишкеку.
 */
@Injectable()
export class StockMaintenanceService implements OnModuleInit {
  private readonly logger = new Logger(StockMaintenanceService.name);

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly platform: PlatformDb,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit() {
    await this.jobs.work('stock.reconcile_all', async () => {
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) {
        try {
          await this.reconcile(t.id, true);
        } catch (e) {
          this.logger.error(`Сверка ${t.id}: ${(e as Error).message}`);
        }
      }
    });
    await this.jobs.schedule('stock.reconcile_all', '15 3 * * *');
  }

  async mismatches(tx: TenantTx) {
    return tx.query(
      `WITH m AS (SELECT warehouse_id, product_id, sum(qty) AS qty, sum(cost_amount) AS amount FROM stock_movements WHERE tenant_id = $1 GROUP BY 1, 2),
            b AS (SELECT warehouse_id, product_id, sum(qty) AS qty, sum(cost_amount) AS amount FROM stock_balances WHERE tenant_id = $1 GROUP BY 1, 2)
       SELECT coalesce(m.warehouse_id, b.warehouse_id) AS "warehouseId", coalesce(m.product_id, b.product_id) AS "productId",
              coalesce(m.qty, 0) AS "movementsQty", coalesce(b.qty, 0) AS "balanceQty",
              coalesce(m.amount, 0) AS "movementsAmount", coalesce(b.amount, 0) AS "balanceAmount"
         FROM m FULL JOIN b ON b.warehouse_id = m.warehouse_id AND b.product_id = m.product_id
        WHERE coalesce(m.qty, 0) <> coalesce(b.qty, 0)
           OR (coalesce(b.qty, 0) <> 0 AND abs(coalesce(m.amount, 0) - coalesce(b.amount, 0)) > 0.01)
        LIMIT 500`,
      [tx.tenantId],
    );
  }

  async reconcile(tenantId: string | undefined, notify = false) {
    return this.tenantTx.run(
      async (tx) => {
        const rows = await this.mismatches(tx);
        if (rows.length && notify) {
          this.logger.warn(`Расхождение остатков в магазине ${tx.tenantId}: ${rows.length} позиций`);
          await this.audit.log(tx, { action: 'stock.reconcile_mismatch', summary: `Расхождение кэша остатков: ${rows.length} позиций`, after: { rows: rows.slice(0, 50) }, important: true });
          await this.notifications.notify(tx, {
            type: 'stock.reconcile_mismatch',
            title: `Ночная сверка: расхождение остатков в ${rows.length} позициях. Нажмите «Пересчитать остатки»`,
            ownersOnly: true,
            link: '/stock/reconcile',
          });
        }
        return { ok: rows.length === 0, mismatches: rows };
      },
      tenantId ? { tenantId, userId: null } : {},
    );
  }

  /** «Пересчитать остатки»: кэш остатков и итог себестоимости собираются заново из движений. */
  async rebuild() {
    return this.tenantTx.run(async (tx) => {
      const before = await this.mismatches(tx);
      const t = tx.tenantId;
      await tx.query(`LOCK TABLE stock_balances IN SHARE ROW EXCLUSIVE MODE`);
      await tx.query(
        `UPDATE stock_balances b SET qty = coalesce(s.qty, 0), cost_amount = CASE WHEN coalesce(s.qty, 0) = 0 THEN 0 ELSE coalesce(s.amount, 0) END
           FROM stock_balances b2 LEFT JOIN (SELECT warehouse_id, product_id, sum(qty) AS qty, sum(cost_amount) AS amount
                                               FROM stock_movements WHERE tenant_id = $1 GROUP BY 1, 2) s
             ON s.warehouse_id = b2.warehouse_id AND s.product_id = b2.product_id
          WHERE b.id = b2.id AND b.tenant_id = $1 AND b.location_id IS NULL`,
        [t],
      );
      await tx.query(
        `INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, qty, cost_amount)
         SELECT $1, warehouse_id, product_id, sum(qty), sum(cost_amount) FROM stock_movements WHERE tenant_id = $1 GROUP BY 2, 3
         ON CONFLICT (tenant_id, warehouse_id, product_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO NOTHING`,
        [t],
      );
      await tx.query(
        `UPDATE product_costs c SET qty = coalesce(s.qty, 0), cost_amount = CASE WHEN coalesce(s.qty, 0) = 0 THEN 0 ELSE coalesce(s.amount, 0) END
           FROM product_costs c2 LEFT JOIN (SELECT product_id, sum(qty) AS qty, sum(cost_amount) AS amount FROM stock_movements WHERE tenant_id = $1 GROUP BY 1) s
             ON s.product_id = c2.product_id
          WHERE c.id = c2.id AND c.tenant_id = $1`,
        [t],
      );
      await this.audit.log(tx, { action: 'stock.rebuild', summary: `Пересчитаны остатки (было расхождений: ${before.length})`, important: true });
      return { fixed: before.length };
    });
  }
}

