import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { distribute } from '../../common/pricing-engine/engine';
import { dayjs } from '../../common/utils/dates';
import { D, Decimal, money, qty as qty3, unitCost } from '../../common/utils/decimal';
import { CountersService } from '../../database/tenant/counters.service';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { OutboxService } from '../../jobs/outbox.service';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { Product, ProductUnit } from '../catalog/entities/product.entity';
import { CustomerVehicle } from '../counterparties/entities/counterparty.entity';
import { DocumentsService } from '../documents/documents.service';
import { Document, DocumentLine } from '../documents/entities/document.entity';
import { KitComponentLine } from '../documents/handlers/sale-handlers';
import { NumberingService } from '../documents/numbering.service';
import { DebtsService } from '../finance/debts.service';
import { MoneyAccount } from '../finance/entities/money-account.entity';
import { MoneyService } from '../finance/money.service';
import { ShiftsService } from '../finance/shifts.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { Register } from '../stores/entities/register.entity';
import { Warehouse } from '../stores/entities/warehouse.entity';
import { PaymentMethod, ProductFitIssue, Receipt, ReceiptApproval, ReceiptPayment } from './entities/receipt.entity';
import { PinService } from './pin.service';
import { publicToken, ReceiptsService, tenantFromToken } from './receipts.service';

export const RETURN_REASONS = {
  not_fit: 'Не подошло',
  defect: 'Брак',
  changed_mind: 'Передумал',
  wrong_item: 'Не та деталь',
  warranty: 'Гарантия',
  other: 'Другое',
} as const;

export interface ReturnLineInput {
  /** Строка исходной продажи */
  saleLineId?: string;
  /** Часть комплекта: какой компонент возвращают (количество — в его базовой единице) */
  componentProductId?: string;
  /** Без чека: товар, единица и цена */
  productId?: string;
  unitId?: string;
  price?: string;
  qty: string;
  /** ok — на склад продаж; defect — на склад «Брак» (→ возврат поставщику) */
  condition?: 'ok' | 'defect';
  reason: keyof typeof RETURN_REASONS;
  /** «Не подошло»: без следов установки и на какую машину пробовали (ТЗ 15.1) */
  noInstallMarks?: boolean;
  triedVehicleId?: string | null;
  triedVehicleTitle?: string | null;
  serialItemIds?: string[];
  comment?: string;
}

export interface RefundInput {
  method: PaymentMethod | 'void';
  amount: string;
  currency?: string;
  accountId?: string | null;
}

export interface CreateReturnInput {
  /** Офлайн-возврат: UUID чека, созданный на кассе */
  id?: string;
  registerId: string;
  saleReceiptId?: string | null;
  customerId?: string | null;
  lines: ReturnLineInput[];
  /** same — теми же способами в той же пропорции; credit — зачётом в новый чек (обмен); custom — свои способы (по праву) */
  refundMode?: 'same' | 'credit' | 'custom';
  refunds?: RefundInput[];
  confirmExpired?: boolean;
  pin?: string | null;
  idempotencyKey?: string | null;
  comment?: string | null;
}

interface PreparedLine {
  input: ReturnLineInput;
  sale: DocumentLine | null;
  product: Product;
  unit: ProductUnit;
  qty: Decimal;
  baseQty: Decimal;
  amount: Decimal;
  unitCost: Decimal;
  kit?: KitComponentLine[];
  warehouseId: string;
}

/** Возвраты и обмен (ТЗ 15.2): по чеку и без, суммы — по сохранённому распределению скидок, деньги — в той же пропорции. */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly docs: DocumentsService,
    private readonly numbering: NumberingService,
    private readonly ledger: StockLedgerService,
    private readonly settings: SettingsService,
    private readonly money: MoneyService,
    private readonly shifts: ShiftsService,
    private readonly debts: DebtsService,
    private readonly pins: PinService,
    private readonly receipts: ReceiptsService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Найти продажу по QR (ссылка чека), номеру чека или номеру документа; что ещё можно вернуть. */
  lookup(code: string) {
    return this.tenantTx.run(async (tx) => {
      const c = code.trim().replace(/^.*\/r\//, '');
      let r: Receipt | null = null;
      if (tenantFromToken(c) === tx.tenantId) r = await tx.repo(Receipt).findOne({ where: { publicToken: c } });
      if (!r) r = await tx.repo(Receipt).findOne({ where: { number: c, kind: 'sale' } });
      if (!r) {
        const [d] = await tx.query(`SELECT id FROM documents WHERE tenant_id = $1 AND number = $2 AND type = 'sale'`, [tx.tenantId, c]);
        if (d) r = await tx.repo(Receipt).findOne({ where: { documentId: d.id } });
      }
      if (!r || r.kind !== 'sale' || r.status !== 'completed') throw Errors.notFound('Чек продажи');
      const s = await this.settings.get(tx);
      if (!this.scope.canStore(r.storeId) && !s.returnInOtherStore) throw Errors.notFound('Чек продажи');
      const view = await this.receipts.viewInTx(tx, r.id);
      const returned = await this.returnedByLine(tx, r.documentId);
      const daysSince = dayjs().diff(dayjs(r.completedAt!), 'day');
      return {
        ...view,
        daysSinceSale: daysSince,
        lines: (view.lines as any[]).map((l) => {
          const ret = returned.get(l.id) ?? { qty: D(0), amount: D(0) };
          const returnDays = l.rules?.returnDays ?? null;
          return {
            ...l,
            returnedQty: ret.qty.toFixed(3),
            returnableQty: D(l.qty).minus(ret.qty).toFixed(3),
            returnableAmount: D(l.amount).minus(ret.amount).toFixed(2),
            returnPeriodExpired: returnDays !== null && daysSince > returnDays,
          };
        }),
      };
    });
  }

  /** Поиск продажи без чека: по товару и клиенту (по праву). */
  findSales(q: { productId?: string; customerId?: string; limit?: number }) {
    if (!this.ctx.can('sales.return_any')) throw Errors.forbidden('Возврат без чека — только по праву');
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const w = [`r.tenant_id = $1`, `r.kind = 'sale'`, `r.status = 'completed'`];
      if (q.productId) {
        params.push(q.productId);
        w.push(`EXISTS (SELECT 1 FROM document_lines l WHERE l.tenant_id = r.tenant_id AND l.document_id = r.document_id AND l.product_id = $${params.length})`);
      }
      if (q.customerId) {
        params.push(q.customerId);
        w.push(`r.customer_id = $${params.length}`);
      }
      if (!q.productId && !q.customerId) throw Errors.bad('FILTER_REQUIRED', 'Укажите товар или клиента');
      return tx.query(
        `SELECT r.id, r.number, r.completed_at AS "completedAt", r.total, c.name AS "customerName"
           FROM receipts r LEFT JOIN counterparties c ON c.id = r.customer_id WHERE ${w.join(' AND ')}
          ORDER BY r.completed_at DESC LIMIT ${Math.min(q.limit ?? 30, 100)}`,
        params,
      );
    });
  }

  create(dto: CreateReturnInput) {
    return this.tenantTx.run(async (tx) => {
      const r = await this.createInTx(tx, dto);
      return this.receipts.viewInTx(tx, r.id);
    });
  }

  /** Возврат: проверки, документ прихода, деньги (или зачёт в новый чек), долг, «не подошло». */
  async createInTx(tx: TenantTx, dto: CreateReturnInput, opts: { system?: boolean; skipPeriodCheck?: boolean } = {}): Promise<Receipt> {
    if (dto.idempotencyKey) {
      const prev = await tx.repo(Receipt).findOne({ where: { idempotencyKey: dto.idempotencyKey } });
      if (prev) return prev;
    }
    if (!dto.lines?.length) throw Errors.bad('NO_LINES', 'Выберите позиции для возврата');
    const s = await this.settings.get(tx);
    const reg = await tx.repo(Register, 'Касса').getById(dto.registerId);
    this.scope.assertStore(reg.storeId);
    const shift = await this.shifts.requireOpenShift(tx, reg.id);
    const approvals: ReceiptApproval[] = [];
    const add = (a: ReceiptApproval | null) => a && approvals.push(a);

    // Исходная продажа
    let sale: Receipt | null = null;
    let saleDoc: Document | null = null;
    if (dto.saleReceiptId) {
      await tx.query(`SELECT id FROM receipts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, dto.saleReceiptId]);
      sale = await tx.repo(Receipt, 'Чек продажи').getById(dto.saleReceiptId);
      if (sale.kind !== 'sale' || sale.status !== 'completed') throw Errors.bad('NOT_SALE', 'Это не оплаченный чек продажи');
      if (sale.storeId !== reg.storeId && !s.returnInOtherStore) throw Errors.bad('OTHER_STORE', 'Возврат в другой точке выключен в настройках');
      saleDoc = await tx.repo(Document).getById(sale.documentId);
      // Возврат не из своей смены — по праву (ТЗ 3.3: «Возврат в пределах смены» / «из любой смены»)
      if (sale.shiftId !== shift.id && !opts.system) {
        add(await this.pins.approve(tx, { action: 'discount', permission: 'sales.return_any', pin: dto.pin, code: 'RETURN_OTHER_SHIFT', message: 'Возврат продажи из другой смены — нужен PIN старшего' }));
      }
    } else if (!opts.system) {
      add(await this.pins.approve(tx, { action: 'discount', permission: 'sales.return_any', pin: dto.pin, code: 'RETURN_WITHOUT_RECEIPT', message: 'Возврат без чека — только по праву' }));
    }
    if (!opts.system && !this.ctx.can('sales.return') && !approvals.length) {
      add(await this.pins.approve(tx, { action: 'discount', permission: 'sales.return', pin: dto.pin, code: 'RETURN_NOT_ALLOWED', message: 'Нет права на возврат — нужен PIN старшего' }));
    }

    const saleLines = saleDoc ? await tx.repo(DocumentLine).find({ where: { documentId: saleDoc.id }, order: { lineNo: 'ASC' } }) : [];
    const returned = saleDoc ? await this.returnedByLine(tx, saleDoc.id) : new Map();
    const defectWh = await tx.repo(Warehouse).findOne({ where: { storeId: reg.storeId, type: 'defect', isActive: true } });
    const daysSince = sale ? dayjs().diff(dayjs(sale.completedAt!), 'day') : 0;
    const prepared: PreparedLine[] = [];
    const errors: any[] = [];
    let expired = false;
    for (const [i, l] of dto.lines.entries()) {
      const no = i + 1;
      const err = (m: string) => errors.push({ line: no, message: `Строка ${no}: ${m}` });
      if (!(l.reason in RETURN_REASONS)) err('укажите причину');
      if (l.reason === 'not_fit' && !opts.system) {
        if (l.noInstallMarks !== true) err('«не подошло» — только без следов установки, отметьте это');
        if (!l.triedVehicleId && !l.triedVehicleTitle?.trim()) err('«не подошло» — укажите, на какую машину пробовали');
      }
      const q = qty3(l.qty);
      if (q.lte(0)) {
        err('количество должно быть больше нуля');
        continue;
      }
      const condition = l.condition ?? (l.reason === 'defect' || l.reason === 'warranty' ? 'defect' : 'ok');
      const warehouseId = condition === 'defect' ? (defectWh?.id ?? reg.warehouseId) : reg.warehouseId;
      if (sale) {
        const sl = saleLines.find((x) => x.id === l.saleLineId);
        if (!sl) {
          err('позиция не из этого чека');
          continue;
        }
        const product = (await tx.repo(Product).findById(sl.productId, { withDeleted: true }))!;
        const ret = returned.get(sl.id) ?? { qty: D(0), amount: D(0), components: new Map() };
        const rules = sl.extra?.rules ?? {};
        if (rules.returnDays !== null && rules.returnDays !== undefined && daysSince > rules.returnDays) expired = true;
        if (l.componentProductId) {
          // Часть комплекта — по сохранённому распределению цены комплекта
          const comp = ((sl.extra?.kitComponents ?? []) as KitComponentLine[]).find((c) => c.productId === l.componentProductId);
          if (!comp) {
            err('такого компонента нет в комплекте');
            continue;
          }
          const soldQty = D(comp.qty).mul(sl.baseQty);
          const already = ret.components.get(comp.productId) ?? { qty: D(0), amount: D(0) };
          if (q.gt(soldQty.minus(already.qty))) {
            err(`можно вернуть не больше ${soldQty.minus(already.qty).toFixed()} шт`);
            continue;
          }
          const compProduct = (await tx.repo(Product).findById(comp.productId, { withDeleted: true }))!;
          const unit = (await tx.repo(ProductUnit).findOne({ where: { productId: comp.productId, isBase: true } }))!;
          const amount = q.eq(soldQty.minus(already.qty)) ? D(comp.amount ?? 0).minus(already.amount) : money(D(comp.amount ?? 0).mul(q).div(soldQty));
          prepared.push({ input: l, sale: sl, product: compProduct, unit, qty: q, baseQty: q, amount, unitCost: await this.saleUnitCost(tx, saleDoc!.id, sl.id, comp.productId, sl), warehouseId });
          continue;
        }
        const left = sl.qty.minus(ret.qty);
        if (q.gt(left)) {
          err(left.lte(0) ? 'позиция уже возвращена' : `можно вернуть не больше ${left.toFixed()} (${sl.extra?.name ?? product.name})`);
          continue;
        }
        if (product.kind === 'kit' && ret.components.size) {
          err('часть комплекта уже возвращена — возвращайте оставшиеся компоненты по одному');
          continue;
        }
        // Повторный возврат: последний возврат забирает остаток суммы (до тыйына)
        const amount = q.eq(left) ? sl.amount!.minus(ret.amount) : money(sl.amount!.mul(q).div(sl.qty));
        const baseQty = qty3(q.mul(sl.factor));
        if (product.isSerial) {
          const ids = l.serialItemIds ?? [];
          if (ids.length !== Number(baseQty) || ids.some((x) => !sl.serialItemIds.includes(x))) err(`выберите ${baseQty} экземпл. из проданных`);
          else {
            const back = await tx.query(`SELECT id FROM serial_items WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status <> 'sold'`, [tx.tenantId, ids]);
            if (back.length) err('экземпляр уже возвращён');
          }
        }
        const unit = (await tx.repo(ProductUnit).findOne({ where: { id: sl.unitId }, withDeleted: true } as any))!;
        prepared.push({
          input: l,
          sale: sl,
          product,
          unit,
          qty: q,
          baseQty,
          amount,
          unitCost: product.kind === 'kit' ? D(0) : await this.saleUnitCost(tx, saleDoc!.id, sl.id, sl.productId, sl),
          kit: product.kind === 'kit' ? await this.kitCosts(tx, saleDoc!.id, sl) : undefined,
          warehouseId,
        });
      } else {
        // Без чека: себестоимость — средняя на дату возврата
        if (!l.productId || !l.price) {
          err('без чека — укажите товар и цену');
          continue;
        }
        const product = await tx.repo(Product, 'Товар').getById(l.productId);
        if (product.kind === 'kit') {
          err('комплект без чека — возвращайте компоненты');
          continue;
        }
        const unit = l.unitId ? await tx.repo(ProductUnit, 'Единица').getById(l.unitId) : (await tx.repo(ProductUnit).findOne({ where: { productId: product.id, isBase: true } }))!;
        if (unit.productId !== product.id) err('единица не относится к товару');
        const baseQty = qty3(q.mul(unit.factor));
        if (product.isSerial) err('серийный товар — возврат только по чеку');
        prepared.push({ input: l, sale: null, product, unit, qty: q, baseQty, amount: money(D(l.price).mul(q)), unitCost: await this.ledger.currentUnitCost(tx, product.id), warehouseId });
      }
    }
    if (errors.length) throw Errors.bad('LINES_INVALID', 'Проверьте позиции возврата', errors);
    if (expired && !opts.skipPeriodCheck && !opts.system) {
      if (!dto.confirmExpired) throw Errors.conflict('RETURN_PERIOD_EXPIRED', `Срок возврата прошёл (${daysSince} дн. с покупки) — подтвердите возврат`, { daysSinceSale: daysSince });
      add(await this.pins.approve(tx, { action: 'discount', permission: 'sales.return_any', pin: dto.pin, code: 'RETURN_PERIOD_EXPIRED_PIN', message: 'Срок возврата прошёл — нужен PIN старшего' }));
    }
    const total = money(prepared.reduce((a, p) => a.plus(p.amount), D(0)));

    // Документ возврата
    const doc = await tx.repo(Document).insert({
      type: 'sale_return',
      number: await this.numbering.next(tx, 'sale_return', reg.storeId, new Date()),
      docDate: new Date(),
      status: 'draft',
      storeId: reg.storeId,
      warehouseId: reg.warehouseId,
      counterpartyId: sale?.customerId ?? dto.customerId ?? null,
      baseDocumentId: saleDoc?.id ?? null,
      totalAmount: total,
      totalQty: prepared.reduce((a, p) => a.plus(p.qty), D(0)),
      comment: dto.comment ?? null,
      extra: { registerId: reg.id },
    });
    await tx.repo(DocumentLine).insertMany(
      prepared.map((p, i) => ({
        documentId: doc.id,
        lineNo: i + 1,
        productId: p.product.id,
        unitId: p.unit.id,
        factor: D(p.unit.factor),
        qty: p.qty,
        baseQty: p.baseQty,
        price: p.qty.isZero() ? D(0) : unitCost(p.amount.div(p.qty)),
        amount: p.amount,
        sourceLineId: p.sale?.id ?? null,
        serialItemIds: p.input.serialItemIds ?? [],
        extra: {
          name: p.sale?.extra?.name && !p.input.componentProductId ? p.sale.extra.name : p.product.name,
          reason: p.input.reason,
          condition: p.input.condition ?? (p.warehouseId === reg.warehouseId ? 'ok' : 'defect'),
          warehouseId: p.warehouseId,
          unitCost: p.unitCost.toFixed(),
          noInstallMarks: p.input.noInstallMarks ?? null,
          triedVehicleId: p.input.triedVehicleId ?? null,
          triedVehicleTitle: p.input.triedVehicleTitle ?? null,
          ...(p.input.componentProductId ? { componentOf: p.sale?.productId, componentProductId: p.input.componentProductId } : {}),
          ...(p.kit ? { kitComponents: p.kit } : {}),
          ...(p.sale?.extra?.free ? { free: p.sale.extra.free } : {}),
          ...(p.sale?.extra?.neighbor ? { neighbor: p.sale.extra.neighbor } : {}),
          ...(p.input.comment ? { comment: p.input.comment } : {}),
        },
      })),
    );
    if (saleDoc) {
      await tx.query(`INSERT INTO document_links (tenant_id, from_id, to_id, kind, created_by) VALUES ($1, $2, $3, 'based_on', $4) ON CONFLICT DO NOTHING`, [
        tx.tenantId,
        saleDoc.id,
        doc.id,
        tx.userId,
      ]);
    }
    await this.docs.postInTx(tx, doc, { system: true });

    const n = await this.counters.next(tx, `return:${reg.id}`);
    const receipt = await tx.repo(Receipt).insert({
      ...(dto.id ? { id: dto.id } : {}),
      documentId: doc.id,
      kind: 'return',
      number: `${reg.code}-В${String(n).padStart(5, '0')}`,
      storeId: reg.storeId,
      registerId: reg.id,
      shiftId: shift.id,
      sellerMembershipId: this.ctx.membershipId ?? sale?.sellerMembershipId ?? null,
      status: 'completed',
      customerId: sale?.customerId ?? dto.customerId ?? null,
      customerVehicleId: sale?.customerVehicleId ?? null,
      subtotal: total,
      total,
      paid: total,
      rate: sale?.rate ?? null,
      approvals,
      originalReceiptId: sale?.id ?? null,
      idempotencyKey: dto.idempotencyKey ?? null,
      publicToken: publicToken(tx.tenantId),
      completedAt: new Date(),
    } as any);

    await this.refund(tx, receipt, doc, sale, total, dto, shift.id);
    await this.fitIssues(tx, receipt, prepared);

    await this.audit.log(tx, {
      action: 'sale.return',
      entityType: 'receipt',
      entityId: receipt.id,
      storeId: receipt.storeId,
      summary: `Возврат ${receipt.number} на ${total.toFixed(2)} сом${sale ? ` по чеку ${sale.number}` : ' без чека'}`,
      important: true,
      after: { lines: dto.lines, refundMode: dto.refundMode ?? 'same', approvals },
    });
    await this.outbox.emit(tx, 'receipt.completed', { storeId: receipt.storeId, receiptId: receipt.id, total: total.toFixed(2), kind: 'return' });
    return receipt;
  }

  /**
   * Деньги по возврату (ТЗ 15.2): теми же способами в той же пропорции; долг — уменьшается;
   * credit — зачёт в новый чек (обмен); custom — свои способы (по праву).
   */
  private async refund(tx: TenantTx, receipt: Receipt, doc: Document, sale: Receipt | null, total: Decimal, dto: CreateReturnInput, shiftId: string) {
    let plan: RefundInput[];
    const mode = dto.refundMode ?? (dto.refunds?.length ? 'custom' : 'same');
    if (mode === 'credit') {
      plan = [{ method: 'return_credit', amount: total.toFixed(2) }];
    } else if (mode === 'custom' || !sale) {
      if (mode === 'custom' && sale && !this.ctx.can('sales.return_any')) throw Errors.forbidden('Изменить способ возврата денег — только по праву');
      plan = dto.refunds?.length ? dto.refunds : [{ method: 'cash', amount: total.toFixed(2), currency: 'KGS' }];
      const sum = plan.reduce((a, p) => a.plus(money(p.amount)), D(0));
      if (!sum.eq(total)) throw Errors.bad('REFUND_MISMATCH', `Сумма возврата денег ${sum.toFixed(2)} ≠ ${total.toFixed(2)}`);
    } else {
      plan = await this.proportional(tx, sale, total);
    }
    for (const p of plan) {
      const amount = money(p.amount);
      if (amount.isZero()) continue;
      let account: MoneyAccount | null = null;
      let currencyAmount = amount;
      let rate = D(1);
      let debtItemId: string | null = null;
      switch (p.method) {
        case 'cash': {
          const cur = p.currency ?? 'KGS';
          account = await this.money.registerCash(tx, receipt.registerId, cur);
          if (cur !== 'KGS') {
            rate = D(sale?.rate ?? 0);
            if (rate.lte(0)) throw Errors.bad('NO_RATE', 'Нет курса исходного чека');
            currencyAmount = money(amount.div(rate));
          }
          const bal = await this.money.balance(tx, account.id);
          if (bal.lt(currencyAmount)) throw Errors.conflict('NOT_ENOUGH_CASH', `В кассе ${bal.toFixed(2)} ${cur} — не хватает на возврат`);
          break;
        }
        case 'card':
        case 'transfer':
          if (!p.accountId) throw Errors.bad('ACCOUNT_REQUIRED', 'Укажите счёт возврата');
          account = await this.money.account(tx, p.accountId);
          break;
        case 'debt': {
          // Продано в долг — уменьшается долг клиента; если долг уже оплачен — разница наличными
          const items = await tx.query(`SELECT debt_item_id FROM receipt_payments WHERE tenant_id = $1 AND receipt_id = $2 AND method = 'debt' AND debt_item_id IS NOT NULL`, [tx.tenantId, sale!.id]);
          let left = amount;
          for (const it of items) {
            if (left.lte(0)) break;
            left = left.minus(await this.debts.reduceBy(tx, it.debt_item_id, left, doc.id));
          }
          debtItemId = items[0]?.debt_item_id ?? null;
          if (left.gt(0)) {
            const cash = await this.money.registerCash(tx, receipt.registerId, 'KGS');
            await this.money.record(tx, { accountId: cash.id, amount: left.neg(), kind: 'refund', documentId: doc.id, shiftId, counterpartyId: receipt.customerId, comment: 'Возврат: долг уже оплачен' });
            await tx.repo(ReceiptPayment).insert({ receiptId: receipt.id, method: 'cash', accountId: cash.id, currency: 'KGS', amount: left.neg(), amountKgs: left.neg(), rate: D(1) });
          }
          const reduced = amount.minus(Decimal.max(left, 0));
          if (reduced.gt(0)) await tx.repo(ReceiptPayment).insert({ receiptId: receipt.id, method: 'debt', currency: 'KGS', amount: reduced.neg(), amountKgs: reduced.neg(), rate: D(1), debtItemId });
          continue;
        }
        case 'return_credit':
          await tx.repo(ReceiptPayment).insert({ receiptId: receipt.id, method: 'return_credit', currency: 'KGS', amount: amount.neg(), amountKgs: amount.neg(), rate: D(1) });
          continue;
        case 'advance': {
          // Оплачено авансом — возвращается авансом клиенту
          if (!receipt.customerId) throw Errors.bad('CUSTOMER_REQUIRED', 'Возврат аванса — нет клиента');
          const item = await this.debts.open(tx, { counterpartyId: receipt.customerId, direction: 'payable', kind: 'advance', amount, documentId: doc.id, description: `Возврат ${receipt.number}`, storeId: receipt.storeId });
          await tx.repo(ReceiptPayment).insert({ receiptId: receipt.id, method: 'advance', currency: 'KGS', amount: amount.neg(), amountKgs: amount.neg(), rate: D(1), advanceItemIds: [item.id] });
          continue;
        }
        case 'void':
          // Перевод не поступил — денег не возвращаем (сторно делает сверка переводов)
          await tx.repo(ReceiptPayment).insert({ receiptId: receipt.id, method: 'transfer', currency: 'KGS', amount: amount.neg(), amountKgs: amount.neg(), rate: D(1), accountId: p.accountId ?? null });
          continue;
        default:
          throw Errors.bad('BAD_METHOD', 'Этим способом деньги не возвращаются');
      }
      const mv = await this.money.record(tx, {
        accountId: account!.id,
        amount: currencyAmount.neg(),
        kind: 'refund',
        rate: account!.currency !== 'KGS' ? rate : null,
        documentId: doc.id,
        shiftId,
        counterpartyId: receipt.customerId,
      });
      await tx.repo(ReceiptPayment).insert({
        receiptId: receipt.id,
        method: p.method as PaymentMethod,
        accountId: account!.id,
        currency: account!.currency,
        amount: currencyAmount.neg(),
        amountKgs: amount.neg(),
        rate,
        moneyMovementId: mv.id,
      });
    }
  }

  /**
   * Пропорция оплат исходного чека: наличные (за вычетом сдачи), карта, перевод, долг, зачёт.
   * Уже возвращённое по каждому способу не возвращается второй раз.
   */
  private async proportional(tx: TenantTx, sale: Receipt, total: Decimal, exclude?: { method: string; accountId: string | null }): Promise<RefundInput[]> {
    const pays = await tx.query(
      `SELECT method, account_id, currency, sum(amount_kgs) AS kgs FROM receipt_payments WHERE tenant_id = $1 AND receipt_id = $2 GROUP BY 1, 2, 3`,
      [tx.tenantId, sale.id],
    );
    // Сдача уменьшает наличные
    let change = D(sale.change ?? 0).mul(sale.changeCurrency === 'KGS' ? 1 : (sale.rate ?? 0));
    const ways = pays.map((p: any) => ({ method: (p.method === 'return_credit' ? 'cash' : p.method) as PaymentMethod, accountId: p.account_id, currency: p.method === 'return_credit' ? 'KGS' : p.currency, kgs: D(p.kgs) }));
    for (const w of ways.filter((x: any) => x.method === 'cash').sort((a: any, b: any) => (a.currency === 'KGS' ? -1 : 1) - (b.currency === 'KGS' ? -1 : 1))) {
      const x = Decimal.min(w.kgs, change);
      w.kgs = w.kgs.minus(x);
      change = change.minus(x);
    }
    // Что уже вернули прежними возвратами этого чека — по тем же способам (наличные — по валюте)
    const prev = await tx.query(
      `SELECT p.method, p.account_id, p.currency, sum(-p.amount_kgs) AS kgs FROM receipt_payments p JOIN receipts r ON r.id = p.receipt_id
        WHERE p.tenant_id = $1 AND r.original_receipt_id = $2 AND r.kind = 'return' GROUP BY 1, 2, 3`,
      [tx.tenantId, sale.id],
    );
    const key = (m: string, acc: string | null, cur: string) => (m === 'cash' ? `cash:${cur}` : m === 'debt' || m === 'return_credit' || m === 'advance' ? m : `${m}:${acc}`);
    const used = new Map<string, Decimal>();
    for (const p of prev) used.set(key(p.method, p.account_id, p.currency), (used.get(key(p.method, p.account_id, p.currency)) ?? D(0)).plus(p.kgs));
    for (const w of ways) {
      const k = key(w.method, w.accountId, w.currency);
      const u = used.get(k) ?? D(0);
      const x = Decimal.min(u, w.kgs);
      w.kgs = w.kgs.minus(x);
      used.set(k, u.minus(x));
    }
    const net = ways.filter((w: any) => w.kgs.gt(0) && !(exclude && w.method === exclude.method && w.accountId === exclude.accountId));
    if (!net.length) return [{ method: 'cash', amount: total.toFixed(2), currency: 'KGS' }];
    const shares = distribute(total, net.map((w: any) => w.kgs));
    // Наличные в долларах возвращаем по курсу исходного чека
    return net.map((w: any, i: number) => ({ method: w.method, accountId: w.method === 'cash' ? null : w.accountId, currency: w.method === 'cash' ? w.currency : 'KGS', amount: shares[i] }));
  }

  /** «Не подошло» с машиной → пометка на товаре и уведомление «проверить применимость» (ТЗ 6.5). */
  private async fitIssues(tx: TenantTx, receipt: Receipt, prepared: PreparedLine[]) {
    for (const p of prepared) {
      if (p.input.reason !== 'not_fit') continue;
      let title = p.input.triedVehicleTitle?.trim() ?? '';
      if (p.input.triedVehicleId) title = (await tx.repo(CustomerVehicle).findById(p.input.triedVehicleId))?.title ?? title;
      if (!title) continue;
      await tx.repo(ProductFitIssue).insert({ productId: p.product.id, vehicleTitle: title.slice(0, 200), customerVehicleId: p.input.triedVehicleId ?? null, returnReceiptId: receipt.id });
      await this.notifications.notify(tx, {
        type: 'return.not_fit',
        title: `Проверить применимость: «${p.product.name}» не подошёл на ${title}`,
        entityType: 'product',
        entityId: p.product.id,
        storeId: receipt.storeId,
        permission: 'catalog.manage',
        link: `/products/${p.product.id}`,
      });
    }
  }

  /** Сколько уже вернули по каждой строке продажи (и по компонентам комплекта). */
  async returnedByLine(tx: TenantTx, saleDocId: string) {
    const rows = await tx.query(
      `SELECT l.source_line_id AS line, l.extra->>'componentProductId' AS comp, sum(l.qty) AS qty, sum(l.amount) AS amount
         FROM document_lines l JOIN documents d ON d.id = l.document_id
        WHERE l.tenant_id = $1 AND d.base_document_id = $2 AND d.type = 'sale_return' AND d.status = 'posted' AND l.source_line_id IS NOT NULL
        GROUP BY 1, 2`,
      [tx.tenantId, saleDocId],
    );
    const map = new Map<string, { qty: Decimal; amount: Decimal; components: Map<string, { qty: Decimal; amount: Decimal }> }>();
    for (const r of rows) {
      const e = map.get(r.line) ?? { qty: D(0), amount: D(0), components: new Map() };
      if (r.comp) e.components.set(r.comp, { qty: D(r.qty), amount: D(r.amount) });
      else {
        e.qty = e.qty.plus(r.qty);
        e.amount = e.amount.plus(r.amount);
      }
      map.set(r.line, e);
    }
    return map;
  }

  /** Себестоимость единицы из исходной продажи (ТЗ 15.2). */
  private async saleUnitCost(tx: TenantTx, saleDocId: string, lineId: string, productId: string, line: DocumentLine): Promise<Decimal> {
    if (line.extra?.neighbor) return unitCost(line.extra.neighbor.purchasePrice);
    const [r] = await tx.query(
      `SELECT sum(cost_amount) AS amount, sum(qty) AS qty FROM stock_movements WHERE tenant_id = $1 AND document_id = $2 AND line_id = $3 AND product_id = $4`,
      [tx.tenantId, saleDocId, lineId, productId],
    );
    if (r?.qty && !D(r.qty).isZero()) return unitCost(D(r.amount).div(r.qty).abs());
    return line.unitCost ? D(line.unitCost) : D(0);
  }

  private async kitCosts(tx: TenantTx, saleDocId: string, line: DocumentLine): Promise<KitComponentLine[]> {
    const comps = (line.extra?.kitComponents ?? []) as KitComponentLine[];
    const out: KitComponentLine[] = [];
    for (const c of comps) out.push({ ...c, unitCost: (await this.saleUnitCost(tx, saleDocId, line.id, c.productId, line)).toFixed() });
    return out;
  }

  // ── Обмен (ТЗ 15.2): возврат + продажа, доплата или сдача — разница ─────

  exchange(dto: {
    registerId: string;
    saleReceiptId: string;
    returnLines: ReturnLineInput[];
    sale: { lines: any[]; payments?: any[]; changeCurrency?: 'KGS' | 'USD'; receiptDiscountPercent?: string | null; receiptDiscountAmount?: string | null };
    pin?: string | null;
    confirmExpired?: boolean;
    idempotencyKey?: string | null;
  }) {
    return this.tenantTx.run(async (tx) => {
      if (dto.idempotencyKey) {
        const prev = await tx.repo(Receipt).findOne({ where: { idempotencyKey: `${dto.idempotencyKey}:sale` } });
        if (prev) return { duplicate: true, sale: await this.receipts.viewInTx(tx, prev.id) };
      }
      const orig = await tx.repo(Receipt, 'Чек продажи').getById(dto.saleReceiptId);
      // Сначала собираем новый чек, чтобы знать его сумму
      const draft = await this.receipts.createInTx(tx, {
        registerId: dto.registerId,
        customerId: orig.customerId,
        customerVehicleId: orig.customerVehicleId,
        lines: dto.sale.lines,
        receiptDiscountPercent: dto.sale.receiptDiscountPercent,
        receiptDiscountAmount: dto.sale.receiptDiscountAmount,
        idempotencyKey: dto.idempotencyKey ? `${dto.idempotencyKey}:sale` : null,
      });
      // Возврат: в зачёт — не больше суммы нового чека, остаток — деньгами в той же пропорции
      const ret = await this.createInTx(tx, {
        registerId: dto.registerId,
        saleReceiptId: dto.saleReceiptId,
        lines: dto.returnLines,
        refundMode: 'credit',
        pin: dto.pin,
        confirmExpired: dto.confirmExpired,
        idempotencyKey: dto.idempotencyKey ? `${dto.idempotencyKey}:return` : null,
      });
      const credit = ret.total;
      const newTotal = draft.total;
      const use = Decimal.min(credit, newTotal);
      if (credit.gt(newTotal)) await this.splitCredit(tx, ret, orig, credit.minus(newTotal));
      const payments = [...(use.gt(0) ? [{ method: 'return_credit' as const, amount: use.toFixed(2), sourceReceiptId: ret.id }] : []), ...(dto.sale.payments ?? [])];
      const doc = await tx.repo(Document).getById(draft.documentId);
      if (newTotal.gt(0) || payments.length) await this.receipts.payInTx(tx, draft, doc, { payments, changeCurrency: dto.sale.changeCurrency, pin: dto.pin });
      return {
        return: await this.receipts.viewInTx(tx, ret.id),
        sale: await this.receipts.viewInTx(tx, draft.id),
        difference: newTotal.minus(credit).toFixed(2),
      };
    });
  }

  /** Часть зачёта возврата, которую не съел новый чек, — вернуть деньгами в той же пропорции. */
  private async splitCredit(tx: TenantTx, ret: Receipt, orig: Receipt, extra: Decimal) {
    const doc = await tx.repo(Document).getById(ret.documentId);
    await tx.query(`UPDATE receipt_payments SET amount = amount + $3, amount_kgs = amount_kgs + $3 WHERE tenant_id = $1 AND receipt_id = $2 AND method = 'return_credit'`, [
      tx.tenantId,
      ret.id,
      extra.toFixed(2),
    ]);
    await this.refund(tx, ret, doc, orig, extra, { registerId: ret.registerId, lines: [], refundMode: 'same' }, ret.shiftId!);
  }

  // ── Отмена чека, перевод по которому не пришёл (ТЗ 19.3) ─────

  async cancelReceiptInTx(tx: TenantTx, sale: Receipt, registerId: string, voidPaymentId: string) {
    const saleDoc = await tx.repo(Document).getById(sale.documentId);
    const lines = await tx.repo(DocumentLine).find({ where: { documentId: saleDoc.id }, order: { lineNo: 'ASC' } });
    const returned = await this.returnedByLine(tx, saleDoc.id);
    const retLines: ReturnLineInput[] = lines
      .map((l) => ({ saleLineId: l.id, qty: l.qty.minus(returned.get(l.id)?.qty ?? 0).toFixed(3), reason: 'other' as const, condition: 'ok' as const, serialItemIds: l.serialItemIds }))
      .filter((l) => D(l.qty).gt(0));
    if (!retLines.length) throw Errors.conflict('ALREADY_RETURNED', 'Чек уже полностью возвращён');
    const voidPay = await tx.repo(ReceiptPayment, 'Оплата').getById(voidPaymentId);
    // Сумма возврата и раскладка: перевод — «не поступил», остальное — теми же способами
    const prep = await this.prepareTotal(tx, sale, retLines);
    const voidAmount = Decimal.min(voidPay.amountKgs, prep);
    const rest = prep.minus(voidAmount);
    const restPlan = rest.gt(0) ? await this.proportional(tx, sale, rest, { method: 'transfer', accountId: voidPay.accountId }) : [];
    const restSum = restPlan.reduce((a, p) => a.plus(p.amount), D(0));
    const refunds: RefundInput[] = [{ method: 'void', amount: voidAmount.plus(rest.minus(restSum)).toFixed(2), accountId: voidPay.accountId }, ...restPlan];
    return this.createInTx(tx, { registerId, saleReceiptId: sale.id, lines: retLines, refundMode: 'custom', refunds, comment: 'Отмена чека: перевод не поступил' }, { system: true, skipPeriodCheck: true });
  }

  private async prepareTotal(tx: TenantTx, sale: Receipt, lines: ReturnLineInput[]): Promise<Decimal> {
    const saleLines = await tx.repo(DocumentLine).find({ where: { documentId: sale.documentId } });
    const returned = await this.returnedByLine(tx, sale.documentId);
    let sum = D(0);
    for (const l of lines) {
      const sl = saleLines.find((x) => x.id === l.saleLineId)!;
      const ret = returned.get(sl.id) ?? { qty: D(0), amount: D(0) };
      sum = sum.plus(D(l.qty).eq(sl.qty.minus(ret.qty)) ? sl.amount!.minus(ret.amount) : money(sl.amount!.mul(l.qty).div(sl.qty)));
    }
    return money(sum);
  }
}
