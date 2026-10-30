import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { dayjs } from '../../common/utils/dates';
import { D, money } from '../../common/utils/decimal';
import { readTable, tableKind } from '../../common/utils/table-reader';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { DebtsService } from '../finance/debts.service';
import { MoneyMovement } from '../finance/entities/money.entity';
import { MoneyService } from '../finance/money.service';
import { StoredFile } from '../files/entities/file.entity';
import { FilesService } from '../files/files.service';
import { Receipt, ReceiptPayment } from './entities/receipt.entity';
import { ReturnsService } from './returns.service';

/**
 * Сверка переводов (ТЗ 19.3): каждый перевод на кошелёк — «не сверено»; владелец отмечает галочкой
 * или загружает выписку; «не поступило» → долг клиента или отмена чека.
 */
@Injectable()
export class TransfersCheckService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly money: MoneyService,
    private readonly debts: DebtsService,
    private readonly returns: ReturnsService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  list(q: { status?: string; accountId?: string; membershipId?: string; from?: string; to?: string; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const w = ['m.tenant_id = $1', 'm.verify_status IS NOT NULL'];
      w.push(`m.verify_status = ${p(q.status ?? 'unverified')}`);
      if (q.accountId) w.push(`m.account_id = ${p(q.accountId)}`);
      if (q.membershipId) w.push(`m.membership_id = ${p(q.membershipId)}`);
      if (q.from) w.push(`m.moved_at >= ${p(q.from)}`);
      if (q.to) w.push(`m.moved_at < ${p(q.to)}`);
      const allowed = this.scope.storeIds();
      if (allowed) w.push(`(a.store_id IS NULL OR a.store_id = ANY(${p(allowed)}::uuid[]))`);
      const where = w.join(' AND ');
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM money_movements m JOIN money_accounts a ON a.id = m.account_id WHERE ${where}`, params);
      const items = await tx.query(
        `SELECT m.id, m.account_id AS "accountId", a.name AS "accountName", m.amount, m.currency, m.moved_at AS "movedAt", m.verify_status AS "status",
                m.document_id AS "documentId", r.id AS "receiptId", r.number AS "receiptNumber", c.name AS "customerName", u.name AS "sellerName", m.file_id AS "fileId"
           FROM money_movements m JOIN money_accounts a ON a.id = m.account_id
           LEFT JOIN receipts r ON r.document_id = m.document_id LEFT JOIN counterparties c ON c.id = m.counterparty_id
           LEFT JOIN memberships ms ON ms.id = m.membership_id LEFT JOIN users u ON u.id = ms.user_id
          WHERE ${where} ORDER BY m.moved_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total };
    });
  }

  /** Отчёт «Несверенные переводы» по дням, продавцам и кошелькам. */
  summary(q: { from?: string; to?: string }) {
    return this.tenantTx.run(async (tx) => {
      const params = [tx.tenantId, q.from ?? '1970-01-01', q.to ?? '2999-01-01'];
      const base = `FROM money_movements m JOIN money_accounts a ON a.id = m.account_id LEFT JOIN memberships ms ON ms.id = m.membership_id LEFT JOIN users u ON u.id = ms.user_id
                    WHERE m.tenant_id = $1 AND m.verify_status = 'unverified' AND m.moved_at >= $2 AND m.moved_at < $3`;
      const sel = `count(*)::int AS count, sum(m.amount) AS amount`;
      return {
        byDay: await tx.query(`SELECT (m.moved_at AT TIME ZONE 'Asia/Bishkek')::date AS day, ${sel} ${base} GROUP BY 1 ORDER BY 1 DESC`, params),
        bySeller: await tx.query(`SELECT m.membership_id AS "membershipId", coalesce(u.name, '—') AS seller, ${sel} ${base} GROUP BY 1, 2 ORDER BY 4 DESC`, params),
        byWallet: await tx.query(`SELECT a.id AS "accountId", a.name AS wallet, ${sel} ${base} GROUP BY 1, 2 ORDER BY 4 DESC`, params),
      };
    });
  }

  /** Отметить «пришло». */
  verify(ids: string[]) {
    return this.tenantTx.run(async (tx) => {
      const res = await tx.query(
        `UPDATE money_movements SET verify_status = 'verified', verified_at = now(), verified_by = $3
          WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND verify_status = 'unverified' RETURNING id`,
        [tx.tenantId, ids, this.ctx.membershipId ?? null],
      );
      const rows: any[] = Array.isArray(res[0]) ? res[0] : res;
      await this.audit.log(tx, { action: 'transfer.verify', entityType: 'money_movement', summary: `Сверено переводов: ${rows.length}`, after: { ids: rows.map((r: any) => r.id) } });
      return { verified: rows.length };
    });
  }

  /**
   * «Не поступило»: debt — сумма становится долгом клиента; cancel — чек отменяется (возврат товара,
   * остальные оплаты возвращаются теми же способами).
   */
  notReceived(id: string, dto: { action: 'debt' | 'cancel'; counterpartyId?: string; registerId?: string; comment?: string }) {
    return this.tenantTx.run(async (tx) => {
      await tx.query(`SELECT id FROM money_movements WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, id]);
      const m = await tx.repo(MoneyMovement, 'Перевод').getById(id);
      if (m.verifyStatus !== 'unverified') throw Errors.conflict('NOT_UNVERIFIED', 'Перевод уже сверен');
      const receipt = m.documentId ? await tx.repo(Receipt).findOne({ where: { documentId: m.documentId } }) : null;
      const payment = receipt ? await tx.repo(ReceiptPayment).findOne({ where: { moneyMovementId: m.id } }) : null;
      // Сторно поступления на кошелёк
      await this.money.record(tx, {
        accountId: m.accountId,
        amount: m.amount.neg(),
        kind: 'not_received',
        documentId: m.documentId,
        counterpartyId: m.counterpartyId,
        comment: dto.comment ?? 'Перевод не поступил',
      });
      await tx.query(`UPDATE money_movements SET verify_status = 'not_received', verified_at = now(), verified_by = $3 WHERE tenant_id = $1 AND id = $2`, [
        tx.tenantId,
        m.id,
        this.ctx.membershipId ?? null,
      ]);
      let result: Record<string, any> = {};
      if (dto.action === 'debt') {
        const cp = dto.counterpartyId ?? receipt?.customerId ?? m.counterpartyId;
        if (!cp) throw Errors.bad('CUSTOMER_REQUIRED', 'У чека нет клиента — укажите, на кого записать долг');
        const item = await this.debts.open(tx, {
          counterpartyId: cp,
          direction: 'receivable',
          kind: 'not_received',
          currency: m.currency,
          amount: m.amount,
          documentId: m.documentId,
          customerVehicleId: receipt?.customerVehicleId ?? null,
          description: `Перевод не поступил${receipt ? `: чек ${receipt.number}` : ''}`,
          storeId: receipt?.storeId ?? null,
        });
        result = { debtItemId: item.id };
      } else {
        if (!receipt || !payment) throw Errors.bad('NO_RECEIPT', 'Перевод не привязан к чеку — отменять нечего');
        const ret = await this.returns.cancelReceiptInTx(tx, receipt, dto.registerId ?? receipt.registerId, payment.id);
        result = { returnReceiptId: ret.id };
      }
      await this.audit.log(tx, {
        action: 'transfer.not_received',
        entityType: 'money_movement',
        entityId: m.id,
        summary: `Перевод ${m.amount.toFixed(2)} ${m.currency} не поступил → ${dto.action === 'debt' ? 'долг клиента' : 'отмена чека'}`,
        important: true,
      });
      return { status: 'not_received', ...result };
    });
  }

  /**
   * Выписка банка (Excel/CSV): ищем колонки даты и суммы, сопоставляем с несверенными переводами этого кошелька
   * по сумме и времени (окно из настроек). Возвращает пары для подтверждения.
   */
  match(dto: { accountId: string; fileId: string; windowMinutes?: number }) {
    return this.tenantTx.run(async (tx) => {
      const acc = await this.money.account(tx, dto.accountId);
      const f = await tx.repo(StoredFile, 'Файл').getById(dto.fileId);
      const kind = tableKind(f.originalName ?? '', f.mime ?? '');
      if (!kind) throw Errors.bad('BAD_FILE', 'Нужен файл Excel (.xlsx) или CSV');
      const s = await tx.query(`SELECT data FROM tenant_settings WHERE tenant_id = $1`, [tx.tenantId]);
      const window = dto.windowMinutes ?? s[0]?.data?.transferMatchWindowMinutes ?? 120;
      const rows: { row: number; at: Date; amount: string }[] = [];
      let dateCol = -1;
      let amountCol = -1;
      await readTable(this.files.pathOf(f), kind, (no, cells) => {
        if (dateCol < 0 || amountCol < 0) {
          const lower = cells.map((c) => c.toLowerCase());
          const d = lower.findIndex((c) => /дата|date|время/.test(c));
          const a = lower.findIndex((c) => /сумма|amount|приход|зачисл/.test(c));
          if (d >= 0 && a >= 0) {
            dateCol = d;
            amountCol = a;
          }
          return;
        }
        const at = parseDate(cells[dateCol]);
        const amount = parseAmount(cells[amountCol]);
        if (at && amount && amount.gt(0)) rows.push({ row: no, at, amount: amount.toFixed(2) });
        if (rows.length > 5000) return false;
      });
      if (dateCol < 0) throw Errors.bad('NO_COLUMNS', 'В выписке не нашли колонки «Дата» и «Сумма»');
      const open = await tx.query(
        `SELECT id, amount, moved_at FROM money_movements WHERE tenant_id = $1 AND account_id = $2 AND verify_status = 'unverified' ORDER BY moved_at`,
        [tx.tenantId, acc.id],
      );
      const used = new Set<string>();
      const matches: any[] = [];
      const unmatchedRows: any[] = [];
      for (const r of rows) {
        const cand = open
          .filter((m: any) => !used.has(m.id) && D(m.amount).eq(r.amount) && Math.abs(dayjs(m.moved_at).diff(r.at, 'minute')) <= window)
          .sort((a: any, b: any) => Math.abs(dayjs(a.moved_at).diff(r.at)) - Math.abs(dayjs(b.moved_at).diff(r.at)))[0];
        if (cand) {
          used.add(cand.id);
          matches.push({ movementId: cand.id, amount: r.amount, statementRow: r.row, statementAt: r.at, movedAt: cand.moved_at });
        } else unmatchedRows.push(r);
      }
      const unmatchedTransfers = open.filter((m: any) => !used.has(m.id)).map((m: any) => ({ movementId: m.id, amount: money(m.amount).toFixed(2), movedAt: m.moved_at }));
      return { matches, unmatchedStatementRows: unmatchedRows.slice(0, 200), unmatchedTransfers };
    });
  }
}

function parseAmount(s: string): ReturnType<typeof D> | null {
  const clean = (s ?? '').replace(/\s/g, '').replace(/[^\d,.-]/g, '').replace(',', '.');
  if (!clean || isNaN(Number(clean))) return null;
  return money(clean);
}

function parseDate(s: string): Date | null {
  const v = (s ?? '').trim();
  if (!v) return null;
  const m = v.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${(m[4] ?? '00').padStart(2, '0')}:${m[5] ?? '00'}:${m[6] ?? '00'}`;
    const d = dayjs.tz(iso, 'Asia/Bishkek');
    return d.isValid() ? d.toDate() : null;
  }
  const d = dayjs(v);
  return d.isValid() ? d.toDate() : null;
}
