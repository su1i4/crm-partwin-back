import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { dayjs } from '../../common/utils/dates';
import { D, Decimal, money, qty as qty3 } from '../../common/utils/decimal';
import { normalizePhone } from '../../common/utils/login';
import { normalizePartNumber } from '../../common/utils/part-number';
import { CountersService } from '../../database/tenant/counters.service';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { Product } from '../catalog/entities/product.entity';
import { CounterpartiesService } from '../counterparties/counterparties.service';
import { Counterparty, CustomerVehicle } from '../counterparties/entities/counterparty.entity';
import { DocumentsService } from '../documents/documents.service';
import { DebtsService } from '../finance/debts.service';
import { MoneyService } from '../finance/money.service';
import { ShiftsService } from '../finance/shifts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReceiptLineInput, ReceiptsService } from '../pos/receipts.service';
import { Store } from '../stores/entities/store.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { CustomerRequest, CustomerRequestItem, PurchaseOrder, RequestOffer, RequestStatus, WaitlistEntry } from './entities/purchasing.entity';
import { PriceListsService } from './price-lists.service';
import { PurchaseOrdersService } from './purchase-orders.service';

export interface RequestItemInput {
  id?: string;
  number?: string | null;
  name?: string;
  qty?: string;
  photoFileIds?: string[];
  productId?: string | null;
  salePrice?: string | null;
}

const STATUS_LABELS: Record<RequestStatus, string> = {
  new: 'Новая',
  selecting: 'Подбирается',
  offered: 'Предложено клиенту',
  ordered: 'Заказано',
  arrived: 'Привезли',
  issued: 'Выдано',
  refused: 'Отказ',
};
const NEXT: Record<RequestStatus, RequestStatus[]> = {
  new: ['selecting', 'offered', 'ordered', 'refused'],
  selecting: ['offered', 'ordered', 'refused'],
  offered: ['ordered', 'selecting', 'refused', 'arrived'],
  ordered: ['arrived', 'refused'],
  arrived: ['refused'],
  issued: [],
  refused: [],
};

/**
 * Заявки клиентов (ТЗ 14.1): «подобрать» и «привезти под заказ» — один экран вместо цепочки документов.
 * Лист ожидания (ТЗ 18.4): при поступлении товара — уведомление продавцу и текст для клиента.
 */
@Injectable()
export class RequestsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly counters: CountersService,
    private readonly counterparties: CounterpartiesService,
    private readonly orders: PurchaseOrdersService,
    private readonly priceLists: PriceListsService,
    private readonly receipts: ReceiptsService,
    private readonly docs: DocumentsService,
    private readonly money: MoneyService,
    private readonly shifts: ShiftsService,
    private readonly debts: DebtsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly registry: OutboxRegistry,
    private readonly jobs: JobsService,
    private readonly platform: PlatformDb,
  ) {}

  async onModuleInit() {
    // Пришёл товар → лист ожидания (после COMMIT документа)
    this.registry.on('document.posted', async (e) => {
      if (!['receiving', 'surplus', 'initial_stock', 'sale_return'].includes(e.payload.type)) return;
      await this.tenantTx.run((tx) => this.checkWaitlist(tx, e.payload.id), { tenantId: e.tenantId, userId: null });
    });
    await this.jobs.work('requests.overdue', async () => {
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) await this.notifyOverdue(t.id).catch(() => undefined);
    });
    await this.jobs.schedule('requests.overdue', '20 * * * *');
  }

  // ── Создание и правка ────────────────────────────────────

  create(dto: {
    kind?: 'select' | 'order';
    storeId?: string;
    customerId?: string | null;
    customerName?: string | null;
    customerPhone?: string | null;
    customerVehicleId?: string | null;
    vehicleText?: string | null;
    dueAt?: string | null;
    comment?: string | null;
    items: RequestItemInput[];
  }) {
    return this.tenantTx.run(async (tx) => {
      const storeId = dto.storeId ?? this.scope.currentStoreId() ?? (await tx.query(`SELECT id FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [tx.tenantId]))[0]?.id;
      this.scope.assertStore(storeId);
      const store = await tx.repo(Store, 'Точка').getById(storeId);
      if (!dto.items?.length) throw Errors.bad('ITEMS_REQUIRED', 'Что нужно: номер, название или фото');
      const customerId = await this.resolveCustomer(tx, dto);
      if (dto.customerVehicleId) {
        const v = await tx.repo(CustomerVehicle, 'Машина').getById(dto.customerVehicleId);
        if (v.counterpartyId !== customerId) throw Errors.bad('VEHICLE_NOT_OF_CUSTOMER', 'Машина не из гаража клиента');
      }
      const year = dayjs().tz(store.timezone).year();
      const n = await this.counters.next(tx, `request:${storeId}:${year}`);
      const r = await tx.repo(CustomerRequest).insert({
        number: `ЗК-${store.code}-${String(n).padStart(5, '0')}`,
        storeId,
        kind: dto.kind ?? 'order',
        status: 'new',
        customerId,
        customerName: dto.customerName ?? null,
        customerPhone: dto.customerPhone ? (normalizePhone(dto.customerPhone) ?? dto.customerPhone) : null,
        customerVehicleId: dto.customerVehicleId ?? null,
        vehicleText: dto.vehicleText ?? null,
        assigneeId: this.ctx.membershipId ?? null,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        comment: dto.comment ?? null,
        history: [{ at: new Date().toISOString(), status: 'new', by: this.ctx.membershipId ?? null }],
      });
      await this.replaceItems(tx, r, dto.items);
      await this.audit.log(tx, { action: 'request.create', entityType: 'customer_request', entityId: r.id, storeId, summary: `${r.number}: ${dto.items.map((i) => i.name ?? i.number).join(', ')}`.slice(0, 300) });
      await this.notifications.notify(tx, { type: 'request.new', title: `Новая заявка ${r.number}`, entityType: 'customer_request', entityId: r.id, storeId, permission: 'requests.write', excludeUserId: tx.userId, link: `/requests/${r.id}` });
      return this.viewInTx(tx, r.id);
    });
  }

  /** Клиент из базы, по телефону — найдём или создадим (нужно для предоплаты и долга). */
  private async resolveCustomer(tx: TenantTx, dto: { customerId?: string | null; customerName?: string | null; customerPhone?: string | null }) {
    if (dto.customerId) return (await tx.repo(Counterparty, 'Клиент').getById(dto.customerId)).id;
    const phone = dto.customerPhone ? normalizePhone(dto.customerPhone) : null;
    if (!phone) return null;
    const found = await tx.repo(Counterparty).findOne({ where: { phone } });
    if (found) return found.id;
    if (!dto.customerName?.trim()) return null;
    const c = await this.counterparties.createInTx(tx, { name: dto.customerName.trim(), phone, roles: ['customer'] });
    return c.id;
  }

  update(id: string, version: number, dto: { customerId?: string | null; customerVehicleId?: string | null; vehicleText?: string | null; dueAt?: string | null; comment?: string | null; assigneeId?: string | null; items?: RequestItemInput[] }) {
    return this.tenantTx.run(async (tx) => {
      const r = await this.lock(tx, id, version);
      this.assertOpen(r);
      if (dto.customerId !== undefined) {
        if (r.prepaid.gt(0) && dto.customerId !== r.customerId) throw Errors.conflict('PREPAID', 'Есть предоплата — клиента не поменять');
        r.customerId = dto.customerId ? (await tx.repo(Counterparty, 'Клиент').getById(dto.customerId)).id : null;
      }
      if (dto.customerVehicleId !== undefined) r.customerVehicleId = dto.customerVehicleId;
      if (dto.vehicleText !== undefined) r.vehicleText = dto.vehicleText;
      if (dto.dueAt !== undefined) r.dueAt = dto.dueAt ? new Date(dto.dueAt) : null;
      if (dto.comment !== undefined) r.comment = dto.comment;
      if (dto.assigneeId !== undefined) r.assigneeId = dto.assigneeId;
      await tx.repo(CustomerRequest).save(r);
      if (dto.items) await this.replaceItems(tx, r, dto.items);
      return this.viewInTx(tx, r.id);
    });
  }

  private async replaceItems(tx: TenantTx, r: CustomerRequest, input: RequestItemInput[]) {
    const old = await tx.repo(CustomerRequestItem).find({ where: { requestId: r.id } });
    const keep = new Set(input.map((i) => i.id).filter(Boolean));
    for (const o of old) {
      if (keep.has(o.id)) continue;
      if (o.purchaseOrderLineId) throw Errors.conflict('ITEM_ORDERED', `«${o.name}» уже заказано у поставщика`);
      await tx.repo(CustomerRequestItem).hardDelete({ id: o.id });
    }
    for (const [i, it] of input.entries()) {
      if (it.productId) await tx.repo(Product, 'Товар').getById(it.productId);
      const name = (it.name?.trim() || it.number?.trim() || (it.productId ? (await tx.repo(Product).findById(it.productId))?.name : '') || (it.photoFileIds?.length ? 'По фото' : '')).slice(0, 300);
      if (!name) throw Errors.bad('ITEM_EMPTY', `Строка ${i + 1}: номер, название или фото`);
      const data = {
        lineNo: i + 1,
        number: it.number?.trim() || null,
        name,
        qty: qty3(it.qty ?? 1),
        photoFileIds: it.photoFileIds ?? [],
        productId: it.productId ?? null,
        salePrice: it.salePrice ? money(it.salePrice) : null,
      };
      const ex = it.id ? old.find((o) => o.id === it.id) : null;
      if (ex) {
        Object.assign(ex, data);
        await tx.repo(CustomerRequestItem).save(ex);
      } else await tx.repo(CustomerRequestItem).insert({ requestId: r.id, ...data, offers: [] });
    }
  }

  // ── Подбор и предложение ─────────────────────────────────

  /**
   * Варианты для клиента: что есть в каталоге (с наличием и ценой) и в прайсах поставщиков — «лестница» по классам.
   */
  suggest(id: string) {
    return this.tenantTx.run(async (tx) => {
      const r = await tx.repo(CustomerRequest, 'Заявка').getById(id);
      const items = await tx.repo(CustomerRequestItem).find({ where: { requestId: r.id }, order: { lineNo: 'ASC' } });
      const out = [];
      for (const it of items) {
        const n = normalizePartNumber(it.number ?? '');
        const catalog = n
          ? await tx.query(
              `SELECT DISTINCT p.id AS "productId", p.name, p.quality_class AS "qualityClass", b.name AS brand,
                      (SELECT coalesce(sum(sb.qty), 0) FROM stock_balances sb JOIN warehouses w ON w.id = sb.warehouse_id WHERE sb.tenant_id = p.tenant_id AND sb.product_id = p.id AND w.store_id = $3 AND w.type IN ('sales_floor', 'storage')) AS stock
                 FROM part_numbers pn JOIN products p ON p.id = pn.product_id AND p.deleted_at IS NULL AND p.status = 'active' LEFT JOIN brands b ON b.id = p.brand_id
                WHERE pn.tenant_id = $1 AND pn.normalized = $2 LIMIT 20`,
              [tx.tenantId, n, r.storeId],
            )
          : [];
        const suppliers = n ? await this.priceLists.searchByNumbers(tx, [n], { limit: 20 }) : [];
        out.push({ itemId: it.id, name: it.name, number: it.number, catalog, suppliers });
      }
      return out;
    });
  }

  /** Сохранить предложение клиенту: варианты с ценами (ТЗ 14.1). Статус — «предложено клиенту». */
  offer(id: string, version: number, dto: { itemId: string; offers: Omit<RequestOffer, 'id'>[] }) {
    return this.tenantTx.run(async (tx) => {
      const r = await this.lock(tx, id, version);
      this.assertOpen(r);
      const it = await tx.repo(CustomerRequestItem, 'Строка заявки').getById(dto.itemId);
      if (it.requestId !== r.id) throw Errors.notFound('Строка заявки');
      it.offers = dto.offers.map((o) => ({ ...o, id: randomUUID(), price: money(o.price).toFixed(2) }));
      await tx.repo(CustomerRequestItem).save(it);
      if (['new', 'selecting'].includes(r.status)) await this.move(tx, r, 'offered');
      return this.viewInTx(tx, r.id);
    });
  }

  /** Клиент выбрал вариант: товар каталога (или позиция от поставщика) и цена продажи. */
  choose(id: string, version: number, dto: { itemId: string; offerId?: string; productId?: string; salePrice?: string }) {
    return this.tenantTx.run(async (tx) => {
      const r = await this.lock(tx, id, version);
      this.assertOpen(r);
      const it = await tx.repo(CustomerRequestItem, 'Строка заявки').getById(dto.itemId);
      if (it.requestId !== r.id) throw Errors.notFound('Строка заявки');
      const offer = dto.offerId ? it.offers.find((o) => o.id === dto.offerId) : null;
      if (dto.offerId && !offer) throw Errors.notFound('Вариант');
      const productId = dto.productId ?? offer?.productId ?? null;
      if (productId) await tx.repo(Product, 'Товар').getById(productId);
      it.offers = it.offers.map((o) => ({ ...o, chosen: o.id === dto.offerId }));
      it.productId = productId;
      it.salePrice = dto.salePrice ? money(dto.salePrice) : offer ? money(offer.price) : it.salePrice;
      if (offer?.supplierId) {
        it.sourceId = offer.supplierId;
        it.sourceKind = 'supplier';
        it.purchasePrice = offer.purchasePrice ? D(offer.purchasePrice) : it.purchasePrice;
      }
      await tx.repo(CustomerRequestItem).save(it);
      return this.viewInTx(tx, r.id);
    });
  }

  /**
   * «У кого заказали»: поставщик — строка в черновик заказа поставщику (новый или существующий);
   * сосед — отметка (при выдаче — «взял у соседа»). Статус «заказано».
   */
  order(id: string, version: number, dto: { itemIds?: string[]; sourceKind: 'supplier' | 'neighbor'; sourceId: string; purchasePrice?: string; dueAt?: string; purchaseOrderId?: string }) {
    return this.tenantTx.run(async (tx) => {
      const r = await this.lock(tx, id, version);
      this.assertOpen(r);
      const src = await tx.repo(Counterparty, 'Поставщик').getById(dto.sourceId);
      const items = (await tx.repo(CustomerRequestItem).find({ where: { requestId: r.id }, order: { lineNo: 'ASC' } })).filter((i) => !dto.itemIds?.length || dto.itemIds.includes(i.id));
      if (!items.length) throw Errors.bad('ITEMS_REQUIRED', 'Нет строк для заказа');
      if (dto.sourceKind === 'supplier') {
        const noProduct = items.filter((i) => !i.productId);
        if (noProduct.length) throw Errors.bad('PRODUCT_REQUIRED', `Выберите товар каталога для: ${noProduct.map((i) => i.name).join(', ')} (или создайте из прайса)`);
        let o: PurchaseOrder | null = dto.purchaseOrderId ? await tx.repo(PurchaseOrder, 'Заказ').getById(dto.purchaseOrderId) : null;
        if (o && (o.supplierId !== src.id || o.status !== 'draft')) throw Errors.bad('ORDER_NOT_DRAFT', 'Добавить можно только в черновик заказа этого поставщика');
        if (!o) o = await this.orders.createInTx(tx, { supplierId: src.id, storeId: r.storeId, source: 'request', comment: `Под заявку ${r.number}` });
        await this.orders.appendLines(
          tx,
          o,
          items.map((i) => ({ productId: i.productId!, qty: i.qty.toFixed(), price: dto.purchasePrice ?? i.purchasePrice?.toFixed() ?? null, requestItemId: i.id, note: `Заявка ${r.number}` })),
        );
        const lines = await tx.query(`SELECT id, request_item_id FROM purchase_order_lines WHERE tenant_id = $1 AND order_id = $2 AND request_item_id = ANY($3::uuid[])`, [tx.tenantId, o.id, items.map((i) => i.id)]);
        for (const l of lines) await tx.query(`UPDATE customer_request_items SET purchase_order_line_id = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, l.request_item_id, l.id]);
      }
      for (const i of items) {
        await tx.query(`UPDATE customer_request_items SET source_id = $3, source_kind = $4, purchase_price = coalesce($5::numeric, purchase_price) WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, i.id, src.id, dto.sourceKind, dto.purchasePrice ?? null]);
      }
      if (dto.dueAt) r.dueAt = new Date(dto.dueAt);
      await this.move(tx, r, 'ordered', `${dto.sourceKind === 'neighbor' ? 'У соседа' : 'У поставщика'} «${src.name}»`);
      return this.viewInTx(tx, r.id);
    });
  }

  setStatus(id: string, version: number, status: RequestStatus, note?: string) {
    return this.tenantTx.run(async (tx) => {
      const r = await this.lock(tx, id, version);
      if (status === 'issued' || status === 'refused') throw Errors.bad('USE_ACTION', status === 'issued' ? 'Выдача — кнопкой «Выдать»' : 'Отказ — кнопкой «Отказ»');
      if (!NEXT[r.status].includes(status)) throw Errors.conflict('BAD_STATUS', `Из «${STATUS_LABELS[r.status]}» в «${STATUS_LABELS[status]}» нельзя`);
      await this.move(tx, r, status, note);
      return this.viewInTx(tx, r.id);
    });
  }

  // ── Предоплата, выдача, отказ ────────────────────────────

  /** Предоплата: деньги в кассу/на кошелёк, у клиента — предоплата (засчитывается при выдаче). */
  prepay(id: string, version: number, dto: { amount: string; method: 'cash' | 'card' | 'transfer'; registerId?: string; accountId?: string; currency?: string }) {
    return this.tenantTx.run(async (tx) => {
      const r = await this.lock(tx, id, version);
      this.assertOpen(r);
      if (!r.customerId) throw Errors.bad('CUSTOMER_REQUIRED', 'Предоплата — только клиенту из базы (укажите имя и телефон)');
      const amount = money(dto.amount);
      if (amount.lte(0)) throw Errors.bad('BAD_AMOUNT', 'Сумма больше нуля');
      let accountId = dto.accountId;
      let shiftId: string | null = null;
      if (dto.method === 'cash') {
        if (!dto.registerId) throw Errors.bad('REGISTER_REQUIRED', 'Укажите кассу');
        const shift = await this.shifts.requireOpenShift(tx, dto.registerId);
        shiftId = shift.id;
        accountId = (await this.money.registerCash(tx, dto.registerId, dto.currency ?? 'KGS')).id;
      }
      if (!accountId) throw Errors.bad('ACCOUNT_REQUIRED', 'Укажите счёт / кошелёк');
      const acc = await this.money.account(tx, accountId);
      const mv = await this.money.record(tx, {
        accountId: acc.id,
        amount: acc.currency === 'KGS' ? amount : amount,
        kind: 'debt_in',
        counterpartyId: r.customerId,
        shiftId,
        verifyStatus: dto.method === 'transfer' && acc.type === 'wallet' ? 'unverified' : null,
        comment: `Предоплата по заявке ${r.number}`,
      });
      const kgs = mv.amountKgs;
      const item = await this.debts.open(tx, { counterpartyId: r.customerId, direction: 'payable', kind: 'prepayment', amount: kgs, description: `Предоплата по заявке ${r.number}`, storeId: r.storeId });
      r.prepaid = r.prepaid.plus(kgs);
      r.prepaymentItemIds = [...r.prepaymentItemIds, item.id];
      r.history = [...r.history, { at: new Date().toISOString(), status: r.status, by: this.ctx.membershipId ?? null, note: `Предоплата ${kgs.toFixed(2)} сом` }];
      await tx.repo(CustomerRequest).save(r);
      await this.audit.log(tx, { action: 'request.prepay', entityType: 'customer_request', entityId: r.id, storeId: r.storeId, summary: `${r.number}: предоплата ${kgs.toFixed(2)} сом`, important: true });
      return this.viewInTx(tx, r.id);
    });
  }

  /**
   * Выдача: система сама делает приёмку (если товар ещё не принят, например — купили у поставщика без заказа)
   * или «взял у соседа», и продажу; предоплата засчитывается, остаток — оплатами чека.
   */
  issue(id: string, version: number, dto: { registerId: string; payments?: any[]; changeCurrency?: 'KGS' | 'USD'; pin?: string; receive?: boolean; warehouseId?: string; idempotencyKey?: string }) {
    return this.tenantTx.run(async (tx) => {
      const r = await this.lock(tx, id, version);
      this.assertOpen(r);
      const items = await tx.repo(CustomerRequestItem).find({ where: { requestId: r.id }, order: { lineNo: 'ASC' } });
      const lines: ReceiptLineInput[] = [];
      // Приёмка «на месте»: поставщик выбран, заказа не было или он не принят
      const toReceive = items.filter((i) => i.sourceKind === 'supplier' && !i.arrivedAt && i.productId);
      if (toReceive.length && dto.receive !== false) {
        const reg = await tx.query(`SELECT warehouse_id FROM registers WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, dto.registerId]);
        const bySupplier = new Map<string, CustomerRequestItem[]>();
        for (const i of toReceive) bySupplier.set(i.sourceId!, [...(bySupplier.get(i.sourceId!) ?? []), i]);
        for (const [supplierId, its] of bySupplier) {
          const doc = await this.docs.createInTx(tx, {
            type: 'receiving',
            warehouseId: dto.warehouseId ?? reg[0]?.warehouse_id,
            counterpartyId: supplierId,
            comment: `Под заявку ${r.number}`,
            lines: its.map((i) => ({ productId: i.productId!, qty: i.qty.toFixed(), price: i.purchasePrice?.toFixed() ?? undefined })),
          } as any);
          await this.docs.postInTx(tx, doc, { system: true });
          for (const i of its) await tx.query(`UPDATE customer_request_items SET arrived_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, i.id]);
        }
      }
      for (const i of items) {
        if (i.sourceKind === 'neighbor' && !i.productId) {
          if (!i.salePrice || !i.purchasePrice) throw Errors.bad('PRICES_REQUIRED', `«${i.name}»: укажите цену закупки у соседа и цену продажи`);
          lines.push({ neighbor: { neighborId: i.sourceId!, name: i.name, partNumber: i.number ?? undefined, purchasePrice: i.purchasePrice.toFixed(2) }, qty: i.qty.toFixed(), price: i.salePrice.toFixed(2) });
        } else if (i.sourceKind === 'neighbor' && i.productId) {
          if (!i.salePrice || !i.purchasePrice) throw Errors.bad('PRICES_REQUIRED', `«${i.name}»: укажите цену закупки у соседа и цену продажи`);
          lines.push({ neighbor: { neighborId: i.sourceId!, name: i.name, partNumber: i.number ?? undefined, productId: i.productId, purchasePrice: i.purchasePrice.toFixed(2) }, qty: i.qty.toFixed(), price: i.salePrice.toFixed(2) });
        } else {
          if (!i.productId) throw Errors.bad('PRODUCT_REQUIRED', `«${i.name}»: выберите товар`);
          lines.push({ productId: i.productId, qty: i.qty.toFixed(), price: i.salePrice?.toFixed(2) ?? undefined });
        }
      }
      const receipt = await this.receipts.createInTx(
        tx,
        { registerId: dto.registerId, customerId: r.customerId, customerVehicleId: r.customerVehicleId, lines, idempotencyKey: dto.idempotencyKey ?? null },
        { system: true },
      );
      // Предоплата засчитывается первой
      const prepay = r.prepaymentItemIds.length ? await this.debts.advances(tx, r.customerId!, ['prepayment']) : [];
      const mine = prepay.filter((p) => r.prepaymentItemIds.includes(p.id));
      const available = mine.reduce((a, p) => a.plus(p.remaining), D(0));
      const use = Decimal.min(available, receipt.total);
      const payments = [...(use.gt(0) ? [{ method: 'advance', amount: use.toFixed(2), advanceItemIds: mine.map((m) => m.id) }] : []), ...(dto.payments ?? [])];
      const doc = await this.docs.lockDoc(tx, receipt.documentId);
      await this.receipts.payInTx(tx, receipt, doc, { payments: payments as any, changeCurrency: dto.changeCurrency, pin: dto.pin });
      // Остаток предоплаты (заказали дешевле) — в аванс клиента
      if (available.gt(use)) await this.releasePrepayment(tx, r, 'advance');
      r.receiptId = receipt.id;
      await this.move(tx, r, 'issued', `Чек ${receipt.number}`);
      r.closedAt = new Date();
      await tx.repo(CustomerRequest).save(r);
      await tx.query(`UPDATE waitlist_entries SET status = 'done' WHERE tenant_id = $1 AND customer_id = $2 AND product_id = ANY($3::uuid[]) AND status IN ('waiting', 'notified')`, [
        tx.tenantId,
        r.customerId,
        items.map((i) => i.productId).filter(Boolean),
      ]);
      return { request: await this.viewInTx(tx, r.id), receipt: await this.receipts.viewInTx(tx, receipt.id) };
    });
  }

  /** Отказ: предоплата возвращается деньгами или остаётся авансом клиента. Заявка — в «Что спрашивают, но нет». */
  refuse(id: string, version: number, dto: { reason: string; refund?: 'money' | 'advance'; registerId?: string; accountId?: string }) {
    return this.tenantTx.run(async (tx) => {
      const r = await this.lock(tx, id, version);
      this.assertOpen(r);
      if (!dto.reason?.trim()) throw Errors.bad('REASON_REQUIRED', 'Укажите причину отказа');
      if (r.prepaid.gt(0)) {
        if (!dto.refund) throw Errors.bad('REFUND_REQUIRED', 'Есть предоплата: вернуть деньгами или оставить авансом');
        if (dto.refund === 'advance') await this.releasePrepayment(tx, r, 'advance');
        else {
          let accountId = dto.accountId;
          let shiftId: string | null = null;
          if (!accountId) {
            if (!dto.registerId) throw Errors.bad('REGISTER_REQUIRED', 'Укажите кассу для возврата денег');
            const shift = await this.shifts.requireOpenShift(tx, dto.registerId);
            shiftId = shift.id;
            accountId = (await this.money.registerCash(tx, dto.registerId, 'KGS')).id;
          }
          const amount = await this.releasePrepayment(tx, r, 'refund');
          if (amount.gt(0)) {
            const bal = await this.money.balance(tx, accountId);
            if (bal.lt(amount)) throw Errors.conflict('NOT_ENOUGH_CASH', `На счёте ${bal.toFixed(2)} — не хватает на возврат предоплаты`);
            await this.money.record(tx, { accountId, amount: amount.neg(), kind: 'debt_out', counterpartyId: r.customerId, shiftId, comment: `Возврат предоплаты по заявке ${r.number}` });
          }
        }
      }
      r.refuseReason = dto.reason.trim().slice(0, 500);
      r.closedAt = new Date();
      await this.move(tx, r, 'refused', r.refuseReason);
      // «Что спрашивают, но нет»
      const items = await tx.repo(CustomerRequestItem).find({ where: { requestId: r.id } });
      for (const i of items) {
        const q = (i.number ?? i.name).slice(0, 300);
        await tx.query(`INSERT INTO unfound_queries (tenant_id, created_by, query, normalized, reason, store_id, context) VALUES ($1, $2, $3, $4, 'request', $5, 'request')`, [
          tx.tenantId,
          tx.userId,
          q,
          (normalizePartNumber(i.number ?? '') || i.name.toLowerCase()).slice(0, 300),
          r.storeId,
        ]);
      }
      return this.viewInTx(tx, r.id);
    });
  }

  /** Снять предоплату заявки: в аванс клиента (сам гасит долги) или для возврата деньгами. Возвращает сумму. */
  private async releasePrepayment(tx: TenantTx, r: CustomerRequest, to: 'advance' | 'refund'): Promise<Decimal> {
    if (!r.customerId || !r.prepaymentItemIds.length) return D(0);
    const items = (await this.debts.advances(tx, r.customerId, ['prepayment'])).filter((i) => r.prepaymentItemIds.includes(i.id));
    const left = items.reduce((a, i) => a.plus(i.remaining), D(0));
    if (left.lte(0)) return D(0);
    await this.debts.consumeAdvance(tx, items, left, null);
    if (to === 'advance') {
      await this.debts.open(tx, { counterpartyId: r.customerId, direction: 'payable', kind: 'advance', amount: left, description: `Аванс после заявки ${r.number}`, storeId: r.storeId });
    }
    return left;
  }

  // ── Чтение ───────────────────────────────────────────────

  /** Список или канбан (view=kanban — по колонкам статусов); просроченные подсвечены. */
  list(q: { status?: string; storeId?: string; customerId?: string; q?: string; view?: 'list' | 'kanban'; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const w = ['r.tenant_id = $1', 'r.deleted_at IS NULL'];
      if (q.status) w.push(`r.status = ANY(${p(q.status.split(','))}::text[])`);
      else if (q.view === 'kanban') w.push(`(r.status NOT IN ('issued', 'refused') OR r.closed_at > now() - interval '3 days')`);
      if (q.storeId) w.push(`r.store_id = ${p(q.storeId)}`);
      if (q.customerId) w.push(`r.customer_id = ${p(q.customerId)}`);
      if (q.q) w.push(`(r.number ILIKE ${p(`%${q.q}%`)} OR r.customer_name ILIKE $${params.length} OR r.customer_phone LIKE $${params.length} OR c.name ILIKE $${params.length}
                    OR EXISTS (SELECT 1 FROM customer_request_items i WHERE i.request_id = r.id AND (i.name ILIKE $${params.length} OR i.number ILIKE $${params.length})))`);
      const allowed = this.scope.storeIds();
      if (allowed) w.push(`r.store_id = ANY(${p(allowed)}::uuid[])`);
      const where = w.join(' AND ');
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM customer_requests r LEFT JOIN counterparties c ON c.id = r.customer_id WHERE ${where}`, params);
      const items = await tx.query(
        `SELECT r.id, r.number, r.kind, r.status, r.created_at AS "createdAt", r.due_at AS "dueAt", r.prepaid, r.version,
                coalesce(c.name, r.customer_name) AS "customerName", coalesce(c.phone, r.customer_phone) AS "customerPhone",
                coalesce(v.title, r.vehicle_text) AS vehicle, (r.due_at < now() AND r.status NOT IN ('issued', 'refused', 'arrived')) AS overdue,
                (SELECT string_agg(i.name, ', ' ORDER BY i.line_no) FROM customer_request_items i WHERE i.request_id = r.id) AS what
           FROM customer_requests r LEFT JOIN counterparties c ON c.id = r.customer_id LEFT JOIN customer_vehicles v ON v.id = r.customer_vehicle_id
          WHERE ${where} ORDER BY overdue DESC, r.created_at DESC LIMIT ${q.view === 'kanban' ? 500 : q.limit} OFFSET ${q.view === 'kanban' ? 0 : (q.page - 1) * q.limit}`,
        params,
      );
      if (q.view === 'kanban') {
        return { columns: Object.entries(STATUS_LABELS).map(([status, label]) => ({ status, label, items: items.filter((i: any) => i.status === status) })), total };
      }
      return { items, total };
    });
  }

  get(id: string) {
    return this.tenantTx.run((tx) => this.viewInTx(tx, id));
  }

  private async viewInTx(tx: TenantTx, id: string) {
    const r = await tx.repo(CustomerRequest, 'Заявка').getById(id);
    if (!this.scope.canStore(r.storeId)) throw Errors.notFound('Заявка');
    const items = await tx.query(
      `SELECT i.id, i.line_no AS "lineNo", i.number, i.name, i.qty, i.photo_file_ids AS "photoFileIds", i.product_id AS "productId", p.name AS "productName",
              i.sale_price AS "salePrice", i.source_id AS "sourceId", i.source_kind AS "sourceKind", s.name AS "sourceName",
              ${this.ctx.can('products.view_cost') ? 'i.purchase_price AS "purchasePrice",' : ''} i.purchase_order_line_id AS "purchaseOrderLineId",
              (SELECT o.number FROM purchase_order_lines ol JOIN purchase_orders o ON o.id = ol.order_id WHERE ol.id = i.purchase_order_line_id) AS "purchaseOrderNumber",
              i.arrived_at AS "arrivedAt", i.offers
         FROM customer_request_items i LEFT JOIN products p ON p.id = i.product_id LEFT JOIN counterparties s ON s.id = i.source_id
        WHERE i.tenant_id = $1 AND i.request_id = $2 ORDER BY i.line_no`,
      [tx.tenantId, id],
    );
    if (!this.ctx.can('products.view_cost')) for (const i of items) i.offers = (i.offers ?? []).map(({ purchasePrice: _p, ...o }: any) => o);
    const customer = r.customerId ? await tx.repo(Counterparty).findById(r.customerId) : null;
    return {
      ...r,
      statusLabel: STATUS_LABELS[r.status],
      overdue: !!r.dueAt && r.dueAt < new Date() && !['issued', 'refused', 'arrived'].includes(r.status),
      customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone } : null,
      items,
      nextStatuses: NEXT[r.status],
    };
  }

  /** Текст «ваша деталь пришла» и ссылка WhatsApp (Telegram-бот — этап 7). */
  message(id: string) {
    return this.tenantTx.run(async (tx) => {
      const v: any = await this.viewInTx(tx, id);
      const store = await tx.repo(Store).findById(v.storeId);
      const what = v.items.map((i: any) => i.productName ?? i.name).join(', ');
      const due = v.items.reduce((a: Decimal, i: any) => a.plus(D(i.salePrice ?? 0).mul(i.qty)), D(0)).minus(v.prepaid);
      const text =
        v.status === 'arrived'
          ? `Здравствуйте${v.customer?.name ? `, ${v.customer.name}` : ''}! Ваша деталь пришла: ${what}. Заявка ${v.number}.${due.gt(0) ? ` К оплате ${due.toFixed(0)} сом.` : ''} ${store?.name ?? ''}${store?.address ? `, ${store.address}` : ''}`
          : `Здравствуйте! По заявке ${v.number} (${what}): ${v.statusLabel.toLowerCase()}. ${store?.name ?? ''}`;
      const phone = (v.customer?.phone ?? v.customerPhone ?? '').replace(/\D/g, '');
      return { text: text.trim(), whatsappUrl: `https://wa.me/${phone}?text=${encodeURIComponent(text.trim())}` };
    });
  }

  private async move(tx: TenantTx, r: CustomerRequest, status: RequestStatus, note?: string) {
    r.status = status;
    r.history = [...r.history, { at: new Date().toISOString(), status, by: this.ctx.membershipId ?? null, note }];
    await tx.repo(CustomerRequest).save(r);
    await this.audit.log(tx, { action: `request.${status}`, entityType: 'customer_request', entityId: r.id, storeId: r.storeId, summary: `${r.number}: ${STATUS_LABELS[status]}${note ? ` — ${note}` : ''}`.slice(0, 300) });
  }

  private assertOpen(r: CustomerRequest) {
    if (r.status === 'issued' || r.status === 'refused') throw Errors.conflict('REQUEST_CLOSED', `Заявка уже «${STATUS_LABELS[r.status]}»`);
  }

  private async lock(tx: TenantTx, id: string, version?: number) {
    const r = await tx.repo(CustomerRequest, 'Заявка').getForUpdate(id, version);
    this.scope.assertStore(r.storeId);
    return r;
  }

  private async notifyOverdue(tenantId: string) {
    await this.tenantTx.run(
      async (tx) => {
        const rows = await tx.query(
          `SELECT id, number, store_id FROM customer_requests WHERE tenant_id = $1 AND deleted_at IS NULL AND status NOT IN ('issued', 'refused', 'arrived')
             AND due_at < now() AND (overdue_notified_at IS NULL OR overdue_notified_at < now() - interval '1 day')`,
          [tenantId],
        );
        for (const r of rows) {
          await this.notifications.notify(tx, { type: 'request.overdue', title: `Заявка ${r.number} просрочена`, entityType: 'customer_request', entityId: r.id, storeId: r.store_id, permission: 'requests.write', link: `/requests/${r.id}` });
          await tx.query(`UPDATE customer_requests SET overdue_notified_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, r.id]);
        }
      },
      { tenantId, userId: null },
    );
  }

  // ── Лист ожидания (ТЗ 18.4) ──────────────────────────────

  waitlist(q: { status?: string; storeId?: string; productId?: string }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const w = ['e.tenant_id = $1', 'e.deleted_at IS NULL'];
      if (q.status) {
        params.push(q.status.split(','));
        w.push(`e.status = ANY($${params.length}::text[])`);
      }
      if (q.storeId) {
        params.push(q.storeId);
        w.push(`e.store_id = $${params.length}`);
      }
      if (q.productId) {
        params.push(q.productId);
        w.push(`e.product_id = $${params.length}`);
      }
      const allowed = this.scope.storeIds();
      if (allowed) {
        params.push(allowed);
        w.push(`e.store_id = ANY($${params.length}::uuid[])`);
      }
      return tx.query(
        `SELECT e.id, e.status, e.product_id AS "productId", p.name AS "productName", e.query, e.qty, e.customer_id AS "customerId",
                coalesce(c.name, e.customer_name) AS "customerName", coalesce(c.phone, e.customer_phone) AS "customerPhone", e.created_at AS "createdAt",
                e.notified_at AS "notifiedAt", e.note, e.version
           FROM waitlist_entries e LEFT JOIN products p ON p.id = e.product_id LEFT JOIN counterparties c ON c.id = e.customer_id
          WHERE ${w.join(' AND ')} ORDER BY e.created_at DESC LIMIT 500`,
        params,
      );
    });
  }

  addWaitlist(dto: { storeId?: string; productId?: string; query?: string; customerId?: string; customerName?: string; customerPhone?: string; qty?: string; note?: string }) {
    return this.tenantTx.run(async (tx) => {
      if (!dto.productId && !dto.query?.trim()) throw Errors.bad('WHAT_REQUIRED', 'Укажите товар или что искали');
      if (!dto.customerId && !dto.customerPhone) throw Errors.bad('CUSTOMER_REQUIRED', 'Укажите клиента или телефон');
      if (dto.productId) await tx.repo(Product, 'Товар').getById(dto.productId);
      const storeId = dto.storeId ?? this.scope.currentStoreId() ?? (await tx.query(`SELECT id FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [tx.tenantId]))[0]?.id;
      this.scope.assertStore(storeId);
      const customerId = await this.resolveCustomer(tx, { customerId: dto.customerId, customerName: dto.customerName, customerPhone: dto.customerPhone });
      return tx.repo(WaitlistEntry).insert({
        storeId,
        productId: dto.productId ?? null,
        query: dto.query?.trim() || null,
        normalized: dto.query ? normalizePartNumber(dto.query) || null : null,
        customerId,
        customerName: dto.customerName ?? null,
        customerPhone: dto.customerPhone ? (normalizePhone(dto.customerPhone) ?? dto.customerPhone) : null,
        qty: qty3(dto.qty ?? 1),
        note: dto.note ?? null,
      });
    });
  }

  setWaitlistStatus(id: string, version: number, status: 'done' | 'cancelled' | 'waiting') {
    return this.tenantTx.run(async (tx) => {
      const e = await tx.repo(WaitlistEntry, 'Запись').getForUpdate(id, version);
      this.scope.assertStore(e.storeId);
      e.status = status;
      return tx.repo(WaitlistEntry).save(e);
    });
  }

  /** Товар пришёл: продавцу — уведомление, клиенту — готовый текст (ссылка WhatsApp в записи). */
  private async checkWaitlist(tx: TenantTx, documentId: string) {
    const rows = await tx.query(
      `SELECT e.id, e.store_id, e.product_id, p.name, coalesce(c.name, e.customer_name) AS customer, coalesce(c.phone, e.customer_phone) AS phone
         FROM waitlist_entries e JOIN products p ON p.id = e.product_id LEFT JOIN counterparties c ON c.id = e.customer_id
        WHERE e.tenant_id = $1 AND e.status = 'waiting' AND e.deleted_at IS NULL
          AND e.product_id IN (SELECT DISTINCT m.product_id FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
                                WHERE m.tenant_id = $1 AND m.document_id = $2 AND m.qty > 0 AND w.store_id = e.store_id)`,
      [tx.tenantId, documentId],
    );
    for (const r of rows) {
      await tx.query(`UPDATE waitlist_entries SET status = 'notified', notified_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, r.id]);
      const text = `Здравствуйте${r.customer ? `, ${r.customer}` : ''}! Пришёл товар, который вы ждали: ${r.name}.`;
      await this.notifications.notify(tx, {
        type: 'waitlist.arrived',
        title: `Пришёл товар из листа ожидания: ${r.name}${r.customer ? ` — ${r.customer}` : ''}`,
        entityType: 'waitlist_entry',
        entityId: r.id,
        storeId: r.store_id,
        permission: 'pos.use',
        data: { whatsappUrl: `https://wa.me/${String(r.phone ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`, text },
      });
    }
  }
}
