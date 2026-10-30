import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { dayjs, DEFAULT_TZ, localDateString } from '../../common/utils/dates';
import { AppConfig } from '../../config/app.config';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { TelegramService } from '../telegram/telegram.service';
import { Tenant } from '../tenants/entities/tenant.entity';
import { DashboardService } from './dashboard.service';
import { OwnerSummary } from './entities/report.entity';
import { num, r2 } from './report-kit';

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ');

/**
 * Вечерняя сводка владельцу (ТЗ 20.3): в настроенное время (по умолчанию 21:00) — выручка, прибыль, чеки,
 * средний чек, несверенные переводы, долги клиентов, что заканчивается, заявки без ответа; кнопка «Автозаказ».
 */
@Injectable()
export class SummaryService implements OnModuleInit {
  private readonly log = new Logger('Summary');

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly platform: PlatformDb,
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
    private readonly dashboard: DashboardService,
    private readonly telegram: TelegramService,
    private readonly notifications: NotificationsService,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    await this.jobs.work('summary.evening', async () => {
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) await this.maybeSend(t.id).catch((e) => this.log.warn(`сводка ${t.id}: ${e.message}`));
    });
    await this.jobs.schedule('summary.evening', '*/5 * * * *');
  }

  /** Время пришло и сегодня ещё не отправляли — отправить. */
  async maybeSend(tenantId: string, now = new Date()) {
    return this.tenantTx.run(
      async (tx) => {
        const s = await this.settings.get(tx);
        const time = s.eveningSummaryTime || '21:00';
        const local = dayjs(now).tz(DEFAULT_TZ);
        if (local.format('HH:mm') < time) return { sent: false, reason: 'not_yet' };
        const day = local.format('YYYY-MM-DD');
        const [done] = await tx.query(`SELECT 1 FROM owner_summaries WHERE tenant_id = $1 AND day = $2`, [tx.tenantId, day]);
        if (done) return { sent: false, reason: 'already' };
        return this.sendInTx(tx, day);
      },
      { tenantId, userId: null },
    );
  }

  /** Собрать сводку за день. */
  async build(tx: TenantTx, day = localDateString(new Date())) {
    const t = await this.dashboard.dayTiles(tx, day, null, undefined, true);
    const [tr] = await tx.query(`SELECT count(*)::int AS n, coalesce(sum(amount), 0) AS s FROM money_movements WHERE tenant_id = $1 AND verify_status = 'unverified'`, [tx.tenantId]);
    const [debts] = await tx.query(
      `SELECT coalesce(sum(remaining), 0) AS s, coalesce(sum(remaining) FILTER (WHERE due_date < current_date), 0) AS overdue
         FROM debt_items WHERE tenant_id = $1 AND direction = 'receivable' AND remaining > 0 AND currency = 'KGS' AND kind <> 'prepayment'`,
      [tx.tenantId],
    );
    const ending = await tx.query(
      `SELECT p.name, coalesce(sum(b.qty), 0) AS qty, r.min_qty AS min FROM stock_rules r JOIN products p ON p.id = r.product_id
         LEFT JOIN stock_balances b ON b.tenant_id = r.tenant_id AND b.product_id = r.product_id
        WHERE r.tenant_id = $1 AND r.deleted_at IS NULL AND r.min_qty > 0 GROUP BY p.name, r.min_qty HAVING coalesce(sum(b.qty), 0) < r.min_qty
        ORDER BY coalesce(sum(b.qty), 0) / r.min_qty LIMIT 50`,
      [tx.tenantId],
    );
    const [req] = await tx.query(`SELECT count(*)::int AS n FROM customer_requests WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'new'`, [tx.tenantId]);
    return {
      day,
      revenue: t.revenue,
      profit: t.profit,
      receipts: t.receipts,
      avg: t.avg,
      unverifiedTransfers: { count: tr.n, amount: r2(num(tr.s)) },
      customerDebts: { total: r2(num(debts.s)), overdue: r2(num(debts.overdue)) },
      ending: { count: ending.length, items: ending.slice(0, 5).map((e: any) => ({ name: e.name, qty: num(e.qty), min: num(e.min) })) },
      requestsNew: req.n,
    };
  }

  text(d: Awaited<ReturnType<SummaryService['build']>>, shopName: string) {
    const lines = [
      `📊 ${shopName} — итоги ${dayjs(d.day).format('DD.MM')}`,
      `Выручка: ${fmt(d.revenue)} сом`,
      ...(d.profit !== null ? [`Прибыль: ${fmt(d.profit)} сом`] : []),
      `Чеков: ${d.receipts}, средний чек ${fmt(d.avg)} сом`,
      `Несверенные переводы: ${d.unverifiedTransfers.count ? `${d.unverifiedTransfers.count} на ${fmt(d.unverifiedTransfers.amount)} сом` : 'нет'}`,
      `Долги клиентов: ${fmt(d.customerDebts.total)} сом${d.customerDebts.overdue ? ` (просрочено ${fmt(d.customerDebts.overdue)})` : ''}`,
      d.ending.count ? `Заканчивается: ${d.ending.count} — ${d.ending.items.map((i) => i.name).join(', ')}${d.ending.count > 5 ? '…' : ''}` : 'Ниже минимума — ничего',
      `Заявки без ответа: ${d.requestsNew}`,
    ];
    return lines.join('\n');
  }

  /** Отправить сводку владельцам (Telegram + уведомление в системе) и запомнить день. */
  async sendInTx(tx: TenantTx, day = localDateString(new Date())) {
    const data = await this.build(tx, day);
    const [tenant] = await tx.query(`SELECT name FROM tenants WHERE id = $1`, [tx.tenantId]);
    const text = this.text(data, tenant?.name ?? 'Магазин');
    const owners = await tx.query(
      `SELECT u.id, u.telegram_chat_id AS chat FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.is_owner AND m.status = 'active'`,
      [tx.tenantId],
    );
    const buttons = data.ending.count ? [[{ text: '🛒 Автозаказ', url: `${this.config.publicUrl}/purchasing/auto-order` }]] : undefined;
    let sent = 0;
    for (const o of owners) if (o.chat && (await this.telegram.send(o.chat, text, buttons))) sent++;
    await this.notifications.notify(tx, { type: 'summary.evening', title: `Итоги дня: выручка ${fmt(data.revenue)} сом, чеков ${data.receipts}`, body: text, ownersOnly: true, link: '/dashboard', data });
    await tx.query(
      `INSERT INTO owner_summaries (tenant_id, day, data, sent_to) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, day) DO UPDATE SET data = EXCLUDED.data, sent_to = EXCLUDED.sent_to, updated_at = now()`,
      [tx.tenantId, day, JSON.stringify(data), sent],
    );
    return { sent: true, telegram: sent, data, text };
  }

  preview() {
    return this.tenantTx.run(async (tx) => {
      const data = await this.build(tx);
      const [tenant] = await tx.query(`SELECT name FROM tenants WHERE id = $1`, [tx.tenantId]);
      return { data, text: this.text(data, tenant?.name ?? 'Магазин') };
    });
  }

  sendNow() {
    return this.tenantTx.run((tx) => this.sendInTx(tx));
  }

  history(limit = 30) {
    return this.tenantTx.run((tx) => tx.repo(OwnerSummary).find({ order: { day: 'DESC' }, take: limit }));
  }
}
