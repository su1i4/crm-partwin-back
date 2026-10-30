import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { dayjs, DEFAULT_TZ, localDateString } from '../../common/utils/dates';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { Tenant } from '../tenants/entities/tenant.entity';

/**
 * Отчётная таблица продаж (ТЗ 20): пересчёт дня — по событию проведения/отмены чека и возврата,
 * ночью — последние 35 дней (себестоимость могла уточниться пересчётом задним числом).
 */
@Injectable()
export class RptSalesService implements OnModuleInit {
  private readonly log = new Logger('Reports');

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly registry: OutboxRegistry,
    private readonly jobs: JobsService,
    private readonly platform: PlatformDb,
  ) {}

  async onModuleInit() {
    const onDoc = async (e: any) => {
      if (!['sale', 'sale_return'].includes(e.payload.type)) return;
      await this.tenantTx.run(
        async (tx) => {
          const [d] = await tx.query(`SELECT doc_date FROM documents WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, e.payload.id]);
          const days = new Set<string>(e.payload.oldDate ? [localDateString(new Date(e.payload.oldDate))] : []);
          if (d) days.add(localDateString(new Date(d.doc_date)));
          for (const day of days) await this.refreshDay(tx, day);
        },
        { tenantId: e.tenantId, userId: null },
      );
    };
    this.registry.on('document.posted', onDoc);
    this.registry.on('document.unposted', onDoc);
    await this.jobs.work('reports.nightly', async () => {
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) {
        await this.rebuild(t.id, dayjs().subtract(35, 'day').format('YYYY-MM-DD'), localDateString(new Date())).catch((err) => this.log.warn(`отчётная таблица ${t.id}: ${err.message}`));
      }
    });
    await this.jobs.schedule('reports.nightly', '50 3 * * *');
  }

  /** Пересобрать день магазина из проведённых чеков и возвратов. */
  async refreshDay(tx: TenantTx, day: string) {
    await tx.query(`DELETE FROM rpt_sales_daily WHERE tenant_id = $1 AND day = $2`, [tx.tenantId, day]);
    await tx.query(
      `INSERT INTO rpt_sales_daily (tenant_id, day, store_id, seller_id, customer_id, product_id, qty, revenue, cost, discount, returned_qty, returned_amount)
       SELECT d.tenant_id, $2::date, d.store_id, r.seller_membership_id, coalesce(r.customer_id, d.counterparty_id), l.product_id,
              sum(CASE WHEN d.type = 'sale' THEN l.base_qty ELSE -l.base_qty END),
              sum(CASE WHEN d.type = 'sale' THEN l.amount ELSE -l.amount END),
              sum(CASE WHEN d.type = 'sale' THEN l.cost_amount ELSE -l.cost_amount END),
              sum(CASE WHEN d.type = 'sale' THEN coalesce(l.line_discount, 0) + coalesce(l.receipt_discount, 0) + coalesce(l.promo_discount, 0) ELSE 0 END),
              sum(CASE WHEN d.type = 'sale_return' THEN l.base_qty ELSE 0 END),
              sum(CASE WHEN d.type = 'sale_return' THEN l.amount ELSE 0 END)
         FROM documents d JOIN document_lines l ON l.document_id = d.id LEFT JOIN receipts r ON r.document_id = d.id
        WHERE d.tenant_id = $1 AND d.type IN ('sale', 'sale_return') AND d.status = 'posted' AND d.deleted_at IS NULL
          AND d.doc_date >= ($2::date::timestamp AT TIME ZONE '${DEFAULT_TZ}') AND d.doc_date < (($2::date + 1)::timestamp AT TIME ZONE '${DEFAULT_TZ}')
        GROUP BY d.tenant_id, d.store_id, r.seller_membership_id, coalesce(r.customer_id, d.counterparty_id), l.product_id`,
      [tx.tenantId, day],
    );
  }

  /** Пересобрать период (ночью и по кнопке владельца). */
  rebuild(tenantId: string, from: string, to: string) {
    return this.tenantTx.run(
      async (tx) => {
        let n = 0;
        for (let d = dayjs(from); !d.isAfter(dayjs(to)); d = d.add(1, 'day')) {
          await this.refreshDay(tx, d.format('YYYY-MM-DD'));
          n++;
        }
        return { from, to, days: n };
      },
      { tenantId, userId: null },
    );
  }
}
