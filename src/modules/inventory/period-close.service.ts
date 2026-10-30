import { Injectable, OnModuleInit } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { dayjs } from '../../common/utils/dates';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { Store } from '../stores/entities/store.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { CostRecalcService } from './cost-recalc.service';
import { PeriodClose } from './entities/stock.entity';

/**
 * Закрытие периода (ТЗ 7.5): ежемесячно, снимок остатков и себестоимости на конец месяца;
 * после закрытия документы периода неизменяемы. Открыть — только владелец, с причиной.
 */
@Injectable()
export class PeriodCloseService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly recalc: CostRecalcService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
    private readonly platform: PlatformDb,
  ) {}

  async onModuleInit() {
    // Напоминание владельцу с 1-го числа, пока прошлый месяц не закрыт
    await this.jobs.work('period.reminder', async () => {
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) await this.remind(t.id).catch(() => undefined);
    });
    await this.jobs.schedule('period.reminder', '7 9 * * *');
  }

  private async tz(tx: TenantTx) {
    const s = await tx.repo(Store).findOne({ where: {}, order: { createdAt: 'ASC' } });
    return s?.timezone ?? 'Asia/Bishkek';
  }

  /** Граница месяца в поясе магазина: начало следующего месяца. */
  private bounds(month: string, tz: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Errors.bad('BAD_MONTH', 'Месяц в формате ГГГГ-ММ');
    const start = dayjs.tz(`${month}-01 00:00`, tz);
    return { start: start.toDate(), end: start.add(1, 'month').toDate(), first: `${month}-01` };
  }

  async list() {
    return this.tenantTx.run(async (tx) => {
      const rows = await tx.repo(PeriodClose).find({ order: { month: 'DESC' } });
      const tz = await this.tz(tx);
      const last = rows.find((r) => r.status === 'closed');
      const nextMonth = last ? dayjs(last.month).add(1, 'month').format('YYYY-MM') : dayjs().tz(tz).subtract(1, 'month').format('YYYY-MM');
      const closable = this.bounds(nextMonth, tz).end <= new Date();
      const pending = await this.recalc.pending(tx);
      return { periods: rows, closedUntil: last?.periodEnd ?? null, nextToClose: closable ? nextMonth : null, costRecalcPending: pending.count };
    });
  }

  async close(month: string) {
    const tenantId = this.ctx.requireTenantId();
    // Сначала досчитать себестоимость, затронутую задними датами
    await this.recalc.processTenant(tenantId);
    return this.tenantTx.run(async (tx) => {
      const tz = await this.tz(tx);
      const { end, first } = this.bounds(month, tz);
      if (end > new Date()) throw Errors.bad('MONTH_NOT_OVER', 'Месяц ещё не закончился');
      await tx.query(`LOCK TABLE period_closes IN EXCLUSIVE MODE`);
      const last = await tx.repo(PeriodClose).findOne({ where: { status: 'closed' }, order: { month: 'DESC' } });
      if (last && last.month >= first) throw Errors.conflict('ALREADY_CLOSED', 'Этот месяц уже закрыт');
      if (last && dayjs(last.month).add(1, 'month').format('YYYY-MM-DD') !== first) {
        throw Errors.conflict('CLOSE_IN_ORDER', `Сначала закройте ${dayjs(last.month).add(1, 'month').format('MM.YYYY')}`);
      }
      const pending = await this.recalc.pending(tx);
      if (pending.count && pending.fromDate && pending.fromDate < end) {
        throw Errors.conflict('RECALC_PENDING', 'Идёт пересчёт себестоимости — повторите через минуту');
      }
      const awaiting = await tx.query(
        `SELECT number FROM documents WHERE tenant_id = $1 AND status = 'awaiting_approval' AND doc_date < $2 AND deleted_at IS NULL LIMIT 5`,
        [tx.tenantId, end],
      );
      if (awaiting.length) throw Errors.conflict('AWAITING_DOCS', `Есть списания на согласовании: ${awaiting.map((a: any) => a.number).join(', ')}`);

      // Снимок на конец месяца: предыдущий снимок + движения месяца (или все движения до конца)
      await tx.query(`DELETE FROM stock_snapshots WHERE tenant_id = $1 AND period_end = $2`, [tx.tenantId, end]);
      await tx.query(
        `INSERT INTO stock_snapshots (tenant_id, created_by, period_end, warehouse_id, product_id, qty, cost_amount)
         SELECT $1, $2, $3, warehouse_id, product_id, sum(qty), sum(cost_amount) FROM (
           SELECT warehouse_id, product_id, qty, cost_amount FROM stock_snapshots
            WHERE tenant_id = $1 AND $4::timestamptz IS NOT NULL AND period_end = $4
           UNION ALL
           SELECT warehouse_id, product_id, qty, cost_amount FROM stock_movements
            WHERE tenant_id = $1 AND moved_at < $3 AND ($4::timestamptz IS NULL OR moved_at >= $4)) x
         GROUP BY warehouse_id, product_id HAVING sum(qty) <> 0 OR sum(cost_amount) <> 0`,
        [tx.tenantId, tx.userId, end, last?.periodEnd ?? null],
      );
      const existing = await tx.repo(PeriodClose).findOne({ where: { month: first } });
      const row = existing
        ? Object.assign(existing, { status: 'closed', periodEnd: end, closedAt: new Date(), closedBy: tx.userId, reopenedAt: null, reopenedBy: null, reopenReason: null })
        : await tx.repo(PeriodClose).insert({ month: first, periodEnd: end, status: 'closed', closedAt: new Date(), closedBy: tx.userId });
      await tx.repo(PeriodClose).save(row as PeriodClose);
      await this.audit.log(tx, { action: 'period.close', entityType: 'period', entityId: row.id, summary: `Закрыт период ${month}`, important: true });
      const [{ n }] = await tx.query(`SELECT count(*)::int AS n FROM stock_snapshots WHERE tenant_id = $1 AND period_end = $2`, [tx.tenantId, end]);
      return { month, periodEnd: end, snapshotRows: n };
    });
  }

  /** Открыть закрытый период — только владелец, с причиной; только последний закрытый месяц. */
  async reopen(month: string, reason: string) {
    if (!this.ctx.isOwner) throw Errors.forbidden('Открыть закрытый период может только владелец');
    if (!reason?.trim()) throw Errors.bad('REASON_REQUIRED', 'Укажите причину');
    return this.tenantTx.run(async (tx) => {
      const { first } = this.bounds(month, await this.tz(tx));
      const last = await tx.repo(PeriodClose).findOne({ where: { status: 'closed' }, order: { month: 'DESC' } });
      if (!last || last.month !== first) throw Errors.conflict('REOPEN_LAST_ONLY', 'Открыть можно только последний закрытый месяц');
      await tx.query(`DELETE FROM stock_snapshots WHERE tenant_id = $1 AND period_end = $2`, [tx.tenantId, last.periodEnd]);
      last.status = 'reopened';
      last.reopenedAt = new Date();
      last.reopenedBy = tx.userId;
      last.reopenReason = reason.trim().slice(0, 500);
      await tx.repo(PeriodClose).save(last);
      await this.audit.log(tx, { action: 'period.reopen', entityType: 'period', entityId: last.id, summary: `Открыт период ${month}: ${reason}`, important: true });
      await this.notifications.notify(tx, { type: 'period.close_reminder', title: `Период ${month} открыт: ${reason}`, ownersOnly: true, excludeUserId: tx.userId });
      return { month, status: 'reopened' };
    });
  }

  private async remind(tenantId: string) {
    await this.tenantTx.run(
      async (tx) => {
        const s = await this.settings.get(tx);
        if (!s.periodCloseReminder) return;
        const tz = await this.tz(tx);
        const prev = dayjs().tz(tz).subtract(1, 'month').format('YYYY-MM');
        const closed = await tx.repo(PeriodClose).findOne({ where: { month: `${prev}-01`, status: 'closed' } });
        if (closed) return;
        const [{ any }] = await tx.query(`SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = $1) AS any`, [tx.tenantId]);
        if (!any) return;
        await this.notifications.notify(tx, { type: 'period.close_reminder', title: `Закройте период ${prev}`, ownersOnly: true, link: '/settings/periods' });
      },
      { tenantId, userId: null },
    );
  }
}
