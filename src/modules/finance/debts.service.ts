import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { dayjs } from '../../common/utils/dates';
import { D, Decimal, money } from '../../common/utils/decimal';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { Counterparty } from '../counterparties/entities/counterparty.entity';
import { PriceResolverService } from '../pricing/price-resolver.service';
import { PdfService } from '../printing/pdf.service';
import { DebtAllocation, DebtDirection, DebtItem, DebtKind, DebtPayment } from './entities/money.entity';
import { MoneyService } from './money.service';

export interface OpenDebtInput {
  counterpartyId: string;
  direction: DebtDirection;
  kind: DebtKind;
  currency?: string;
  amount: Decimal;
  documentId?: string | null;
  customerVehicleId?: string | null;
  vehicleLabel?: string | null;
  description?: string | null;
  /** Срок долга, дней от сегодня */
  dueDays?: number | null;
  storeId?: string | null;
  openedAt?: Date;
  /** Сразу зачесть против любых встречных долгов (возврат поставщику гасит долг перед ним) */
  offsetAll?: boolean;
}

export interface Allocation {
  mode: 'oldest' | 'vehicles' | 'items';
  vehicleIds?: (string | null)[];
  itemIds?: string[];
}

export interface DebtPayInput {
  counterpartyId: string;
  /** in — клиент платит нам; out — мы платим (соседу, поставщику) */
  direction: 'in' | 'out';
  /** Валюта долга */
  currency?: string;
  amount: string;
  accountId: string;
  /** Сумма по счёту, если валюта счёта другая (иначе — по курсу магазина) */
  accountAmount?: string | null;
  allocation?: Allocation;
  shiftId?: string | null;
  comment?: string | null;
  idempotencyKey?: string | null;
}

/** Долги и взаиморасчёты (ТЗ 14.6, 18.2, 19.5): позиции, оплаты с распределением, аванс, взаимозачёт, сверка. */
@Injectable()
export class DebtsService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly moneyService: MoneyService,
    private readonly resolver: PriceResolverService,
    private readonly audit: AuditService,
    private readonly pdf: PdfService,
  ) {}

  // ── Позиции ──────────────────────────────────────────────

  /** Открыть позицию долга. Встречный аванс того же контрагента и валюты гасит её сразу. */
  async open(tx: TenantTx, i: OpenDebtInput): Promise<DebtItem> {
    const amount = money(i.amount);
    if (amount.lte(0)) throw Errors.bad('BAD_AMOUNT', 'Сумма долга должна быть больше нуля');
    const openedAt = i.openedAt ?? new Date();
    const item = await tx.repo(DebtItem).insert({
      counterpartyId: i.counterpartyId,
      direction: i.direction,
      kind: i.kind,
      currency: i.currency ?? 'KGS',
      amount,
      remaining: amount,
      documentId: i.documentId ?? null,
      customerVehicleId: i.customerVehicleId ?? null,
      vehicleLabel: i.vehicleLabel ?? null,
      description: i.description?.slice(0, 500) ?? null,
      openedAt,
      dueDate: i.dueDays !== null && i.dueDays !== undefined ? dayjs(openedAt).add(i.dueDays, 'day').format('YYYY-MM-DD') : null,
      storeId: i.storeId ?? null,
    });
    // Переплата / аванс сама гасит следующий долг (ТЗ 18.2). Предоплата по заявке — только при выдаче заявки.
    if (i.kind === 'prepayment') {
      // ничего не зачитываем
    } else if (i.kind !== 'advance') {
      const opposite: DebtDirection = i.direction === 'receivable' ? 'payable' : 'receivable';
      const advances = await this.lockOpen(tx, i.counterpartyId, opposite, item.currency, i.offsetAll ? { excludeKinds: ['prepayment'] } : { kinds: ['advance'] });
      await this.offsetItems(tx, [item], advances);
    } else {
      const opposite: DebtDirection = i.direction === 'payable' ? 'receivable' : 'payable';
      const debts = await this.lockOpen(tx, i.counterpartyId, opposite, item.currency, { excludeKinds: ['advance'] });
      await this.offsetItems(tx, debts, [item]);
    }
    return (await tx.repo(DebtItem).findById(item.id))!;
  }

  private async lockOpen(
    tx: TenantTx,
    counterpartyId: string,
    direction: DebtDirection,
    currency: string,
    f: { kinds?: string[]; excludeKinds?: string[]; vehicleIds?: (string | null)[]; itemIds?: string[] } = {},
  ): Promise<DebtItem[]> {
    const params: unknown[] = [tx.tenantId, counterpartyId, direction, currency];
    const w = ['tenant_id = $1', 'counterparty_id = $2', 'direction = $3', 'currency = $4', 'remaining > 0'];
    if (f.kinds) {
      params.push(f.kinds);
      w.push(`kind = ANY($${params.length}::text[])`);
    }
    if (f.excludeKinds) {
      params.push(f.excludeKinds);
      w.push(`NOT (kind = ANY($${params.length}::text[]))`);
    }
    if (f.itemIds) {
      params.push(f.itemIds);
      w.push(`id = ANY($${params.length}::uuid[])`);
    }
    if (f.vehicleIds) {
      const ids = f.vehicleIds.filter((v): v is string => !!v);
      const withNull = f.vehicleIds.some((v) => !v);
      params.push(ids);
      w.push(`(customer_vehicle_id = ANY($${params.length}::uuid[])${withNull ? ' OR customer_vehicle_id IS NULL' : ''})`);
    }
    const rows = await tx.query(`SELECT id FROM debt_items WHERE ${w.join(' AND ')} ORDER BY opened_at, id FOR UPDATE`, params);
    return rows.length ? (await tx.repo(DebtItem).findByIds(rows.map((r: any) => r.id))).sort((a, b) => +a.openedAt - +b.openedAt || a.id.localeCompare(b.id)) : [];
  }

  /** Взаимно погасить позиции (долг ↔ аванс / долг соседу ↔ его долг нам). */
  private async offsetItems(tx: TenantTx, left: DebtItem[], right: DebtItem[], ref: { documentId?: string | null; paymentId?: string | null } = {}): Promise<Decimal> {
    let total = D(0);
    let j = 0;
    for (const a of left) {
      while (a.remaining.gt(0) && j < right.length) {
        const b = right[j];
        if (b.remaining.lte(0)) {
          j++;
          continue;
        }
        const x = Decimal.min(a.remaining, b.remaining);
        await this.reduce(tx, a, x, { offsetItemId: b.id, ...ref });
        await this.reduce(tx, b, x, { offsetItemId: a.id, ...ref });
        total = total.plus(x);
      }
    }
    return total;
  }

  private async reduce(tx: TenantTx, item: DebtItem, amount: Decimal, ref: { paymentId?: string | null; offsetItemId?: string | null; documentId?: string | null }) {
    item.remaining = money(item.remaining.minus(amount));
    await tx.repo(DebtAllocation).insert({ debtItemId: item.id, paymentId: ref.paymentId ?? null, offsetItemId: ref.offsetItemId ?? null, documentId: ref.documentId ?? null, amount: money(amount) });
    await tx.query(`UPDATE debt_items SET remaining = $3, closed_at = CASE WHEN $3::numeric <= 0 THEN now() ELSE NULL END, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [
      tx.tenantId,
      item.id,
      item.remaining.toFixed(2),
    ]);
  }

  /**
   * Отменить долги документа (отмена приёмки, возврата поставщику, доп. расходов). Не оплаченная часть исчезает;
   * оплаченная становится авансом встречной стороны (поставщик должен нам) и сама гасит другие долги.
   */
  async cancelForDocument(tx: TenantTx, documentId: string, kinds?: DebtKind[]) {
    const items = await tx.query(
      `SELECT id FROM debt_items WHERE tenant_id = $1 AND document_id = $2 ${kinds ? 'AND kind = ANY($3::text[])' : ''} AND kind NOT IN ('advance', 'prepayment') FOR UPDATE`,
      kinds ? [tx.tenantId, documentId, kinds] : [tx.tenantId, documentId],
    );
    for (const { id } of items) {
      const it = (await tx.repo(DebtItem).findById(id))!;
      const settled = it.amount.minus(it.remaining);
      if (settled.isZero()) {
        await tx.repo(DebtItem).hardDelete({ id: it.id });
        continue;
      }
      await tx.query(`UPDATE debt_items SET remaining = 0, closed_at = now(), description = left(coalesce(description, '') || ' (отменено)', 500) WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, it.id]);
      await this.open(tx, {
        counterpartyId: it.counterpartyId,
        direction: it.direction === 'payable' ? 'receivable' : 'payable',
        kind: 'advance',
        currency: it.currency,
        amount: settled,
        description: `Переплата после отмены документа`,
        storeId: it.storeId,
      });
    }
  }

  /** Аванс / предоплата клиента: что доступно для оплаты чека. */
  async advances(tx: TenantTx, counterpartyId: string, kinds: DebtKind[] = ['advance']): Promise<DebtItem[]> {
    return this.lockOpen(tx, counterpartyId, 'payable', 'KGS', { kinds });
  }

  /** Списать аванс (оплата чека авансом): позиции по порядку. Возвращает id затронутых позиций. */
  async consumeAdvance(tx: TenantTx, items: DebtItem[], amount: Decimal, documentId: string | null): Promise<string[]> {
    let left = money(amount);
    const used: string[] = [];
    for (const it of items) {
      if (left.lte(0)) break;
      const x = Decimal.min(left, it.remaining);
      if (x.lte(0)) continue;
      await this.reduce(tx, it, x, { documentId });
      used.push(it.id);
      left = left.minus(x);
    }
    if (left.gt(0)) throw Errors.bad('ADVANCE_NOT_ENOUGH', `Аванса не хватает: ещё ${left.toFixed(2)} сом`);
    return used;
  }

  /** Уменьшить позицию (возврат товара, проданного в долг). Возвращает, сколько удалось списать. */
  async reduceBy(tx: TenantTx, itemId: string, amount: Decimal, documentId: string | null): Promise<Decimal> {
    await tx.query(`SELECT id FROM debt_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, itemId]);
    const item = await tx.repo(DebtItem, 'Долг').getById(itemId);
    const x = Decimal.min(item.remaining, money(amount));
    if (x.gt(0)) await this.reduce(tx, item, x, { documentId });
    return x;
  }

  /** Открытый долг клиента нам в сомах (валютные — по курсу магазина) и просрочка в днях. */
  async exposure(tx: TenantTx, counterpartyId: string): Promise<{ totalKgs: Decimal; maxOverdueDays: number }> {
    const rows = await tx.query(
      `SELECT currency, sum(remaining) AS amount, max(current_date - due_date) FILTER (WHERE due_date < current_date) AS overdue
         FROM debt_items WHERE tenant_id = $1 AND counterparty_id = $2 AND direction = 'receivable' AND remaining > 0
        GROUP BY currency`,
      [tx.tenantId, counterpartyId],
    );
    const rates = await this.resolver.rates(tx);
    let total = D(0);
    let overdue = 0;
    for (const r of rows) {
      total = total.plus(D(r.amount).mul(r.currency === 'KGS' ? 1 : (rates[r.currency] ?? 0)));
      overdue = Math.max(overdue, Number(r.overdue ?? 0));
    }
    return { totalKgs: money(total), maxOverdueDays: overdue };
  }

  // ── Оплата долга ─────────────────────────────────────────

  pay(dto: DebtPayInput) {
    return this.tenantTx.run((tx) => this.payInTx(tx, dto));
  }

  async payInTx(tx: TenantTx, dto: DebtPayInput) {
    if (dto.idempotencyKey) {
      const prev = await tx.repo(DebtPayment).findOne({ where: { idempotencyKey: dto.idempotencyKey } });
      if (prev) return this.paymentView(tx, prev.id);
    }
    const cp = await tx.repo(Counterparty, 'Контрагент').getById(dto.counterpartyId);
    const currency = dto.currency ?? 'KGS';
    const amount = money(dto.amount);
    if (amount.lte(0)) throw Errors.bad('BAD_AMOUNT', 'Сумма должна быть больше нуля');
    const acc = await this.moneyService.account(tx, dto.accountId);
    if (acc.storeId) this.scope.assertStore(acc.storeId);
    // Долг в долларах, оплата сомами — по курсу магазина на дату оплаты (ТЗ 18.2)
    let accountAmount = amount;
    let rate: Decimal | null = null;
    if (acc.currency !== currency) {
      if (dto.accountAmount) {
        accountAmount = money(dto.accountAmount);
        rate = acc.currency === 'KGS' ? accountAmount.div(amount) : amount.div(accountAmount);
      } else {
        const rates = await this.resolver.rates(tx);
        const foreign = currency !== 'KGS' ? currency : acc.currency;
        if (!rates[foreign]) throw Errors.bad('NO_RATE', `Не задан курс магазина ${foreign}`);
        rate = D(rates[foreign]);
        accountAmount = money(acc.currency === 'KGS' ? amount.mul(rate) : amount.div(rate));
      }
    }
    if (dto.direction === 'out' && acc.type === 'cash') {
      const bal = await this.moneyService.balance(tx, acc.id);
      if (bal.lt(accountAmount)) throw Errors.conflict('NOT_ENOUGH_CASH', `На счёте «${acc.name}» ${bal.toFixed(2)} ${acc.currency}`);
    }
    const payment = await tx.repo(DebtPayment).insert({
      counterpartyId: cp.id,
      direction: dto.direction,
      currency,
      amount,
      accountId: acc.id,
      accountAmount: acc.currency !== currency ? accountAmount : null,
      rate,
      storeId: acc.storeId,
      shiftId: dto.shiftId ?? null,
      comment: dto.comment ?? null,
      idempotencyKey: dto.idempotencyKey ?? null,
    });
    await this.moneyService.record(tx, {
      accountId: acc.id,
      amount: dto.direction === 'in' ? accountAmount : accountAmount.neg(),
      kind: dto.direction === 'in' ? 'debt_in' : 'debt_out',
      rate: acc.currency !== 'KGS' ? (rate ?? null) : null,
      debtPaymentId: payment.id,
      counterpartyId: cp.id,
      shiftId: dto.shiftId,
      verifyStatus: acc.type === 'wallet' && dto.direction === 'in' ? 'unverified' : null,
      comment: dto.comment,
    });
    const direction: DebtDirection = dto.direction === 'in' ? 'receivable' : 'payable';
    const a = dto.allocation ?? { mode: 'oldest' };
    const items = await this.lockOpen(tx, cp.id, direction, currency, {
      excludeKinds: ['advance'],
      vehicleIds: a.mode === 'vehicles' ? (a.vehicleIds ?? []) : undefined,
      itemIds: a.mode === 'items' ? (a.itemIds ?? []) : undefined,
    });
    let rest = amount;
    for (const it of items) {
      if (rest.lte(0)) break;
      const x = Decimal.min(rest, it.remaining);
      await this.reduce(tx, it, x, { paymentId: payment.id });
      rest = rest.minus(x);
    }
    // Остаток — аванс (клиент переплатил) / предоплата (мы переплатили соседу)
    if (rest.gt(0)) {
      await this.open(tx, {
        counterpartyId: cp.id,
        direction: dto.direction === 'in' ? 'payable' : 'receivable',
        kind: 'advance',
        currency,
        amount: rest,
        description: dto.direction === 'in' ? 'Аванс клиента (переплата)' : 'Предоплата',
        storeId: acc.storeId,
      });
    }
    await this.audit.log(tx, {
      action: dto.direction === 'in' ? 'debt.payment_in' : 'debt.payment_out',
      entityType: 'counterparty',
      entityId: cp.id,
      summary: `${dto.direction === 'in' ? 'Оплата долга от' : 'Оплата долга'} «${cp.name}»: ${amount.toFixed(2)} ${currency}`,
      important: true,
    });
    return this.paymentView(tx, payment.id);
  }

  private async paymentView(tx: TenantTx, id: string) {
    const p = await tx.repo(DebtPayment).getById(id);
    const allocations = await tx.query(
      `SELECT a.debt_item_id AS "debtItemId", a.amount, d.description, d.opened_at AS "openedAt", d.customer_vehicle_id AS "vehicleId"
         FROM debt_allocations a JOIN debt_items d ON d.id = a.debt_item_id WHERE a.tenant_id = $1 AND a.payment_id = $2`,
      [tx.tenantId, id],
    );
    const balance = await this.summary(tx, p.counterpartyId);
    return { payment: p, allocations, balance };
  }

  /** Взаимозачёт: клиент одновременно сосед/поставщик — его долг нам гасит наш долг ему (ТЗ 18.2). */
  offset(counterpartyId: string, currency = 'KGS') {
    return this.tenantTx.run(async (tx) => {
      const cp = await tx.repo(Counterparty, 'Контрагент').getById(counterpartyId);
      const rec = await this.lockOpen(tx, cp.id, 'receivable', currency);
      const pay = await this.lockOpen(tx, cp.id, 'payable', currency);
      if (!rec.length || !pay.length) throw Errors.bad('NOTHING_TO_OFFSET', 'Нет встречных долгов');
      const payment = await tx.repo(DebtPayment).insert({ counterpartyId: cp.id, direction: 'offset', currency, amount: D(0) });
      const total = await this.offsetItems(tx, rec, pay, { paymentId: payment.id });
      await tx.query(`UPDATE debt_payments SET amount = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, payment.id, total.toFixed(2)]);
      await this.audit.log(tx, { action: 'debt.offset', entityType: 'counterparty', entityId: cp.id, summary: `Взаимозачёт с «${cp.name}»: ${total.toFixed(2)} ${currency}`, important: true });
      return { amount: total.toFixed(2), currency, balance: await this.summary(tx, cp.id) };
    });
  }

  // ── Чтение ───────────────────────────────────────────────

  async summary(tx: TenantTx, counterpartyId: string) {
    return tx.query(
      `SELECT direction, kind = 'advance' AS advance, currency, sum(remaining) AS amount
         FROM debt_items WHERE tenant_id = $1 AND counterparty_id = $2 AND remaining > 0 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      [tx.tenantId, counterpartyId],
    );
  }

  /** Дебиторка / кредиторка по контрагентам с возрастом долга (0–30, 31–60, 61–90, 90+) и просрочкой. */
  list(q: { direction?: DebtDirection; overdueOnly?: boolean; q?: string; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId, q.direction ?? 'receivable'];
      const w = [`d.tenant_id = $1`, `d.direction = $2`, `d.remaining > 0`, `d.kind NOT IN ('advance', 'prepayment')`];
      if (q.q) {
        params.push(`%${q.q}%`);
        w.push(`c.name ILIKE $${params.length}`);
      }
      const allowed = this.scope.storeIds();
      if (allowed) {
        params.push(allowed);
        w.push(`(d.store_id IS NULL OR d.store_id = ANY($${params.length}::uuid[]))`);
      }
      const having = q.overdueOnly ? `HAVING coalesce(sum(d.remaining) FILTER (WHERE d.due_date < current_date), 0) > 0` : '';
      const base = `FROM debt_items d JOIN counterparties c ON c.id = d.counterparty_id WHERE ${w.join(' AND ')} GROUP BY c.id, c.name, c.phone, d.currency ${having}`;
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM (SELECT 1 ${base}) x`, params);
      const items = await tx.query(
        `SELECT c.id AS "counterpartyId", c.name, c.phone, d.currency, sum(d.remaining) AS amount,
                coalesce(sum(d.remaining) FILTER (WHERE d.due_date < current_date), 0) AS overdue,
                coalesce(sum(d.remaining) FILTER (WHERE current_date - d.opened_at::date <= 30), 0) AS "age0_30",
                coalesce(sum(d.remaining) FILTER (WHERE current_date - d.opened_at::date BETWEEN 31 AND 60), 0) AS "age31_60",
                coalesce(sum(d.remaining) FILTER (WHERE current_date - d.opened_at::date BETWEEN 61 AND 90), 0) AS "age61_90",
                coalesce(sum(d.remaining) FILTER (WHERE current_date - d.opened_at::date > 90), 0) AS "age90plus",
                min(d.opened_at) AS "oldestAt"
           ${base} ORDER BY sum(d.remaining) DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total };
    });
  }

  /** Позиции долга контрагента; фильтр «за какую машину» (ТЗ 14.6). */
  items(counterpartyId: string, q: { vehicleId?: string; open?: boolean; direction?: DebtDirection }) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Counterparty, 'Контрагент').getById(counterpartyId);
      return this.itemsInTx(tx, counterpartyId, q);
    });
  }

  private async itemsInTx(tx: TenantTx, counterpartyId: string, q: { vehicleId?: string; open?: boolean; direction?: DebtDirection }) {
    const params: unknown[] = [tx.tenantId, counterpartyId];
    const w = ['d.tenant_id = $1', 'd.counterparty_id = $2'];
    if (q.direction) {
      params.push(q.direction);
      w.push(`d.direction = $${params.length}`);
    }
    if (q.open !== false) w.push('d.remaining > 0');
    if (q.vehicleId) {
      params.push(q.vehicleId);
      w.push(`d.customer_vehicle_id = $${params.length}`);
    }
    return tx.query(
      `SELECT d.id, d.direction, d.kind, d.currency, d.amount, d.remaining, d.opened_at AS "openedAt", d.due_date AS "dueDate",
              d.due_date < current_date AND d.remaining > 0 AS overdue, d.document_id AS "documentId", doc.number AS "documentNumber",
              d.customer_vehicle_id AS "vehicleId", coalesce(v.title, d.vehicle_label) AS "vehicleTitle", v.plate, d.description,
              (SELECT string_agg(p.name || CASE WHEN l.qty <> 1 THEN ' ×' || trim(trailing '.' from trim(trailing '0' from l.qty::text)) ELSE '' END, ', ' ORDER BY l.line_no)
                 FROM document_lines l JOIN products p ON p.id = l.product_id WHERE l.tenant_id = d.tenant_id AND l.document_id = d.document_id) AS what
         FROM debt_items d LEFT JOIN documents doc ON doc.id = d.document_id LEFT JOIN customer_vehicles v ON v.id = d.customer_vehicle_id
        WHERE ${w.join(' AND ')} ORDER BY d.opened_at`,
      params,
    );
  }

  /**
   * Сверка одним сообщением (ТЗ 14.6): «дата — машина — что — сумма» + итог; ссылки WhatsApp и Telegram; PDF.
   */
  statement(counterpartyId: string, q: { vehicleId?: string }) {
    return this.tenantTx.run((tx) => this.statementInTx(tx, counterpartyId, q));
  }

  private async statementInTx(tx: TenantTx, counterpartyId: string, q: { vehicleId?: string }) {
    const cp = await tx.repo(Counterparty, 'Контрагент').getById(counterpartyId);
    const items = (await this.itemsInTx(tx, cp.id, { direction: 'receivable', vehicleId: q.vehicleId })).filter((i: any) => i.kind !== 'advance');
    const advances = await this.summary(tx, cp.id);
    const byCur = new Map<string, Decimal>();
    for (const i of items) byCur.set(i.currency, (byCur.get(i.currency) ?? D(0)).plus(i.remaining));
    const fmt = (v: string | number | Decimal) => D(v).toNumber().toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    const lines = items.map((i: any) => `${dayjs(i.openedAt).tz('Asia/Bishkek').format('DD.MM')} — ${i.vehicleTitle ?? 'без машины'}${i.plate ? ` (${i.plate})` : ''} — ${i.what ?? i.description ?? 'покупка'} — ${fmt(i.remaining)} ${cur(i.currency)}`);
    const totals = [...byCur.entries()].map(([c, v]) => `${fmt(v)} ${cur(c)}`).join(' + ');
    const adv = advances.filter((a: any) => a.advance && a.direction === 'payable');
    const text = [
      `${cp.name}, сверка на ${dayjs().tz('Asia/Bishkek').format('DD.MM.YYYY')}:`,
      ...lines,
      `Итого долг: ${totals || '0 сом'}`,
      ...adv.map((a: any) => `Аванс: ${fmt(a.amount)} ${cur(a.currency)}`),
    ].join('\n');
    const phone = (cp.messengers?.whatsapp ?? cp.phone ?? '').replace(/\D/g, '');
    return {
      counterparty: { id: cp.id, name: cp.name, phone: cp.phone },
      items,
      totals: Object.fromEntries([...byCur.entries()].map(([c, v]) => [c, v.toFixed(2)])),
      text,
      whatsappUrl: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`,
      telegramUrl: `https://t.me/share/url?url=${encodeURIComponent(' ')}&text=${encodeURIComponent(text)}`,
    };
  }

  /** PDF сверки. */
  async statementPdf(counterpartyId: string, q: { vehicleId?: string }): Promise<Buffer> {
    const s = await this.statement(counterpartyId, q);
    const body: any[] = [[{ text: 'Дата', bold: true }, { text: 'Машина', bold: true }, { text: 'Что', bold: true }, { text: 'Сумма', bold: true, alignment: 'right' }]];
    for (const i of s.items as any[]) {
      body.push([
        dayjs(i.openedAt).tz('Asia/Bishkek').format('DD.MM.YYYY'),
        `${i.vehicleTitle ?? '—'}${i.plate ? `\n${i.plate}` : ''}`,
        i.what ?? i.description ?? '',
        { text: `${D(i.remaining).toFixed(2)} ${cur(i.currency)}`, alignment: 'right' },
      ]);
    }
    return this.pdf.render({
      pageSize: 'A4',
      pageMargins: [36, 36, 36, 36],
      content: [
        { text: `Сверка: ${s.counterparty.name}`, fontSize: 14, bold: true, margin: [0, 0, 0, 4] },
        { text: `на ${dayjs().tz('Asia/Bishkek').format('DD.MM.YYYY')}`, margin: [0, 0, 0, 12] },
        { table: { headerRows: 1, widths: [60, 110, '*', 80], body }, layout: 'lightHorizontalLines', fontSize: 9 },
        { text: `Итого: ${Object.entries(s.totals).map(([c, v]) => `${v} ${cur(c)}`).join(' + ') || '0'}`, bold: true, margin: [0, 12, 0, 0] },
      ],
      defaultStyle: { font: 'Roboto', fontSize: 10 },
    });
  }
}

const cur = (c: string) => (c === 'KGS' ? 'сом' : c === 'USD' ? '$' : c);
