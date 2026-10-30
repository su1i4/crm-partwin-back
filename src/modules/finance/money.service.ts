import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { D, Decimal, money } from '../../common/utils/decimal';
import { normalizePhone } from '../../common/utils/login';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { PriceResolverService } from '../pricing/price-resolver.service';
import { Register } from '../stores/entities/register.entity';
import { MONEY_ACCOUNT_TYPES, MoneyAccount, MoneyAccountDetails, MoneyAccountType } from './entities/money-account.entity';
import { MoneyKind, MoneyMovement, MoneyOperation, VerifyStatus } from './entities/money.entity';

export interface RecordMoney {
  accountId: string;
  /** Со знаком, в валюте счёта */
  amount: Decimal;
  kind: MoneyKind;
  /** Курс к сому для валютного счёта; по умолчанию — курс магазина */
  rate?: Decimal | null;
  documentId?: string | null;
  shiftId?: string | null;
  operationId?: string | null;
  debtPaymentId?: string | null;
  counterpartyId?: string | null;
  verifyStatus?: VerifyStatus | null;
  fileId?: string | null;
  comment?: string | null;
  movedAt?: Date;
}

export interface AccountInput {
  type?: MoneyAccountType;
  name?: string;
  currency?: string;
  storeId?: string | null;
  holderMembershipId?: string | null;
  details?: MoneyAccountDetails;
  isActive?: boolean;
}

/** Деньги (ТЗ 19.1, 19.2): счета, регистр движений, внесение, изъятие, перемещение, обмен валюты. */
@Injectable()
export class MoneyService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly resolver: PriceResolverService,
  ) {}

  // ── Регистр ──────────────────────────────────────────────

  async record(tx: TenantTx, r: RecordMoney): Promise<MoneyMovement> {
    const acc = await this.account(tx, r.accountId);
    if (!acc.isActive) throw Errors.bad('ACCOUNT_INACTIVE', `Счёт «${acc.name}» отключён`);
    const amount = money(r.amount);
    let rate = D(1);
    if (acc.currency !== 'KGS') {
      rate = r.rate ? D(r.rate) : D((await this.resolver.rates(tx))[acc.currency] ?? 0);
      if (rate.lte(0)) throw Errors.bad('NO_RATE', `Не задан курс магазина ${acc.currency}`);
    }
    return tx.repo(MoneyMovement).insert({
      accountId: acc.id,
      currency: acc.currency,
      amount,
      amountKgs: money(amount.mul(rate)),
      kind: r.kind,
      movedAt: r.movedAt ?? new Date(),
      documentId: r.documentId ?? null,
      shiftId: r.shiftId ?? null,
      operationId: r.operationId ?? null,
      debtPaymentId: r.debtPaymentId ?? null,
      counterpartyId: r.counterpartyId ?? null,
      membershipId: this.ctx.membershipId ?? null,
      verifyStatus: r.verifyStatus ?? null,
      fileId: r.fileId ?? null,
      comment: r.comment ?? null,
    });
  }

  async account(tx: TenantTx, id: string): Promise<MoneyAccount> {
    const key = `acc:${id}`;
    if (tx.memo.has(key)) return tx.memo.get(key) as MoneyAccount;
    const a = await tx.repo(MoneyAccount, 'Счёт').getById(id);
    tx.memo.set(key, a);
    return a;
  }

  async balance(tx: TenantTx, accountId: string): Promise<Decimal> {
    const [r] = await tx.query(`SELECT coalesce(sum(amount), 0) AS s FROM money_movements WHERE tenant_id = $1 AND account_id = $2`, [tx.tenantId, accountId]);
    return D(r.s);
  }

  /** Наличные кассы в валюте (создаются вместе с кассой: «Касса 1 — сомы / доллары»). */
  async registerCash(tx: TenantTx, registerId: string, currency: string): Promise<MoneyAccount> {
    const a = await tx.repo(MoneyAccount).findOne({ where: { registerId, currency, type: 'cash', isActive: true } });
    if (!a) throw Errors.bad('NO_CASH_ACCOUNT', `У кассы нет счёта наличных ${currency}`);
    return a;
  }

  async registerCashAccounts(tx: TenantTx, registerId: string): Promise<MoneyAccount[]> {
    return tx.repo(MoneyAccount).find({ where: { registerId, type: 'cash', isActive: true }, order: { currency: 'ASC' } });
  }

  // ── Счета ────────────────────────────────────────────────

  accounts(q: { storeId?: string; type?: string; includeInactive?: boolean }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const w = ['a.tenant_id = $1', 'a.deleted_at IS NULL'];
      if (!q.includeInactive) w.push('a.is_active');
      if (q.type) {
        params.push(q.type);
        w.push(`a.type = $${params.length}`);
      }
      if (q.storeId) {
        params.push(q.storeId);
        w.push(`(a.store_id = $${params.length} OR a.store_id IS NULL)`);
      }
      const allowed = this.scope.storeIds();
      if (allowed) {
        params.push(allowed);
        w.push(`(a.store_id IS NULL OR a.store_id = ANY($${params.length}::uuid[]))`);
      }
      const canSeeBalance = this.ctx.can('money.read');
      return tx.query(
        `SELECT a.id, a.type, a.name, a.currency, a.store_id AS "storeId", a.register_id AS "registerId",
                a.holder_membership_id AS "holderMembershipId", a.details, a.is_active AS "isActive", a.version
                ${canSeeBalance ? `, (SELECT coalesce(sum(m.amount), 0) FROM money_movements m WHERE m.tenant_id = a.tenant_id AND m.account_id = a.id) AS balance,
                (SELECT coalesce(sum(m.amount), 0) FROM money_movements m WHERE m.tenant_id = a.tenant_id AND m.account_id = a.id AND m.verify_status = 'unverified') AS unverified` : ''}
           FROM money_accounts a WHERE ${w.join(' AND ')}
          ORDER BY array_position(ARRAY['cash','safe','wallet','acquiring','bank','accountable'], a.type::text), a.name`,
        params,
      );
    });
  }

  createAccount(dto: AccountInput) {
    return this.tenantTx.run(async (tx) => {
      if (!dto.type || !(MONEY_ACCOUNT_TYPES as readonly string[]).includes(dto.type)) throw Errors.bad('BAD_TYPE', 'Неизвестный тип счёта');
      if (dto.type === 'cash') throw Errors.bad('CASH_BY_REGISTER', 'Счета наличных создаются вместе с кассой');
      if (!dto.name?.trim()) throw Errors.bad('NAME_REQUIRED', 'Укажите название счёта');
      if (dto.storeId) this.scope.assertStore(dto.storeId);
      if (dto.type === 'acquiring' && dto.details?.commissionPercent && (D(dto.details.commissionPercent).lt(0) || D(dto.details.commissionPercent).gt(10))) {
        throw Errors.bad('BAD_COMMISSION', 'Комиссия эквайринга от 0 до 10%');
      }
      const details = { ...(dto.details ?? {}) };
      if (details.phone) details.phone = normalizePhone(details.phone) ?? details.phone;
      const a = await tx.repo(MoneyAccount).insert({
        type: dto.type,
        name: dto.name.trim(),
        currency: dto.currency ?? 'KGS',
        storeId: dto.storeId ?? null,
        holderMembershipId: dto.holderMembershipId ?? null,
        details,
      });
      await this.audit.log(tx, { action: 'money_account.create', entityType: 'money_account', entityId: a.id, summary: a.name, important: true });
      return a;
    });
  }

  updateAccount(id: string, version: number, dto: AccountInput) {
    return this.tenantTx.run(async (tx) => {
      const a = await tx.repo(MoneyAccount, 'Счёт').getForUpdate(id, version);
      const before = { ...a };
      if (dto.currency && dto.currency !== a.currency) {
        const [{ n }] = await tx.query(`SELECT count(*)::int AS n FROM money_movements WHERE tenant_id = $1 AND account_id = $2`, [tx.tenantId, id]);
        if (n) throw Errors.conflict('ACCOUNT_USED', 'По счёту есть движения — валюту не поменять');
        a.currency = dto.currency;
      }
      if (dto.name) a.name = dto.name.trim();
      if (dto.holderMembershipId !== undefined) a.holderMembershipId = dto.holderMembershipId;
      if (dto.details) a.details = { ...a.details, ...dto.details };
      if (dto.isActive !== undefined) {
        if (!dto.isActive && !(await this.balance(tx, id)).isZero()) throw Errors.conflict('ACCOUNT_NOT_EMPTY', 'На счёте есть деньги — сначала переместите их');
        a.isActive = dto.isActive;
      }
      const saved = await tx.repo(MoneyAccount).save(a);
      await this.audit.log(tx, { action: 'money_account.update', entityType: 'money_account', entityId: a.id, before, after: saved, important: true });
      return saved;
    });
  }

  movements(q: { accountId?: string; shiftId?: string; from?: string; to?: string; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const w = ['m.tenant_id = $1'];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      if (q.accountId) w.push(`m.account_id = ${p(q.accountId)}`);
      if (q.shiftId) w.push(`m.shift_id = ${p(q.shiftId)}`);
      if (q.from) w.push(`m.moved_at >= ${p(q.from)}`);
      if (q.to) w.push(`m.moved_at < ${p(q.to)}`);
      const allowed = this.scope.storeIds();
      if (allowed) w.push(`EXISTS (SELECT 1 FROM money_accounts a WHERE a.id = m.account_id AND (a.store_id IS NULL OR a.store_id = ANY(${p(allowed)}::uuid[])))`);
      const where = w.join(' AND ');
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM money_movements m WHERE ${where}`, params);
      const items = await tx.query(
        `SELECT m.id, m.account_id AS "accountId", a.name AS "accountName", m.currency, m.amount, m.amount_kgs AS "amountKgs", m.kind,
                m.moved_at AS "movedAt", m.document_id AS "documentId", d.number AS "documentNumber", m.shift_id AS "shiftId",
                m.counterparty_id AS "counterpartyId", c.name AS "counterpartyName", m.verify_status AS "verifyStatus", m.comment
           FROM money_movements m JOIN money_accounts a ON a.id = m.account_id
           LEFT JOIN documents d ON d.id = m.document_id LEFT JOIN counterparties c ON c.id = m.counterparty_id
          WHERE ${where} ORDER BY m.moved_at DESC, m.seq DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total };
    });
  }

  // ── Операции (ТЗ 13.7, 19.2) ─────────────────────────────

  /**
   * Внесение (cash_in), изъятие (cash_out, куда: сейф / владельцу / банк — тогда это перемещение на тот счёт),
   * перемещение между счетами (transfer), обмен валюты в кассе (exchange: −доллары, +сомы по факту).
   */
  async operation(
    tx: TenantTx,
    dto: {
      type: 'cash_in' | 'cash_out' | 'transfer' | 'exchange';
      fromAccountId?: string | null;
      toAccountId?: string | null;
      amount: string;
      toAmount?: string | null;
      rate?: string | null;
      purpose?: string | null;
      comment?: string | null;
      shiftId?: string | null;
      storeId?: string | null;
    },
  ): Promise<MoneyOperation> {
    const amount = money(dto.amount);
    if (amount.lte(0)) throw Errors.bad('BAD_AMOUNT', 'Сумма должна быть больше нуля');
    const from = dto.fromAccountId ? await this.account(tx, dto.fromAccountId) : null;
    const to = dto.toAccountId ? await this.account(tx, dto.toAccountId) : null;
    for (const a of [from, to]) if (a?.storeId) this.scope.assertStore(a.storeId);
    let toAmount: Decimal | null = null;
    let rate: Decimal | null = null;
    let shopRate: Decimal | null = null;
    switch (dto.type) {
      case 'cash_in':
        if (!to) throw Errors.bad('ACCOUNT_REQUIRED', 'Куда внести');
        break;
      case 'cash_out':
        if (!from) throw Errors.bad('ACCOUNT_REQUIRED', 'Откуда изъять');
        // Изъятие в сейф / владельцу / в банк — перемещение на тот счёт
        if (to && to.currency !== from.currency) throw Errors.bad('CURRENCY_MISMATCH', 'Разные валюты — используйте обмен');
        if (to) toAmount = amount;
        break;
      case 'transfer':
        if (!from || !to || from.id === to.id) throw Errors.bad('ACCOUNTS_REQUIRED', 'Укажите два разных счёта');
        if (from.currency !== to.currency) throw Errors.bad('CURRENCY_MISMATCH', 'Разные валюты — используйте обмен');
        toAmount = amount;
        break;
      case 'exchange': {
        if (!from || !to || from.currency === to.currency) throw Errors.bad('EXCHANGE_ACCOUNTS', 'Обмен — между счетами разных валют');
        if (!dto.rate && !dto.toAmount) throw Errors.bad('RATE_REQUIRED', 'Укажите курс или сумму');
        // Курс — сомов за единицу валюты
        const foreign = from.currency !== 'KGS' ? from.currency : to.currency;
        const rates = await this.resolver.rates(tx);
        shopRate = rates[foreign] ? D(rates[foreign]) : null;
        if (dto.toAmount) {
          toAmount = money(dto.toAmount);
          rate = from.currency === 'KGS' ? amount.div(toAmount) : toAmount.div(amount);
        } else {
          rate = D(dto.rate!);
          toAmount = money(from.currency === 'KGS' ? amount.div(rate) : amount.mul(rate));
        }
        break;
      }
    }
    if (from && from.type === 'cash') {
      const bal = await this.balance(tx, from.id);
      if (bal.lt(amount)) throw Errors.conflict('NOT_ENOUGH_CASH', `На счёте «${from.name}» ${bal.toFixed(2)} ${from.currency}`);
    }
    const op = await tx.repo(MoneyOperation).insert({
      type: dto.type,
      storeId: dto.storeId ?? from?.storeId ?? to?.storeId ?? null,
      shiftId: dto.shiftId ?? null,
      fromAccountId: from?.id ?? null,
      toAccountId: to?.id ?? null,
      amount,
      toAmount,
      rate,
      shopRate,
      purpose: dto.purpose ?? null,
      comment: dto.comment ?? null,
      membershipId: this.ctx.membershipId ?? null,
    });
    const kind: MoneyKind = dto.type === 'transfer' ? 'transfer' : dto.type === 'exchange' ? 'exchange' : dto.type;
    const rateFor = (acc: MoneyAccount) => (acc.currency === 'KGS' ? D(1) : dto.type === 'exchange' ? rate : null);
    if (from) await this.record(tx, { accountId: from.id, amount: amount.neg(), kind, rate: rateFor(from), operationId: op.id, shiftId: dto.shiftId, comment: dto.comment });
    if (to) await this.record(tx, { accountId: to.id, amount: toAmount ?? amount, kind, rate: rateFor(to), operationId: op.id, shiftId: dto.shiftId, comment: dto.comment });
    await this.audit.log(tx, {
      action: `money.${dto.type}`,
      entityType: 'money_operation',
      entityId: op.id,
      summary: `${OPERATION_LABELS[dto.type]}: ${amount.toFixed(2)} ${from?.currency ?? to?.currency}${from ? ` из «${from.name}»` : ''}${to ? ` в «${to.name}»` : ''}`,
      important: true,
    });
    return op;
  }

  /** Касса для операции: счета наличных её валют. */
  async registerOf(tx: TenantTx, registerId: string): Promise<Register> {
    return tx.repo(Register, 'Касса').getById(registerId);
  }
}

export const OPERATION_LABELS: Record<string, string> = {
  cash_in: 'Внесение',
  cash_out: 'Изъятие',
  transfer: 'Перемещение денег',
  exchange: 'Обмен валюты',
};
