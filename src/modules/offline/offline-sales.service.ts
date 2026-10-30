import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { calcReceipt, PricingError } from '../../common/pricing-engine/engine';
import { D, Decimal, money, qty as qty3 } from '../../common/utils/decimal';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { OutboxService } from '../../jobs/outbox.service';
import { AuditService } from '../audit/audit.service';
import { Product, ProductUnit } from '../catalog/entities/product.entity';
import { CounterpartiesService } from '../counterparties/counterparties.service';
import { Counterparty } from '../counterparties/entities/counterparty.entity';
import { DocumentsService } from '../documents/documents.service';
import { Document, DocumentLine } from '../documents/entities/document.entity';
import { NumberingService } from '../documents/numbering.service';
import { DebtsService } from '../finance/debts.service';
import { Shift } from '../finance/entities/money.entity';
import { PeriodsService } from '../inventory/periods.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Receipt, ReceiptApproval } from '../pos/entities/receipt.entity';
import { PaymentInput, publicToken, ReceiptLineInput, ReceiptsService } from '../pos/receipts.service';
import { PriceResolverService } from '../pricing/price-resolver.service';
import { Register } from '../stores/entities/register.entity';
import { Store } from '../stores/entities/store.entity';
import { Membership } from '../users/entities/membership.entity';
import { DeviceContext } from './pos-devices.service';

export interface OfflineSaleLine extends ReceiptLineInput {
  /** Скидка клиента / акция, посчитанная на кассе */
  promoDiscount?: string | null;
}

export interface OfflineSale {
  /** UUID чека, созданный на кассе — ключ защиты от дублей */
  id: string;
  /** Номер для людей: код кассы + серия + счётчик (К1А-000457) */
  number: string;
  /** Время продажи на устройстве */
  createdAt: string;
  shiftId: string;
  membershipId: string;
  customerId?: string | null;
  customerVehicleId?: string | null;
  vehicleLabel?: string | null;
  masterId?: string | null;
  priceTypeId?: string | null;
  receiptDiscountPercent?: string | null;
  receiptDiscountAmount?: string | null;
  lines: OfflineSaleLine[];
  payments: PaymentInput[];
  changeCurrency?: 'KGS' | 'USD';
  /** Итог, посчитанный кассой (тем же движком) */
  total: string;
  /** Подтверждения PIN, сделанные на кассе без сети */
  approvals?: { action: ReceiptApproval['action']; membershipId: string; at?: string }[];
  rate?: string | null;
}

const MAX_SKEW_MS = 5 * 60_000;

/**
 * Приём офлайн-чека (ТЗ 16.4): цена — как продали, минус и закрытый период не мешают (пометки), часы устройства
 * сбиты — предупреждение, долг сверх лимита — чек принимается и управляющему уведомление.
 */
@Injectable()
export class OfflineSalesService {
  constructor(
    private readonly receipts: ReceiptsService,
    private readonly docs: DocumentsService,
    private readonly numbering: NumberingService,
    private readonly periods: PeriodsService,
    private readonly resolver: PriceResolverService,
    private readonly counterparties: CounterpartiesService,
    private readonly debts: DebtsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  async accept(tx: TenantTx, dc: DeviceContext, p: OfflineSale, ctx: { skewMs: number; resolveId: (entity: string, id: string | null | undefined) => Promise<string | null> }) {
    const prev = await tx.repo(Receipt).findOne({ where: { id: p.id }, withDeleted: true });
    if (prev) return { receiptId: prev.id, number: prev.number, duplicate: true };

    const reg = await tx.repo(Register, 'Касса').getById(dc.device.registerId);
    const store = await tx.repo(Store, 'Точка').getById(reg.storeId);
    const single = store.registerMode === 'single';
    const prefix = `${reg.code}${dc.device.series}-`;
    if (!p.number?.startsWith(prefix) || !/^\d{1,9}$/.test(p.number.slice(prefix.length))) {
      throw Errors.bad('BAD_NUMBER', `Номер чека должен начинаться с ${prefix}`);
    }
    if (await tx.repo(Receipt).count({ where: { number: p.number, deviceId: dc.device.id } })) throw Errors.bad('NUMBER_TAKEN', `Номер ${p.number} уже есть`);
    const flags: Record<string, any> = {};

    // Смена: открытая на этой кассе (офлайн — по UUID с устройства)
    const shiftId = await ctx.resolveId('shift', p.shiftId);
    const shift = shiftId ? await tx.repo(Shift).findById(shiftId) : null;
    if (!shift || shift.registerId !== reg.id) throw Errors.bad('UNKNOWN_SHIFT', 'Смена чека не найдена — сначала должна прийти операция открытия смены');
    if (shift.status === 'closed') flags.shiftClosed = true;

    // Время: устройство + поправка на сбитые часы; закрытый период — проводим в текущем с исходным временем
    const deviceAt = new Date(p.createdAt);
    if (isNaN(+deviceAt)) throw Errors.bad('BAD_TIME', 'Неверное время чека');
    let docDate = new Date(Math.min(Date.now(), +deviceAt + ctx.skewMs));
    if (Math.abs(ctx.skewMs) > MAX_SKEW_MS) flags.clockSkew = { seconds: Math.round(ctx.skewMs / 1000) };
    const closedUntil = await this.periods.closedUntil(tx);
    if (closedUntil && docDate <= closedUntil) {
      flags.closedPeriod = { originalAt: docDate.toISOString() };
      docDate = new Date();
    }

    // Клиент: офлайн-клиент мог объединиться по телефону с существующим
    const customerId = await ctx.resolveId('customer', p.customerId);
    if (customerId) await tx.repo(Counterparty, 'Клиент').getById(customerId);
    const seller = await tx.repo(Membership, 'Продавец').getById(p.membershipId);

    // Строки — по ценам продажи (не пересчитываем по новым ценам)
    const doc = await tx.repo(Document).insert({
      type: 'sale',
      number: await this.numbering.next(tx, 'sale', reg.storeId, docDate),
      docDate,
      status: 'draft',
      storeId: reg.storeId,
      warehouseId: reg.warehouseId,
      counterpartyId: customerId,
      extra: { registerId: reg.id, offline: true, deviceId: dc.device.id, receiptNumber: p.number },
    });
    const rows: Partial<DocumentLine>[] = [];
    const errors: string[] = [];
    const products = new Map<string, Product>();
    for (const [i, l] of p.lines.entries()) {
      const lineNo = i + 1;
      const q = qty3(l.qty);
      if (q.lte(0)) errors.push(`Строка ${lineNo}: количество`);
      if (l.price === undefined || l.price === null || D(l.price).lt(0)) errors.push(`Строка ${lineNo}: нет цены`);
      let productId: string;
      let extra: Record<string, any> = { priceSource: 'offline' };
      if (l.free || l.neighbor) {
        productId = (await this.receipts.systemProduct(tx, l.free ? 'FREE' : 'NEIGHBOR')).id;
        if (l.free) extra = { ...extra, free: { name: l.free.name }, name: l.free.name, customPrice: true };
        else {
          const nb = await tx.repo(Counterparty, 'Сосед').getById(l.neighbor!.neighborId);
          extra = { ...extra, neighbor: { ...l.neighbor, purchasePrice: money(l.neighbor!.purchasePrice).toFixed(2), neighborName: nb.name }, name: l.neighbor!.name, customPrice: true };
        }
      } else {
        const pid = await ctx.resolveId('product', l.productId);
        // Товар удалили или отправили в архив — чек всё равно принимается (ТЗ 16.4)
        const prod = pid ? await tx.repo(Product).findById(pid, { withDeleted: true }) : null;
        if (!prod) {
          errors.push(`Строка ${lineNo}: товар не найден`);
          continue;
        }
        products.set(prod.id, prod);
        productId = prod.id;
        extra.name = prod.name;
        if (prod.kind === 'kit') extra.kitComponents = await this.receipts.kitComponents(tx, prod.id);
        if (prod.status !== 'active' || prod.deletedAt) flags.archivedProduct = true;
      }
      const unit = l.unitId
        ? await tx.repo(ProductUnit).findOne({ where: { id: l.unitId, productId }, withDeleted: true } as any)
        : await tx.repo(ProductUnit).findOne({ where: { productId, isBase: true } });
      if (!unit) {
        errors.push(`Строка ${lineNo}: единица не относится к товару`);
        continue;
      }
      if (l.discountPercent) extra.discountPercent = D(l.discountPercent).toFixed(2);
      else if (l.discountAmount) extra.discountAmount = money(l.discountAmount).toFixed(2);
      rows.push({
        documentId: doc.id,
        lineNo,
        productId,
        unitId: unit.id,
        factor: D(unit.factor),
        qty: q,
        baseQty: qty3(q.mul(unit.factor)),
        price: money(l.price ?? 0),
        serialItemIds: l.serialItemIds ?? [],
        promoDiscount: D(l.promoDiscount ?? 0),
        extra,
      });
    }
    if (errors.length) throw Errors.bad('LINES_INVALID', errors.join('; '));

    // Тот же движок, что на кассе: итог должен сойтись до тыйына
    let calc;
    try {
      calc = calcReceipt({
        lines: rows.map((r, i) => ({
          key: String(i),
          qty: r.qty!.toFixed(),
          price: r.price!.toFixed(2),
          promoDiscount: r.promoDiscount!.gt(0) ? r.promoDiscount!.toFixed(2) : null,
          discountPercent: r.extra!.discountPercent ?? null,
          discountAmount: r.extra!.discountAmount ?? null,
        })),
        receiptDiscountPercent: p.receiptDiscountPercent ?? null,
        receiptDiscountAmount: p.receiptDiscountAmount ?? null,
      });
    } catch (e) {
      if (e instanceof PricingError) throw Errors.bad(e.code, e.message);
      throw e;
    }
    if (!D(calc.total).eq(money(p.total))) throw Errors.bad('TOTAL_MISMATCH', `Итог чека ${p.total} ≠ расчёту сервера ${calc.total}`);
    calc.lines.forEach((c, i) => {
      const r = rows[i];
      r.lineDiscount = D(c.lineDiscount);
      r.receiptDiscount = D(c.receiptDiscount);
      r.bonusPaid = D(c.bonusPaid);
      r.rounding = D(c.rounding);
      r.amount = D(c.total);
      r.extra = { ...r.extra, manualPercent: c.manualPercent };
    });

    // Цена изменилась, пока касса была без сети → отчёт «Продажи по устаревшей цене»
    const priced = rows.map((r, i) => ({ r, i })).filter(({ r }) => !r.extra!.customPrice && products.has(r.productId!));
    if (priced.length) {
      const quotes = await this.resolver
        .quote(tx, { storeId: reg.storeId, priceTypeId: p.priceTypeId ?? (customerId ? (await this.counterparties.terms(tx, customerId)).priceTypeId : null), items: priced.map(({ r }) => ({ productId: r.productId!, unitId: r.unitId })) })
        .catch(() => []);
      quotes.forEach((qp, k) => {
        const r = priced[k].r;
        if (qp?.price && !D(qp.price).eq(r.price!)) {
          r.extra = { ...r.extra, stalePrice: { soldAt: r.price!.toFixed(2), current: qp.price } };
          flags.stalePrice = true;
        }
      });
    }
    await tx.repo(DocumentLine).insertMany(rows);
    await tx.query(`UPDATE documents SET total_qty = $3, total_amount = $4 WHERE tenant_id = $1 AND id = $2`, [
      tx.tenantId,
      doc.id,
      rows.reduce((a, r) => a.plus(r.qty as Decimal), D(0)).toFixed(),
      calc.total,
    ]);

    // Шапка чека (UUID — с кассы)
    const receipt = await tx.repo(Receipt).insert({
      id: p.id,
      documentId: doc.id,
      kind: 'sale',
      number: p.number,
      storeId: reg.storeId,
      registerId: reg.id,
      shiftId: shift.id,
      sellerMembershipId: seller.id,
      status: 'open',
      customerId,
      customerVehicleId: p.customerVehicleId ?? null,
      vehicleLabel: p.vehicleLabel ?? null,
      masterId: p.masterId ?? null,
      priceTypeId: p.priceTypeId ?? null,
      receiptDiscountPercent: p.receiptDiscountPercent ?? null,
      receiptDiscountAmount: p.receiptDiscountAmount ? money(p.receiptDiscountAmount) : null,
      subtotal: D(calc.subtotal),
      discountTotal: D(calc.discountTotal),
      total: D(calc.total),
      rate: p.rate ? D(p.rate) : ((await this.resolver.currentRate(tx, 'USD'))?.rate ?? null),
      approvals: [],
      idempotencyKey: `offline:${p.id}`,
      offline: true,
      deviceId: dc.device.id,
      deviceCreatedAt: deviceAt,
      receivedAt: new Date(),
      flags,
    });

    // Проведение: товар уходит со склада кассы, минус — с пометкой
    const lines = await tx.repo(DocumentLine).find({ where: { documentId: doc.id }, order: { lineNo: 'ASC' } });
    await this.receipts.writeRules(tx, lines, new Map([...(await tx.repo(Product).findByIds([...new Set(lines.map((l) => l.productId))], { withDeleted: true })).map((x) => [x.id, x] as const)]));
    await this.docs.postInTx(tx, doc, { system: true, acceptNegative: true });
    const posted = await tx.repo(Document).getById(doc.id);
    if (posted.hasNegative) flags.negativeStock = true;

    // Оплаты: правила режима точки (ТЗ 16.2) проверила касса; нарушение — пометка и уведомление
    if (!single && p.payments.some((x) => x.method === 'debt')) flags.offlineViolation = 'debt_in_multi_register_mode';
    if (!single && rows.some((r) => r.serialItemIds?.length)) flags.offlineViolation = 'serial_in_multi_register_mode';
    const plan = await this.receipts.planPayments(tx, receipt, { payments: p.payments, changeCurrency: p.changeCurrency });
    if (plan.debt.gt(0) && customerId) {
      const terms = await this.counterparties.terms(tx, customerId);
      const exp = await this.debts.exposure(tx, customerId);
      if (terms.debtLimit !== null && exp.totalKgs.plus(plan.debtKgs).gt(terms.debtLimit)) flags.debtOverLimit = { limit: terms.debtLimit, total: exp.totalKgs.plus(plan.debtKgs).toFixed(2) };
    }
    await this.receipts.applyPayments(tx, receipt, posted, plan, shift);
    await this.receipts.applyNeighbors(tx, receipt, posted, lines);

    // Подтверждения PIN с кассы
    const approvals: ReceiptApproval[] = [];
    for (const a of p.approvals ?? []) {
      const m = await tx.repo(Membership).findById(a.membershipId);
      if (m) approvals.push({ action: a.action, membershipId: m.id, name: (await tx.query(`SELECT name FROM users WHERE id = $1`, [m.userId]))[0]?.name ?? '', at: a.at ?? p.createdAt });
    }
    receipt.status = 'completed';
    receipt.completedAt = docDate;
    receipt.paid = plan.paidKgs;
    receipt.change = plan.change;
    receipt.changeCurrency = plan.changeCurrency;
    receipt.debtAmount = plan.debtKgs;
    receipt.approvals = approvals;
    receipt.publicToken = publicToken(tx.tenantId);
    receipt.flags = flags;
    await tx.repo(Receipt).save(receipt);

    const problems = Object.keys(flags).filter((k) => ['negativeStock', 'debtOverLimit', 'offlineViolation', 'closedPeriod', 'clockSkew'].includes(k));
    if (problems.some((k) => k !== 'negativeStock')) {
      await this.notifications.notify(tx, {
        type: 'pos.unsent_receipts',
        title: `Офлайн-чек ${p.number}: ${problems.map((k) => FLAG_LABELS[k]).join(', ')}`,
        entityType: 'receipt',
        entityId: receipt.id,
        storeId: reg.storeId,
        permission: 'reports.sales',
      });
    }
    await this.audit.log(tx, {
      action: 'sale.offline',
      entityType: 'receipt',
      entityId: receipt.id,
      storeId: reg.storeId,
      summary: `Офлайн-чек ${p.number} на ${receipt.total.toFixed(2)} сом`,
      after: { flags, deviceAt: p.createdAt },
      important: problems.length > 0,
    });
    await this.outbox.emit(tx, 'receipt.completed', { storeId: reg.storeId, receiptId: receipt.id, total: receipt.total.toFixed(2), offline: true });
    return { receiptId: receipt.id, number: receipt.number, documentNumber: posted.number, flags };
  }
}

export const FLAG_LABELS: Record<string, string> = {
  negativeStock: 'остаток ушёл в минус',
  debtOverLimit: 'долг клиента сверх лимита',
  offlineViolation: 'операция запрещена без интернета в режиме «несколько касс»',
  closedPeriod: 'пришёл в закрытый период — проведён текущим',
  clockSkew: 'часы устройства сбиты',
  stalePrice: 'продан по устаревшей цене',
};
