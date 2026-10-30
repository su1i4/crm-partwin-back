import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { dayjs } from '../../common/utils/dates';
import { D, Decimal, money, qty as qty3, unitCost } from '../../common/utils/decimal';
import { CountersService } from '../../database/tenant/counters.service';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { Product, ProductUnit } from '../catalog/entities/product.entity';
import { Counterparty } from '../counterparties/entities/counterparty.entity';
import { DocumentsService } from '../documents/documents.service';
import { Document } from '../documents/entities/document.entity';
import { PdfService } from '../printing/pdf.service';
import { Store } from '../stores/entities/store.entity';
import { Warehouse } from '../stores/entities/warehouse.entity';
import { OrderStatus, PurchaseOrder, PurchaseOrderLine } from './entities/purchasing.entity';

export interface OrderLineInput {
  productId: string;
  unitId?: string;
  qty: string;
  price?: string | null;
  note?: string | null;
  requestItemId?: string | null;
  extra?: Record<string, any>;
}

/** Открытые заказы — их остаток «ожидается». */
export const OPEN_ORDER_STATUSES: OrderStatus[] = ['sent', 'confirmed', 'partially_received'];

const STATUS_LABELS: Record<OrderStatus, string> = {
  draft: 'Черновик',
  sent: 'Отправлен',
  confirmed: 'Подтверждён',
  partially_received: 'Частично принят',
  received: 'Принят',
  closed: 'Закрыт',
  cancelled: 'Отменён',
};

/** Заказы поставщикам (ТЗ 10.3): статусы, PDF / Excel / текст для WhatsApp, приёмка по заказу. */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly counters: CountersService,
    private readonly docs: DocumentsService,
    private readonly pdf: PdfService,
    private readonly audit: AuditService,
  ) {}

  // ── Создание и правка ────────────────────────────────────

  create(dto: { supplierId: string; storeId?: string; warehouseId?: string; currency?: string; expectedAt?: string | null; comment?: string | null; lines?: OrderLineInput[] }) {
    return this.tenantTx.run(async (tx) => {
      const o = await this.createInTx(tx, { ...dto, source: 'manual' });
      return this.viewInTx(tx, o.id);
    });
  }

  async createInTx(
    tx: TenantTx,
    dto: { supplierId: string; storeId?: string; warehouseId?: string | null; currency?: string; expectedAt?: string | null; comment?: string | null; lines?: OrderLineInput[]; source: string },
  ): Promise<PurchaseOrder> {
    const s = await tx.repo(Counterparty, 'Поставщик').getById(dto.supplierId);
    if (!s.roles.includes('supplier') && !s.roles.includes('neighbor')) throw Errors.bad('NOT_SUPPLIER', `«${s.name}» не отмечен как поставщик`);
    const storeId = dto.storeId ?? this.scope.currentStoreId() ?? (await this.firstStore(tx));
    this.scope.assertStore(storeId);
    const store = await tx.repo(Store, 'Точка').getById(storeId);
    if (dto.warehouseId) {
      const wh = await tx.repo(Warehouse, 'Склад').getById(dto.warehouseId);
      if (wh.storeId !== storeId) throw Errors.bad('WAREHOUSE_OTHER_STORE', 'Склад другой точки');
    }
    const year = dayjs().tz(store.timezone).year();
    const n = await this.counters.next(tx, `purchase_order:${storeId}:${year}`);
    const lead = Number(s.supplierTerms?.leadTimeDays ?? 0);
    const o = await tx.repo(PurchaseOrder).insert({
      number: `ЗП-${store.code}-${year}-${String(n).padStart(6, '0')}`,
      supplierId: s.id,
      storeId,
      warehouseId: dto.warehouseId ?? null,
      currency: dto.currency ?? s.supplierTerms?.currency ?? 'KGS',
      expectedAt: dto.expectedAt ?? (lead ? dayjs().add(lead, 'day').format('YYYY-MM-DD') : null),
      comment: dto.comment ?? null,
      source: dto.source,
      status: 'draft',
      history: [{ at: new Date().toISOString(), status: 'draft', by: this.ctx.membershipId ?? null }],
    });
    if (dto.lines?.length) await this.replaceLines(tx, o, dto.lines);
    await this.audit.log(tx, { action: 'purchase_order.create', entityType: 'purchase_order', entityId: o.id, storeId, summary: `${o.number} для «${s.name}»` });
    return o;
  }

  private async firstStore(tx: TenantTx) {
    const [s] = await tx.query(`SELECT id FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active ORDER BY created_at LIMIT 1`, [tx.tenantId]);
    if (!s) throw Errors.bad('NO_STORE', 'Нет точки');
    return s.id as string;
  }

  update(id: string, version: number, dto: { warehouseId?: string | null; currency?: string; expectedAt?: string | null; comment?: string | null; lines?: OrderLineInput[] }) {
    return this.tenantTx.run(async (tx) => {
      const o = await this.lock(tx, id, version);
      if (!['draft', 'sent', 'confirmed'].includes(o.status)) throw Errors.conflict('ORDER_LOCKED', `Заказ «${STATUS_LABELS[o.status]}» — менять нельзя`);
      if (dto.currency && o.status !== 'draft') throw Errors.conflict('ORDER_SENT', 'Валюту меняют только в черновике');
      if (dto.warehouseId !== undefined) o.warehouseId = dto.warehouseId;
      if (dto.currency) o.currency = dto.currency;
      if (dto.expectedAt !== undefined) o.expectedAt = dto.expectedAt;
      if (dto.comment !== undefined) o.comment = dto.comment;
      await tx.repo(PurchaseOrder).save(o);
      if (dto.lines) await this.replaceLines(tx, o, dto.lines);
      return this.viewInTx(tx, o.id);
    });
  }

  /** Добавить строки (автозаказ, заявка клиента) к черновику. */
  async appendLines(tx: TenantTx, o: PurchaseOrder, lines: OrderLineInput[]) {
    const existing = await tx.repo(PurchaseOrderLine).find({ where: { orderId: o.id }, order: { lineNo: 'ASC' } });
    const inputs: OrderLineInput[] = existing.map((l) => ({
      productId: l.productId,
      unitId: l.unitId,
      qty: l.qty.toFixed(),
      price: l.price?.toFixed() ?? null,
      note: l.note,
      requestItemId: l.requestItemId,
      extra: l.extra,
    }));
    await this.replaceLines(tx, o, [...inputs, ...lines], existing);
  }

  private async replaceLines(tx: TenantTx, o: PurchaseOrder, input: OrderLineInput[], existing?: PurchaseOrderLine[]) {
    const ids = [...new Set(input.map((l) => l.productId))];
    const products = new Map((await tx.repo(Product, 'Товар').getByIds(ids)).map((p) => [p.id, p]));
    const units = ids.length ? await tx.repo(ProductUnit).find({ where: ids.map((productId) => ({ productId })) }) : [];
    const old = existing ?? (await tx.repo(PurchaseOrderLine).find({ where: { orderId: o.id } }));
    const errors: any[] = [];
    const rows: Partial<PurchaseOrderLine>[] = [];
    input.forEach((l, i) => {
      const p = products.get(l.productId)!;
      if (p.kind !== 'goods') errors.push({ line: i + 1, message: `Строка ${i + 1}: «${p.name}» — не товар` });
      const unit = l.unitId ? units.find((u) => u.id === l.unitId && u.productId === p.id) : units.find((u) => u.productId === p.id && u.isBase);
      if (!unit) return errors.push({ line: i + 1, message: `Строка ${i + 1}: единица не относится к товару` });
      const q = qty3(l.qty);
      if (q.lte(0)) errors.push({ line: i + 1, message: `Строка ${i + 1}: количество больше нуля` });
      // Принятое по строке не теряется при правке
      const prev = old.find((x) => x.productId === p.id && x.unitId === unit.id && (x.requestItemId ?? null) === (l.requestItemId ?? null));
      const received = prev?.receivedQty ?? D(0);
      if (q.lt(received)) errors.push({ line: i + 1, message: `Строка ${i + 1}: уже принято ${received.toFixed()}` });
      rows.push({
        ...(prev ? { id: prev.id } : {}),
        orderId: o.id,
        lineNo: i + 1,
        productId: p.id,
        unitId: unit.id,
        factor: D(unit.factor),
        qty: q,
        price: l.price !== undefined && l.price !== null && l.price !== '' ? unitCost(l.price) : null,
        receivedQty: received,
        requestItemId: l.requestItemId ?? null,
        note: l.note ?? null,
        extra: l.extra ?? {},
      });
    });
    if (errors.length) throw Errors.bad('LINES_INVALID', 'Проверьте строки заказа', errors);
    const keep = new Set(rows.map((r) => r.id).filter(Boolean));
    for (const x of old) {
      if (keep.has(x.id)) continue;
      if (x.receivedQty.gt(0)) throw Errors.conflict('LINE_RECEIVED', 'Строку, по которой уже принят товар, удалить нельзя');
      await tx.repo(PurchaseOrderLine).hardDelete({ id: x.id });
    }
    for (const r of rows) {
      if (r.id) await tx.query(`UPDATE purchase_order_lines SET line_no = $3, qty = $4, price = $5, note = $6, extra = $7, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, r.id, r.lineNo, r.qty!.toFixed(), r.price?.toFixed() ?? null, r.note, JSON.stringify(r.extra)]);
      else await tx.repo(PurchaseOrderLine).insert(r);
    }
    const total = rows.reduce((a, r) => a.plus(r.price ? money(r.price.mul(r.qty!)) : 0), D(0));
    await tx.query(`UPDATE purchase_orders SET total_amount = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, o.id, total.toFixed(2)]);
  }

  // ── Статусы ──────────────────────────────────────────────

  setStatus(id: string, version: number, status: 'sent' | 'confirmed' | 'closed' | 'cancelled', note?: string) {
    return this.tenantTx.run(async (tx) => {
      const o = await this.lock(tx, id, version);
      const allowed: Record<string, OrderStatus[]> = {
        sent: ['draft'],
        confirmed: ['draft', 'sent'],
        closed: ['partially_received', 'sent', 'confirmed'],
        cancelled: ['draft', 'sent', 'confirmed'],
      };
      if (!allowed[status].includes(o.status)) throw Errors.conflict('BAD_STATUS', `Из «${STATUS_LABELS[o.status]}» в «${STATUS_LABELS[status]}» нельзя`);
      if (status !== 'cancelled' && status !== 'closed') {
        const [{ n }] = await tx.query(`SELECT count(*)::int AS n FROM purchase_order_lines WHERE tenant_id = $1 AND order_id = $2`, [tx.tenantId, o.id]);
        if (!n) throw Errors.bad('NO_LINES', 'В заказе нет строк');
      }
      if (status === 'cancelled') {
        const [{ r }] = await tx.query(`SELECT coalesce(sum(received_qty), 0) AS r FROM purchase_order_lines WHERE tenant_id = $1 AND order_id = $2`, [tx.tenantId, o.id]);
        if (D(r).gt(0)) throw Errors.conflict('ORDER_RECEIVED', 'По заказу уже принят товар — его можно только закрыть');
      }
      o.status = status;
      if (status === 'sent') o.sentAt = new Date();
      if (status === 'confirmed') o.confirmedAt = new Date();
      if (status === 'closed' || status === 'cancelled') o.closedAt = new Date();
      o.history = [...o.history, { at: new Date().toISOString(), status, by: this.ctx.membershipId ?? null, note }];
      await tx.repo(PurchaseOrder).save(o);
      await this.audit.log(tx, { action: `purchase_order.${status}`, entityType: 'purchase_order', entityId: o.id, storeId: o.storeId, summary: `${o.number}: ${STATUS_LABELS[status]}` });
      return this.viewInTx(tx, o.id);
    });
  }

  /** Пересчитать принятое по заказу и статус (вызывается при проведении/отмене приёмки). */
  async recalcReceived(tx: TenantTx, orderId: string) {
    await tx.query(
      `UPDATE purchase_order_lines ol SET received_qty = coalesce((
         SELECT sum(l.qty) FROM document_lines l JOIN documents d ON d.id = l.document_id
          WHERE l.tenant_id = ol.tenant_id AND d.type = 'receiving' AND d.status = 'posted' AND d.deleted_at IS NULL AND l.extra->>'orderLineId' = ol.id::text), 0), updated_at = now()
        WHERE ol.tenant_id = $1 AND ol.order_id = $2`,
      [tx.tenantId, orderId],
    );
    const o = await tx.repo(PurchaseOrder).findById(orderId);
    if (!o || ['closed', 'cancelled'].includes(o.status)) return o;
    const [agg] = await tx.query(
      `SELECT coalesce(sum(received_qty), 0) AS received, bool_and(received_qty >= qty) AS full FROM purchase_order_lines WHERE tenant_id = $1 AND order_id = $2`,
      [tx.tenantId, orderId],
    );
    const status: OrderStatus = D(agg.received).isZero() ? (o.confirmedAt ? 'confirmed' : o.sentAt ? 'sent' : 'draft') : agg.full ? 'received' : 'partially_received';
    if (status !== o.status) {
      o.status = status;
      o.history = [...o.history, { at: new Date().toISOString(), status, by: this.ctx.membershipId ?? null }];
      await tx.repo(PurchaseOrder).save(o);
    }
    return o;
  }

  // ── Приёмка по заказу ────────────────────────────────────

  /** Черновик приёмки по заказу: остаток строк, цены заказа; режим сверки «ожидалось / пришло». */
  createReceiving(id: string, dto: { warehouseId?: string }) {
    return this.tenantTx.run(async (tx) => {
      const o = await this.lock(tx, id);
      if (!OPEN_ORDER_STATUSES.includes(o.status) && o.status !== 'draft') throw Errors.conflict('ORDER_NOT_OPEN', `Заказ «${STATUS_LABELS[o.status]}»`);
      const lines = await tx.repo(PurchaseOrderLine).find({ where: { orderId: o.id }, order: { lineNo: 'ASC' } });
      const rest = lines.filter((l) => l.qty.gt(l.receivedQty));
      if (!rest.length) throw Errors.conflict('ORDER_RECEIVED', 'По заказу всё принято');
      const warehouseId = dto.warehouseId ?? o.warehouseId ?? (await this.defaultWarehouse(tx, o.storeId));
      const doc = await this.docs.createInTx(tx, {
        type: 'receiving',
        warehouseId,
        counterpartyId: o.supplierId,
        currency: o.currency,
        rate: o.currency !== 'KGS' ? await this.rateFor(tx, o.currency) : undefined,
        comment: `По заказу ${o.number}`,
        extra: { purchaseOrderId: o.id },
        lines: rest.map((l) => {
          const left = l.qty.minus(l.receivedQty).toFixed();
          return { productId: l.productId, unitId: l.unitId, qty: left, expectedQty: left, orderLineId: l.id, price: l.price?.toFixed() ?? undefined, orderPrice: l.price?.toFixed() ?? undefined };
        }),
      } as any);
      return this.docs.viewInTx(tx, doc.id);
    });
  }

  private async rateFor(tx: TenantTx, currency: string) {
    const [r] = await tx.query(`SELECT rate FROM shop_rates WHERE tenant_id = $1 AND currency = $2 ORDER BY created_at DESC LIMIT 1`, [tx.tenantId, currency]);
    return r ? D(r.rate).toFixed() : undefined;
  }

  private async defaultWarehouse(tx: TenantTx, storeId: string) {
    const [w] = await tx.query(
      `SELECT id FROM warehouses WHERE tenant_id = $1 AND store_id = $2 AND is_active AND deleted_at IS NULL AND type IN ('storage', 'sales_floor') ORDER BY (type = 'storage') DESC, created_at LIMIT 1`,
      [tx.tenantId, storeId],
    );
    if (!w) throw Errors.bad('NO_WAREHOUSE', 'У точки нет склада для приёмки');
    return w.id as string;
  }

  // ── Чтение ───────────────────────────────────────────────

  list(q: { status?: string; supplierId?: string; storeId?: string; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const w = ['o.tenant_id = $1', 'o.deleted_at IS NULL'];
      if (q.status) w.push(`o.status = ANY(${p(q.status.split(','))}::text[])`);
      if (q.supplierId) w.push(`o.supplier_id = ${p(q.supplierId)}`);
      if (q.storeId) w.push(`o.store_id = ${p(q.storeId)}`);
      const allowed = this.scope.storeIds();
      if (allowed) w.push(`o.store_id = ANY(${p(allowed)}::uuid[])`);
      const where = w.join(' AND ');
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM purchase_orders o WHERE ${where}`, params);
      const items = await tx.query(
        `SELECT o.id, o.number, o.status, o.source, o.supplier_id AS "supplierId", c.name AS "supplierName", o.store_id AS "storeId", o.currency,
                o.total_amount AS "totalAmount", o.expected_at AS "expectedAt", o.created_at AS "createdAt", o.version,
                (o.expected_at < current_date AND o.status IN ('sent', 'confirmed', 'partially_received')) AS overdue,
                (SELECT count(*)::int FROM purchase_order_lines l WHERE l.tenant_id = o.tenant_id AND l.order_id = o.id) AS "linesCount"
           FROM purchase_orders o JOIN counterparties c ON c.id = o.supplier_id
          WHERE ${where} ORDER BY o.created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total };
    });
  }

  get(id: string) {
    return this.tenantTx.run((tx) => this.viewInTx(tx, id));
  }

  async viewInTx(tx: TenantTx, id: string) {
    const o = await tx.repo(PurchaseOrder, 'Заказ').getById(id);
    if (!this.scope.canStore(o.storeId)) throw Errors.notFound('Заказ');
    const supplier = await tx.repo(Counterparty).findById(o.supplierId);
    const lines = await tx.query(
      `SELECT l.id, l.line_no AS "lineNo", l.product_id AS "productId", p.name AS "productName", p.sku, b.name AS brand,
              (SELECT pn.number FROM part_numbers pn WHERE pn.tenant_id = l.tenant_id AND pn.product_id = l.product_id AND pn.type = 'manufacturer' LIMIT 1) AS number,
              (SELECT sp.supplier_code FROM supplier_products sp WHERE sp.tenant_id = l.tenant_id AND sp.product_id = l.product_id AND sp.supplier_id = $3 AND sp.deleted_at IS NULL) AS "supplierCode",
              l.unit_id AS "unitId", u.name AS "unitName", l.factor, l.qty, l.price, round(l.price * l.qty, 2) AS amount, l.received_qty AS "receivedQty",
              greatest(l.qty - l.received_qty, 0) AS "leftQty", l.request_item_id AS "requestItemId", l.note, l.extra
         FROM purchase_order_lines l JOIN products p ON p.id = l.product_id JOIN product_units u ON u.id = l.unit_id LEFT JOIN brands b ON b.id = p.brand_id
        WHERE l.tenant_id = $1 AND l.order_id = $2 ORDER BY l.line_no`,
      [tx.tenantId, id, o.supplierId],
    );
    // Приёмки по заказу; разница цены накладной и заказа (ТЗ 10.5)
    const receivings = await tx.query(
      `SELECT d.id, d.number, d.status, d.doc_date AS "docDate", d.total_amount AS "totalAmount",
              (SELECT json_agg(json_build_object('productId', l.product_id, 'orderPrice', l.extra->>'orderPrice', 'price', l.price))
                 FROM document_lines l WHERE l.document_id = d.id AND l.extra ? 'orderPrice' AND l.price IS NOT NULL AND l.price <> (l.extra->>'orderPrice')::numeric) AS "priceDiffs"
         FROM documents d WHERE d.tenant_id = $1 AND d.type = 'receiving' AND d.deleted_at IS NULL AND d.extra->>'purchaseOrderId' = $2 ORDER BY d.doc_date`,
      [tx.tenantId, id],
    );
    return { ...o, statusLabel: STATUS_LABELS[o.status], supplier: supplier ? { id: supplier.id, name: supplier.name, phone: supplier.phone, messengers: supplier.messengers } : null, lines, receivings };
  }

  /** Сколько ожидается по открытым заказам (для автозаказа и остатков «ожидается»). */
  async expected(tx: TenantTx, productIds: string[], storeId?: string | null): Promise<Map<string, Decimal>> {
    if (!productIds.length) return new Map();
    const rows = await tx.query(
      `SELECT l.product_id, sum(greatest(l.qty - l.received_qty, 0) * l.factor) AS q FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.order_id
        WHERE l.tenant_id = $1 AND l.product_id = ANY($2::uuid[]) AND o.status = ANY($3::text[]) AND o.deleted_at IS NULL ${storeId ? 'AND o.store_id = $4' : ''}
        GROUP BY 1`,
      storeId ? [tx.tenantId, productIds, OPEN_ORDER_STATUSES, storeId] : [tx.tenantId, productIds, OPEN_ORDER_STATUSES],
    );
    return new Map(rows.map((r: any) => [r.product_id, D(r.q)]));
  }

  expectedList(productIds: string[], storeId?: string) {
    return this.tenantTx.run(async (tx) => Object.fromEntries([...(await this.expected(tx, productIds, storeId))].map(([k, v]) => [k, v.toFixed()])));
  }

  // ── Отправка: текст WhatsApp, PDF, Excel ─────────────────

  async message(id: string) {
    const v = await this.get(id);
    const lines = (v.lines as any[]).map((l, i) => `${i + 1}. ${[l.supplierCode ?? l.number, l.brand, l.productName].filter(Boolean).join(' ')} — ${D(l.qty).toFixed()} ${l.unitName}`);
    const text = [`Заказ ${v.number}`, ...lines, v.comment ? `\n${v.comment}` : ''].filter(Boolean).join('\n');
    const phone = (v.supplier?.messengers?.whatsapp ?? v.supplier?.phone ?? '').replace(/\D/g, '');
    return { text, whatsappUrl: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`, telegramUrl: `https://t.me/share/url?url=${encodeURIComponent(' ')}&text=${encodeURIComponent(text)}` };
  }

  async pdfFile(id: string): Promise<Buffer> {
    const v: any = await this.get(id);
    const body: any[] = [['№', 'Номер', 'Бренд', 'Наименование', 'Кол-во', 'Цена', 'Сумма'].map((t) => ({ text: t, bold: true }))];
    for (const l of v.lines) body.push([l.lineNo, l.supplierCode ?? l.number ?? '', l.brand ?? '', l.productName, `${D(l.qty).toFixed()} ${l.unitName}`, l.price ? D(l.price).toFixed(2) : '', l.amount ? D(l.amount).toFixed(2) : '']);
    return this.pdf.render({
      pageSize: 'A4',
      pageMargins: [30, 30, 30, 30],
      content: [
        { text: `Заказ поставщику ${v.number}`, fontSize: 14, bold: true },
        { text: `Поставщик: ${v.supplier?.name ?? ''}   Дата: ${dayjs(v.createdAt).tz('Asia/Bishkek').format('DD.MM.YYYY')}${v.expectedAt ? `   Ожидаем: ${dayjs(v.expectedAt).format('DD.MM.YYYY')}` : ''}`, margin: [0, 4, 0, 10] },
        { table: { headerRows: 1, widths: [18, 80, 60, '*', 50, 50, 55], body }, layout: 'lightHorizontalLines', fontSize: 8 },
        { text: `Итого: ${D(v.totalAmount).toFixed(2)} ${v.currency}`, bold: true, margin: [0, 10, 0, 0] },
        v.comment ? { text: v.comment, margin: [0, 8, 0, 0] } : '',
      ],
      defaultStyle: { font: 'Roboto', fontSize: 9 },
    });
  }

  async excelFile(id: string): Promise<Buffer> {
    const v: any = await this.get(id);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Заказ');
    ws.addRow([`Заказ ${v.number}`, '', `Поставщик: ${v.supplier?.name ?? ''}`]);
    ws.addRow([]);
    ws.addRow(['№', 'Номер', 'Бренд', 'Наименование', 'Количество', 'Ед.', 'Цена', 'Сумма', 'Валюта']).font = { bold: true };
    for (const l of v.lines) {
      ws.addRow([l.lineNo, l.supplierCode ?? l.number ?? '', l.brand ?? '', l.productName, Number(l.qty), l.unitName, l.price ? Number(l.price) : null, l.amount ? Number(l.amount) : null, v.currency]);
    }
    ws.columns.forEach((c, i) => (c.width = [5, 18, 14, 40, 10, 6, 10, 12, 8][i] ?? 12));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private async lock(tx: TenantTx, id: string, version?: number) {
    const o = await tx.repo(PurchaseOrder, 'Заказ').getForUpdate(id, version);
    this.scope.assertStore(o.storeId);
    return o;
  }

  receivingDoc(tx: TenantTx, id: string) {
    return tx.repo(Document).findById(id);
  }
}
