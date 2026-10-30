import { Injectable, OnModuleInit } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { dayjs, DEFAULT_TZ, localDateString } from '../../common/utils/dates';
import { D, money } from '../../common/utils/decimal';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Tenant } from '../tenants/entities/tenant.entity';
import { Expense, ExpenseArticle, ExpenseArticleKind, RecurringExpense, SalaryRule } from './entities/expense.entity';
import { MoneyService } from './money.service';

/** Статьи по умолчанию (ТЗ 19.2). Системные не удаляются, но переименовываются. */
const DEFAULT_ARTICLES: [string, string, ExpenseArticleKind][] = [
  ['rent', 'Аренда', 'expense'],
  ['salary', 'Зарплата', 'salary'],
  ['utilities', 'Коммунальные', 'expense'],
  ['delivery', 'Доставка', 'expense'],
  ['ads', 'Реклама', 'expense'],
  ['bank_fee', 'Банковские комиссии', 'expense'],
  ['other', 'Прочее', 'expense'],
  ['owner', 'Изъятие собственника', 'owner'],
];

export interface ExpenseInput {
  articleId?: string;
  articleCode?: string;
  accountId: string;
  amount: string;
  date?: string;
  storeId?: string | null;
  counterpartyId?: string | null;
  membershipId?: string | null;
  comment?: string | null;
}

function nextMonthDate(from: string, day: number): string {
  const m = dayjs(from).add(1, 'month');
  return m.date(Math.min(day, m.daysInMonth())).format('YYYY-MM-DD');
}

/** Расходы по статьям, регулярные расходы, изъятие собственника, мотивация продавцов (ТЗ 19.2, 19.7). */
@Injectable()
export class ExpensesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly money: MoneyService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobsService,
    private readonly platform: PlatformDb,
  ) {}

  async onModuleInit() {
    await this.jobs.work('expenses.recurring', async () => {
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) await this.runRecurring(t.id).catch(() => undefined);
    });
    await this.jobs.schedule('expenses.recurring', '40 6 * * *');
  }

  // ── Статьи ───────────────────────────────────────────────

  async ensureArticles(tx: TenantTx) {
    const [{ n }] = await tx.query(`SELECT count(*)::int AS n FROM expense_articles WHERE tenant_id = $1`, [tx.tenantId]);
    if (n) return;
    await tx.repo(ExpenseArticle).insertMany(DEFAULT_ARTICLES.map(([code, name, kind]) => ({ code, name, kind, isSystem: true })));
  }

  articles() {
    return this.tenantTx.run(async (tx) => {
      await this.ensureArticles(tx);
      return tx.repo(ExpenseArticle).find({ order: { isSystem: 'DESC', name: 'ASC' } });
    });
  }

  createArticle(dto: { name: string; kind?: ExpenseArticleKind }) {
    return this.tenantTx.run(async (tx) => {
      await this.ensureArticles(tx);
      const code = `custom_${Date.now().toString(36)}`;
      return tx.repo(ExpenseArticle).insert({ code, name: dto.name.trim().slice(0, 100), kind: dto.kind === 'salary' ? 'salary' : 'expense' });
    });
  }

  updateArticle(id: string, dto: { name?: string; isActive?: boolean }) {
    return this.tenantTx.run(async (tx) => {
      const a = await tx.repo(ExpenseArticle, 'Статья').getById(id);
      if (dto.name) a.name = dto.name.trim().slice(0, 100);
      if (dto.isActive !== undefined) {
        if (a.isSystem && !dto.isActive) throw Errors.bad('SYSTEM_ARTICLE', 'Системную статью нельзя отключить');
        a.isActive = dto.isActive;
      }
      return tx.repo(ExpenseArticle).save(a);
    });
  }

  private async article(tx: TenantTx, dto: { articleId?: string; articleCode?: string }) {
    await this.ensureArticles(tx);
    const a = dto.articleId
      ? await tx.repo(ExpenseArticle, 'Статья').getById(dto.articleId)
      : await tx.repo(ExpenseArticle).findOne({ where: { code: dto.articleCode ?? 'other' } });
    if (!a) throw Errors.notFound('Статья');
    if (!a.isActive) throw Errors.bad('ARTICLE_INACTIVE', `Статья «${a.name}» отключена`);
    return a;
  }

  // ── Расходы ──────────────────────────────────────────────

  create(dto: ExpenseInput) {
    return this.tenantTx.run((tx) => this.createInTx(tx, dto));
  }

  async createInTx(tx: TenantTx, dto: ExpenseInput, opts: { recurringId?: string; system?: boolean } = {}) {
    const art = await this.article(tx, dto);
    const acc = await this.money.account(tx, dto.accountId);
    if (acc.storeId) this.scope.assertStore(acc.storeId);
    if (art.kind === 'owner' && !opts.system && !this.ctx.isOwner) throw Errors.forbidden('Изъятие собственника делает владелец');
    if (art.kind === 'salary' && !dto.membershipId) throw Errors.bad('MEMBER_REQUIRED', 'Укажите сотрудника, кому зарплата');
    const amount = money(dto.amount);
    if (amount.lte(0)) throw Errors.bad('BAD_AMOUNT', 'Сумма должна быть больше нуля');
    if (acc.type === 'cash' || acc.type === 'safe') {
      const bal = await this.money.balance(tx, acc.id);
      if (bal.lt(amount)) throw Errors.conflict('NOT_ENOUGH_CASH', `На счёте «${acc.name}» ${bal.toFixed(2)} ${acc.currency}`);
    }
    // Расход из кассы во время смены — в X/Z-отчёт смены
    let shiftId: string | null = null;
    if (acc.registerId) {
      const [s] = await tx.query(`SELECT id FROM shifts WHERE tenant_id = $1 AND register_id = $2 AND status = 'open' LIMIT 1`, [tx.tenantId, acc.registerId]);
      shiftId = s?.id ?? null;
    }
    const date = dto.date ?? localDateString(new Date());
    const exp = await tx.repo(Expense).insert({
      articleId: art.id,
      accountId: acc.id,
      storeId: dto.storeId ?? acc.storeId ?? this.scope.currentStoreId() ?? null,
      currency: acc.currency,
      amount,
      amountKgs: amount, // уточняется ниже по курсу движения
      expenseDate: date,
      counterpartyId: dto.counterpartyId ?? null,
      membershipId: dto.membershipId ?? null,
      recurringId: opts.recurringId ?? null,
      comment: dto.comment?.slice(0, 500) ?? null,
    });
    const mv = await this.money.record(tx, {
      accountId: acc.id,
      amount: amount.neg(),
      kind: art.kind === 'owner' ? 'owner_withdrawal' : 'expense',
      operationId: exp.id,
      shiftId,
      counterpartyId: dto.counterpartyId ?? null,
      comment: `${art.name}${dto.comment ? `: ${dto.comment}` : ''}`.slice(0, 500),
      movedAt: date === localDateString(new Date()) ? new Date() : dayjs.tz(`${date} 12:00`, DEFAULT_TZ).toDate(),
    });
    exp.amountKgs = money(D(mv.amountKgs).neg());
    await tx.repo(Expense).save(exp);
    if (!opts.system) {
      await this.audit.log(tx, {
        action: art.kind === 'owner' ? 'money.owner_withdrawal' : 'money.expense',
        entityType: 'expense',
        entityId: exp.id,
        storeId: exp.storeId,
        summary: `${art.name}: ${amount.toFixed(2)} ${acc.currency} из «${acc.name}»`,
        important: true,
      });
    }
    return exp;
  }

  /** Отмена расхода: деньги возвращаются на счёт обратной записью. */
  cancel(id: string, reason?: string) {
    return this.tenantTx.run(async (tx) => {
      const [locked] = await tx.query(`SELECT id FROM expenses WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, id]);
      if (!locked) throw Errors.notFound('Расход');
      const e = await tx.repo(Expense, 'Расход').getById(id);
      if (e.status === 'cancelled') throw Errors.conflict('ALREADY_CANCELLED', 'Расход уже отменён');
      const art = await tx.repo(ExpenseArticle, 'Статья').getById(e.articleId);
      if (art.kind === 'owner' && !this.ctx.isOwner) throw Errors.forbidden('Изъятие отменяет владелец');
      await this.money.record(tx, {
        accountId: e.accountId,
        amount: D(e.amount),
        kind: art.kind === 'owner' ? 'owner_withdrawal' : 'expense',
        operationId: e.id,
        rate: e.currency === 'KGS' ? null : D(e.amountKgs).div(e.amount),
        comment: `Отмена: ${art.name}${reason ? ` — ${reason}` : ''}`.slice(0, 500),
      });
      e.status = 'cancelled';
      e.cancelledAt = new Date();
      await tx.repo(Expense).save(e);
      await this.audit.log(tx, { action: 'money.expense_cancel', entityType: 'expense', entityId: e.id, summary: `Отменён расход «${art.name}» ${D(e.amount).toFixed(2)} ${e.currency}`, important: true });
      return e;
    });
  }

  list(q: { from?: string; to?: string; articleId?: string; storeId?: string; kind?: string; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      await this.ensureArticles(tx);
      const params: unknown[] = [tx.tenantId];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const w = ['e.tenant_id = $1'];
      if (q.from) w.push(`e.expense_date >= ${p(q.from)}`);
      if (q.to) w.push(`e.expense_date <= ${p(q.to)}`);
      if (q.articleId) w.push(`e.article_id = ${p(q.articleId)}`);
      if (q.storeId) w.push(`e.store_id = ${p(q.storeId)}`);
      if (q.kind) w.push(`a.kind = ${p(q.kind)}`);
      const allowed = this.scope.storeIds();
      if (allowed) w.push(`(e.store_id IS NULL OR e.store_id = ANY(${p(allowed)}::uuid[]))`);
      const where = w.join(' AND ');
      const [{ total, sum }] = await tx.query(
        `SELECT count(*)::int AS total, coalesce(sum(e.amount_kgs) FILTER (WHERE e.status = 'posted'), 0) AS sum
           FROM expenses e JOIN expense_articles a ON a.id = e.article_id WHERE ${where}`,
        params,
      );
      const items = await tx.query(
        `SELECT e.id, e.expense_date AS "date", e.article_id AS "articleId", a.name AS "articleName", a.kind AS "articleKind",
                e.account_id AS "accountId", acc.name AS "accountName", e.currency, e.amount, e.amount_kgs AS "amountKgs",
                e.store_id AS "storeId", e.counterparty_id AS "counterpartyId", c.name AS "counterpartyName",
                e.membership_id AS "membershipId", u.name AS "memberName", e.recurring_id AS "recurringId", e.comment, e.status
           FROM expenses e JOIN expense_articles a ON a.id = e.article_id JOIN money_accounts acc ON acc.id = e.account_id
           LEFT JOIN counterparties c ON c.id = e.counterparty_id
           LEFT JOIN memberships m ON m.id = e.membership_id LEFT JOIN users u ON u.id = m.user_id
          WHERE ${where} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total, totalKgs: money(sum).toFixed(2) };
    });
  }

  // ── Регулярные расходы ───────────────────────────────────

  listRecurring() {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT r.id, r.version, r.article_id AS "articleId", a.name AS "articleName", r.account_id AS "accountId", acc.name AS "accountName",
                r.store_id AS "storeId", r.amount, acc.currency, r.counterparty_id AS "counterpartyId", r.day_of_month AS "dayOfMonth",
                r.next_date AS "nextDate", r.comment, r.is_active AS "isActive", r.last_run_at AS "lastRunAt"
           FROM recurring_expenses r JOIN expense_articles a ON a.id = r.article_id JOIN money_accounts acc ON acc.id = r.account_id
          WHERE r.tenant_id = $1 AND r.deleted_at IS NULL ORDER BY r.next_date`,
        [tx.tenantId],
      ),
    );
  }

  createRecurring(dto: { articleId?: string; articleCode?: string; accountId: string; amount: string; dayOfMonth: number; startDate?: string; storeId?: string; counterpartyId?: string; comment?: string }) {
    return this.tenantTx.run(async (tx) => {
      const art = await this.article(tx, dto);
      if (art.kind === 'owner') throw Errors.bad('OWNER_RECURRING', 'Изъятие собственника не делается по расписанию');
      if (art.kind === 'salary') throw Errors.bad('SALARY_RECURRING', 'Зарплата начисляется по мотивации, а не по расписанию');
      const acc = await this.money.account(tx, dto.accountId);
      if (acc.storeId) this.scope.assertStore(acc.storeId);
      if (money(dto.amount).lte(0)) throw Errors.bad('BAD_AMOUNT', 'Сумма должна быть больше нуля');
      const today = localDateString(new Date());
      const start = dto.startDate ?? today;
      const m = dayjs(start);
      let next = m.date(Math.min(dto.dayOfMonth, m.daysInMonth())).format('YYYY-MM-DD');
      if (next < start) next = nextMonthDate(next, dto.dayOfMonth);
      const r = await tx.repo(RecurringExpense).insert({
        articleId: art.id,
        accountId: acc.id,
        storeId: dto.storeId ?? acc.storeId ?? null,
        amount: money(dto.amount),
        counterpartyId: dto.counterpartyId ?? null,
        dayOfMonth: dto.dayOfMonth,
        nextDate: next,
        comment: dto.comment ?? null,
      });
      await this.audit.log(tx, { action: 'money.recurring_create', entityType: 'recurring_expense', entityId: r.id, summary: `${art.name}: ${money(dto.amount).toFixed(2)} ${acc.currency} каждое ${dto.dayOfMonth}-е`, important: true });
      return r;
    });
  }

  updateRecurring(id: string, version: number, dto: { amount?: string; dayOfMonth?: number; isActive?: boolean; comment?: string; accountId?: string }) {
    return this.tenantTx.run(async (tx) => {
      const r = await tx.repo(RecurringExpense, 'Регулярный расход').getForUpdate(id, version);
      if (dto.amount) r.amount = money(dto.amount);
      if (dto.accountId) r.accountId = (await this.money.account(tx, dto.accountId)).id;
      if (dto.dayOfMonth) {
        r.dayOfMonth = dto.dayOfMonth;
        const m = dayjs(r.nextDate);
        r.nextDate = m.date(Math.min(dto.dayOfMonth, m.daysInMonth())).format('YYYY-MM-DD');
      }
      if (dto.isActive !== undefined) r.isActive = dto.isActive;
      if (dto.comment !== undefined) r.comment = dto.comment;
      return tx.repo(RecurringExpense).save(r);
    });
  }

  /**
   * Провести наступившие регулярные расходы (каждое утро; пропущенные дни догоняются).
   * Не хватило денег в кассе — расход не создаётся, владельцу уведомление.
   */
  async runRecurring(tenantId: string, today = localDateString(new Date())) {
    return this.tenantTx.run(
      async (tx) => {
        const due = await tx.query(
          `SELECT id FROM recurring_expenses WHERE tenant_id = $1 AND is_active AND deleted_at IS NULL AND next_date <= $2 FOR UPDATE SKIP LOCKED`,
          [tx.tenantId, today],
        );
        let created = 0;
        for (const { id } of due) {
          const r = await tx.repo(RecurringExpense).getById(id);
          while (r.nextDate <= today) {
            const sp = `rec_${created}`;
            await tx.query(`SAVEPOINT ${sp}`);
            try {
              await this.createInTx(tx, { articleId: r.articleId, accountId: r.accountId, amount: D(r.amount).toFixed(2), date: r.nextDate, storeId: r.storeId, counterpartyId: r.counterpartyId, comment: r.comment ?? 'по расписанию' }, { recurringId: r.id, system: true });
              await tx.query(`RELEASE SAVEPOINT ${sp}`);
              created++;
            } catch (e: any) {
              await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
              await this.notifications.notify(tx, {
                type: 'money.recurring_failed',
                title: `Регулярный расход ${D(r.amount).toFixed(0)} сом на ${r.nextDate} не проведён: ${e?.message ?? 'ошибка'}`,
                entityType: 'recurring_expense',
                entityId: r.id,
                ownersOnly: true,
              });
              break;
            }
            r.nextDate = nextMonthDate(r.nextDate, r.dayOfMonth);
          }
          r.lastRunAt = new Date();
          await tx.repo(RecurringExpense).save(r);
        }
        return { due: due.length, created };
      },
      { tenantId, userId: null },
    );
  }

  // ── Мотивация (ТЗ 19.7) ──────────────────────────────────

  salaryRules() {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT m.id AS "membershipId", u.name, r.id, r.version, coalesce(r.base_monthly, 0) AS "baseMonthly", coalesce(r.percent, 0) AS percent,
                coalesce(r.basis, 'sales') AS basis, r.plan_monthly AS "planMonthly"
           FROM memberships m JOIN users u ON u.id = m.user_id
           LEFT JOIN salary_rules r ON r.tenant_id = m.tenant_id AND r.membership_id = m.id
          WHERE m.tenant_id = $1 AND m.status = 'active' ORDER BY u.name`,
        [tx.tenantId],
      ),
    );
  }

  setSalaryRule(membershipId: string, dto: { baseMonthly?: string; percent?: string; basis?: 'sales' | 'margin'; planMonthly?: string | null }) {
    if (!this.ctx.isOwner && !this.ctx.can('staff.manage')) throw Errors.forbidden();
    return this.tenantTx.run(async (tx) => {
      await tx.query(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, membershipId]).then((r) => {
        if (!r.length) throw Errors.notFound('Сотрудник');
      });
      if (dto.percent && (D(dto.percent).lt(0) || D(dto.percent).gt(50))) throw Errors.bad('BAD_PERCENT', 'Процент от 0 до 50');
      const repo = tx.repo(SalaryRule);
      const cur = await repo.findOne({ where: { membershipId } });
      const data = {
        baseMonthly: dto.baseMonthly !== undefined ? money(dto.baseMonthly) : (cur?.baseMonthly ?? money(0)),
        percent: dto.percent ?? cur?.percent ?? '0',
        basis: dto.basis ?? cur?.basis ?? 'sales',
        planMonthly: dto.planMonthly === undefined ? (cur?.planMonthly ?? null) : dto.planMonthly === null ? null : money(dto.planMonthly),
      };
      const saved = cur ? await repo.save(Object.assign(cur, data)) : await repo.insert({ membershipId, ...data });
      await this.audit.log(tx, { action: 'staff.salary_rule', entityType: 'membership', entityId: membershipId, after: data, important: true });
      return saved;
    });
  }
}
