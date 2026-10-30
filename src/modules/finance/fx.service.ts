import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { dayjs, localDateString } from '../../common/utils/dates';
import { D, Decimal, money } from '../../common/utils/decimal';
import { AppConfig } from '../../config/app.config';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { AuditService } from '../audit/audit.service';
import { PriceResolverService } from '../pricing/price-resolver.service';
import { Tenant } from '../tenants/entities/tenant.entity';
import { FxRevaluation, NbkrRate } from './entities/expense.entity';

/** Разбор daily.xml НБКР: <CurrencyRates Date="25.10.2026"><Currency ISOCode="USD"><Nominal>1</Nominal><Value>87,4500</Value> */
export function parseNbkrXml(xml: string): { date: string; rates: Record<string, string> } {
  const dm = /<CurrencyRates[^>]*Date="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml);
  if (!dm) throw new Error('нет даты в ответе НБКР');
  const rates: Record<string, string> = {};
  const re = /<Currency\s+ISOCode="([A-Z]{3})"\s*>\s*<Nominal>\s*(\d+)\s*<\/Nominal>\s*<Value>\s*([\d.,]+)\s*<\/Value>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const v = D(m[3].replace(',', '.')).div(m[2]);
    if (v.gt(0)) rates[m[1]] = v.toFixed(6);
  }
  if (!Object.keys(rates).length) throw new Error('нет курсов в ответе НБКР');
  return { date: `${dm[3]}-${dm[2]}-${dm[1]}`, rates };
}

/**
 * Курсы НБКР (ТЗ 19.4): загружаются каждый день; на выходные и праздники — последний опубликованный.
 * Переоценка валютных долгов на конец месяца, курсовые разницы (ТЗ 19.5).
 */
@Injectable()
export class FxService implements OnModuleInit {
  private readonly log = new Logger('NBKR');

  constructor(
    private readonly platform: PlatformDb,
    private readonly tenantTx: TenantTransaction,
    private readonly jobs: JobsService,
    private readonly config: AppConfig,
    private readonly resolver: PriceResolverService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    await this.jobs.work('nbkr.load', async () => {
      await this.load().catch((e) => this.log.warn(`курсы НБКР не загрузились: ${e.message}`));
    });
    // НБКР публикует курс до полудня; второй запуск — если утром сайт не ответил
    await this.jobs.schedule('nbkr.load', '5 10,15 * * *');
    await this.jobs.work('fx.revaluation', async () => {
      const month = dayjs().subtract(1, 'month').format('YYYY-MM');
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) await this.revalueTenant(t.id, month).catch(() => undefined);
    });
    await this.jobs.schedule('fx.revaluation', '30 2 1 * *');
  }

  /** Загрузить курсы с сайта НБКР (адрес — NBKR_URL). */
  async load(): Promise<{ date: string; rates: Record<string, string> }> {
    const res = await fetch(this.config.nbkrUrl, { signal: AbortSignal.timeout(15000) }).catch((e) => {
      throw Errors.bad('NBKR_UNAVAILABLE', `Сайт НБКР недоступен: ${e.message}`);
    });
    if (!res.ok) throw Errors.bad('NBKR_UNAVAILABLE', `Сайт НБКР ответил ${res.status}`);
    let parsed;
    try {
      parsed = parseNbkrXml(await res.text());
    } catch (e: any) {
      throw Errors.bad('NBKR_BAD_RESPONSE', `Неверный ответ НБКР: ${e.message}`);
    }
    for (const [currency, rate] of Object.entries(parsed.rates)) {
      await this.platform.ds.query(
        `INSERT INTO nbkr_rates (rate_date, currency, rate) VALUES ($1, $2, $3)
         ON CONFLICT (rate_date, currency) DO UPDATE SET rate = EXCLUDED.rate, updated_at = now()`,
        [parsed.date, currency, rate],
      );
    }
    this.log.log(`курсы НБКР на ${parsed.date}: ${Object.keys(parsed.rates).length} валют`);
    return parsed;
  }

  /** Курс НБКР на дату — последний опубликованный не позже неё. */
  async rateOn(currency: string, date: string): Promise<Decimal | null> {
    if (currency === 'KGS') return D(1);
    const [r] = await this.platform.ds.query(
      `SELECT rate FROM nbkr_rates WHERE currency = $1 AND rate_date <= $2 ORDER BY rate_date DESC LIMIT 1`,
      [currency, date],
    );
    return r ? D(r.rate) : null;
  }

  async ratesOn(date = localDateString(new Date())) {
    const rows = await this.platform.ds.query(
      `SELECT DISTINCT ON (currency) currency, rate, rate_date AS "rateDate" FROM nbkr_rates WHERE rate_date <= $1 ORDER BY currency, rate_date DESC`,
      [date],
    );
    return { date, rates: rows };
  }

  // ── Переоценка ───────────────────────────────────────────

  revalue(month: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Errors.bad('BAD_MONTH', 'Месяц в формате ГГГГ-ММ');
    return this.tenantTx.run((tx) => this.revalueInTx(tx, month));
  }

  private revalueTenant(tenantId: string, month: string) {
    return this.tenantTx.run((tx) => this.revalueInTx(tx, month), { tenantId, userId: null });
  }

  /**
   * Переоценка открытых валютных долгов на конец месяца по курсу НБКР. Повторный запуск за тот же месяц
   * пересчитывает его. База — курс прошлой переоценки долга, для нового долга — курс НБКР на дату открытия.
   * Нам должны (receivable): курс вырос — доход; мы должны (payable): курс вырос — убыток.
   */
  async revalueInTx(tx: TenantTx, month: string) {
    const end = dayjs(`${month}-01`).endOf('month').format('YYYY-MM-DD');
    const shopRates = await this.resolver.rates(tx);
    const debts = await tx.query(
      `SELECT d.id, d.counterparty_id, d.direction, d.currency, d.opened_at,
              d.remaining + coalesce((SELECT sum(a.amount) FROM debt_allocations a
                                       WHERE a.tenant_id = d.tenant_id AND a.debt_item_id = d.id AND a.created_at >= ($2::date + 1)), 0) AS remaining
         FROM debt_items d
        WHERE d.tenant_id = $1 AND d.currency <> 'KGS' AND d.opened_at < ($2::date + 1) AND (d.closed_at IS NULL OR d.closed_at >= ($2::date + 1))
          AND d.kind <> 'prepayment'`,
      [tx.tenantId, end],
    );
    await tx.query(`DELETE FROM fx_revaluations WHERE tenant_id = $1 AND month = $2`, [tx.tenantId, month]);
    const rows: Partial<FxRevaluation>[] = [];
    const missing = new Set<string>();
    let total = D(0);
    for (const d of debts) {
      const remaining = money(d.remaining);
      if (remaining.isZero()) continue;
      const rateTo = await this.rateOn(d.currency, end);
      if (!rateTo) {
        missing.add(d.currency);
        continue;
      }
      const [prev] = await tx.query(
        `SELECT rate_to FROM fx_revaluations WHERE tenant_id = $1 AND debt_item_id = $2 AND month < $3 ORDER BY month DESC LIMIT 1`,
        [tx.tenantId, d.id, month],
      );
      const rateFrom = prev
        ? D(prev.rate_to)
        : ((await this.rateOn(d.currency, localDateString(new Date(d.opened_at)))) ?? (shopRates[d.currency] ? D(shopRates[d.currency]) : rateTo));
      const sign = d.direction === 'receivable' ? 1 : -1;
      const diff = money(remaining.mul(rateTo.minus(rateFrom)).mul(sign));
      total = total.plus(diff);
      rows.push({ month, debtItemId: d.id, counterpartyId: d.counterparty_id, direction: d.direction, currency: d.currency, remaining, rateFrom, rateTo, diffKgs: diff });
    }
    if (rows.length) await tx.repo(FxRevaluation).insertMany(rows as any);
    await this.audit.log(tx, { action: 'money.revaluation', entityType: 'fx_revaluation', summary: `Переоценка валютных долгов за ${month}: ${total.toFixed(2)} сом`, important: true });
    return { month, debts: rows.length, totalKgs: total.toFixed(2), missingRates: [...missing] };
  }
}
