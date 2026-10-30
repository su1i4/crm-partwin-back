import { Injectable, OnModuleInit } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { dayjs } from '../../common/utils/dates';
import { D, money } from '../../common/utils/decimal';
import { CountersService } from '../../database/tenant/counters.service';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { OutboxService } from '../../jobs/outbox.service';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { Register } from '../stores/entities/register.entity';
import { Store } from '../stores/entities/store.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { Membership } from '../users/entities/membership.entity';
import { CashByCurrency, Shift, ShiftHandover } from './entities/money.entity';
import { MoneyService } from './money.service';

/** Кассовая смена (ТЗ 13.7): открытие с пересчётом, передача кассы, X и Z-отчёт, напоминание и автозакрытие. */
@Injectable()
export class ShiftsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly money: MoneyService,
    private readonly counters: CountersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobsService,
    private readonly platform: PlatformDb,
  ) {}

  async onModuleInit() {
    await this.jobs.work('shift.maintenance', async () => {
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) await this.maintain(t.id).catch(() => undefined);
    });
    await this.jobs.schedule('shift.maintenance', '*/10 * * * *');
  }

  // ── Чтение ───────────────────────────────────────────────

  /** Открытая смена кассы (или null). */
  async openShift(tx: TenantTx, registerId: string): Promise<Shift | null> {
    return tx.repo(Shift).findOne({ where: { registerId, status: 'open' } });
  }

  /** Для продажи: смена открыта; при «передаче кассы» продаёт только текущий продавец. */
  async requireOpenShift(tx: TenantTx, registerId: string): Promise<Shift> {
    const shift = await this.openShift(tx, registerId);
    if (!shift) throw Errors.conflict('SHIFT_CLOSED', 'Смена на кассе не открыта');
    const s = await this.settings.get(tx);
    // Офлайн-операции кассы (контекст устройства) приходят задним числом — передачу кассы не проверяем
    if (s.cashHandover && !this.ctx.get('deviceId') && shift.currentMembershipId !== this.ctx.membershipId) {
      throw Errors.conflict('SHIFT_HANDOVER_REQUIRED', 'Касса у другого продавца — примите кассу с пересчётом');
    }
    return shift;
  }

  current(registerId: string) {
    return this.tenantTx.run(async (tx) => {
      const reg = await this.registerFor(tx, registerId);
      const shift = await this.openShift(tx, reg.id);
      const last = shift ? null : await tx.repo(Shift).findOne({ where: { registerId: reg.id }, order: { number: 'DESC' } });
      const accounts = await this.money.registerCashAccounts(tx, reg.id);
      const cash: CashByCurrency = {};
      for (const a of accounts) cash[a.currency] = (await this.money.balance(tx, a.id)).toFixed(2);
      return { register: reg, shift, lastClosed: last, cashBalance: cash };
    });
  }

  list(q: { registerId?: string; storeId?: string; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const w = ['s.tenant_id = $1', 's.deleted_at IS NULL'];
      if (q.registerId) {
        params.push(q.registerId);
        w.push(`s.register_id = $${params.length}`);
      }
      if (q.storeId) {
        params.push(q.storeId);
        w.push(`s.store_id = $${params.length}`);
      }
      const allowed = this.scope.storeIds();
      if (allowed) {
        params.push(allowed);
        w.push(`s.store_id = ANY($${params.length}::uuid[])`);
      }
      const where = w.join(' AND ');
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM shifts s WHERE ${where}`, params);
      const items = await tx.query(
        `SELECT s.id, s.number, s.status, s.register_id AS "registerId", r.name AS "registerName", s.store_id AS "storeId",
                s.opened_at AS "openedAt", s.closed_at AS "closedAt", s.opening, s.counted, s.expected, s.diff, s.auto_closed AS "autoClosed",
                uo.name AS "openedByName", uc.name AS "closedByName"
           FROM shifts s JOIN registers r ON r.id = s.register_id
           LEFT JOIN memberships mo ON mo.id = s.opened_by LEFT JOIN users uo ON uo.id = mo.user_id
           LEFT JOIN memberships mc ON mc.id = s.closed_by LEFT JOIN users uc ON uc.id = mc.user_id
          WHERE ${where} ORDER BY s.opened_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total };
    });
  }

  // ── Открытие ─────────────────────────────────────────────

  open(registerId: string, opening: CashByCurrency) {
    return this.tenantTx.run(async (tx) => {
      const reg = await this.registerFor(tx, registerId);
      if (!reg.isActive) throw Errors.bad('REGISTER_INACTIVE', 'Касса отключена');
      // Блокируем кассу — две параллельные попытки открыть смену не пройдут
      await tx.query(`SELECT id FROM registers WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, reg.id]);
      if (await this.openShift(tx, reg.id)) throw Errors.conflict('SHIFT_ALREADY_OPEN', 'Смена уже открыта — сначала закройте её');
      const membershipId = this.ctx.membershipId;
      if (!membershipId) throw Errors.forbidden();
      const number = await this.counters.next(tx, `shift:${reg.id}`);
      const shift = await tx.repo(Shift).insert({
        registerId: reg.id,
        storeId: reg.storeId,
        number,
        status: 'open',
        openedAt: new Date(),
        openedBy: membershipId,
        currentMembershipId: membershipId,
        opening: {},
        openingDiff: {},
      });
      const { counted, diff } = await this.recount(tx, reg.id, shift.id, opening, 'Расхождение при открытии смены');
      shift.opening = counted;
      shift.openingDiff = diff;
      await tx.repo(Shift).save(shift);
      await this.audit.log(tx, {
        action: 'shift.open',
        entityType: 'shift',
        entityId: shift.id,
        storeId: reg.storeId,
        summary: `${reg.name}: смена №${number} открыта`,
        after: { opening: counted, diff },
      });
      await this.outbox.emit(tx, 'shift.changed', { storeId: reg.storeId, registerId: reg.id, shiftId: shift.id, status: 'open' });
      return shift;
    });
  }

  /**
   * Пересчёт наличных: введённое vs остаток счёта. Разница проводится движением shift_diff,
   * чтобы остаток счёта совпал с фактом. Валюты, которые не ввели, считаются как есть.
   */
  private async recount(tx: TenantTx, registerId: string, shiftId: string, input: CashByCurrency, comment: string) {
    const accounts = await this.money.registerCashAccounts(tx, registerId);
    const counted: CashByCurrency = {};
    const expected: CashByCurrency = {};
    const diff: CashByCurrency = {};
    for (const a of accounts) {
      const bal = await this.money.balance(tx, a.id);
      const fact = input[a.currency] !== undefined && input[a.currency] !== null && input[a.currency] !== '' ? money(input[a.currency]) : bal;
      if (fact.isNegative()) throw Errors.bad('BAD_AMOUNT', 'Сумма не может быть отрицательной');
      expected[a.currency] = bal.toFixed(2);
      counted[a.currency] = fact.toFixed(2);
      const d = fact.minus(bal);
      diff[a.currency] = d.toFixed(2);
      if (!d.isZero()) await this.money.record(tx, { accountId: a.id, amount: d, kind: 'shift_diff', shiftId, comment });
    }
    for (const cur of Object.keys(input)) if (!(cur in counted)) throw Errors.bad('BAD_CURRENCY', `У кассы нет наличных в ${cur}`);
    return { counted, expected, diff };
  }

  // ── Внесение, изъятие, обмен в смене ─────────────────────

  cashOperation(
    shiftId: string,
    dto: { type: 'cash_in' | 'cash_out' | 'exchange'; currency?: string; amount: string; toAccountId?: string | null; purpose?: string; rate?: string; toAmount?: string; comment?: string },
  ) {
    return this.tenantTx.run(async (tx) => {
      const shift = await tx.repo(Shift, 'Смена').getById(shiftId);
      this.scope.assertStore(shift.storeId);
      if (shift.status !== 'open') throw Errors.conflict('SHIFT_CLOSED', 'Смена закрыта');
      if (dto.type === 'exchange') {
        // Обмен в кассе: −доллары, +сомы по фактическому курсу; разница с курсом магазина — в отчёт
        const fromCur = dto.currency ?? 'USD';
        const from = await this.money.registerCash(tx, shift.registerId, fromCur);
        const to = await this.money.registerCash(tx, shift.registerId, fromCur === 'KGS' ? 'USD' : 'KGS');
        return this.money.operation(tx, { type: 'exchange', fromAccountId: from.id, toAccountId: to.id, amount: dto.amount, rate: dto.rate, toAmount: dto.toAmount, comment: dto.comment, shiftId, storeId: shift.storeId });
      }
      const cash = await this.money.registerCash(tx, shift.registerId, dto.currency ?? 'KGS');
      if (dto.type === 'cash_in') {
        return this.money.operation(tx, { type: 'cash_in', toAccountId: cash.id, fromAccountId: dto.toAccountId ?? null, amount: dto.amount, purpose: dto.purpose, comment: dto.comment, shiftId, storeId: shift.storeId });
      }
      if (!dto.purpose) throw Errors.bad('PURPOSE_REQUIRED', 'Укажите, куда изъяли: сейф, владельцу, банк');
      return this.money.operation(tx, { type: 'cash_out', fromAccountId: cash.id, toAccountId: dto.toAccountId ?? null, amount: dto.amount, purpose: dto.purpose, comment: dto.comment, shiftId, storeId: shift.storeId });
    });
  }

  // ── Передача кассы ───────────────────────────────────────

  handover(shiftId: string, version: number, toMembershipId: string, counted: CashByCurrency) {
    return this.tenantTx.run(async (tx) => {
      const shift = await tx.repo(Shift, 'Смена').getForUpdate(shiftId, version);
      this.scope.assertStore(shift.storeId);
      if (shift.status !== 'open') throw Errors.conflict('SHIFT_CLOSED', 'Смена закрыта');
      const s = await this.settings.get(tx);
      if (!s.cashHandover) throw Errors.bad('HANDOVER_DISABLED', 'Передача кассы выключена в настройках');
      const to = await tx.repo(Membership, 'Сотрудник').getById(toMembershipId);
      if (to.status !== 'active') throw Errors.bad('MEMBER_DISABLED', 'Сотрудник отключён');
      if (to.id === shift.currentMembershipId) throw Errors.bad('SAME_SELLER', 'Касса уже у этого продавца');
      const r = await this.recount(tx, shift.registerId, shift.id, counted, 'Расхождение при передаче кассы');
      const h = await tx.repo(ShiftHandover).insert({ shiftId: shift.id, fromMembershipId: shift.currentMembershipId, toMembershipId: to.id, ...r });
      shift.currentMembershipId = to.id;
      await tx.repo(Shift).save(shift);
      await this.audit.log(tx, { action: 'shift.handover', entityType: 'shift', entityId: shift.id, storeId: shift.storeId, summary: 'Передача кассы', after: r, important: hasDiff(r.diff) });
      if (hasDiff(r.diff)) await this.notifyDiff(tx, shift, r.diff, 'при передаче кассы');
      return { shift, handover: h };
    });
  }

  // ── Отчёты и закрытие ────────────────────────────────────

  xReport(shiftId: string) {
    return this.tenantTx.run(async (tx) => {
      const shift = await tx.repo(Shift, 'Смена').getById(shiftId);
      this.scope.assertStore(shift.storeId);
      return shift.status === 'closed' && shift.zReport ? shift.zReport : this.report(tx, shift);
    });
  }

  close(shiftId: string, version: number, counted: CashByCurrency) {
    return this.tenantTx.run(async (tx) => {
      const shift = await tx.repo(Shift, 'Смена').getForUpdate(shiftId, version);
      this.scope.assertStore(shift.storeId);
      return this.closeInTx(tx, shift, counted, false);
    });
  }

  private async closeInTx(tx: TenantTx, shift: Shift, counted: CashByCurrency, auto: boolean) {
    if (shift.status !== 'open') throw Errors.conflict('SHIFT_CLOSED', 'Смена уже закрыта');
    const deferred = await tx.query(`SELECT count(*)::int AS n FROM receipts WHERE tenant_id = $1 AND shift_id = $2 AND status = 'open'`, [tx.tenantId, shift.id]);
    if (deferred[0].n && !auto) throw Errors.conflict('OPEN_RECEIPTS', 'На кассе есть незавершённые чеки — оплатите, отложите или отмените их');
    const r = await this.recount(tx, shift.registerId, shift.id, counted, auto ? 'Автозакрытие смены' : 'Расхождение при закрытии смены');
    shift.status = 'closed';
    shift.closedAt = new Date();
    shift.closedBy = auto ? null : (this.ctx.membershipId ?? null);
    shift.counted = r.counted;
    shift.expected = r.expected;
    shift.diff = r.diff;
    shift.autoClosed = auto;
    shift.zReport = await this.report(tx, shift);
    await tx.repo(Shift).save(shift);
    // Незавершённые чеки закрытой смены становятся отложенными — их можно продолжить в новой смене
    await tx.query(`UPDATE receipts SET status = 'deferred', shift_id = NULL, version = version + 1 WHERE tenant_id = $1 AND shift_id = $2 AND status = 'open'`, [tx.tenantId, shift.id]);
    await this.audit.log(tx, {
      action: auto ? 'shift.auto_close' : 'shift.close',
      entityType: 'shift',
      entityId: shift.id,
      storeId: shift.storeId,
      summary: `Смена №${shift.number} закрыта${auto ? ' автоматически' : ''}`,
      after: { counted: r.counted, expected: r.expected, diff: r.diff },
      important: hasDiff(r.diff),
    });
    if (hasDiff(r.diff)) await this.notifyDiff(tx, shift, r.diff, 'при закрытии смены');
    await this.outbox.emit(tx, 'shift.changed', { storeId: shift.storeId, registerId: shift.registerId, shiftId: shift.id, status: 'closed' });
    return shift;
  }

  private async notifyDiff(tx: TenantTx, shift: Shift, diff: CashByCurrency, when: string) {
    const text = Object.entries(diff)
      .filter(([, v]) => !D(v).isZero())
      .map(([c, v]) => `${D(v).gt(0) ? '+' : ''}${v} ${c}`)
      .join(', ');
    await this.notifications.notify(tx, {
      type: 'shift.discrepancy',
      title: `Расхождение ${when}: ${text}`,
      entityType: 'shift',
      entityId: shift.id,
      storeId: shift.storeId,
      permission: 'money.read',
      link: `/shifts/${shift.id}`,
    });
  }

  /** X / Z-отчёт смены: итоги по способам оплаты, по кошелькам, возвраты, скидки, долги, «сдать владельцу». */
  async report(tx: TenantTx, shift: Shift) {
    const t = tx.tenantId;
    const [sales] = await tx.query(
      `SELECT count(*) FILTER (WHERE kind = 'sale')::int AS "salesCount",
              coalesce(sum(total) FILTER (WHERE kind = 'sale'), 0) AS "salesTotal",
              count(*) FILTER (WHERE kind = 'return')::int AS "returnsCount",
              coalesce(sum(total) FILTER (WHERE kind = 'return'), 0) AS "returnsTotal",
              coalesce(sum(discount_total) FILTER (WHERE kind = 'sale'), 0) AS "discountsTotal",
              coalesce(sum(debt_amount) FILTER (WHERE kind = 'sale'), 0) AS "debtTotal"
         FROM receipts WHERE tenant_id = $1 AND shift_id = $2 AND status = 'completed'`,
      [t, shift.id],
    );
    const byMethod = await tx.query(
      `SELECT p.method, p.currency, sum(p.amount) AS amount, sum(p.amount_kgs) AS "amountKgs"
         FROM receipt_payments p JOIN receipts r ON r.id = p.receipt_id
        WHERE p.tenant_id = $1 AND r.shift_id = $2 AND r.status = 'completed'
        GROUP BY p.method, p.currency ORDER BY p.method, p.currency`,
      [t, shift.id],
    );
    const byAccount = await tx.query(
      `SELECT a.id AS "accountId", a.name, a.type, a.currency, sum(m.amount) AS amount,
              sum(m.amount) FILTER (WHERE m.verify_status = 'unverified') AS unverified
         FROM money_movements m JOIN money_accounts a ON a.id = m.account_id
        WHERE m.tenant_id = $1 AND m.shift_id = $2 AND m.kind IN ('sale', 'refund', 'debt_in', 'fee')
        GROUP BY a.id, a.name, a.type, a.currency ORDER BY a.type, a.name`,
      [t, shift.id],
    );
    // Переводы на личный кошелёк продавца — продавец сдаёт владельцу (ТЗ 13.7)
    const toOwner = await tx.query(
      `SELECT a.holder_membership_id AS "membershipId", u.name AS "holderName", a.name AS "accountName", sum(m.amount) AS amount
         FROM money_movements m JOIN money_accounts a ON a.id = m.account_id
         JOIN memberships ms ON ms.id = a.holder_membership_id LEFT JOIN users u ON u.id = ms.user_id
        WHERE m.tenant_id = $1 AND m.shift_id = $2 AND a.type = 'wallet' AND NOT ms.is_owner AND m.kind IN ('sale', 'refund', 'debt_in')
        GROUP BY 1, 2, 3 HAVING sum(m.amount) <> 0`,
      [t, shift.id],
    );
    const operations = await tx.query(
      `SELECT o.id, o.type, o.amount, o.to_amount AS "toAmount", o.rate, o.shop_rate AS "shopRate", o.purpose, o.comment, o.created_at AS "at",
              fa.name AS "fromAccount", fa.currency AS "fromCurrency", ta.name AS "toAccount", ta.currency AS "toCurrency"
         FROM money_operations o LEFT JOIN money_accounts fa ON fa.id = o.from_account_id LEFT JOIN money_accounts ta ON ta.id = o.to_account_id
        WHERE o.tenant_id = $1 AND o.shift_id = $2 ORDER BY o.created_at`,
      [t, shift.id],
    );
    // Курсовая разница обменов: (фактический курс − курс магазина) × сумма валюты
    let exchangeDiff = D(0);
    for (const o of operations.filter((x: any) => x.type === 'exchange' && x.shopRate)) {
      const foreignAmount = o.fromCurrency === 'KGS' ? D(o.toAmount) : D(o.amount);
      const sign = o.fromCurrency === 'KGS' ? -1 : 1;
      exchangeDiff = exchangeDiff.plus(D(o.rate).minus(o.shopRate).mul(foreignAmount).mul(sign));
    }
    const cash = [];
    for (const a of await this.money.registerCashAccounts(tx, shift.registerId)) {
      const [m] = await tx.query(
        `SELECT coalesce(sum(amount) FILTER (WHERE kind IN ('sale')), 0) AS sales,
                coalesce(sum(amount) FILTER (WHERE kind IN ('refund')), 0) AS refunds,
                coalesce(sum(amount) FILTER (WHERE kind IN ('debt_in', 'debt_out')), 0) AS debts,
                coalesce(sum(amount) FILTER (WHERE kind IN ('cash_in', 'cash_out', 'transfer', 'exchange')), 0) AS operations,
                coalesce(sum(amount) FILTER (WHERE kind = 'shift_diff'), 0) AS diffs
           FROM money_movements WHERE tenant_id = $1 AND account_id = $2 AND shift_id = $3`,
        [t, a.id, shift.id],
      );
      cash.push({
        accountId: a.id,
        currency: a.currency,
        opening: shift.opening[a.currency] ?? '0.00',
        ...m,
        balance: (await this.money.balance(tx, a.id)).toFixed(2),
      });
    }
    const handovers = await tx.repo(ShiftHandover).find({ where: { shiftId: shift.id }, order: { createdAt: 'ASC' } });
    const reg = await tx.repo(Register).findById(shift.registerId);
    return {
      shiftId: shift.id,
      number: shift.number,
      register: reg?.name,
      status: shift.status,
      openedAt: shift.openedAt,
      closedAt: shift.closedAt,
      ...sales,
      byMethod,
      byAccount,
      toOwner: { items: toOwner, total: toOwner.reduce((s: any, x: any) => s.plus(x.amount), D(0)).toFixed(2) },
      operations,
      exchangeDiff: money(exchangeDiff).toFixed(2),
      cash,
      handovers,
      counted: shift.counted,
      expected: shift.expected,
      diff: shift.diff,
      generatedAt: new Date(),
    };
  }

  // ── Напоминание и автозакрытие (каждые 10 минут) ─────────

  private async maintain(tenantId: string) {
    await this.tenantTx.run(
      async (tx) => {
        const shifts = await tx.repo(Shift).find({ where: { status: 'open' } });
        if (!shifts.length) return;
        const s = await this.settings.get(tx);
        for (const shift of shifts) {
          const store = await tx.repo(Store).findById(shift.storeId);
          const now = dayjs().tz(store?.timezone ?? 'Asia/Bishkek');
          const hm = now.format('HH:mm');
          const openedLocal = dayjs(shift.openedAt).tz(store?.timezone ?? 'Asia/Bishkek');
          if (s.shiftAutoCloseTime && hm >= s.shiftAutoCloseTime && openedLocal.format('YYYY-MM-DD HH:mm') < `${now.format('YYYY-MM-DD')} ${s.shiftAutoCloseTime}`) {
            await this.closeInTx(tx, shift, {}, true);
            continue;
          }
          // Забыли закрыть: напоминание в конце рабочего дня (время вечерней сводки) или если смена старше суток
          const late = hm >= s.eveningSummaryTime || now.diff(openedLocal, 'hour') >= 24;
          if (!late) continue;
          const [{ n }] = await tx.query(
            `SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND type = 'shift.not_closed' AND entity_id = $2 AND created_at > now() - interval '20 hours'`,
            [tx.tenantId, shift.id],
          );
          if (n) continue;
          const reg = await tx.repo(Register).findById(shift.registerId);
          await this.notifications.notify(tx, {
            type: 'shift.not_closed',
            title: `${reg?.name ?? 'Касса'}: смена №${shift.number} не закрыта`,
            entityType: 'shift',
            entityId: shift.id,
            storeId: shift.storeId,
            permission: 'pos.shift',
            link: `/pos/shift`,
          });
        }
      },
      { tenantId, userId: null },
    );
  }

  private async registerFor(tx: TenantTx, registerId: string) {
    const reg = await tx.repo(Register, 'Касса').getById(registerId);
    this.scope.assertStore(reg.storeId);
    return reg;
  }
}

const hasDiff = (d: CashByCurrency) => Object.values(d).some((v) => !D(v).isZero());
