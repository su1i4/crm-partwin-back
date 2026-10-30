import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { normalizePartNumber } from '../../common/utils/part-number';
import { readTable, tableKind } from '../../common/utils/table-reader';
import { D, Decimal, money } from '../../common/utils/decimal';
import { CountersService } from '../../database/tenant/counters.service';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { CounterpartiesService } from '../counterparties/counterparties.service';
import { DocumentsService } from '../documents/documents.service';
import { DebtsService } from '../finance/debts.service';
import { MoneyService } from '../finance/money.service';
import { MoneyAccount } from '../finance/entities/money-account.entity';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReceiptsService } from '../pos/receipts.service';
import { PriceResolverService } from '../pricing/price-resolver.service';
import { Warehouse } from '../stores/entities/warehouse.entity';
import { ConsignmentReport, Container, ContainerLine, ContainerStatus, DeliveryStatus, Donor, InvoiceMapping, SalesOrder, SalesOrderLine } from './entities/wholesale.entity';

const CONTAINER_FLOW: ContainerStatus[] = ['draft', 'paid', 'in_transit', 'customs', 'received'];
const DELIVERY_FLOW: DeliveryStatus[] = ['assembled', 'on_way', 'delivered', 'paid'];
const mapKey = (code?: string | null, name?: string | null) => (code ? `c:${normalizePartNumber(code)}` : `n:${String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}`);

/**
 * Опт и импорт (этап 9): контейнеры с инвойсом и запоминанием сопоставлений, заказы покупателей с резервом,
 * доставка и подотчёт водителя, реализация, разборка доноров.
 */
@Injectable()
export class WholesaleService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly docs: DocumentsService,
    private readonly receipts: ReceiptsService,
    private readonly debts: DebtsService,
    private readonly money: MoneyService,
    private readonly files: FilesService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly resolver: PriceResolverService,
    private readonly counterparties: CounterpartiesService,
  ) {}

  private history(status: string, note?: string) {
    return { at: new Date().toISOString(), status, by: this.ctx.membershipId ?? null, ...(note ? { note } : {}) };
  }

  // ── Контейнеры (ТЗ 10.8) ─────────────────────────────────

  createContainer(dto: { supplierId: string; warehouseId: string; currency?: string; rate?: string; expectedOn?: string; distribution?: Container['distribution']; comment?: string }) {
    return this.tenantTx.run(async (tx) => {
      const wh = await tx.repo(Warehouse, 'Склад').getById(dto.warehouseId);
      this.scope.assertStore(wh.storeId);
      const n = await this.counters.next(tx, 'container');
      const c = await tx.repo(Container).insert({
        number: `КН-${n}`,
        supplierId: dto.supplierId,
        storeId: wh.storeId!,
        warehouseId: wh.id,
        currency: dto.currency ?? 'USD',
        rate: dto.rate ? D(dto.rate) : null,
        expectedOn: dto.expectedOn ?? null,
        distribution: dto.distribution ?? 'amount',
        comment: dto.comment ?? null,
        history: [this.history('draft')],
      });
      await this.audit.log(tx, { action: 'container.create', entityType: 'container', entityId: c.id, storeId: c.storeId, summary: c.number });
      return c;
    });
  }

  getContainer(id: string) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(Container, 'Контейнер').getById(id);
      const lines = await tx.query(
        `SELECT l.*, p.name AS "productName" FROM container_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.tenant_id = $1 AND l.container_id = $2 ORDER BY l.line_no`,
        [tx.tenantId, id],
      );
      const total = lines.reduce((a: Decimal, l: any) => a.plus(D(l.qty).mul(l.price)), D(0));
      const paid = c.prepayments.reduce((a, p) => a.plus(D(p.amount)), D(0));
      return { ...c, lines, total: total.toFixed(2), prepaid: paid.toFixed(2), unmatched: lines.filter((l: any) => !l.product_id).length };
    });
  }

  listContainers(status?: string) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT c.id, c.number, c.status, c.currency, c.expected_on AS "expectedOn", s.name AS supplier,
                (SELECT coalesce(sum(l.qty * l.price), 0) FROM container_lines l WHERE l.container_id = c.id) AS total
           FROM containers c JOIN counterparties s ON s.id = c.supplier_id
          WHERE c.tenant_id = $1 AND c.deleted_at IS NULL AND ($2::varchar IS NULL OR c.status = $2) AND ($3::uuid[] IS NULL OR c.store_id = ANY($3))
          ORDER BY c.created_at DESC`,
        [tx.tenantId, status ?? null, this.scope.storeIds()],
      ),
    );
  }

  /**
   * Импорт инвойса (Excel/CSV): колонки — код, название, кол-во, цена, [объём], [вес] (номера колонок задаются).
   * Строки сопоставляются по запомненным сопоставлениям поставщика, затем по номеру детали.
   */
  importInvoice(id: string, dto: { fileId: string; columns: { code?: number; name?: number; qty: number; price: number; volume?: number; weight?: number }; skipRows?: number }) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(Container, 'Контейнер').getById(id);
      if (c.status === 'received') throw Errors.conflict('CONTAINER_RECEIVED', 'Контейнер уже принят');
      const f = await this.files.meta(dto.fileId);
      const kind = tableKind(f.originalName, f.mime);
      if (!kind) throw Errors.bad('FILE_TYPE', 'Нужен Excel или CSV');
      const rows: any[] = [];
      const col = (cells: string[], i?: number) => (i === undefined ? null : (cells[i - 1] ?? '').trim() || null);
      const num = (v: string | null) => (v ? v.replace(/\s/g, '').replace(',', '.') : null);
      await readTable(this.files.pathOf(f), kind, (rowNo, cells) => {
        if (rowNo <= (dto.skipRows ?? 1)) return;
        const qty = num(col(cells, dto.columns.qty));
        const price = num(col(cells, dto.columns.price));
        if (!qty || !/^\d+(\.\d+)?$/.test(qty) || D(qty).lte(0) || !price || !/^\d+(\.\d+)?$/.test(price)) return;
        rows.push({ code: col(cells, dto.columns.code), name: col(cells, dto.columns.name), qty, price, volume: num(col(cells, dto.columns.volume)), weight: num(col(cells, dto.columns.weight)) });
        if (rows.length >= 5000) return false;
      });
      if (!rows.length) throw Errors.bad('EMPTY_INVOICE', 'В файле нет строк с количеством и ценой');
      await tx.query(`DELETE FROM container_lines WHERE tenant_id = $1 AND container_id = $2 AND received_qty = 0`, [tx.tenantId, id]);
      const maps = new Map<string, string>(
        (await tx.query(`SELECT key, product_id FROM invoice_mappings WHERE tenant_id = $1 AND supplier_id = $2`, [tx.tenantId, c.supplierId])).map((m: any) => [m.key, m.product_id]),
      );
      let matched = 0;
      let byNumber = 0;
      const out: Partial<ContainerLine>[] = [];
      for (const [i, r] of rows.entries()) {
        let productId = maps.get(mapKey(r.code, r.name)) ?? null;
        if (!productId && r.code) {
          const [p] = await tx.query(`SELECT product_id FROM part_numbers WHERE tenant_id = $1 AND normalized = $2 LIMIT 1`, [tx.tenantId, normalizePartNumber(r.code)]);
          if (p) {
            productId = p.product_id;
            byNumber++;
          }
        } else if (productId) matched++;
        out.push({ containerId: id, lineNo: i + 1, invoiceCode: r.code?.slice(0, 100) ?? null, invoiceName: r.name?.slice(0, 300) ?? null, productId: productId ?? null, qty: r.qty, price: D(r.price), volume: r.volume, weight: r.weight });
      }
      await tx.repo(ContainerLine).insertMany(out as any);
      return { lines: out.length, matchedByMemory: matched, matchedByNumber: byNumber, unmatched: out.filter((l) => !l.productId).length };
    });
  }

  /** Сопоставить строку с товаром (и запомнить для следующих контейнеров этого поставщика). */
  matchLine(containerId: string, lineId: string, productId: string) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(Container, 'Контейнер').getById(containerId);
      const l = await tx.repo(ContainerLine, 'Строка').getById(lineId);
      await tx.repo(ContainerLine).save(Object.assign(l, { productId }));
      await tx.query(
        `INSERT INTO invoice_mappings (tenant_id, supplier_id, key, product_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, supplier_id, key) DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now()`,
        [tx.tenantId, c.supplierId, mapKey(l.invoiceCode, l.invoiceName), productId],
      );
      return l;
    });
  }

  /** Несопоставленные строки → новые товары одним действием (название и номер из инвойса). */
  createProductsForUnmatched(containerId: string, dto: { categoryId?: string; brandName?: string }) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(Container, 'Контейнер').getById(containerId);
      const lines = await tx.repo(ContainerLine).find({ where: { containerId } });
      let created = 0;
      for (const l of lines.filter((x) => !x.productId)) {
        const [p] = await tx.query(
          `INSERT INTO products (tenant_id, name, sku, kind, quality_class, category_id, base_unit, status, attributes, tags, search_text)
           VALUES ($1, $2, $3, 'part', 'aftermarket', $4, 'шт', 'active', '{}', '{}', lower($2 || ' ' || coalesce($3, ''))) RETURNING id`,
          [tx.tenantId, (l.invoiceName || l.invoiceCode || 'Товар из контейнера').slice(0, 300), l.invoiceCode?.slice(0, 60) ?? null, dto.categoryId ?? null],
        );
        await tx.query(`INSERT INTO product_units (tenant_id, product_id, name, factor, is_base) VALUES ($1, $2, 'шт', 1, true)`, [tx.tenantId, p.id]).catch(() => undefined);
        if (l.invoiceCode) {
          await tx.query(`INSERT INTO part_numbers (tenant_id, product_id, number, normalized, type) VALUES ($1, $2, $3, $4, 'manufacturer')`, [tx.tenantId, p.id, l.invoiceCode, normalizePartNumber(l.invoiceCode)]).catch(() => undefined);
        }
        l.productId = p.id;
        await tx.repo(ContainerLine).save(l);
        await tx.query(
          `INSERT INTO invoice_mappings (tenant_id, supplier_id, key, product_id) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, supplier_id, key) DO NOTHING`,
          [tx.tenantId, c.supplierId, mapKey(l.invoiceCode, l.invoiceName), p.id],
        );
        created++;
      }
      return { created };
    });
  }

  updateContainer(id: string, version: number, dto: Partial<Pick<Container, 'rate' | 'expectedOn' | 'distribution' | 'costs' | 'comment'>> & { manualCosts?: { lineId: string; amount: string }[] }) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(Container, 'Контейнер').getForUpdate(id, version);
      const { manualCosts, ...rest } = dto as any;
      if (rest.rate) rest.rate = D(rest.rate);
      Object.assign(c, rest);
      for (const m of manualCosts ?? []) await tx.query(`UPDATE container_lines SET manual_cost = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, m.lineId, money(m.amount).toFixed(2)]);
      return tx.repo(Container).save(c);
    });
  }

  /** Предоплата поставщику по контейнеру: со счёта (в валюте счёта), долг/аванс поставщика. */
  prepay(id: string, dto: { accountId: string; amount: string; comment?: string }) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(Container, 'Контейнер').getById(id);
      const pay: any = await this.debts.payInTx(tx, { counterpartyId: c.supplierId, direction: 'out', currency: c.currency === 'KGS' ? 'KGS' : 'USD', amount: dto.amount, accountId: dto.accountId, comment: `Предоплата за контейнер ${c.number}${dto.comment ? `: ${dto.comment}` : ''}` } as any);
      c.prepayments = [...c.prepayments, { at: new Date().toISOString(), amount: money(dto.amount).toFixed(2), currency: c.currency, accountId: dto.accountId, paymentId: pay?.id ?? null }];
      if (c.status === 'draft') {
        c.status = 'paid';
        c.history = [...c.history, this.history('paid')];
      }
      return tx.repo(Container).save(c);
    });
  }

  setContainerStatus(id: string, status: ContainerStatus) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(Container, 'Контейнер').getById(id);
      if (status === 'received') throw Errors.bad('USE_RECEIVE', 'Принять контейнер — через приёмку (/receive)');
      if (CONTAINER_FLOW.indexOf(status) < CONTAINER_FLOW.indexOf(c.status)) throw Errors.bad('BAD_STATUS', 'Статус назад не меняется');
      c.status = status;
      c.history = [...c.history, this.history(status)];
      return tx.repo(Container).save(c);
    });
  }

  /**
   * Приёмка контейнера (частями): документ «Приёмка» по курсу контейнера; расходы распределены по объёму,
   * весу, сумме или вручную и входят в себестоимость строк. Бой — отдельно (в акт).
   */
  receiveContainer(id: string, dto: { lines?: { lineId: string; qty: string; damaged?: string }[]; post?: boolean }) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(Container, 'Контейнер').getById(id);
      if (!c.rate && c.currency !== 'KGS') throw Errors.bad('RATE_REQUIRED', 'Укажите курс контейнера');
      const all = await tx.repo(ContainerLine).find({ where: { containerId: id }, order: { lineNo: 'ASC' } });
      if (all.some((l) => !l.productId)) throw Errors.bad('UNMATCHED', 'Есть несопоставленные строки — сопоставьте или создайте товары');
      const take = new Map((dto.lines ?? all.map((l) => ({ lineId: l.id, qty: D(l.qty).minus(l.receivedQty).toFixed() }))).map((x: any) => [x.lineId, x]));
      // Распределение расходов (в сомах) на весь контейнер, доля строки — пропорционально принимаемому
      const costsKgs = c.costs.reduce((a, x) => a.plus(D(x.amount)), D(0));
      const base = (l: ContainerLine) =>
        c.distribution === 'volume' ? D(l.volume ?? 0) : c.distribution === 'weight' ? D(l.weight ?? 0) : D(l.qty).mul(l.price);
      const totalBase = all.reduce((a, l) => a.plus(base(l)), D(0));
      const rate = c.currency === 'KGS' ? D(1) : D(c.rate!);
      const lines: any[] = [];
      for (const l of all) {
        const t: any = take.get(l.id);
        if (!t || D(t.qty).lte(0)) continue;
        const left = D(l.qty).minus(l.receivedQty);
        if (D(t.qty).gt(left)) throw Errors.bad('OVER_RECEIVED', `Строка ${l.lineNo}: осталось принять ${left.toFixed()}`);
        const lineCost = c.distribution === 'manual' ? D(l.manualCost ?? 0) : totalBase.isZero() ? D(0) : costsKgs.mul(base(l)).div(totalBase);
        const perUnitExtra = lineCost.div(l.qty).div(rate);
        lines.push({ productId: l.productId, qty: D(t.qty).toFixed(), price: D(l.price).plus(perUnitExtra).toDecimalPlaces(4).toFixed() });
        l.receivedQty = D(l.receivedQty).plus(t.qty).toFixed();
        if (t.damaged) l.damagedQty = D(l.damagedQty).plus(t.damaged).toFixed();
        await tx.repo(ContainerLine).save(l);
      }
      if (!lines.length) throw Errors.bad('NO_LINES', 'Нечего принимать');
      const doc = await this.docs.createInTx(tx, { type: 'receiving', warehouseId: c.warehouseId, counterpartyId: c.supplierId, currency: c.currency, rate: rate.toFixed(), comment: `Контейнер ${c.number}`, extra: { containerId: c.id }, lines } as any);
      if (dto.post !== false) await this.docs.postInTx(tx, doc);
      c.receivingDocumentIds = [...c.receivingDocumentIds, doc.id];
      if (all.every((l) => D(l.receivedQty).gte(l.qty))) {
        c.status = 'received';
        c.history = [...c.history, this.history('received')];
      }
      await tx.repo(Container).save(c);
      return { container: c, documentId: doc.id, damaged: all.filter((l) => D(l.damagedQty).gt(0)).map((l) => ({ lineNo: l.lineNo, productId: l.productId, qty: l.damagedQty })) };
    });
  }

  /** Товар «ожидается» из контейнеров в пути. */
  expected(productIds?: string[]) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT l.product_id AS "productId", sum(l.qty - l.received_qty) AS qty, min(c.expected_on) AS "expectedOn", array_agg(DISTINCT c.number) AS containers
           FROM container_lines l JOIN containers c ON c.id = l.container_id
          WHERE l.tenant_id = $1 AND c.status IN ('paid', 'in_transit', 'customs') AND l.product_id IS NOT NULL AND l.qty > l.received_qty
            AND ($2::uuid[] IS NULL OR l.product_id = ANY($2)) GROUP BY l.product_id`,
        [tx.tenantId, productIds?.length ? productIds : null],
      ),
    );
  }

  // ── Заказы покупателей и доставка (ТЗ 14.3, 14.4) ────────

  /** Резерв: заказанное и не отгруженное по открытым заказам. */
  async reservedMap(tx: TenantTx, productIds: string[], exceptOrderId?: string) {
    const rows = await tx.query(
      `SELECT l.product_id, sum(l.qty - l.shipped_qty) AS q FROM sales_order_lines l JOIN sales_orders o ON o.id = l.order_id
        WHERE l.tenant_id = $1 AND o.status IN ('reserved', 'partially_shipped') AND l.product_id = ANY($2::uuid[]) AND ($3::uuid IS NULL OR o.id <> $3)
        GROUP BY l.product_id`,
      [tx.tenantId, productIds, exceptOrderId ?? null],
    );
    return new Map<string, Decimal>(rows.map((r: any) => [r.product_id, D(r.q)]));
  }

  createOrder(dto: { counterpartyId: string; lines: { productId: string; qty: string; price?: string; warehouseId?: string }[]; reserve?: boolean; dueOn?: string; address?: string; driverId?: string; deliveryCost?: string; comment?: string }) {
    return this.tenantTx.run(async (tx) => {
      const storeId = this.scope.currentStoreId();
      if (!storeId) throw Errors.bad('STORE_REQUIRED', 'Выберите точку');
      if (!dto.lines?.length) throw Errors.bad('NO_LINES', 'В заказе нет строк');
      const terms = await this.counterparties.terms(tx, dto.counterpartyId);
      const quotes = await this.resolver.quote(tx, { storeId, priceTypeId: terms.priceTypeId, counterpartyId: dto.counterpartyId, items: dto.lines.map((l) => ({ productId: l.productId, unitId: null })) });
      const priced = dto.lines.map((l, i) => {
        if (l.price && !this.ctx.can('sales.custom_price')) throw Errors.forbidden('Своя цена в заказе — по праву');
        const price = l.price ?? (quotes[i] as any)?.price;
        if (!price) throw Errors.bad('NO_PRICE', 'У товара нет цены');
        return { ...l, price: money(price) };
      });
      const total = priced.reduce((a, l) => a.plus(money(l.price.mul(l.qty))), D(0));
      const n = await this.counters.next(tx, 'sales_order');
      const o = await tx.repo(SalesOrder).insert({
        number: `ЗП-${n}`,
        storeId,
        counterpartyId: dto.counterpartyId,
        status: 'new',
        total,
        dueOn: dto.dueOn ?? null,
        address: dto.address ?? null,
        driverId: dto.driverId ?? null,
        deliveryCost: dto.deliveryCost ? money(dto.deliveryCost) : null,
        comment: dto.comment ?? null,
        history: [this.history('new')],
      });
      await tx.repo(SalesOrderLine).insertMany(priced.map((l, i) => ({ orderId: o.id, lineNo: i + 1, productId: l.productId, warehouseId: l.warehouseId ?? null, qty: D(l.qty).toFixed(), price: l.price })));
      if (dto.reserve !== false) await this.reserveInTx(tx, o);
      return this.orderView(tx, o.id);
    });
  }

  private async reserveInTx(tx: TenantTx, o: SalesOrder) {
    const lines = await tx.repo(SalesOrderLine).find({ where: { orderId: o.id } });
    const ids = lines.map((l) => l.productId);
    const reserved = await this.reservedMap(tx, ids, o.id);
    const stock = await tx.query(
      `SELECT b.product_id, sum(b.qty) AS q FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
        WHERE b.tenant_id = $1 AND w.store_id = $2 AND w.type IN ('sales_floor', 'storage') AND b.product_id = ANY($3::uuid[]) GROUP BY b.product_id`,
      [tx.tenantId, o.storeId, ids],
    );
    const short: string[] = [];
    for (const l of lines) {
      const free = D(stock.find((s: any) => s.product_id === l.productId)?.q ?? 0).minus(reserved.get(l.productId) ?? 0);
      if (free.lt(D(l.qty).minus(l.shippedQty))) short.push(l.productId);
    }
    o.status = 'reserved';
    o.history = [...o.history, this.history('reserved', short.length ? `не хватает ${short.length} поз.` : undefined)];
    await tx.repo(SalesOrder).save(o);
    return short;
  }

  async orderView(tx: TenantTx, id: string) {
    const o = await tx.repo(SalesOrder, 'Заказ').getById(id);
    const lines = await tx.query(
      `SELECT l.*, p.name FROM sales_order_lines l JOIN products p ON p.id = l.product_id WHERE l.tenant_id = $1 AND l.order_id = $2 ORDER BY l.line_no`,
      [tx.tenantId, id],
    );
    const [prepaid] = await tx.query(`SELECT coalesce(sum(remaining), 0) AS s FROM debt_items WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tx.tenantId, o.prepaymentItemIds]);
    return { ...o, lines, prepaidRemaining: money(prepaid.s).toFixed(2) };
  }

  getOrder(id: string) {
    return this.tenantTx.run((tx) => this.orderView(tx, id));
  }

  listOrders(q: { status?: string; counterpartyId?: string; driver?: boolean }) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT o.id, o.number, o.status, o.total, o.due_on AS "dueOn", o.address, o.delivery_status AS "deliveryStatus", o.driver_id AS "driverId", c.name AS customer, c.phone
           FROM sales_orders o JOIN counterparties c ON c.id = o.counterparty_id
          WHERE o.tenant_id = $1 AND o.deleted_at IS NULL AND ($2::varchar IS NULL OR o.status = $2) AND ($3::uuid IS NULL OR o.counterparty_id = $3)
            AND ($4::uuid IS NULL OR o.driver_id = $4) AND ($5::uuid[] IS NULL OR o.store_id = ANY($5))
          ORDER BY o.created_at DESC LIMIT 500`,
        [tx.tenantId, q.status ?? null, q.counterpartyId ?? null, q.driver ? this.ctx.membershipId : null, this.scope.storeIds()],
      ),
    );
  }

  /** Изменить цену строки заказа — по праву «своя цена». */
  setOrderPrice(id: string, lineId: string, price: string) {
    if (!this.ctx.can('sales.custom_price')) throw Errors.forbidden('Цена в заказе меняется по праву');
    return this.tenantTx.run(async (tx) => {
      const l = await tx.repo(SalesOrderLine, 'Строка').getById(lineId);
      if (l.orderId !== id) throw Errors.notFound('Строка');
      l.price = money(price);
      await tx.repo(SalesOrderLine).save(l);
      const lines = await tx.repo(SalesOrderLine).find({ where: { orderId: id } });
      await tx.query(`UPDATE sales_orders SET total = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id, lines.reduce((a, x) => a.plus(money(D(x.price).mul(x.qty))), D(0)).toFixed(2)]);
      return this.orderView(tx, id);
    });
  }

  /** Предоплата по заказу: деньги на счёт, у клиента — предоплата, гасится при отгрузке. */
  prepayOrder(id: string, dto: { accountId: string; amount: string }) {
    return this.tenantTx.run(async (tx) => {
      const o = await tx.repo(SalesOrder, 'Заказ').getById(id);
      const amount = money(dto.amount);
      const acc = await this.money.account(tx, dto.accountId);
      const item = await this.debts.open(tx, { counterpartyId: o.counterpartyId, direction: 'payable', kind: 'prepayment', amount, description: `Предоплата по заказу ${o.number}`, storeId: o.storeId } as any);
      await this.money.record(tx, { accountId: acc.id, amount, kind: 'debt_in', counterpartyId: o.counterpartyId, comment: `Предоплата ${o.number}`, verifyStatus: acc.type === 'wallet' ? 'unverified' : null });
      o.prepaymentItemIds = [...o.prepaymentItemIds, item.id];
      o.history = [...o.history, this.history(o.status, `предоплата ${amount.toFixed(2)}`)];
      await tx.repo(SalesOrder).save(o);
      return this.orderView(tx, id);
    });
  }

  /**
   * Отгрузка (полная или частичная): чек по зафиксированным в заказе ценам, оплата — предоплатой, долгом
   * или деньгами. Со склада кассы; другой склад — сначала перемещение.
   */
  ship(id: string, dto: { registerId: string; lines?: { lineId: string; qty: string }[]; payments?: any[]; changeCurrency?: 'KGS' | 'USD'; pin?: string }) {
    return this.tenantTx.run(async (tx) => {
      const [lock] = await tx.query(`SELECT id FROM sales_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, id]);
      if (!lock) throw Errors.notFound('Заказ');
      const o = await tx.repo(SalesOrder, 'Заказ').getById(id);
      if (o.status === 'cancelled' || o.status === 'shipped') throw Errors.conflict('ORDER_CLOSED', 'Заказ закрыт');
      const lines = await tx.repo(SalesOrderLine).find({ where: { orderId: id }, order: { lineNo: 'ASC' } });
      const want = dto.lines ?? lines.map((l) => ({ lineId: l.id, qty: D(l.qty).minus(l.shippedQty).toFixed() }));
      const sale: { productId: string; qty: string; price: string }[] = [];
      for (const w of want) {
        const l = lines.find((x) => x.id === w.lineId);
        if (!l) throw Errors.bad('BAD_LINE', 'Строка не из этого заказа');
        if (D(w.qty).gt(D(l.qty).minus(l.shippedQty))) throw Errors.bad('OVER_SHIP', `Строка ${l.lineNo}: больше, чем осталось`);
        if (D(w.qty).lte(0)) continue;
        sale.push({ productId: l.productId, qty: w.qty, price: D(l.price).toFixed(2) });
        l.shippedQty = D(l.shippedQty).plus(w.qty).toFixed();
      }
      if (!sale.length) throw Errors.bad('NO_LINES', 'Нечего отгружать');
      const total = sale.reduce((a, l) => a.plus(money(D(l.price).mul(l.qty))), D(0));
      let payments = dto.payments;
      if (!payments?.length) {
        const [pre] = await tx.query(`SELECT coalesce(sum(remaining), 0) AS s FROM debt_items WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tx.tenantId, o.prepaymentItemIds]);
        const fromPre = Decimal.min(total, D(pre.s));
        payments = [
          ...(fromPre.gt(0) ? [{ method: 'advance', amount: fromPre.toFixed(2), advanceItemIds: o.prepaymentItemIds }] : []),
          ...(total.minus(fromPre).gt(0) ? [{ method: 'debt', amount: total.minus(fromPre).toFixed(2) }] : []),
        ];
      }
      const r: any = await this.receipts.sale({
        registerId: dto.registerId,
        idempotencyKey: `order-${o.id}-${o.receiptIds.length + 1}`,
        customerId: o.counterpartyId,
        label: o.number,
        lines: sale.map((l) => ({ productId: l.productId, qty: l.qty, price: l.price })) as any,
        payments,
        changeCurrency: dto.changeCurrency,
        pin: dto.pin,
      } as any);
      for (const l of lines) await tx.repo(SalesOrderLine).save(l);
      o.receiptIds = [...o.receiptIds, r.id];
      o.status = lines.every((l) => D(l.shippedQty).gte(l.qty)) ? 'shipped' : 'partially_shipped';
      if (o.address && !o.deliveryStatus) o.deliveryStatus = 'assembled';
      o.history = [...o.history, this.history(o.status, `чек ${r.number}`)];
      await tx.repo(SalesOrder).save(o);
      return { order: await this.orderView(tx, id), receiptId: r.id };
    });
  }

  /** Отмена: резерв снимается; предоплата — вернуть деньгами или оставить авансом клиента. */
  cancelOrder(id: string, dto: { prepayment: 'advance' | 'refund'; accountId?: string; reason?: string }) {
    return this.tenantTx.run(async (tx) => {
      const o = await tx.repo(SalesOrder, 'Заказ').getById(id);
      if (o.status === 'shipped' || o.status === 'cancelled') throw Errors.conflict('ORDER_CLOSED', 'Заказ закрыт');
      const items = await tx.query(`SELECT id, remaining FROM debt_items WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND remaining > 0`, [tx.tenantId, o.prepaymentItemIds]);
      const rest = items.reduce((a: Decimal, i: any) => a.plus(i.remaining), D(0));
      if (rest.gt(0)) {
        if (dto.prepayment === 'refund') {
          if (!dto.accountId) throw Errors.bad('ACCOUNT_REQUIRED', 'Откуда вернуть предоплату');
          await this.debts.payInTx(tx, { counterpartyId: o.counterpartyId, direction: 'out', amount: rest.toFixed(2), accountId: dto.accountId, comment: `Возврат предоплаты ${o.number}`, allocation: { mode: 'items', itemIds: items.map((i: any) => i.id) } } as any);
        } else {
          await tx.query(`UPDATE debt_items SET kind = 'advance' WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tx.tenantId, items.map((i: any) => i.id)]);
        }
      }
      o.status = 'cancelled';
      o.history = [...o.history, this.history('cancelled', dto.reason)];
      await tx.repo(SalesOrder).save(o);
      return this.orderView(tx, id);
    });
  }

  /** Подотчётный счёт водителя «Подотчёт: имя» — создаётся сам. */
  private async driverAccount(tx: TenantTx, membershipId: string, storeId: string): Promise<MoneyAccount> {
    const found = await tx.repo(MoneyAccount).findOne({ where: { type: 'accountable', holderMembershipId: membershipId, currency: 'KGS' } });
    if (found) return found;
    const [u] = await tx.query(`SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.id = $2`, [tx.tenantId, membershipId]);
    return tx.repo(MoneyAccount).insert({ type: 'accountable', name: `Подотчёт: ${u?.name ?? 'водитель'}`, currency: 'KGS', storeId, holderMembershipId: membershipId, details: {} });
  }

  /**
   * Статус доставки (водитель на телефоне): собран → в пути → доставлен → оплачен / возврат.
   * «Оплачен»: наличные — на подотчёт водителя, перевод — на его номер (кошелёк) — гасят долг клиента.
   */
  deliveryStatus(id: string, dto: { status: DeliveryStatus; payment?: { method: 'cash' | 'transfer'; amount: string; accountId?: string }; note?: string }) {
    return this.tenantTx.run(async (tx) => {
      const o = await tx.repo(SalesOrder, 'Заказ').getById(id);
      if (!o.address && !o.driverId) throw Errors.bad('NO_DELIVERY', 'Заказ без доставки');
      if (o.driverId && o.driverId !== this.ctx.membershipId && !this.ctx.can('deliveries.manage')) throw Errors.forbidden('Чужая доставка');
      if (dto.status !== 'returned' && o.deliveryStatus && DELIVERY_FLOW.indexOf(dto.status) < DELIVERY_FLOW.indexOf(o.deliveryStatus)) throw Errors.bad('BAD_STATUS', 'Статус назад не меняется');
      if (dto.status === 'paid') {
        if (!dto.payment) throw Errors.bad('PAYMENT_REQUIRED', 'Сколько и как оплатили');
        const driver = o.driverId ?? this.ctx.membershipId!;
        const acc = dto.payment.method === 'cash' ? await this.driverAccount(tx, driver, o.storeId) : await this.money.account(tx, dto.payment.accountId!);
        await this.debts.payInTx(tx, { counterpartyId: o.counterpartyId, direction: 'in', amount: dto.payment.amount, accountId: acc.id, comment: `Оплата доставки ${o.number}` } as any);
      }
      o.deliveryStatus = dto.status;
      o.history = [...o.history, this.history(`delivery:${dto.status}`, dto.note)];
      await tx.repo(SalesOrder).save(o);
      return this.orderView(tx, id);
    });
  }

  /** Водитель сдаёт выручку: подотчёт → касса (перемещение), подотчёт обнуляется. */
  driverHandover(dto: { driverId?: string; toAccountId: string; amount?: string }) {
    return this.tenantTx.run(async (tx) => {
      const driver = dto.driverId ?? this.ctx.membershipId!;
      const acc = await tx.repo(MoneyAccount).findOne({ where: { type: 'accountable', holderMembershipId: driver, currency: 'KGS' } });
      if (!acc) throw Errors.bad('NO_ACCOUNTABLE', 'У водителя нет подотчёта');
      const bal = await this.money.balance(tx, acc.id);
      const amount = dto.amount ? money(dto.amount) : bal;
      if (amount.lte(0)) throw Errors.bad('NOTHING', 'На подотчёте нет денег');
      await this.money.operation(tx, { type: 'transfer', fromAccountId: acc.id, toAccountId: dto.toAccountId, amount: amount.toFixed(2), comment: 'Водитель сдал выручку' });
      return { accountId: acc.id, handed: amount.toFixed(2), left: (await this.money.balance(tx, acc.id)).toFixed(2) };
    });
  }

  // ── Реализация (ТЗ 14.10) ────────────────────────────────

  private async consignee(tx: TenantTx, storeId: string, counterpartyId: string) {
    const [cp] = await tx.query(`SELECT name FROM counterparties WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, counterpartyId]);
    if (!cp) throw Errors.notFound('Реализатор');
    const found = await tx.repo(Warehouse).findOne({ where: { storeId, type: 'customer', counterpartyId } as any });
    return found ?? (await tx.repo(Warehouse).insert({ storeId, type: 'customer', name: `Реализатор: ${cp.name}`.slice(0, 100), counterpartyId } as any));
  }

  consign(dto: { counterpartyId: string; warehouseId: string; lines: { productId: string; qty: string }[] }) {
    return this.tenantTx.run(async (tx) => {
      const src = await tx.repo(Warehouse, 'Склад').getById(dto.warehouseId);
      this.scope.assertStore(src.storeId);
      const cw = await this.consignee(tx, src.storeId!, dto.counterpartyId);
      const doc = await this.docs.createInTx(tx, { type: 'consignment', warehouseId: src.id, warehouseToId: cw.id, counterpartyId: dto.counterpartyId, lines: dto.lines } as any);
      await this.docs.postInTx(tx, doc);
      return this.docs.viewInTx(tx, doc.id);
    });
  }

  /** Отчёт реализатора: проданное — продажа в долг реализатору; товар возвращается с его склада и сразу продаётся. */
  consignmentReport(dto: { counterpartyId: string; registerId: string; sold: { productId: string; qty: string; price?: string }[] }) {
    return this.tenantTx.run(async (tx) => {
      const reg = await tx.query(`SELECT store_id, warehouse_id FROM registers WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, dto.registerId]);
      if (!reg[0]) throw Errors.notFound('Касса');
      const cw = await this.consignee(tx, reg[0].store_id, dto.counterpartyId);
      const back = await this.docs.createInTx(tx, { type: 'consignment_return', warehouseId: cw.id, warehouseToId: reg[0].warehouse_id, counterpartyId: dto.counterpartyId, comment: 'Отчёт реализатора: продано', lines: dto.sold.map((s) => ({ productId: s.productId, qty: s.qty })) } as any);
      await this.docs.postInTx(tx, back);
      const draft: any = await this.receipts.create({ registerId: dto.registerId, customerId: dto.counterpartyId, label: 'Отчёт реализатора', lines: dto.sold.map((s) => ({ productId: s.productId, qty: s.qty, ...(s.price ? { price: s.price } : {}) })) } as any);
      const receipt: any = await this.receipts.pay(draft.id, draft.version, { payments: [{ method: 'debt', amount: String(draft.total) }] } as any);
      await tx.repo(ConsignmentReport).insert({ counterpartyId: dto.counterpartyId, returnDocumentId: back.id, receiptId: receipt.id, amount: money(receipt.total) });
      return { receiptId: receipt.id, total: receipt.total };
    });
  }

  consignmentReturn(dto: { counterpartyId: string; warehouseId: string; lines: { productId: string; qty: string }[] }) {
    return this.tenantTx.run(async (tx) => {
      const dst = await tx.repo(Warehouse, 'Склад').getById(dto.warehouseId);
      const cw = await this.consignee(tx, dst.storeId!, dto.counterpartyId);
      const doc = await this.docs.createInTx(tx, { type: 'consignment_return', warehouseId: cw.id, warehouseToId: dst.id, counterpartyId: dto.counterpartyId, lines: dto.lines } as any);
      await this.docs.postInTx(tx, doc);
      return this.docs.viewInTx(tx, doc.id);
    });
  }

  /** Остатки и долги по реализаторам. */
  consignees() {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT c.id, c.name, w.id AS "warehouseId",
                coalesce((SELECT sum(b.qty) FROM stock_balances b WHERE b.tenant_id = w.tenant_id AND b.warehouse_id = w.id), 0) AS qty,
                coalesce((SELECT sum(b.cost_amount) FROM stock_balances b WHERE b.tenant_id = w.tenant_id AND b.warehouse_id = w.id), 0) AS cost,
                coalesce((SELECT sum(d.remaining) FROM debt_items d WHERE d.tenant_id = c.tenant_id AND d.counterparty_id = c.id AND d.direction = 'receivable'), 0) AS debt
           FROM warehouses w JOIN counterparties c ON c.id = w.counterparty_id WHERE w.tenant_id = $1 AND w.type = 'customer' AND w.counterparty_id IS NOT NULL ORDER BY c.name`,
        [tx.tenantId],
      ),
    );
  }

  // ── Доноры (ТЗ 14.12) ────────────────────────────────────

  createDonor(dto: Partial<Donor> & { warehouseId: string; title: string }) {
    return this.tenantTx.run(async (tx) => {
      const wh = await tx.repo(Warehouse, 'Склад').getById(dto.warehouseId);
      this.scope.assertStore(wh.storeId);
      const n = await this.counters.next(tx, 'donor');
      const m = (v: any) => money(v ?? 0);
      const d = await tx.repo(Donor).insert({
        ...dto,
        number: `ДН-${n}`,
        storeId: wh.storeId!,
        purchasePrice: m(dto.purchasePrice),
        deliveryCost: m(dto.deliveryCost),
        customsCost: m(dto.customsCost),
        otherCost: m(dto.otherCost),
        expectedTotal: m(dto.expectedTotal),
      } as any);
      await this.audit.log(tx, { action: 'donor.create', entityType: 'donor', entityId: d.id, storeId: d.storeId, summary: `${d.number}: ${d.title}` });
      return d;
    });
  }

  private cost(d: Donor) {
    return D(d.purchasePrice).plus(d.deliveryCost).plus(d.customsCost).plus(d.otherCost);
  }

  /**
   * Детали с донора (частями): себестоимость = ожидаемая цена × (стоимость донора / ожидаемая выручка),
   * или вручную (cost). Последняя партия может забрать весь нераспределённый остаток (closeDonor).
   */
  donorParts(id: string, dto: { lines: { productId: string; qty: string; expectedPrice?: string; cost?: string }[]; close?: boolean }) {
    return this.tenantTx.run(async (tx) => {
      const [lock] = await tx.query(`SELECT id FROM donors WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, id]);
      if (!lock) throw Errors.notFound('Донор');
      const d = await tx.repo(Donor, 'Донор').getById(id);
      if (d.status === 'closed') throw Errors.conflict('DONOR_CLOSED', 'Разборка закрыта');
      const cost = this.cost(d);
      const factor = D(d.expectedTotal).gt(0) ? cost.div(d.expectedTotal) : D(0);
      const lines = dto.lines.map((l) => {
        const unit = l.cost ? D(l.cost) : D(l.expectedPrice ?? 0).mul(factor);
        return { productId: l.productId, qty: l.qty, price: unit.toDecimalPlaces(2).toFixed(2) };
      });
      let add = lines.reduce((a, l) => a.plus(D(l.price).mul(l.qty)), D(0));
      const left = cost.minus(d.distributed);
      if (dto.close && lines.length) {
        // Остаток стоимости — на последнюю партию пропорционально
        const k = add.gt(0) ? left.div(add) : D(0);
        for (const l of lines) l.price = D(l.price).mul(k).toDecimalPlaces(2).toFixed(2);
        add = left;
      }
      if (add.gt(left.plus(1))) throw Errors.bad('OVER_DISTRIBUTED', `Распределено больше стоимости донора: осталось ${left.toFixed(2)}`);
      const doc = await this.docs.createInTx(tx, { type: 'donor', warehouseId: d.warehouseId, counterpartyId: d.counterpartyId, comment: `${d.number}: ${d.title}`, extra: { donorId: d.id }, lines } as any);
      await this.docs.postInTx(tx, doc);
      d.distributed = money(D(d.distributed).plus(add));
      d.documentIds = [...d.documentIds, doc.id];
      if (dto.close) d.status = 'closed';
      await tx.repo(Donor).save(d);
      return { donor: await this.donorView(tx, d.id), documentId: doc.id };
    });
  }

  /** Окупаемость донора: вложено, распределено, продано (выручка деталей), осталось на складе. */
  async donorView(tx: TenantTx, id: string) {
    const d = await tx.repo(Donor, 'Донор').getById(id);
    const cost = this.cost(d);
    const [s] = await tx.query(
      `WITH parts AS (SELECT DISTINCT l.product_id FROM document_lines l WHERE l.tenant_id = $1 AND l.document_id = ANY($2::uuid[]))
       SELECT coalesce((SELECT sum(CASE WHEN dd.type = 'sale' THEN sl.amount ELSE -sl.amount END) FROM document_lines sl JOIN documents dd ON dd.id = sl.document_id
                          WHERE sl.tenant_id = $1 AND sl.product_id IN (SELECT product_id FROM parts) AND dd.type IN ('sale', 'sale_return') AND dd.status = 'posted'), 0) AS sold,
              coalesce((SELECT sum(b.cost_amount) FROM stock_balances b WHERE b.tenant_id = $1 AND b.product_id IN (SELECT product_id FROM parts)), 0) AS "inStock"`,
      [tx.tenantId, d.documentIds],
    );
    return { ...d, totalCost: cost.toFixed(2), undistributed: cost.minus(d.distributed).toFixed(2), sold: money(s.sold).toFixed(2), inStockCost: money(s.inStock).toFixed(2), payback: cost.gt(0) ? money(D(s.sold).div(cost).mul(100)).toFixed(1) : null };
  }

  getDonor(id: string) {
    return this.tenantTx.run((tx) => this.donorView(tx, id));
  }

  listDonors() {
    return this.tenantTx.run(async (tx) => {
      const rows = await tx.repo(Donor).find({ order: { createdAt: 'DESC' } });
      return Promise.all(rows.map((r) => this.donorView(tx, r.id)));
    });
  }
}
