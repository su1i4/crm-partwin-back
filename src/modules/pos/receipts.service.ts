import { Warehouse } from '../stores/entities/warehouse.entity';
import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { calcReceipt, CalcLineInput, distribute, PricingError } from '../../common/pricing-engine/engine';
import { randomToken } from '../../common/utils/crypto';
import { D, Decimal, money, qty as qty3, unitCost } from '../../common/utils/decimal';
import { CountersService } from '../../database/tenant/counters.service';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { OutboxService } from '../../jobs/outbox.service';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { CategoriesService } from '../catalog/categories.service';
import { KitComponent, Product, ProductUnit } from '../catalog/entities/product.entity';
import { CounterpartiesService } from '../counterparties/counterparties.service';
import { Counterparty, CustomerVehicle } from '../counterparties/entities/counterparty.entity';
import { DocumentsService } from '../documents/documents.service';
import { NumberingService } from '../documents/numbering.service';
import { Document, DocumentLine } from '../documents/entities/document.entity';
import { KitComponentLine } from '../documents/handlers/sale-handlers';
import { DebtsService } from '../finance/debts.service';
import { MoneyAccount } from '../finance/entities/money-account.entity';
import { Shift } from '../finance/entities/money.entity';
import { MoneyService } from '../finance/money.service';
import { ShiftsService } from '../finance/shifts.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PriceResolverService } from '../pricing/price-resolver.service';
import { PricesService } from '../pricing/prices.service';
import { SettingsService } from '../settings/settings.service';
import { Register } from '../stores/entities/register.entity';
import {
  NeighborPurchase,
  PaymentMethod,
  Receipt,
  ReceiptApproval,
  ReceiptPayment,
} from './entities/receipt.entity';
import { PinService } from './pin.service';

export interface ReceiptLineInput {
  /** Строка, уже бывшая в чеке: цена сохраняется (чек держит цену на момент добавления) */
  lineId?: string;
  productId?: string;
  unitId?: string;
  qty: string;
  /** «Договорная» / свободная цена за единицу строки */
  price?: string | null;
  discountPercent?: string | null;
  discountAmount?: string | null;
  serialItemIds?: string[];
  /** Свободная позиция: название + цена (ТЗ 13.2) */
  free?: { name: string };
  /** «Взял у соседа» (ТЗ 14.2) */
  neighbor?: {
    neighborId: string;
    name?: string;
    partNumber?: string;
    productId?: string | null;
    purchasePrice: string;
  };
}

export interface ReceiptHeaderInput {
  customerId?: string | null;
  customerVehicleId?: string | null;
  vehicleLabel?: string | null;
  masterId?: string | null;
  priceTypeId?: string | null;
  receiptDiscountPercent?: string | null;
  receiptDiscountAmount?: string | null;
  label?: string | null;
  promoCode?: string | null;
  bonusAmount?: string | null;
}

export interface PaymentInput {
  method: PaymentMethod;
  amount: string;
  /** Для наличных: KGS или USD */
  currency?: string;
  /** Кошелёк / эквайринг; для наличных — касса сама */
  accountId?: string | null;
  /** Скриншот перевода */
  fileId?: string | null;
  /** Обмен: оплата зачётом возврата */
  sourceReceiptId?: string | null;
  /** Долг в долларах по договорённости */
  debtCurrency?: string;
  /** Оплата авансом / предоплатой заявки: какие позиции аванса (по умолчанию — все авансы клиента) */
  advanceItemIds?: string[];
  /** Зачёт лома / старой детали (ТЗ 14.11): что сдаёт клиент */
  scrap?: { productId: string; qty: string; warehouseId?: string | null };
}

export interface PayInput {
  payments: PaymentInput[];
  /** Сдача в сомах или долларах */
  changeCurrency?: 'KGS' | 'USD';
  pin?: string | null;
}

const SYSTEM_PRODUCTS = {
  FREE: { sku: '__FREE__', name: 'Свободная позиция' },
  NEIGHBOR: { sku: '__NEIGHBOR__', name: 'Позиция от соседа' },
} as const;

/** Касса онлайн (ТЗ 13): чек как документ, распределение скидок, лимиты и PIN, оплаты, долг, отложенные чеки. */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly docs: DocumentsService,
    private readonly numbering: NumberingService,
    private readonly ledger: StockLedgerService,
    private readonly resolver: PriceResolverService,
    private readonly prices: PricesService,
    private readonly settings: SettingsService,
    private readonly categories: CategoriesService,
    private readonly counterparties: CounterpartiesService,
    private readonly money: MoneyService,
    private readonly shifts: ShiftsService,
    private readonly debts: DebtsService,
    private readonly pins: PinService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly loyalty: LoyaltyService,
  ) {}

  // ── Создание и правка чека ───────────────────────────────

  create(dto: { registerId: string; lines?: ReceiptLineInput[] } & ReceiptHeaderInput) {
    return this.tenantTx.run(async (tx) => {
      const r = await this.createInTx(tx, dto);
      return this.viewInTx(tx, r.id);
    });
  }

  async createInTx(
    tx: TenantTx,
    dto: {
      registerId: string;
      lines?: ReceiptLineInput[];
      idempotencyKey?: string | null;
    } & ReceiptHeaderInput,
    opts: { system?: boolean } = {},
  ): Promise<Receipt> {
    const reg = await this.register(tx, dto.registerId);
    const shift = await this.shifts.requireOpenShift(tx, reg.id);
    const rate = await this.resolver.currentRate(tx, 'USD');
    const temp = `ЧЕРН-${randomToken(9)}`;
    const doc = await tx.repo(Document).insert({
      type: 'sale',
      number: temp,
      docDate: new Date(),
      status: 'draft',
      storeId: reg.storeId,
      warehouseId: reg.warehouseId,
      counterpartyId: null,
      extra: { registerId: reg.id },
    });
    const receipt = await tx.repo(Receipt).insert({
      documentId: doc.id,
      kind: 'sale',
      number: temp,
      storeId: reg.storeId,
      registerId: reg.id,
      shiftId: shift.id,
      sellerMembershipId: this.ctx.membershipId!,
      status: 'open',
      rate: rate?.rate ?? null,
      idempotencyKey: dto.idempotencyKey ?? null,
      approvals: [],
    });
    await this.applyHeader(tx, receipt, doc, dto);
    await this.replaceLines(tx, receipt, doc, dto.lines ?? [], null, opts);
    return receipt;
  }

  update(
    id: string,
    version: number,
    dto: ReceiptHeaderInput & { lines?: ReceiptLineInput[]; pin?: string | null },
  ) {
    return this.tenantTx.run(async (tx) => {
      const { receipt, doc } = await this.lockEditable(tx, id, version);
      await this.applyHeader(tx, receipt, doc, dto);
      await this.replaceLines(tx, receipt, doc, dto.lines ?? null, dto.pin ?? null);
      return this.viewInTx(tx, id);
    });
  }

  private async lockEditable(tx: TenantTx, id: string, version?: number) {
    const receipt = await tx.repo(Receipt, 'Чек').getForUpdate(id, version);
    this.scope.assertStore(receipt.storeId);
    if (receipt.kind !== 'sale') throw Errors.bad('NOT_SALE', 'Это не чек продажи');
    if (receipt.status === 'completed') throw Errors.conflict('RECEIPT_COMPLETED', 'Чек уже оплачен');
    if (receipt.status === 'cancelled') throw Errors.conflict('RECEIPT_CANCELLED', 'Чек отменён');
    const doc = await tx.repo(Document).getById(receipt.documentId);
    return { receipt, doc };
  }

  private async applyHeader(tx: TenantTx, r: Receipt, doc: Document, dto: ReceiptHeaderInput) {
    if (dto.customerId !== undefined) {
      if (dto.customerId) {
        const c = await tx.repo(Counterparty, 'Клиент').getById(dto.customerId);
        const terms = await this.counterparties.terms(tx, c);
        r.customerId = c.id;
        r.priceTypeId = dto.priceTypeId ?? terms.priceTypeId;
      } else {
        r.customerId = null;
        r.customerVehicleId = null;
        r.priceTypeId = dto.priceTypeId ?? null;
      }
      doc.counterpartyId = r.customerId;
    } else if (dto.priceTypeId !== undefined) {
      r.priceTypeId = dto.priceTypeId;
    }
    if (dto.customerVehicleId !== undefined) {
      if (dto.customerVehicleId) {
        const v = await tx.repo(CustomerVehicle, 'Машина').getById(dto.customerVehicleId);
        if (v.counterpartyId !== r.customerId)
          throw Errors.bad('VEHICLE_NOT_OF_CUSTOMER', 'Машина не из гаража этого клиента');
        r.customerVehicleId = v.id;
      } else r.customerVehicleId = null;
    }
    if (dto.vehicleLabel !== undefined) r.vehicleLabel = dto.vehicleLabel?.trim().slice(0, 60) || null;
    if (dto.masterId !== undefined) {
      if (dto.masterId) {
        const m = await tx.repo(Counterparty, 'Мастер').getById(dto.masterId);
        if (!m.roles.includes('master')) throw Errors.bad('NOT_MASTER', `«${m.name}» не отмечен как мастер`);
        r.masterId = m.id;
      } else r.masterId = null;
    }
    if (dto.receiptDiscountPercent !== undefined || dto.receiptDiscountAmount !== undefined) {
      r.receiptDiscountPercent = dto.receiptDiscountPercent ? D(dto.receiptDiscountPercent).toFixed(2) : null;
      r.receiptDiscountAmount =
        !r.receiptDiscountPercent && dto.receiptDiscountAmount ? money(dto.receiptDiscountAmount) : null;
    }
    if (dto.label !== undefined) r.label = dto.label?.slice(0, 100) || null;
    if (dto.promoCode !== undefined) r.promoCode = dto.promoCode ? await this.loyalty.checkCode(tx, dto.promoCode) : null;
    if (dto.bonusAmount !== undefined) {
      if (dto.bonusAmount && !r.customerId) throw Errors.bad('CUSTOMER_REQUIRED', 'Бонусами платит клиент с картой');
      r.bonusAmount = money(dto.bonusAmount || 0);
    }
    await tx.repo(Document).save(doc);
    await tx.repo(Receipt).save(r);
  }

  /**
   * Строки чека. lines = null — оставить как есть, только пересчитать (сменился клиент или скидка на чек).
   * Цена строки, которая уже была в чеке, не меняется — новая цена действует для новых строк.
   */
  private async replaceLines(
    tx: TenantTx,
    r: Receipt,
    doc: Document,
    input: ReceiptLineInput[] | null,
    pin: string | null,
    opts: { system?: boolean } = {},
  ) {
    const existing = await tx
      .repo(DocumentLine)
      .find({ where: { documentId: doc.id }, order: { lineNo: 'ASC' } });
    const s = await this.settings.get(tx);
    const inputs: ReceiptLineInput[] =
      input ??
      existing.map((l) => ({
        lineId: l.id,
        productId: l.productId,
        unitId: l.unitId,
        qty: l.qty.toFixed(),
        price: l.extra?.customPrice ? l.price!.toFixed() : undefined,
        discountPercent: l.extra?.discountPercent ?? null,
        discountAmount: l.extra?.discountAmount ?? null,
        serialItemIds: l.serialItemIds,
        free: l.extra?.free,
        neighbor: l.extra?.neighbor,
      }));

    // Удалённые строки — в журнал; по настройке — PIN старшего (ТЗ 13.3)
    if (input) {
      const keep = new Set(input.map((l) => l.lineId).filter(Boolean));
      const removed = existing.filter((l) => !keep.has(l.id));
      if (removed.length) {
        if (s.deleteLineRequiresPin) {
          const a = await this.pins.approve(tx, {
            action: 'delete_line',
            permission: 'sales.delete_line',
            pin,
            code: 'DELETE_LINE_PIN',
            message: 'Удаление строки — нужен PIN старшего',
          });
          if (a) r.approvals = [...r.approvals, a];
        }
        await this.audit.log(tx, {
          action: 'receipt.line_delete',
          entityType: 'receipt',
          entityId: r.id,
          storeId: r.storeId,
          summary: `Удалены строки чека: ${removed.map((l) => `${l.extra?.name ?? l.productId} × ${l.qty.toFixed()}`).join(', ')}`,
        });
      }
    }

    const terms = r.customerId ? await this.counterparties.terms(tx, r.customerId) : null;
    const productIds = [...new Set(inputs.map((l) => l.productId).filter((x): x is string => !!x))];
    const products = new Map((await tx.repo(Product, 'Товар').getByIds(productIds)).map((p) => [p.id, p]));
    const units = productIds.length
      ? await tx.repo(ProductUnit).find({ where: productIds.map((productId) => ({ productId })) })
      : [];
    const errors: any[] = [];
    const rows: Partial<DocumentLine>[] = [];
    // Строки, сохранённые ранее, уже проверены тем, кто их добавил (пересчёт при оплате не перепроверяет права)
    const trusted = opts.system || input === null;
    const canCustom = trusted || this.ctx.can('sales.custom_price') || r.approvals.some((a) => a.action === 'custom_price');

    // Цены новых строк — движком цен (строки с введённой ценой и сохранённые строки не пересчитываются)
    const hasCustom = (l: ReceiptLineInput) => l.price !== undefined && l.price !== null && l.price !== '';
    const needIdx = inputs
      .map((l, i) => ({ l, i }))
      .filter(
        ({ l }) =>
          l.productId &&
          products.has(l.productId) &&
          !l.free &&
          !l.neighbor &&
          !hasCustom(l) &&
          !this.keepPrice(existing, l),
      );
    const quoted = needIdx.length
      ? await this.resolver.quote(tx, {
          storeId: r.storeId,
          priceTypeId: r.priceTypeId,
          counterpartyId: r.customerId,
          items: needIdx.map(({ l }) => ({ productId: l.productId!, unitId: l.unitId ?? null })),
        })
      : [];
    const quotes = new Map(needIdx.map(({ i }, k) => [i, quoted[k]]));

    for (const [i, l] of inputs.entries()) {
      const lineNo = i + 1;
      const err = (m: string) => errors.push({ line: lineNo, message: `Строка ${lineNo}: ${m}` });
      const q = qty3(l.qty);
      if (q.lte(0)) {
        err('количество должно быть больше нуля');
        continue;
      }
      // Свободная позиция и «от соседа» — служебный товар без остатка
      if (l.free || l.neighbor) {
        if (l.free && !trusted && (!s.allowFreeItems || !this.ctx.can('sales.free_item'))) err('свободная позиция запрещена');
        if (l.price === undefined || l.price === null || D(l.price).lte(0)) err('укажите цену');
        let extra: Record<string, any>;
        let productId: string;
        if (l.free) {
          if (!l.free.name?.trim()) err('укажите название');
          productId = (await this.systemProduct(tx, 'FREE')).id;
          extra = { free: { name: l.free.name?.trim().slice(0, 300) }, name: l.free.name?.trim() };
        } else {
          const n = l.neighbor!;
          const nb = await tx.repo(Counterparty, 'Сосед').getById(n.neighborId);
          if (!nb.roles.includes('neighbor')) err(`«${nb.name}» не отмечен как сосед`);
          if (D(n.purchasePrice).lt(0)) err('цена закупки не может быть отрицательной');
          const linked = n.productId ? await tx.repo(Product, 'Товар').getById(n.productId) : null;
          const name = (n.name?.trim() || linked?.name || '').slice(0, 300);
          if (!name) err('укажите номер или название');
          productId = (await this.systemProduct(tx, 'NEIGHBOR')).id;
          extra = {
            neighbor: { ...n, name, purchasePrice: money(n.purchasePrice).toFixed(2), neighborName: nb.name },
            name,
          };
        }
        const unit = await this.baseUnit(tx, productId);
        rows.push(
          this.row(doc.id, lineNo, productId, unit, q, money(l.price ?? 0), l, {
            ...extra,
            priceSource: 'manual',
            customPrice: true,
          }),
        );
        continue;
      }
      const p = l.productId ? products.get(l.productId) : undefined;
      if (!p) {
        err('выберите товар');
        continue;
      }
      if (p.status === 'system') {
        err('служебный товар');
        continue;
      }
      const unit = l.unitId
        ? units.find((u) => u.id === l.unitId && u.productId === p.id)
        : units.find((u) => u.productId === p.id && u.isBase);
      if (!unit) {
        err('единица не относится к товару');
        continue;
      }
      const baseQty = qty3(q.mul(unit.factor));
      if (!p.fractional && !baseQty.isInteger()) err(`«${p.name}» не продаётся дробно`);
      if (p.isSerial && (l.serialItemIds?.length ?? 0) > 0 && l.serialItemIds!.length !== Number(baseQty))
        err(`выберите ${baseQty} экземпл.`);

      const prev = this.keepPrice(existing, l);
      let price: Decimal | null;
      let extra: Record<string, any>;
      if (hasCustom(l)) {
        // Договорная или свободная цена
        if (!p.priceNegotiable && !canCustom) err('свободная цена — только по праву');
        price = money(l.price!);
        if (price.lte(0)) err('цена должна быть больше нуля');
        const min = p.minPrice ? money(p.minPrice.mul(unit.factor)) : null;
        if (min && price.lt(min) && !opts.system) err(`цена ниже минимальной`);
        extra = { priceSource: p.priceNegotiable ? 'negotiable' : 'manual', customPrice: true };
      } else if (prev) {
        price = prev.price;
        extra = pickPriceExtra(prev.extra);
      } else {
        const qp = quotes.get(i)!;
        if (qp.price === null) {
          err(
            qp.negotiable
              ? `«${p.name}» — договорная цена, введите цену`
              : `цена «${p.name}» не задана — продажа запрещена`,
          );
          continue;
        }
        price = money(qp.price);
        extra = {
          priceSource: qp.source,
          priceTypeId: qp.priceTypeId,
          originalPrice: qp.originalPrice,
          originalCurrency: qp.originalCurrency,
          rate: qp.rate,
        };
      }
      if (p.kind === 'kit') extra.kitComponents = await this.kitComponents(tx, p.id);
      rows.push(this.row(doc.id, lineNo, p.id, unit, q, price!, l, { ...extra, name: p.name }));
    }
    if (errors.length) throw Errors.bad('LINES_INVALID', 'Проверьте позиции чека', errors);

    // Расчёт: постоянная скидка клиента (как акция) → ручная скидка строки → скидка на чек
    const clientPct = terms ? D(terms.discountPercent) : D(0);
    // Акции (ТЗ 17.6): лучшая для покупателя или суммируемые; постоянная скидка клиента — как несуммируемая акция
    const promo = await this.loyalty.promoForLines(
      tx,
      r.storeId,
      r.promoCode,
      rows.map((row) => ({ productId: row.productId!, qty: row.qty!.toFixed(), price: row.price!.toFixed(2), excluded: !!(row.extra!.customPrice || row.extra!.free || row.extra!.neighbor) })),
      clientPct,
    );
    r.promotions = promo.applied;
    let calc;
    const run = (bonus: string | null) =>
      calcReceipt({
        lines: rows.map((row, i) => ({
          key: String(i),
          qty: row.qty!.toFixed(),
          price: row.price!.toFixed(2),
          promoDiscount: promo.amounts[i],
          discountPercent: row.extra!.discountPercent ?? null,
          discountAmount: row.extra!.discountAmount ?? null,
        })) as CalcLineInput[],
        receiptDiscountPercent: r.receiptDiscountPercent,
        receiptDiscountAmount: r.receiptDiscountAmount?.toFixed(2) ?? null,
        bonusAmount: bonus,
      });
    try {
      calc = run(null);
      // Бонусы — после всех скидок, не больше баланса и N% чека (ТЗ 17.7)
      if (D(r.bonusAmount ?? 0).gt(0)) {
        const cap = await this.loyalty.bonusCap(tx, r.customerId, D(r.bonusAmount), D(calc.total));
        r.bonusAmount = money(cap);
        if (cap.gt(0)) calc = run(cap.toFixed(2));
      }
    } catch (e) {
      if (e instanceof PricingError) throw Errors.bad(e.code, e.message);
      throw e;
    }
    calc.lines.forEach((c, i) => {
      const row = rows[i];
      row.promoDiscount = D(c.promoDiscount);
      row.lineDiscount = D(c.lineDiscount);
      row.receiptDiscount = D(c.receiptDiscount);
      row.bonusPaid = D(c.bonusPaid);
      row.rounding = D(c.rounding);
      row.amount = D(c.total);
      row.extra = {
        ...row.extra,
        manualPercent: c.manualPercent,
        ...(clientPct.gt(0) ? { clientDiscountPercent: clientPct.toFixed(2) } : {}),
      };
    });
    await tx.repo(DocumentLine).hardDelete({ documentId: doc.id });
    if (rows.length) await tx.repo(DocumentLine).insertMany(rows);
    r.subtotal = D(calc.subtotal);
    r.discountTotal = D(calc.discountTotal);
    r.total = D(calc.total);
    await tx.repo(Receipt).save(r);
    await tx.query(
      `UPDATE documents SET total_qty = $3, total_amount = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, doc.id, rows.reduce((a, x) => a.plus(x.qty as Decimal), D(0)).toFixed(), calc.total],
    );
  }

  private keepPrice(existing: DocumentLine[], l: ReceiptLineInput): DocumentLine | null {
    if (!l.lineId) return null;
    const e = existing.find((x) => x.id === l.lineId);
    if (!e || e.productId !== l.productId || (l.unitId && l.unitId !== e.unitId) || e.extra?.customPrice)
      return null;
    return e;
  }

  private row(
    documentId: string,
    lineNo: number,
    productId: string,
    unit: ProductUnit,
    q: Decimal,
    price: Decimal,
    l: ReceiptLineInput,
    extra: Record<string, any>,
  ): Partial<DocumentLine> {
    return {
      documentId,
      lineNo,
      productId,
      unitId: unit.id,
      factor: D(unit.factor),
      qty: q,
      baseQty: qty3(q.mul(unit.factor)),
      price,
      serialItemIds: l.serialItemIds ?? [],
      extra: {
        ...extra,
        ...(l.discountPercent && D(l.discountPercent).gt(0)
          ? { discountPercent: D(l.discountPercent).toFixed(2) }
          : {}),
        ...(!l.discountPercent && l.discountAmount && D(l.discountAmount).gt(0)
          ? { discountAmount: money(l.discountAmount).toFixed(2) }
          : {}),
      },
    };
  }

  /** Компоненты комплекта и распределение его цены по розничным ценам компонентов (для возврата части комплекта). */
  async kitComponents(tx: TenantTx, kitId: string): Promise<KitComponentLine[]> {
    const comps = await tx.repo(KitComponent).find({ where: { kitId } });
    if (!comps.length) throw Errors.bad('EMPTY_KIT', 'В комплекте нет компонентов');
    const ids = comps.map((c) => c.componentId);
    const units = await tx
      .repo(ProductUnit)
      .find({ where: ids.map((productId) => ({ productId, isBase: true })) });
    const retail = await this.prices.retailMap(tx, ids);
    return comps.map((c) => ({
      productId: c.componentId,
      unitId: units.find((u) => u.productId === c.componentId)!.id,
      qty: D(c.qty).toFixed(),
      weight: D(retail.get(c.componentId)?.price ?? 1)
        .mul(c.qty)
        .toFixed(2),
    })) as any;
  }

  async baseUnit(tx: TenantTx, productId: string): Promise<ProductUnit> {
    const u = await tx.repo(ProductUnit).findOne({ where: { productId, isBase: true } });
    if (!u) throw Errors.bad('NO_BASE_UNIT', 'У товара нет базовой единицы');
    return u;
  }

  /** Служебный товар кассы (создаётся при первом использовании, в каталоге и поиске не виден). */
  async systemProduct(tx: TenantTx, kind: keyof typeof SYSTEM_PRODUCTS): Promise<Product> {
    const def = SYSTEM_PRODUCTS[kind];
    const key = `sysprod:${kind}`;
    if (tx.memo.has(key)) return tx.memo.get(key) as Product;
    let p = await tx.repo(Product).findOne({ where: { sku: def.sku } });
    if (!p) {
      p = await tx
        .repo(Product)
        .insert({
          name: def.name,
          sku: def.sku,
          kind: 'service',
          status: 'system',
          noStockControl: true,
          baseUnit: 'шт',
        });
      await tx.repo(ProductUnit).insert({ productId: p.id, name: 'шт', factor: D(1), isBase: true });
    }
    tx.memo.set(key, p);
    return p;
  }

  // ── Отложенные, отмена ───────────────────────────────────

  defer(id: string, version: number, label?: string | null) {
    return this.tenantTx.run(async (tx) => {
      const { receipt } = await this.lockEditable(tx, id, version);
      receipt.status = 'deferred';
      if (label !== undefined) receipt.label = label?.slice(0, 100) || null;
      await tx.repo(Receipt).save(receipt);
      await this.outbox.emit(tx, 'receipts.deferred_changed', {
        storeId: receipt.storeId,
        receiptId: receipt.id,
        status: 'deferred',
      });
      return this.viewInTx(tx, id);
    });
  }

  /** Продолжить отложенный чек на этой кассе (видны всем кассам точки). */
  resume(id: string, registerId: string) {
    return this.tenantTx.run(async (tx) => {
      const { receipt, doc } = await this.lockEditable(tx, id);
      const reg = await this.register(tx, registerId);
      if (reg.storeId !== receipt.storeId) throw Errors.bad('OTHER_STORE', 'Отложенный чек другой точки');
      const shift = await this.shifts.requireOpenShift(tx, reg.id);
      receipt.status = 'open';
      receipt.registerId = reg.id;
      receipt.shiftId = shift.id;
      doc.warehouseId = reg.warehouseId;
      doc.extra = { ...doc.extra, registerId: reg.id };
      await tx.repo(Document).save(doc);
      await tx.repo(Receipt).save(receipt);
      await this.outbox.emit(tx, 'receipts.deferred_changed', {
        storeId: receipt.storeId,
        receiptId: receipt.id,
        status: 'open',
      });
      return this.viewInTx(tx, id);
    });
  }

  cancel(id: string, version: number) {
    return this.tenantTx.run(async (tx) => {
      const { receipt, doc } = await this.lockEditable(tx, id, version);
      receipt.status = 'cancelled';
      await tx.repo(Receipt).save(receipt);
      doc.deletionMark = true;
      await tx.repo(Document).save(doc);
      await this.audit.log(tx, {
        action: 'receipt.cancel',
        entityType: 'receipt',
        entityId: id,
        storeId: receipt.storeId,
        summary: `Чек отменён до оплаты на ${receipt.total.toFixed(2)} сом`,
      });
      await this.outbox.emit(tx, 'receipts.deferred_changed', {
        storeId: receipt.storeId,
        receiptId: receipt.id,
        status: 'cancelled',
      });
      return this.viewInTx(tx, id);
    });
  }

  // ── Оплата ───────────────────────────────────────────────

  pay(id: string, version: number, dto: PayInput) {
    return this.tenantTx.run(async (tx) => {
      const { receipt, doc } = await this.lockEditable(tx, id, version);
      await this.payInTx(tx, receipt, doc, dto);
      return this.viewInTx(tx, id);
    });
  }

  /** Продажа одним запросом (сканер → оплата). Повтор с тем же ключом — тот же чек (ТЗ 13.8). */
  sale(
    dto: { registerId: string; idempotencyKey: string; lines: ReceiptLineInput[] } & ReceiptHeaderInput &
      PayInput,
  ) {
    return this.tenantTx.run(async (tx) => {
      const prev = await tx.repo(Receipt).findOne({ where: { idempotencyKey: dto.idempotencyKey } });
      if (prev) return { ...(await this.viewInTx(tx, prev.id)), duplicate: true };
      const receipt = await this.createInTx(tx, dto);
      const doc = await tx.repo(Document).getById(receipt.documentId);
      await this.payInTx(tx, receipt, doc, dto);
      return this.viewInTx(tx, receipt.id);
    });
  }

  async payInTx(
    tx: TenantTx,
    receipt: Receipt,
    doc: Document,
    dto: PayInput,
    opts: { system?: boolean } = {},
  ) {
    if (receipt.status === 'deferred')
      throw Errors.conflict('RECEIPT_DEFERRED', 'Чек отложен — сначала продолжите его на кассе');
    const shift = await this.shifts.requireOpenShift(tx, receipt.registerId);
    receipt.shiftId = shift.id;
    // Пересчёт с сохранёнными ценами (клиент или скидка могли поменяться)
    await this.replaceLines(tx, receipt, doc, null, null, opts);
    const lines = await tx
      .repo(DocumentLine)
      .find({ where: { documentId: doc.id }, order: { lineNo: 'ASC' } });
    if (!lines.length) throw Errors.bad('NO_LINES', 'В чеке нет позиций');
    const s = await this.settings.get(tx);
    const approvals: ReceiptApproval[] = [...receipt.approvals];
    const add = (a: ReceiptApproval | null) => a && approvals.push(a);
    const products = new Map(
      (await tx.repo(Product).findByIds([...new Set(lines.map((l) => l.productId))])).map((p) => [p.id, p]),
    );

    const below: { line: DocumentLine; cost: Decimal }[] = [];
    // Замена по гарантии и прочие системные чеки — без проверок скидок
    if (!opts.system) {
      // 1. Ручная скидка в пределах лимита роли (ТЗ 3.4, 13.8)
      const maxManual = lines.reduce((m, l) => Decimal.max(m, D(l.extra?.manualPercent ?? 0)), D(0));
      if (maxManual.gt(0)) {
        const myLimit = D(this.ctx.get('maxDiscountPercent') ?? 0);
        const selfOk =
          this.ctx.can('sales.discount_unlimited') ||
          (this.ctx.can('sales.discount') && maxManual.lte(myLimit));
        add(
          await this.pins.approve(tx, {
            action: 'discount',
            permission: 'sales.discount_unlimited',
            selfOk,
            pin: dto.pin,
            code: 'DISCOUNT_OVER_LIMIT',
            message: `Скидка ${maxManual.toFixed(1)}% выше вашего лимита ${myLimit.toFixed(0)}% — нужен PIN управляющего`,
            check: (a) =>
              this.pins.can(a, 'sales.discount_unlimited') ||
              (this.pins.can(a, 'sales.discount') && D(a.maxDiscountPercent).gte(maxManual)),
          }),
        );
      }

      // 2. Минимальная цена и продажа ниже себестоимости (ТЗ 17.5)
      for (const l of lines) {
        const p = products.get(l.productId)!;
        const effective = l.amount!.div(l.qty);
        if (p.minPrice && !l.extra?.free && !l.extra?.neighbor && effective.lt(p.minPrice.mul(l.factor))) {
          add(
            await this.pins.approve(tx, {
              action: 'discount',
              permission: 'sales.discount_unlimited',
              pin: dto.pin,
              code: 'BELOW_MIN_PRICE',
              message: `Строка ${l.lineNo}: цена после скидки ниже минимальной — нужен PIN управляющего`,
            }),
          );
        }
        const cost = l.extra?.neighbor
          ? D(l.extra.neighbor.purchasePrice).mul(l.qty)
          : await this.estimateCost(tx, l, p);
        if (cost.gt(0) && l.amount!.lt(cost)) below.push({ line: l, cost });
      }
      if (below.length) {
        if (s.belowCostSale === 'forbid' && !this.ctx.can('sales.below_cost')) {
          throw Errors.conflict('BELOW_COST', 'Цена после скидки ниже себестоимости — продажа запрещена', {
            lines: below.map((b) => b.line.lineNo),
          });
        }
        if (s.belowCostSale === 'confirm') {
          add(
            await this.pins.approve(tx, {
              action: 'below_cost',
              permission: 'sales.below_cost',
              pin: dto.pin,
              code: 'BELOW_COST',
              message: 'Цена после скидки ниже себестоимости — нужно подтверждение управляющего',
            }),
          );
        }
      }
    }

    // 3. Оплаты
    const plan = await this.planPayments(tx, receipt, dto);
    if (plan.debt.gt(0)) {
      if (!receipt.customerId) throw Errors.bad('CUSTOMER_REQUIRED', 'В долг — только клиенту из базы');
      const terms = await this.counterparties.terms(tx, receipt.customerId);
      const exp = await this.debts.exposure(tx, receipt.customerId);
      const debtKgs = plan.debtKgs;
      if (!this.ctx.can('sales.credit')) {
        add(
          await this.pins.approve(tx, {
            action: 'credit_over_limit',
            permission: 'sales.credit',
            pin: dto.pin,
            code: 'CREDIT_NOT_ALLOWED',
            message: 'Продажа в долг — нужен PIN старшего',
          }),
        );
      }
      if (terms.debtLimit !== null && exp.totalKgs.plus(debtKgs).gt(terms.debtLimit)) {
        add(
          await this.pins.approve(tx, {
            action: 'credit_over_limit',
            permission: 'sales.credit_over_limit',
            pin: dto.pin,
            code: 'CREDIT_LIMIT',
            message: D(terms.debtLimit).isZero()
              ? 'Этому клиенту в долг нельзя — нужен PIN управляющего'
              : `Долг станет ${exp.totalKgs.plus(debtKgs).toFixed(0)} сом при лимите ${D(terms.debtLimit).toFixed(0)} — нужен PIN управляющего`,
          }),
        );
      }
      if (s.creditBlockOverdueDays !== null && exp.maxOverdueDays > s.creditBlockOverdueDays) {
        add(
          await this.pins.approve(tx, {
            action: 'credit_overdue',
            permission: 'sales.credit_over_limit',
            pin: dto.pin,
            code: 'CREDIT_OVERDUE',
            message: `У клиента долг просрочен на ${exp.maxOverdueDays} дн. — в долг только с PIN управляющего`,
          }),
        );
      }
    }

    // 4. Номер, проведение документа (товар уходит со склада кассы)
    const reg = await tx.repo(Register).getById(receipt.registerId);
    receipt.number = `${reg.code}-${String(await this.counters.next(tx, `receipt:${reg.id}`)).padStart(6, '0')}`;
    doc.number = await this.numbering.next(tx, 'sale', doc.storeId, new Date());
    doc.docDate = new Date();
    doc.counterpartyId = receipt.customerId;
    doc.extra = { ...doc.extra, receiptId: receipt.id, receiptNumber: receipt.number };
    await tx.repo(Document).save(doc);
    await this.writeRules(tx, lines, products);
    await this.docs.postInTx(tx, doc, { system: true });

    // 5. Деньги, долги, соседи
    await this.applyPayments(tx, receipt, doc, plan, shift);
    await this.applyNeighbors(tx, receipt, doc, lines);

    receipt.status = 'completed';
    receipt.completedAt = new Date();
    receipt.approvals = approvals;
    receipt.paid = plan.paidKgs;
    receipt.change = plan.change;
    receipt.changeCurrency = plan.changeCurrency;
    receipt.debtAmount = plan.debtKgs;
    receipt.publicToken = publicToken(tx.tenantId);
    await tx.repo(Receipt).save(receipt);

    if (below.length && s.belowCostSale !== 'forbid') {
      await this.notifications.notify(tx, {
        type: 'sale.below_cost',
        title: `Чек ${receipt.number}: продажа ниже себестоимости`,
        entityType: 'receipt',
        entityId: receipt.id,
        storeId: receipt.storeId,
        permission: 'reports.profit',
        excludeUserId: tx.userId,
      });
    }
    if (approvals.some((a) => a.action === 'discount')) {
      await this.notifications.notify(tx, {
        type: 'sale.discount_over_limit',
        title: `Чек ${receipt.number}: скидка сверх лимита (подтвердил ${approvals.find((a) => a.action === 'discount')!.name})`,
        entityType: 'receipt',
        entityId: receipt.id,
        storeId: receipt.storeId,
        ownersOnly: true,
      });
    }
    await this.audit.log(tx, {
      action: 'sale.complete',
      entityType: 'receipt',
      entityId: receipt.id,
      storeId: receipt.storeId,
      summary: `Чек ${receipt.number} на ${receipt.total.toFixed(2)} сом`,
      after: { total: receipt.total.toFixed(2), payments: dto.payments, approvals },
      important: approvals.length > 0,
    });
    await this.outbox.emit(tx, 'receipt.completed', {
      storeId: receipt.storeId,
      receiptId: receipt.id,
      total: receipt.total.toFixed(2),
    });
  }

  /** Себестоимость строки по текущей средней (для проверки «ниже себестоимости»). */
  private async estimateCost(tx: TenantTx, l: DocumentLine, p: Product): Promise<Decimal> {
    if (l.extra?.free || p.kind === 'service') return D(0);
    if (p.kind === 'kit') {
      let sum = D(0);
      for (const c of (l.extra?.kitComponents ?? []) as KitComponentLine[])
        sum = sum.plus((await this.ledger.currentUnitCost(tx, c.productId)).mul(c.qty).mul(l.baseQty));
      return money(sum);
    }
    return money((await this.ledger.currentUnitCost(tx, p.id)).mul(l.baseQty));
  }

  /** Гарантия и правила возврата позиции — на момент продажи (печатаются на чеке, ТЗ 15.1). */
  async writeRules(tx: TenantTx, lines: DocumentLine[], products: Map<string, Product>) {
    for (const l of lines) {
      const p = products.get(l.productId)!;
      const cat = await this.categories.effectiveSettings(tx, p.categoryId);
      const rules = {
        warrantyDays: p.warrantyDays ?? cat.warrantyDays ?? null,
        returnDays: p.returnDays ?? cat.returnDays ?? null,
        returnConditions: p.returnConditions ?? cat.returnConditions ?? null,
        requireNoInstallMarks: cat.requireNoInstallMarks ?? false,
      };
      // Доли цены комплекта по компонентам
      let kit = l.extra?.kitComponents as (KitComponentLine & { weight?: string })[] | undefined;
      if (kit?.length) {
        const shares = distribute(
          l.amount!,
          kit.map((c) => c.weight ?? '1'),
        );
        kit = kit.map((c, i) => ({
          productId: c.productId,
          unitId: c.unitId,
          qty: c.qty,
          amount: shares[i],
        }));
      }
      l.extra = { ...l.extra, rules, ...(kit ? { kitComponents: kit } : {}) };
      await tx.query(`UPDATE document_lines SET extra = $3 WHERE tenant_id = $1 AND id = $2`, [
        tx.tenantId,
        l.id,
        JSON.stringify(l.extra),
      ]);
    }
  }

  // ── Оплаты: план и проводки ──────────────────────────────

  async planPayments(tx: TenantTx, receipt: Receipt, dto: PayInput) {
    const total = receipt.total;
    const rateUsd = receipt.rate ?? (await this.resolver.currentRate(tx, 'USD'))?.rate ?? null;
    const rows: {
      p: PaymentInput;
      amount: Decimal;
      amountKgs: Decimal;
      rate: Decimal;
      account: MoneyAccount | null;
    }[] = [];
    let cashKgs = D(0);
    let nonCash = D(0);
    let debt = D(0);
    let debtKgs = D(0);
    let debtCurrency = 'KGS';
    if (!dto.payments?.length && total.gt(0)) throw Errors.bad('PAYMENT_REQUIRED', 'Укажите оплату');
    for (const p of dto.payments ?? []) {
      const amount = money(p.amount);
      if (amount.lte(0)) throw Errors.bad('BAD_AMOUNT', 'Сумма оплаты должна быть больше нуля');
      const currency = p.currency ?? 'KGS';
      let account: MoneyAccount | null = null;
      let rate = D(1);
      switch (p.method) {
        case 'cash':
          account = await this.money.registerCash(tx, receipt.registerId, currency);
          if (currency !== 'KGS') {
            if (!rateUsd) throw Errors.bad('NO_RATE', 'Не задан курс магазина');
            rate = D(rateUsd);
          }
          break;
        case 'card':
          account = p.accountId
            ? await this.money.account(tx, p.accountId)
            : await this.defaultAccount(tx, receipt.storeId, 'acquiring');
          if (account.type !== 'acquiring')
            throw Errors.bad('BAD_ACCOUNT', 'Оплата картой — на счёт эквайринга');
          break;
        case 'transfer':
          if (!p.accountId)
            throw Errors.bad('WALLET_REQUIRED', 'Выберите кошелёк, на который пришёл перевод');
          account = await this.money.account(tx, p.accountId);
          if (account.type !== 'wallet' && account.type !== 'bank')
            throw Errors.bad('BAD_ACCOUNT', 'Перевод — на кошелёк или банковский счёт');
          break;
        case 'debt':
          debtCurrency = p.debtCurrency ?? 'KGS';
          if (debtCurrency !== 'KGS' && !rateUsd) throw Errors.bad('NO_RATE', 'Не задан курс магазина');
          break;
        case 'advance': {
          if (!receipt.customerId) throw Errors.bad('CUSTOMER_REQUIRED', 'Оплата авансом — только клиенту из базы');
          const items = p.advanceItemIds?.length
            ? (await this.debts.advances(tx, receipt.customerId, ['advance', 'prepayment'])).filter((i) => p.advanceItemIds!.includes(i.id))
            : await this.debts.advances(tx, receipt.customerId, ['advance']);
          const available = items.reduce((a, i) => a.plus(i.remaining), D(0));
          if (amount.gt(available)) throw Errors.bad('ADVANCE_NOT_ENOUGH', `Аванс клиента ${available.toFixed(2)} сом`);
          (p as any).__items = items;
          break;
        }
        case 'return_credit': {
          if (!p.sourceReceiptId) throw Errors.bad('SOURCE_REQUIRED', 'Укажите чек возврата');
          const available = await this.returnCreditAvailable(tx, p.sourceReceiptId);
          if (amount.gt(available))
            throw Errors.bad('RETURN_CREDIT_EXCEEDED', `По возврату доступно ${available.toFixed(2)} сом`);
          break;
        }
        case 'scrap': {
          if (!p.scrap?.productId || !p.scrap.qty || D(p.scrap.qty).lte(0)) throw Errors.bad('SCRAP_REQUIRED', 'Укажите, что сдаёт клиент, и количество (штуки или кг)');
          await tx.repo(Product, 'Лом').getById(p.scrap.productId);
          break;
        }
        default:
          throw Errors.bad('BAD_METHOD', 'Неизвестный способ оплаты');
      }
      if (account?.storeId && account.storeId !== receipt.storeId && account.type !== 'wallet')
        throw Errors.bad('OTHER_STORE_ACCOUNT', `Счёт «${account.name}» другой точки`);
      if (account && !account.isActive)
        throw Errors.bad('ACCOUNT_INACTIVE', `Счёт «${account.name}» отключён`);
      const amountKgs = money(amount.mul(rate));
      rows.push({ p, amount, amountKgs, rate, account });
      if (p.method === 'cash') cashKgs = cashKgs.plus(amountKgs);
      else if (p.method === 'debt') {
        debt = debt.plus(amount);
        debtKgs = debtKgs.plus(amountKgs);
      } else nonCash = nonCash.plus(amountKgs);
    }
    if (nonCash.plus(debtKgs).gt(total))
      throw Errors.bad(
        'OVERPAY_NONCASH',
        'Безналичная оплата и долг больше суммы чека — сдача только с наличных',
      );
    const paidKgs = cashKgs.plus(nonCash).plus(debtKgs);
    if (paidKgs.lt(total)) throw Errors.bad('UNDERPAID', `Не хватает ${total.minus(paidKgs).toFixed(2)} сом`);
    const changeKgs = paidKgs.minus(total);
    const changeCurrency = dto.changeCurrency ?? 'KGS';
    let change = changeKgs;
    if (changeCurrency === 'USD' && changeKgs.gt(0)) {
      if (!rateUsd) throw Errors.bad('NO_RATE', 'Не задан курс магазина');
      change = money(changeKgs.div(rateUsd));
    }
    // Долг в долларах: сумма долга в USD по курсу чека
    const debtAmount = debtCurrency === 'KGS' ? debtKgs : money(debtKgs.div(rateUsd!));
    return {
      rows,
      paidKgs,
      change,
      changeKgs,
      changeCurrency,
      debt: debtAmount,
      debtKgs,
      debtCurrency,
      rateUsd,
    };
  }

  async applyPayments(
    tx: TenantTx,
    receipt: Receipt,
    doc: Document,
    plan: Awaited<ReturnType<ReceiptsService['planPayments']>>,
    shift: Shift,
  ) {
    for (const r of plan.rows) {
      const pay = await tx.repo(ReceiptPayment).insert({
        receiptId: receipt.id,
        method: r.p.method,
        accountId: r.account?.id ?? null,
        currency: r.p.method === 'debt' ? plan.debtCurrency : (r.p.currency ?? 'KGS'),
        amount: r.p.method === 'debt' ? plan.debt : r.amount,
        amountKgs: r.amountKgs,
        rate: r.p.method === 'debt' && plan.debtCurrency !== 'KGS' ? D(plan.rateUsd!) : r.rate,
        fileId: r.p.fileId ?? null,
        sourceReceiptId: r.p.sourceReceiptId ?? null,
      });
      if (r.account) {
        const mv = await this.money.record(tx, {
          accountId: r.account.id,
          amount: r.amount,
          kind: 'sale',
          rate: r.account.currency !== 'KGS' ? r.rate : null,
          documentId: doc.id,
          shiftId: shift.id,
          counterpartyId: receipt.customerId,
          verifyStatus: r.p.method === 'transfer' && r.account.type === 'wallet' ? 'unverified' : null,
          fileId: r.p.fileId ?? null,
        });
        await tx.query(
          `UPDATE receipt_payments SET money_movement_id = $3 WHERE tenant_id = $1 AND id = $2`,
          [tx.tenantId, pay.id, mv.id],
        );
        // Комиссия эквайринга
        const pct = r.account.type === 'acquiring' ? D(r.account.details?.commissionPercent ?? 0) : D(0);
        if (pct.gt(0))
          await this.money.record(tx, {
            accountId: r.account.id,
            amount: money(r.amount.mul(pct).div(100)).neg(),
            kind: 'fee',
            documentId: doc.id,
            shiftId: shift.id,
            comment: `Комиссия ${pct.toFixed(2)}%`,
          });
      }
      if (r.p.method === 'scrap') {
        // Лом приходуется на склад «Лом» точки по цене зачёта
        let wh = r.p.scrap!.warehouseId
          ? await tx.repo(Warehouse, 'Склад').getById(r.p.scrap!.warehouseId)
          : await tx.repo(Warehouse).findOne({ where: { storeId: receipt.storeId, type: 'scrap' } });
        if (!wh) wh = await tx.repo(Warehouse).insert({ storeId: receipt.storeId, type: 'scrap', name: 'Лом' } as any);
        const qty = D(r.p.scrap!.qty);
        const purchase = await this.docs.createInTx(
          tx,
          { type: 'customer_purchase', warehouseId: wh!.id, counterpartyId: receipt.customerId, comment: `Зачёт в чеке ${receipt.number}`, extra: { receiptId: receipt.id, scrap: true }, lines: [{ productId: r.p.scrap!.productId, qty: qty.toFixed(), price: r.amount.div(qty).toFixed(2) }] } as any,
          { system: true },
        );
        await this.docs.postInTx(tx, purchase, { system: true });
      }
      if (r.p.method === 'advance') {
        const used = await this.debts.consumeAdvance(tx, (r.p as any).__items, r.amount, doc.id);
        await tx.query(`UPDATE receipt_payments SET advance_item_ids = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, pay.id, used]);
      }
      if (r.p.method === 'debt') {
        const terms = await this.counterparties.terms(tx, receipt.customerId!);
        const item = await this.debts.open(tx, {
          counterpartyId: receipt.customerId!,
          direction: 'receivable',
          kind: 'sale',
          currency: plan.debtCurrency,
          amount: plan.debt,
          documentId: doc.id,
          customerVehicleId: receipt.customerVehicleId,
          vehicleLabel: receipt.vehicleLabel,
          description: `Чек ${receipt.number}`,
          dueDays: terms.debtDays,
          storeId: receipt.storeId,
        });
        await tx.query(`UPDATE receipt_payments SET debt_item_id = $3 WHERE tenant_id = $1 AND id = $2`, [
          tx.tenantId,
          pay.id,
          item.id,
        ]);
      }
    }
    // Сдача — из наличных кассы выбранной валюты
    if (plan.change.gt(0)) {
      const acc = await this.money.registerCash(tx, receipt.registerId, plan.changeCurrency);
      const bal = await this.money.balance(tx, acc.id);
      // Офлайн-чек: сдачу уже выдали — принимаем даже при «минусе» по кассе
      if (bal.lt(plan.change) && !this.ctx.get('deviceId'))
        throw Errors.conflict(
          'NOT_ENOUGH_CHANGE',
          `В кассе нет ${plan.change.toFixed(2)} ${plan.changeCurrency} на сдачу`,
        );
      await this.money.record(tx, {
        accountId: acc.id,
        amount: plan.change.neg(),
        kind: 'sale',
        rate: plan.changeCurrency !== 'KGS' ? D(plan.rateUsd!) : null,
        documentId: doc.id,
        shiftId: shift.id,
        comment: 'Сдача',
      });
    }
  }

  /** «Взял у соседа»: приход от соседа, долг перед соседом, прибыль по позиции (ТЗ 14.2). */
  async applyNeighbors(tx: TenantTx, receipt: Receipt, doc: Document, lines: DocumentLine[]) {
    for (const l of lines) {
      const n = l.extra?.neighbor;
      if (!n) continue;
      const cost = money(D(n.purchasePrice).mul(l.qty));
      const item = cost.gt(0)
        ? await this.debts.open(tx, {
            counterpartyId: n.neighborId,
            direction: 'payable',
            kind: 'neighbor',
            amount: cost,
            documentId: doc.id,
            description: `Взяли: ${n.name}${n.partNumber ? ` (${n.partNumber})` : ''} × ${l.qty.toFixed()}`,
            storeId: receipt.storeId,
          })
        : null;
      await tx.repo(NeighborPurchase).insert({
        neighborId: n.neighborId,
        documentId: doc.id,
        lineId: l.id,
        name: n.name,
        partNumber: n.partNumber ?? null,
        productId: n.productId ?? null,
        qty: l.qty,
        purchasePrice: money(n.purchasePrice),
        salePrice: l.amount!.div(l.qty).toDecimalPlaces(2),
        debtItemId: item?.id ?? null,
        storeId: receipt.storeId,
      });
      // Себестоимость позиции = цена закупки у соседа
      await tx.query(
        `UPDATE document_lines SET unit_cost = $3, cost_amount = $4 WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, l.id, unitCost(n.purchasePrice).toFixed(), cost.toFixed()],
      );
    }
  }

  async returnCreditAvailable(tx: TenantTx, returnReceiptId: string): Promise<Decimal> {
    const ret = await tx.repo(Receipt, 'Возврат').getById(returnReceiptId);
    if (ret.kind !== 'return' || ret.status !== 'completed')
      throw Errors.bad('NOT_RETURN', 'Это не проведённый возврат');
    const [{ credit }] = await tx.query(
      `SELECT coalesce(sum(-amount_kgs), 0) AS credit FROM receipt_payments WHERE tenant_id = $1 AND receipt_id = $2 AND method = 'return_credit'`,
      [tx.tenantId, ret.id],
    );
    const [{ used }] = await tx.query(
      `SELECT coalesce(sum(p.amount_kgs), 0) AS used FROM receipt_payments p JOIN receipts r ON r.id = p.receipt_id
        WHERE p.tenant_id = $1 AND p.method = 'return_credit' AND p.source_receipt_id = $2 AND r.status = 'completed' AND r.kind = 'sale'`,
      [tx.tenantId, ret.id],
    );
    return D(credit).minus(used);
  }

  private async defaultAccount(tx: TenantTx, storeId: string, type: 'acquiring'): Promise<MoneyAccount> {
    const list = await tx.repo(MoneyAccount).find({
      where: [
        { type, storeId, isActive: true },
        { type, storeId: null as any, isActive: true },
      ],
    });
    const a = list.find((x) => x.storeId === storeId) ?? list[0];
    if (!a) throw Errors.bad('NO_ACQUIRING', 'Нет счёта эквайринга — добавьте его в «Деньги → Счета»');
    return a;
  }

  // ── Чтение ───────────────────────────────────────────────

  get(id: string) {
    return this.tenantTx.run(async (tx) => {
      const r = await tx.repo(Receipt, 'Чек').getById(id);
      this.scope.assertStore(r.storeId);
      return this.viewInTx(tx, id);
    });
  }

  /** Открытые и отложенные чеки точки (видны всем кассам точки). */
  list(q: {
    storeId?: string;
    registerId?: string;
    status?: string;
    customerId?: string;
    from?: string;
    to?: string;
    q?: string;
    page: number;
    limit: number;
  }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const w = ['r.tenant_id = $1', 'r.deleted_at IS NULL'];
      if (q.storeId) w.push(`r.store_id = ${p(q.storeId)}`);
      if (q.registerId) w.push(`r.register_id = ${p(q.registerId)}`);
      if (q.status) w.push(`r.status = ANY(${p(q.status.split(','))}::text[])`);
      if (q.customerId) w.push(`r.customer_id = ${p(q.customerId)}`);
      if (q.from) w.push(`coalesce(r.completed_at, r.created_at) >= ${p(q.from)}`);
      if (q.to) w.push(`coalesce(r.completed_at, r.created_at) < ${p(q.to)}`);
      if (q.q) w.push(`(r.number ILIKE ${p(`%${q.q}%`)} OR r.label ILIKE $${params.length})`);
      const allowed = this.scope.storeIds();
      if (allowed) w.push(`r.store_id = ANY(${p(allowed)}::uuid[])`);
      const where = w.join(' AND ');
      const [{ total }] = await tx.query(
        `SELECT count(*)::int AS total FROM receipts r WHERE ${where}`,
        params,
      );
      const items = await tx.query(
        `SELECT r.id, r.number, r.kind, r.status, r.label, r.total, r.paid, r.debt_amount AS "debtAmount", r.created_at AS "createdAt",
                r.completed_at AS "completedAt", r.register_id AS "registerId", g.name AS "registerName", r.customer_id AS "customerId",
                c.name AS "customerName", u.name AS "sellerName", r.version,
                (SELECT count(*)::int FROM document_lines l WHERE l.tenant_id = r.tenant_id AND l.document_id = r.document_id) AS "linesCount"
           FROM receipts r JOIN registers g ON g.id = r.register_id LEFT JOIN counterparties c ON c.id = r.customer_id
           LEFT JOIN memberships m ON m.id = r.seller_membership_id LEFT JOIN users u ON u.id = m.user_id
          WHERE ${where} ORDER BY coalesce(r.completed_at, r.created_at) DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total };
    });
  }

  async viewInTx(tx: TenantTx, id: string) {
    const r = await tx.repo(Receipt, 'Чек').getById(id);
    const canCost = this.ctx.can('products.view_cost');
    const lines = await tx.query(
      `SELECT l.id, l.line_no AS "lineNo", l.product_id AS "productId", coalesce(l.extra->>'name', p.name) AS name, p.sku, p.kind,
              p.is_serial AS "isSerial", l.unit_id AS "unitId", u.name AS "unitName", l.factor, l.qty, l.base_qty AS "baseQty",
              l.price, l.promo_discount AS "promoDiscount", l.line_discount AS "lineDiscount", l.receipt_discount AS "receiptDiscount",
              l.bonus_paid AS "bonusPaid", l.rounding, l.amount, l.serial_item_ids AS "serialItemIds",
              (SELECT pl.place FROM product_places pl WHERE pl.tenant_id = l.tenant_id AND pl.product_id = l.product_id AND pl.warehouse_id = d.warehouse_id LIMIT 1) AS place,
              l.extra->>'priceSource' AS "priceSource", l.extra->>'originalPrice' AS "originalPrice", l.extra->>'originalCurrency' AS "originalCurrency",
              l.extra->>'discountPercent' AS "discountPercent", l.extra->>'discountAmount' AS "discountAmount",
              (l.extra->>'customPrice')::boolean AS "customPrice", l.extra->'free' AS free, l.extra->'neighbor' AS neighbor, l.extra->'rules' AS rules,
              l.extra->'kitComponents' AS "kitComponents", l.source_line_id AS "sourceLineId", l.extra->>'reason' AS reason
              ${canCost ? ', l.unit_cost AS "unitCost", l.cost_amount AS "costAmount"' : ''}
         FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN products p ON p.id = l.product_id JOIN product_units u ON u.id = l.unit_id
        WHERE l.tenant_id = $1 AND l.document_id = $2 ORDER BY l.line_no`,
      [tx.tenantId, r.documentId],
    );
    if (!canCost) for (const l of lines) if (l.neighbor) delete l.neighbor.purchasePrice;
    const payments = await tx.query(
      `SELECT p.id, p.method, p.account_id AS "accountId", a.name AS "accountName", p.currency, p.amount, p.amount_kgs AS "amountKgs", p.rate,
              m.verify_status AS "verifyStatus", p.source_receipt_id AS "sourceReceiptId"
         FROM receipt_payments p LEFT JOIN money_accounts a ON a.id = p.account_id LEFT JOIN money_movements m ON m.id = p.money_movement_id
        WHERE p.tenant_id = $1 AND p.receipt_id = $2 ORDER BY p.created_at`,
      [tx.tenantId, r.id],
    );
    const [extra] = await tx.query(
      `SELECT c.name AS "customerName", c.phone AS "customerPhone", v.title AS "vehicleTitle", v.plate AS "vehiclePlate", mc.name AS "masterName",
              u.name AS "sellerName", g.name AS "registerName", s.name AS "storeName", s.address AS "storeAddress", s.phone AS "storePhone", d.number AS "documentNumber"
         FROM receipts r JOIN registers g ON g.id = r.register_id JOIN stores s ON s.id = r.store_id JOIN documents d ON d.id = r.document_id
         LEFT JOIN counterparties c ON c.id = r.customer_id LEFT JOIN customer_vehicles v ON v.id = r.customer_vehicle_id
         LEFT JOIN counterparties mc ON mc.id = r.master_id
         LEFT JOIN memberships m ON m.id = r.seller_membership_id LEFT JOIN users u ON u.id = m.user_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tx.tenantId, r.id],
    );
    const usdRate = r.rate ?? (await this.resolver.currentRate(tx, 'USD'))?.rate ?? null;
    return {
      ...r,
      ...extra,
      totalUsd: usdRate && D(usdRate).gt(0) ? r.total.div(usdRate).toDecimalPlaces(2).toFixed(2) : null,
      lines,
      payments,
      publicUrl: r.publicToken ? `/r/${r.publicToken}` : null,
    };
  }

  /** «Как в прошлый раз»: последняя цена продажи этому клиенту по каждой позиции (ТЗ 13.3). */
  lastPrices(customerId: string, productIds: string[]) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Counterparty, 'Клиент').getById(customerId);
      return tx.query(
        `SELECT DISTINCT ON (l.product_id) l.product_id AS "productId", round(l.amount / nullif(l.qty, 0), 2) AS price, l.price AS "priceBeforeDiscount",
                l.unit_id AS "unitId", r.completed_at AS "date", r.number
           FROM receipts r JOIN document_lines l ON l.tenant_id = r.tenant_id AND l.document_id = r.document_id
          WHERE r.tenant_id = $1 AND r.customer_id = $2 AND r.kind = 'sale' AND r.status = 'completed' AND l.product_id = ANY($3::uuid[])
          ORDER BY l.product_id, r.completed_at DESC`,
        [tx.tenantId, customerId, productIds],
      );
    });
  }

  private async register(tx: TenantTx, id: string) {
    const reg = await tx.repo(Register, 'Касса').getById(id);
    this.scope.assertStore(reg.storeId);
    if (!reg.isActive) throw Errors.bad('REGISTER_INACTIVE', 'Касса отключена');
    return reg;
  }
}

function pickPriceExtra(e: Record<string, any>) {
  const { priceSource, priceTypeId, originalPrice, originalCurrency, rate } = e ?? {};
  return { priceSource, priceTypeId, originalPrice, originalCurrency, rate };
}

/** Токен публичной ссылки чека: магазин (base64url uuid) + случайная часть. */
export function publicToken(tenantId: string) {
  const t = Buffer.from(tenantId.replace(/-/g, ''), 'hex').toString('base64url');
  return `${t}${randomToken(18)}`;
}

export function tenantFromToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(token)) return null;
  const hex = Buffer.from(token.slice(0, 22), 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
