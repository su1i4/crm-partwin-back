import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { D, Decimal, money, qty as qty3, unitCost } from '../../common/utils/decimal';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { OutboxService } from '../../jobs/outbox.service';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { CategoriesService } from '../catalog/categories.service';
import { Product, ProductUnit } from '../catalog/entities/product.entity';
import { StoredFile } from '../files/entities/file.entity';
import { PeriodsService } from '../inventory/periods.service';
import { normalizePlace, PlacesService } from '../inventory/places.service';
import { NegativeLine, StockLedgerService } from '../inventory/stock-ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { Warehouse } from '../stores/entities/warehouse.entity';
import { CreateDocumentDto, DocumentLineDto, DocumentListQueryDto, UpdateDocumentDto } from './dto/document.dto';
import { Document, DocumentLine, DocumentLink, DOCUMENT_TYPES, DocumentType } from './entities/document.entity';
import { PostingContext, PostingHandler, tracksStock } from './handlers/handler.types';
import { SaleHandler, SaleReturnHandler } from './handlers/sale-handlers';
import { ExtraCostsHandler, SupplierReturnHandler } from './handlers/purchase-handlers';
import { DocumentHooks } from './document-hooks';

/** Виды, которые создаются только кассой (чек, возврат) — не через общий журнал документов. */
const POS_TYPES: string[] = ['sale', 'sale_return'];
import {
  CostAdjustmentHandler,
  InitialStockHandler,
  InventoryHandler,
  ReceivingHandler,
  ResortHandler,
  SurplusHandler,
  TransferHandler,
  WRITEOFF_REASONS,
  WriteoffHandler,
  SelectionIssueHandler,
  SelectionReturnHandler,
  ConsignmentHandler,
  ConsignmentReturnHandler,
  CustomerPurchaseHandler,
  DonorHandler,
} from './handlers/stock-handlers';
import { NumberingService } from './numbering.service';

export interface PostOptions {
  confirmDuplicateInvoice?: boolean;
  /** Внутренний вызов (автодокументы): без проверки «старше N дней» */
  system?: boolean;
  /** Офлайн-чек (ТЗ 16.4): минус не запрещает — чек принимается с пометкой и уведомлением */
  acceptNegative?: boolean;
}

/**
 * Движок документов (ТЗ 9): черновик → проведён; отмена проведения; перепроведение (исправление проведённого);
 * связи «на основании»; номера; оптимистичная блокировка; журнал.
 */
@Injectable()
export class DocumentsService {
  private readonly handlers: Map<DocumentType, PostingHandler>;

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly numbering: NumberingService,
    private readonly ledger: StockLedgerService,
    private readonly periods: PeriodsService,
    private readonly settings: SettingsService,
    private readonly categories: CategoriesService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly places: PlacesService,
    private readonly hooks: DocumentHooks,
    initial: InitialStockHandler,
    receiving: ReceivingHandler,
    surplus: SurplusHandler,
    writeoff: WriteoffHandler,
    resort: ResortHandler,
    transfer: TransferHandler,
    inventory: InventoryHandler,
    adjustment: CostAdjustmentHandler,
    sale: SaleHandler,
    saleReturn: SaleReturnHandler,
    supplierReturn: SupplierReturnHandler,
    extraCosts: ExtraCostsHandler,
    selIssue: SelectionIssueHandler,
    selReturn: SelectionReturnHandler,
    consignment: ConsignmentHandler,
    consignmentReturn: ConsignmentReturnHandler,
    customerPurchase: CustomerPurchaseHandler,
    donor: DonorHandler,
  ) {
    this.handlers = new Map<DocumentType, PostingHandler>(
      [initial, receiving, surplus, writeoff, resort, transfer, inventory, adjustment, sale, saleReturn, supplierReturn, extraCosts, selIssue, selReturn, consignment, consignmentReturn, customerPurchase, donor].map((h) => [h.type, h]),
    );
  }

  /** Права на вид документа (ТЗ 3.3): кладовщик — приёмка, перемещения, списания, инвентаризация… */
  assertTypePermission(type: string) {
    if (POS_TYPES.includes(type)) throw Errors.bad('USE_POS', 'Чеки и возвраты оформляются на кассе');
    if (type === 'extra_costs') throw Errors.bad('USE_EXTRA_COSTS', 'Доп. расходы оформляются из приёмки: POST /receivings/:id/extra-costs');
    const map: Record<string, string> = {
      receiving: 'stock.receive',
      transfer: 'stock.transfer',
      writeoff: 'stock.writeoff',
      inventory: 'stock.inventory',
      surplus: 'stock.inventory',
      resort: 'stock.inventory',
      initial_stock: 'stock.receive',
      supplier_return: 'stock.receive',
    };
    const perm = map[type];
    if (perm && !this.ctx.can(perm)) throw Errors.forbidden('Нет права на этот вид документа');
  }

  handler(type: DocumentType): PostingHandler {
    const h = this.handlers.get(type);
    if (!h) throw Errors.bad('UNKNOWN_TYPE', `Неизвестный вид документа: ${type}`);
    return h;
  }

  // ── Создание и сохранение черновика ─────────────────────

  async create(dto: CreateDocumentDto) {
    this.assertTypePermission(dto.type);
    if (dto.post && !this.ctx.can('documents.post')) throw Errors.forbidden('Нет права проводить документы');
    return this.tenantTx.run(async (tx) => {
      const doc = await this.createInTx(tx, dto);
      if (dto.post) await this.postInTx(tx, doc, { confirmDuplicateInvoice: dto.confirmDuplicateInvoice });
      return this.viewInTx(tx, doc.id);
    });
  }

  async createInTx(tx: TenantTx, dto: Partial<CreateDocumentDto> & { type: string }, opts: { system?: boolean } = {}): Promise<Document> {
    const type = dto.type as DocumentType;
    const handler = this.handler(type);
    const docDate = dto.docDate ? new Date(dto.docDate) : new Date();
    if (docDate.getTime() > Date.now() + 5 * 60_000) throw Errors.bad('FUTURE_DATE', 'Дата документа в будущем');
    await this.periods.assertEditable(tx, docDate, { checkAge: !opts.system });
    const storeId = await this.storeOf(tx, dto.warehouseId ?? null, opts.system);
    const doc = await tx.repo(Document).insert({
      type,
      number: await this.numbering.next(tx, type, storeId, docDate),
      docDate,
      status: 'draft',
      storeId,
      warehouseId: dto.warehouseId ?? null,
      warehouseToId: dto.warehouseToId ?? null,
      counterpartyId: dto.counterpartyId ?? null,
      currency: dto.currency ?? 'KGS',
      rate: dto.currency && dto.currency !== 'KGS' ? D(dto.rate ?? 0) : D(1),
      comment: dto.comment ?? null,
      extra: this.cleanExtra(type, dto.extra ?? {}),
      baseDocumentId: dto.baseDocumentId ?? null,
    });
    if (dto.baseDocumentId) {
      await tx.repo(Document, 'Документ-основание').getById(dto.baseDocumentId);
      await tx.repo(DocumentLink).insert({ fromId: dto.baseDocumentId, toId: doc.id, kind: 'based_on' });
    }
    await this.replaceLines(tx, doc, dto.lines ?? []);
    await handler.validateHeader?.(await this.context(tx, doc));
    if (!opts.system) {
      await this.audit.log(tx, {
        action: 'document.create',
        entityType: 'document',
        entityId: doc.id,
        storeId: doc.storeId,
        summary: `${DOCUMENT_TYPES[type].label} ${doc.number}`,
      });
    }
    return doc;
  }

  async update(id: string, dto: UpdateDocumentDto) {
    return this.tenantTx.run(async (tx) => {
      const doc = await this.lockDoc(tx, id, dto.version);
      this.assertTypePermission(doc.type);
      if (doc.type === 'inventory' || doc.type === 'cost_adjustment') throw Errors.bad('NOT_EDITABLE', 'Этот документ так не меняется');
      await this.periods.assertEditable(tx, doc.docDate);
      if (dto.docDate) await this.periods.assertEditable(tx, new Date(dto.docDate));
      const before = await this.viewInTx(tx, id);
      if (doc.status === 'posted') {
        await this.repostInTx(tx, doc, dto);
      } else {
        this.applyHeader(doc, dto);
        if (dto.warehouseId !== undefined) doc.storeId = await this.storeOf(tx, doc.warehouseId);
        await tx.repo(Document).save(doc);
        if (dto.lines) await this.replaceLines(tx, doc, dto.lines);
        await this.handler(doc.type).validateHeader?.(await this.context(tx, doc));
      }
      const after = await this.viewInTx(tx, id);
      await this.audit.log(tx, {
        action: doc.status === 'posted' ? 'document.repost' : 'document.update',
        entityType: 'document',
        entityId: id,
        storeId: doc.storeId,
        summary: `${DOCUMENT_TYPES[doc.type].label} ${doc.number}`,
        before: slim(before),
        after: slim(after),
        important: doc.status === 'posted',
      });
      return after;
    });
  }

  private applyHeader(doc: Document, dto: UpdateDocumentDto) {
    if (dto.docDate) doc.docDate = new Date(dto.docDate);
    if (dto.warehouseId !== undefined) doc.warehouseId = dto.warehouseId;
    if (dto.warehouseToId !== undefined) doc.warehouseToId = dto.warehouseToId;
    if (dto.counterpartyId !== undefined) doc.counterpartyId = dto.counterpartyId;
    if (dto.currency) {
      doc.currency = dto.currency;
      doc.rate = dto.currency === 'KGS' ? D(1) : D(dto.rate ?? doc.rate);
    } else if (dto.rate && doc.currency !== 'KGS') doc.rate = D(dto.rate);
    if (dto.comment !== undefined) doc.comment = dto.comment;
    if (dto.extra) doc.extra = { ...doc.extra, ...this.cleanExtra(doc.type, dto.extra) };
  }

  private cleanExtra(type: DocumentType, extra: Record<string, any>) {
    const allowed: Record<string, string[]> = {
      receiving: ['supplierInvoiceNumber', 'supplierInvoiceDate', 'extraCosts', 'extraCostsCurrency', 'purchaseOrderId', 'overMode'],
      supplier_return: ['returnReason', 'warrantyClaimId', 'supplierInvoiceNumber'],
      writeoff: ['reason'],
      inventory: ['scope'],
      transfer: [],
      initial_stock: [],
      surplus: ['reason'],
      resort: ['reason'],
      cost_adjustment: ['sourceDocumentId'],
    };
    const out: Record<string, any> = {};
    for (const k of allowed[type] ?? []) if (extra[k] !== undefined) out[k] = extra[k];
    if (out.extraCosts) {
      if (!Array.isArray(out.extraCosts)) throw Errors.bad('BAD_EXTRA', 'extraCosts — список {name, amount}');
      out.extraCosts = out.extraCosts.map((c: any) => {
        if (!c || !/^\d+([.,]\d+)?$/.test(String(c.amount))) throw Errors.bad('BAD_EXTRA', 'Сумма доп. расхода — число');
        return { name: String(c.name ?? 'Доп. расход').slice(0, 100), amount: String(c.amount).replace(',', '.') };
      });
    }
    if (out.reason && !(out.reason in WRITEOFF_REASONS)) throw Errors.bad('BAD_REASON', 'Неизвестная причина');
    return out;
  }

  /** Строки документа: проверка товаров, единиц, количества; пересчёт итогов. */
  private async replaceLines(tx: TenantTx, doc: Document, input: DocumentLineDto[]) {
    const productIds = [...new Set(input.flatMap((l) => [l.productId, l.productToId].filter(Boolean) as string[]))];
    const products = new Map((await tx.repo(Product, 'Товар').getByIds(productIds)).map((p) => [p.id, p]));
    const units = productIds.length ? await tx.repo(ProductUnit).find({ where: productIds.map((productId) => ({ productId })) }) : [];
    const errors: any[] = [];
    const rows: Partial<DocumentLine>[] = [];
    // Брак при приёмке — сразу на склад «Брак» точки (ТЗ 10.5)
    const defectWh = input.some((l) => l.defect) && doc.storeId ? await tx.repo(Warehouse).findOne({ where: { storeId: doc.storeId, type: 'defect', isActive: true } }) : null;
    if (input.some((l) => l.defect) && !defectWh) throw Errors.bad('NO_DEFECT_WAREHOUSE', 'У точки нет склада «Брак»');
    for (const l of input) if (l.warehouseId) await this.scope.assertWarehouse(tx, l.warehouseId);
    input.forEach((l, i) => {
      const lineNo = i + 1;
      const p = products.get(l.productId)!;
      if (p.kind !== 'goods' && doc.type !== 'receiving') errors.push({ line: lineNo, message: `Строка ${lineNo}: «${p.name}» — ${p.kind === 'kit' ? 'комплект' : 'услуга'}, в складской документ не входит` });
      if (p.kind === 'kit') errors.push({ line: lineNo, message: `Строка ${lineNo}: комплект не принимается — добавьте компоненты` });
      const unit = l.unitId ? units.find((u) => u.id === l.unitId && u.productId === p.id) : units.find((u) => u.productId === p.id && u.isBase);
      if (!unit) {
        errors.push({ line: lineNo, message: `Строка ${lineNo}: единица не относится к товару` });
        return;
      }
      const q = qty3(l.qty);
      if (q.lte(0)) errors.push({ line: lineNo, message: `Строка ${lineNo}: количество должно быть больше нуля` });
      const baseQty = qty3(q.mul(unit.factor));
      if (!p.fractional && !baseQty.isInteger()) errors.push({ line: lineNo, message: `Строка ${lineNo}: «${p.name}» не продаётся дробно` });
      if (p.isSerial && !baseQty.isInteger()) errors.push({ line: lineNo, message: `Строка ${lineNo}: серийный товар — целое количество` });
      let unitTo: ProductUnit | undefined;
      if (l.productToId) {
        unitTo = units.find((u) => u.productId === l.productToId && u.isBase);
        if (!unitTo) errors.push({ line: lineNo, message: `Строка ${lineNo}: у товара «во что» нет базовой единицы` });
      }
      const price = l.price === undefined || l.price === null || l.price === '' ? null : D(l.price);
      if (price && price.isNegative()) errors.push({ line: lineNo, message: `Строка ${lineNo}: цена не может быть отрицательной` });
      if (l.reason && !(l.reason in WRITEOFF_REASONS)) errors.push({ line: lineNo, message: `Строка ${lineNo}: неизвестная причина` });
      rows.push({
        documentId: doc.id,
        lineNo,
        productId: p.id,
        unitId: unit.id,
        factor: D(unit.factor),
        qty: q,
        baseQty,
        price: price ? unitCost(price) : null,
        amount: price ? money(price.mul(q)) : null,
        productToId: l.productToId ?? null,
        unitToId: unitTo?.id ?? null,
        serialItemIds: l.serialItemIds ?? [],
        place: l.place ?? null,
        extra: {
          ...(l.serials ? { serials: l.serials } : {}),
          ...(l.reason ? { reason: l.reason } : {}),
          ...(l.comment ? { comment: l.comment } : {}),
          ...(l.orderLineId ? { orderLineId: l.orderLineId } : {}),
          ...(l.expectedQty ? { expectedQty: l.expectedQty } : {}),
          ...(l.orderPrice ? { orderPrice: l.orderPrice } : {}),
          ...(l.notOrderedAction ? { notOrderedAction: l.notOrderedAction } : {}),
          ...(l.defect ? { defect: true, defectAction: l.defectAction ?? 'claim', warehouseId: defectWh?.id ?? null } : {}),
          ...(l.warehouseId ? { warehouseId: l.warehouseId } : {}),
        },
      });
    });
    if (errors.length) throw Errors.bad('LINES_INVALID', 'Проверьте строки документа', errors);
    await tx.repo(DocumentLine).hardDelete({ documentId: doc.id });
    await tx.repo(DocumentLine).insertMany(rows);
    doc.totalQty = rows.reduce((a, r) => a.plus(r.qty as Decimal), D(0));
    doc.totalAmount = money(rows.reduce((a, r) => a.plus((r.amount as Decimal) ?? 0), D(0)));
    await tx.query(`UPDATE documents SET total_qty = $3, total_amount = $4 WHERE tenant_id = $1 AND id = $2`, [
      tx.tenantId,
      doc.id,
      doc.totalQty.toFixed(),
      doc.totalAmount.toFixed(),
    ]);
  }

  // ── Проведение ──────────────────────────────────────────

  async post(id: string, version: number, opts: PostOptions = {}) {
    return this.tenantTx.run(async (tx) => {
      const doc = await this.lockDoc(tx, id, version);
      this.assertTypePermission(doc.type);
      if (doc.type === 'inventory') throw Errors.bad('USE_FINISH', 'Инвентаризация завершается кнопкой «Завершить»');
      if (doc.status === 'posted') throw Errors.conflict('ALREADY_POSTED', 'Документ уже проведён');
      if (doc.status === 'awaiting_approval') throw Errors.conflict('AWAITING_APPROVAL', 'Списание ждёт согласования');
      await this.postInTx(tx, doc, opts);
      return this.viewInTx(tx, id);
    });
  }

  async postInTx(tx: TenantTx, doc: Document, opts: PostOptions = {}, approval = false) {
    await this.periods.assertEditable(tx, doc.docDate, { checkAge: !opts.system });
    if (!opts.system) await this.assertWarehouseAccess(tx, doc);
    const ctx = await this.context(tx, doc);
    const handler = this.handler(doc.type);
    await handler.beforePost?.(ctx);
    await this.hooks.beforePost(ctx);
    if (doc.type === 'receiving') await this.checkDuplicateInvoice(tx, doc, !!opts.confirmDuplicateInvoice);

    // Списание сверх порога — на согласование (ТЗ 9.3)
    if (doc.type === 'writeoff' && !approval && !opts.system) {
      const threshold = D(ctx.settings.writeoffApprovalAmount ?? 0);
      if (threshold.gt(0) && !this.ctx.can('stock.writeoff_approve')) {
        const estimate = await this.estimateOut(tx, ctx);
        if (estimate.gt(threshold)) {
          doc.status = 'awaiting_approval';
          doc.extra = { ...doc.extra, approvalEstimate: estimate.toFixed(2) };
          await tx.repo(Document).save(doc);
          await this.notifications.notify(tx, {
            type: 'document.unposted',
            title: `Списание ${doc.number} на ${estimate.toFixed(0)} сом ждёт согласования`,
            entityType: 'document',
            entityId: doc.id,
            storeId: doc.storeId,
            permission: 'stock.writeoff_approve',
            link: `/documents/${doc.id}`,
          });
          return { awaitingApproval: true };
        }
      }
    }

    const plans = await handler.plan(ctx);
    const result = await this.ledger.apply(tx, doc.id, doc.docDate, plans);
    await this.handleNegatives(tx, doc, ctx, result.negatives, !!opts.acceptNegative);
    await this.writeLineCosts(tx, doc.id);
    if (result.adjustments.length) await this.createCoverAdjustment(tx, doc, result.adjustments);

    doc.status = 'posted';
    doc.postedAt = new Date();
    doc.postedBy = tx.userId;
    doc.deletionMark = false;
    await tx.repo(Document).save(doc);
    await handler.afterPost?.(ctx);
    await this.hooks.afterPost(ctx);
    await this.rememberPlaces(tx, doc, ctx);
    await this.ledger.enqueueRecalcIfBackdated(tx, [...new Set(plans.map((p) => p.productId))], doc.docDate, doc.id);
    await this.outbox.emit(tx, 'document.posted', { id: doc.id, type: doc.type, storeId: doc.storeId });
    if (!opts.system) {
      await this.audit.log(tx, {
        action: 'document.post',
        entityType: 'document',
        entityId: doc.id,
        storeId: doc.storeId,
        summary: `Проведён ${DOCUMENT_TYPES[doc.type].label} ${doc.number}`,
      });
    }
    return { awaitingApproval: false, negatives: result.negatives };
  }

  /** Место из строки прихода запоминается для пары «товар + склад» (ТЗ 8.1). */
  private async rememberPlaces(tx: TenantTx, doc: Document, ctx: PostingContext) {
    if (!['initial_stock', 'receiving', 'surplus'].includes(doc.type) || !doc.warehouseId) return;
    for (const l of ctx.lines) {
      if (l.place && tracksStock(ctx.products.get(l.productId))) {
        await this.places.setInTx(tx, doc.warehouseId, [l.productId], normalizePlace(l.place).slice(0, 50));
      }
    }
  }

  /** Согласовать списание сверх порога. */
  async approve(id: string, version: number) {
    return this.tenantTx.run(async (tx) => {
      const doc = await this.lockDoc(tx, id, version);
      if (doc.status !== 'awaiting_approval') throw Errors.conflict('NOT_AWAITING', 'Документ не ждёт согласования');
      await this.postInTx(tx, doc, {}, true);
      await this.audit.log(tx, { action: 'document.approve', entityType: 'document', entityId: id, summary: `Согласовано списание ${doc.number}`, important: true });
      return this.viewInTx(tx, id);
    });
  }

  /** Минус: запрет или предупреждение (настройка магазина, категория; серийные — запрет всегда) (ТЗ 7.4). */
  private async handleNegatives(tx: TenantTx, doc: Document, ctx: PostingContext, negatives: NegativeLine[], accept = false) {
    if (!negatives.length) {
      doc.hasNegative = false;
      return;
    }
    const whs = new Map((await tx.repo(Warehouse).findByIds([...new Set(negatives.map((n) => n.warehouseId))])).map((w) => [w.id, w]));
    const forbid: NegativeLine[] = [];
    for (const n of negatives) {
      const p = ctx.products.get(n.productId) ?? (await tx.repo(Product).findById(n.productId))!;
      const cat = await this.categories.effectiveSettings(tx, p.categoryId);
      const policy = p.isSerial ? 'forbid' : (cat.negativeStock ?? ctx.settings.negativeStock);
      if (!accept && (policy === 'forbid' || whs.get(n.warehouseId)?.type === 'transit')) forbid.push(n);
    }
    if (forbid.length) {
      const names = new Map((await tx.repo(Product).findByIds(forbid.map((f) => f.productId))).map((p) => [p.id, p]));
      throw Errors.conflict(
        'STOCK_NOT_ENOUGH',
        'Не хватает товара на складе',
        forbid.map((f) => {
          const p = names.get(f.productId);
          return {
            line: f.lineNo,
            productId: f.productId,
            warehouseId: f.warehouseId,
            need: f.need,
            available: f.available,
            message: `${f.lineNo ? `Строка ${f.lineNo}: ` : ''}не хватает ${D(f.need).minus(D(f.available).gt(0) ? f.available : 0).toFixed()} ${p?.baseUnit ?? 'шт'} «${p?.name ?? ''}», на складе ${f.available}`,
          };
        }),
      );
    }
    doc.hasNegative = true;
    await this.notifications.notify(tx, {
      type: 'sale.negative_stock',
      title: `${DOCUMENT_TYPES[doc.type].label} ${doc.number}: остаток ушёл в минус`,
      entityType: 'document',
      entityId: doc.id,
      storeId: doc.storeId,
      permission: 'stock.read',
      excludeUserId: tx.userId,
      link: `/documents/${doc.id}`,
    });
  }

  /** Себестоимость строк по фактическим движениям. */
  private async writeLineCosts(tx: TenantTx, documentId: string) {
    await tx.query(
      `UPDATE document_lines l SET cost_amount = abs(s.amount),
              unit_cost = CASE WHEN s.qty <> 0 THEN abs(s.amount / s.qty) ELSE NULL END
         FROM (SELECT line_id, sum(cost_amount) AS amount, sum(qty) AS qty FROM stock_movements
                WHERE tenant_id = $1 AND document_id = $2 AND kind IN ('in', 'out', 'transfer_out')
                  AND NOT (kind = 'transfer_out' AND warehouse_id IN (SELECT id FROM warehouses WHERE tenant_id = $1 AND type = 'transit'))
                GROUP BY line_id) s
        WHERE l.tenant_id = $1 AND l.id = s.line_id`,
      [tx.tenantId, documentId],
    );
  }

  /** Приход покрыл продажи в минус → документ «Корректировка себестоимости» (ТЗ 7.4). */
  private async createCoverAdjustment(tx: TenantTx, source: Document, adjustments: { productId: string; warehouseId: string; amount: Decimal; qty: Decimal }[]) {
    const byWh = new Map<string, typeof adjustments>();
    for (const a of adjustments) byWh.set(a.warehouseId, [...(byWh.get(a.warehouseId) ?? []), a]);
    for (const [warehouseId, list] of byWh) {
      const adj = await tx.repo(Document).insert({
        type: 'cost_adjustment',
        number: await this.numbering.next(tx, 'cost_adjustment', source.storeId, source.docDate),
        docDate: source.docDate,
        status: 'draft',
        storeId: source.storeId,
        warehouseId,
        comment: `Дооценка проданного в минус по ${source.number}`,
        extra: { sourceDocumentId: source.id },
      });
      const units = await tx.repo(ProductUnit).find({ where: list.map((a) => ({ productId: a.productId, isBase: true })) });
      await tx.repo(DocumentLine).insertMany(
        list.map((a, i) => ({
          documentId: adj.id,
          lineNo: i + 1,
          productId: a.productId,
          unitId: units.find((u) => u.productId === a.productId)!.id,
          factor: D(1),
          qty: a.qty,
          baseQty: a.qty,
          price: null,
          amount: money(a.amount),
          costAmount: a.amount,
          extra: { registerAmount: a.amount.neg().toFixed() },
        })),
      );
      const ctx = await this.context(tx, adj);
      const plans = await this.handler('cost_adjustment').plan(ctx);
      await this.ledger.apply(tx, adj.id, adj.docDate, plans);
      adj.status = 'posted';
      adj.postedAt = new Date();
      adj.totalAmount = money(list.reduce((s, a) => s.plus(a.amount), D(0)));
      await tx.repo(Document).save(adj);
      await tx.repo(DocumentLink).insert({ fromId: source.id, toId: adj.id, kind: 'cost_adjustment' });
    }
  }

  // ── Отмена проведения ───────────────────────────────────

  async unpost(id: string, version: number) {
    return this.tenantTx.run(async (tx) => {
      const doc = await this.lockDoc(tx, id, version);
      this.assertTypePermission(doc.type);
      if (doc.type === 'cost_adjustment') throw Errors.bad('AUTO_DOCUMENT', 'Корректировка отменяется вместе с документом-основанием');
      if (doc.status !== 'posted') throw Errors.conflict('NOT_POSTED', 'Документ не проведён');
      await this.unpostInTx(tx, doc);
      await this.notifications.notify(tx, {
        type: 'document.unposted',
        title: `Отменено проведение ${DOCUMENT_TYPES[doc.type].label} ${doc.number}`,
        entityType: 'document',
        entityId: doc.id,
        storeId: doc.storeId,
        ownersOnly: true,
        excludeUserId: tx.userId,
        link: `/documents/${doc.id}`,
      });
      return this.viewInTx(tx, id);
    });
  }

  async unpostInTx(tx: TenantTx, doc: Document, opts: { forRepost?: boolean } = {}) {
    await this.periods.assertEditable(tx, doc.docDate);
    await this.assertWarehouseAccess(tx, doc);
    const ctx = await this.context(tx, doc);
    const handler = this.handler(doc.type);
    if (!opts.forRepost) {
      await handler.beforeUnpost?.(ctx);
      await this.assertNoPostedDependents(tx, doc);
      // Отчёты (отчётная таблица продаж) пересчитают день документа
      await this.outbox.emit(tx, 'document.unposted', { id: doc.id, type: doc.type, storeId: doc.storeId, oldDate: doc.docDate });
    }
    // Автокорректировки себестоимости этого документа — тоже отменяются
    const adjs = await tx.query<{ id: string }>(
      `SELECT d.id FROM document_links l JOIN documents d ON d.id = l.to_id AND d.deleted_at IS NULL
        WHERE l.tenant_id = $1 AND l.from_id = $2 AND l.kind = 'cost_adjustment'`,
      [tx.tenantId, doc.id],
    );
    for (const a of adjs) {
      await this.ledger.reverse(tx, a.id);
      await tx.query(`UPDATE documents SET status = 'draft', deleted_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, a.id]);
      await tx.query(`DELETE FROM document_links WHERE tenant_id = $1 AND to_id = $2`, [tx.tenantId, a.id]);
    }
    const rev = await this.ledger.reverse(tx, doc.id);
    if (!opts.forRepost && rev.negatives.length) {
      const forbid = [];
      for (const n of rev.negatives) {
        const p = (await tx.repo(Product).findById(n.productId))!;
        const cat = await this.categories.effectiveSettings(tx, p.categoryId);
        if (p.isSerial || (cat.negativeStock ?? ctx.settings.negativeStock) === 'forbid') forbid.push({ n, p });
      }
      if (forbid.length) {
        const blockers = await tx.query(
          `SELECT DISTINCT d.id, d.number, d.type, d.doc_date AS "docDate" FROM stock_movements m JOIN documents d ON d.id = m.document_id
            WHERE m.tenant_id = $1 AND m.product_id = ANY($2::uuid[]) AND m.qty < 0 AND m.moved_at >= $3 ORDER BY d.doc_date LIMIT 20`,
          [tx.tenantId, forbid.map((f) => f.p.id), doc.docDate],
        );
        throw Errors.conflict(
          'UNPOST_NEGATIVE',
          'Отмена уведёт остаток в минус: товар уже продан или списан. Исправьте документ или оформите возврат поставщику',
          { products: forbid.map((f) => ({ productId: f.p.id, name: f.p.name, shortage: f.n.need })), blockingDocuments: blockers },
        );
      }
    }
    if (!opts.forRepost) await handler.afterUnpost?.(ctx);
    await this.hooks.afterUnpost(ctx, !!opts.forRepost);
    doc.status = 'draft';
    doc.postedAt = null;
    doc.postedBy = null;
    doc.hasNegative = false;
    await tx.repo(Document).save(doc);
    if (rev.productIds.length) await this.ledger.enqueueRecalcIfBackdated(tx, rev.productIds, doc.docDate, doc.id);
    if (!opts.forRepost) {
      await this.audit.log(tx, {
        action: 'document.unpost',
        entityType: 'document',
        entityId: doc.id,
        storeId: doc.storeId,
        summary: `Отменено проведение ${DOCUMENT_TYPES[doc.type].label} ${doc.number}`,
        important: true,
      });
    }
  }

  /**
   * Исправление проведённого документа (перепроведение, ТЗ 9.2): старые движения заменяются новыми
   * в одной транзакции, проверка минуса — по итоговому результату.
   */
  private async repostInTx(tx: TenantTx, doc: Document, dto: UpdateDocumentDto) {
    if (!this.ctx.can('documents.post')) throw Errors.forbidden('Исправлять проведённые документы может только тот, кто их проводит');
    const oldLines = await tx.repo(DocumentLine).find({ where: { documentId: doc.id } });
    if (oldLines.some((l) => l.serialItemIds.length) && dto.lines) {
      throw Errors.conflict('REPOST_SERIALS', 'В документе серийные экземпляры: отмените проведение, исправьте и проведите снова');
    }
    if (doc.type === 'transfer' && doc.extra?.transferState === 'received' && (dto.warehouseId || dto.warehouseToId)) {
      throw Errors.conflict('TRANSFER_RECEIVED', 'Перемещение принято — склады менять нельзя');
    }
    const baseline = await this.ledger.balancesFor(tx, doc.id);
    const oldDate = doc.docDate;
    const oldInvoice = `${doc.counterpartyId}|${doc.extra?.supplierInvoiceNumber ?? ''}`;
    await this.unpostInTx(tx, doc, { forRepost: true });
    this.applyHeader(doc, dto);
    if (dto.warehouseId !== undefined) doc.storeId = await this.storeOf(tx, doc.warehouseId);
    await tx.repo(Document).save(doc);
    if (dto.lines) await this.replaceLines(tx, doc, dto.lines);

    const ctx = await this.context(tx, doc);
    const handler = this.handler(doc.type);
    await handler.beforePost?.(ctx);
    await this.hooks.beforePost(ctx);
    // Повторно предупреждаем только если поменяли поставщика или номер накладной
    const invoiceChanged = oldInvoice !== `${doc.counterpartyId}|${doc.extra?.supplierInvoiceNumber ?? ''}`;
    if (doc.type === 'receiving' && invoiceChanged) await this.checkDuplicateInvoice(tx, doc, !!dto.confirmDuplicateInvoice);
    const plans = await handler.plan(ctx);
    const result = await this.ledger.apply(tx, doc.id, doc.docDate, plans, baseline);
    await this.handleNegatives(tx, doc, ctx, result.negatives);
    await this.writeLineCosts(tx, doc.id);
    if (result.adjustments.length) await this.createCoverAdjustment(tx, doc, result.adjustments);
    doc.status = 'posted';
    doc.postedAt = new Date();
    doc.postedBy = tx.userId;
    await tx.repo(Document).save(doc);
    await handler.afterPost?.(ctx);
    await this.hooks.afterPost(ctx);
    const from = oldDate < doc.docDate ? oldDate : doc.docDate;
    await this.ledger.enqueueRecalcIfBackdated(tx, [...new Set(plans.map((p) => p.productId))], from, doc.id);
    await this.outbox.emit(tx, 'document.posted', { id: doc.id, type: doc.type, storeId: doc.storeId, repost: true, oldDate });
  }

  // ── Удаление ────────────────────────────────────────────

  /** Удалить можно только черновик (мягко). */
  async remove(id: string, version: number) {
    await this.tenantTx.run(async (tx) => {
      const doc = await this.lockDoc(tx, id, version);
      this.assertTypePermission(doc.type);
      if (doc.status !== 'draft') throw Errors.conflict('NOT_DRAFT', 'Удалить можно только черновик. Сначала отмените проведение');
      await this.periods.assertEditable(tx, doc.docDate);
      await this.assertNoPostedDependents(tx, doc);
      await tx.repo(Document).softDelete(id);
      await this.audit.log(tx, { action: 'document.delete', entityType: 'document', entityId: id, summary: doc.number, important: true });
    });
  }

  async setDeletionMark(id: string, version: number, mark: boolean) {
    return this.tenantTx.run(async (tx) => {
      const doc = await this.lockDoc(tx, id, version);
      this.assertTypePermission(doc.type);
      if (mark && doc.status === 'posted') throw Errors.conflict('POSTED', 'Сначала отмените проведение');
      doc.deletionMark = mark;
      await tx.repo(Document).save(doc);
      await this.audit.log(tx, { action: mark ? 'document.mark_deletion' : 'document.unmark_deletion', entityType: 'document', entityId: id });
      return this.viewInTx(tx, id);
    });
  }

  private async assertNoPostedDependents(tx: TenantTx, doc: Document) {
    const deps = await tx.query(
      `SELECT d.id, d.number, d.type, d.status FROM document_links l JOIN documents d ON d.id = l.to_id AND d.deleted_at IS NULL
        WHERE l.tenant_id = $1 AND l.from_id = $2 AND l.kind <> 'cost_adjustment' AND d.status = 'posted'`,
      [tx.tenantId, doc.id],
    );
    if (deps.length) {
      throw Errors.conflict('HAS_DEPENDENTS', 'Есть проведённые документы на основании этого — сначала отмените их', { chain: deps });
    }
  }

  // ── На основании, вложения ──────────────────────────────

  async createBasedOn(id: string, type: string) {
    return this.tenantTx.run(async (tx) => {
      const src = await tx.repo(Document, 'Документ').getById(id);
      const lines = await tx.repo(DocumentLine).find({ where: { documentId: id }, order: { lineNo: 'ASC' } });
      const doc = await this.createInTx(tx, {
        type,
        warehouseId: src.warehouseToId ?? src.warehouseId ?? undefined,
        counterpartyId: type === 'receiving' || type === 'supplier_return' ? src.counterpartyId : undefined,
        currency: type === 'supplier_return' ? src.currency : undefined,
        rate: type === 'supplier_return' ? src.rate.toFixed() : undefined,
        baseDocumentId: src.id,
        comment: `На основании ${src.number}`,
        lines: lines.map((l) => ({
          productId: l.productId,
          unitId: l.unitId,
          qty: l.qty.toFixed(),
          // Возврат поставщику — по цене приёмки, с того склада, куда легла строка (брак → «Брак»)
          price: (type === 'receiving' || type === 'supplier_return') && l.price ? l.price.toFixed() : undefined,
          warehouseId: type === 'supplier_return' ? l.extra?.warehouseId : undefined,
          serialItemIds: type === 'supplier_return' && l.serialItemIds.length ? l.serialItemIds : undefined,
        })),
      });
      return this.viewInTx(tx, doc.id);
    });
  }

  async addAttachment(id: string, fileId: string) {
    return this.tenantTx.run(async (tx) => {
      const doc = await tx.repo(Document, 'Документ').getById(id);
      await tx.repo(StoredFile, 'Файл').getById(fileId);
      await tx.query(`UPDATE files SET entity_type = 'document', entity_id = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, fileId, doc.id]);
      await this.audit.log(tx, { action: 'document.attach', entityType: 'document', entityId: id, after: { fileId } });
      return this.viewInTx(tx, id);
    });
  }

  // ── Чтение ──────────────────────────────────────────────

  async view(id: string) {
    return this.tenantTx.run((tx) => this.viewInTx(tx, id));
  }

  async viewInTx(tx: TenantTx, id: string) {
    const doc = await tx.repo(Document, 'Документ').getById(id);
    if (doc.storeId && !this.scope.canStore(doc.storeId) && !(await this.canSeeAsReceiver(tx, doc))) throw Errors.notFound('Документ');
    const lines = await tx.query(
      `SELECT l.id, l.line_no AS "lineNo", l.product_id AS "productId", p.name AS "productName", p.sku, p.base_unit AS "baseUnit",
              p.is_serial AS "isSerial", (SELECT n.number FROM part_numbers n WHERE n.tenant_id = l.tenant_id AND n.product_id = p.id
                ORDER BY (n.type = 'manufacturer') DESC LIMIT 1) AS "mainNumber",
              l.unit_id AS "unitId", u.name AS "unitName", l.factor, l.qty, l.base_qty AS "baseQty", l.price, l.amount,
              l.unit_cost AS "unitCost", l.cost_amount AS "costAmount", l.product_to_id AS "productToId", pt.name AS "productToName",
              l.serial_item_ids AS "serialItemIds", l.place, l.extra
         FROM document_lines l JOIN products p ON p.id = l.product_id
         LEFT JOIN product_units u ON u.id = l.unit_id
         LEFT JOIN products pt ON pt.id = l.product_to_id
        WHERE l.tenant_id = $1 AND l.document_id = $2 ORDER BY l.line_no`,
      [tx.tenantId, id],
    );
    const canCost = this.ctx.can('products.view_cost');
    const links = await tx.query(
      `SELECT l.kind, CASE WHEN l.from_id = $2 THEN 'to' ELSE 'from' END AS direction, d.id, d.number, d.type, d.status, d.doc_date AS "docDate"
         FROM document_links l JOIN documents d ON d.id = CASE WHEN l.from_id = $2 THEN l.to_id ELSE l.from_id END AND d.deleted_at IS NULL
        WHERE l.tenant_id = $1 AND (l.from_id = $2 OR l.to_id = $2) ORDER BY d.doc_date`,
      [tx.tenantId, id],
    );
    const attachments = await tx.query(
      `SELECT id, original_name AS "name", mime, size, created_at AS "createdAt" FROM files
        WHERE tenant_id = $1 AND entity_type = 'document' AND entity_id = $2 AND deleted_at IS NULL ORDER BY created_at`,
      [tx.tenantId, id],
    );
    const whIds = [doc.warehouseId, doc.warehouseToId].filter(Boolean) as string[];
    const whs = await tx.repo(Warehouse).findByIds(whIds);
    const [cp] = doc.counterpartyId ? await tx.query(`SELECT id, name FROM counterparties WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, doc.counterpartyId]) : [];
    const { extra, ...head } = doc;
    return {
      ...head,
      extra: canCost ? extra : { ...extra, extraCosts: undefined },
      typeLabel: DOCUMENT_TYPES[doc.type].label,
      warehouse: whs.find((w) => w.id === doc.warehouseId) ?? null,
      warehouseTo: whs.find((w) => w.id === doc.warehouseToId) ?? null,
      counterparty: cp ?? null,
      lines: lines.map((l: any) =>
        canCost || doc.type !== 'receiving'
          ? hideCost(l, canCost)
          : { ...hideCost(l, false), price: null, amount: null },
      ),
      totalAmount: canCost || doc.type !== 'receiving' ? doc.totalAmount : null,
      links,
      attachments,
    };
  }

  async list(q: DocumentListQueryDto) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const w: string[] = ['d.tenant_id = $1', 'd.deleted_at IS NULL'];
      if (q.type) w.push(`d.type = ${p(q.type)}`);
      else w.push(`d.type <> 'cost_adjustment'`);
      if (q.status) w.push(`d.status = ${p(q.status)}`);
      if (q.storeId) w.push(`d.store_id = ${p(q.storeId)}`);
      if (q.warehouseId) w.push(`(d.warehouse_id = ${p(q.warehouseId)} OR d.warehouse_to_id = $${params.length})`);
      if (q.counterpartyId) w.push(`d.counterparty_id = ${p(q.counterpartyId)}`);
      if (q.productId) w.push(`EXISTS (SELECT 1 FROM document_lines l WHERE l.tenant_id = d.tenant_id AND l.document_id = d.id AND l.product_id = ${p(q.productId)})`);
      if (q.from) w.push(`d.doc_date >= ${p(q.from)}`);
      if (q.to) w.push(`d.doc_date < ${p(q.to)}`);
      if (q.deletionMark !== undefined) w.push(`d.deletion_mark = ${p(q.deletionMark)}`);
      if (q.inTransit) w.push(`d.type = 'transfer' AND d.status = 'posted' AND d.extra->>'transferState' = 'in_transit'`);
      if (q.q) w.push(`(d.number ILIKE ${p(`%${q.q}%`)} OR d.comment ILIKE $${params.length} OR d.extra->>'supplierInvoiceNumber' ILIKE $${params.length})`);
      const stores = this.scope.storeIds();
      if (stores !== null) w.push(`(d.store_id = ANY(${p(stores)}::uuid[]) OR d.warehouse_to_id IN (SELECT id FROM warehouses WHERE tenant_id = $1 AND store_id = ANY($${params.length}::uuid[])))`);
      const where = w.join(' AND ');
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM documents d WHERE ${where}`, params);
      const items = await tx.query(
        `SELECT d.id, d.type, d.number, d.doc_date AS "docDate", d.status, d.deletion_mark AS "deletionMark", d.store_id AS "storeId",
                d.warehouse_id AS "warehouseId", w.name AS "warehouseName", d.warehouse_to_id AS "warehouseToId", wt.name AS "warehouseToName",
                d.counterparty_id AS "counterpartyId", c.name AS "counterpartyName", d.currency, d.total_qty AS "totalQty",
                ${this.ctx.can('products.view_cost') ? 'd.total_amount' : `CASE WHEN d.type = 'receiving' THEN NULL ELSE d.total_amount END`} AS "totalAmount",
                d.has_negative AS "hasNegative", d.comment, d.extra->>'transferState' AS "transferState", d.version, d.created_at AS "createdAt"
           FROM documents d
           LEFT JOIN warehouses w ON w.id = d.warehouse_id
           LEFT JOIN warehouses wt ON wt.id = d.warehouse_to_id
           LEFT JOIN counterparties c ON c.id = d.counterparty_id
          WHERE ${where} ORDER BY d.doc_date DESC, d.created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items: items.map((i: any) => ({ ...i, typeLabel: DOCUMENT_TYPES[i.type as DocumentType]?.label })), total };
    });
  }

  // ── Вспомогательное ────────────────────────────────────

  async lockDoc(tx: TenantTx, id: string, version?: number): Promise<Document> {
    const doc = await tx.repo(Document, 'Документ').getById(id, { lock: { mode: 'pessimistic_write' } } as any);
    if (version !== undefined && doc.version !== version) throw Errors.versionConflict();
    if (doc.storeId && !this.scope.canStore(doc.storeId) && !(await this.canSeeAsReceiver(tx, doc))) throw Errors.notFound('Документ');
    return doc;
  }

  async context(tx: TenantTx, doc: Document): Promise<PostingContext> {
    const lines = await tx.repo(DocumentLine).find({ where: { documentId: doc.id }, order: { lineNo: 'ASC' } });
    const ids = [...new Set(lines.flatMap((l) => [l.productId, l.productToId].filter(Boolean) as string[]))];
    const products = new Map((await tx.repo(Product).findByIds(ids, { withDeleted: true })).map((p) => [p.id, p]));
    return { tx, doc, lines, products, settings: await this.settings.get(tx) };
  }

  private async storeOf(tx: TenantTx, warehouseId: string | null, system = false): Promise<string | null> {
    if (!warehouseId) return this.scope.currentStoreId() ?? null;
    const wh = await tx.repo(Warehouse, 'Склад').getById(warehouseId);
    if (!system) await this.scope.assertWarehouse(tx, wh.id);
    return wh.storeId;
  }

  private async assertWarehouseAccess(tx: TenantTx, doc: Document) {
    if (doc.warehouseId) await this.scope.assertWarehouse(tx, doc.warehouseId);
  }

  private async canSeeAsReceiver(tx: TenantTx, doc: Document) {
    if (doc.type !== 'transfer' || !doc.warehouseToId) return false;
    const allowed = await this.scope.warehouseIds(tx);
    return allowed === null || allowed.includes(doc.warehouseToId);
  }

  /** Та же накладная поставщика проведена дважды — предупреждение (ТЗ 10.5). */
  private async checkDuplicateInvoice(tx: TenantTx, doc: Document, confirmed: boolean) {
    const inv = doc.extra?.supplierInvoiceNumber;
    if (!inv || !doc.counterpartyId || confirmed) return;
    const dups = await tx.query(
      `SELECT id, number, doc_date AS "docDate" FROM documents WHERE tenant_id = $1 AND type = 'receiving' AND status = 'posted'
          AND counterparty_id = $2 AND extra->>'supplierInvoiceNumber' = $3 AND id <> $4 AND deleted_at IS NULL`,
      [tx.tenantId, doc.counterpartyId, String(inv), doc.id],
    );
    if (dups.length) {
      throw Errors.conflict('DUPLICATE_INVOICE', `Накладная ${inv} этого поставщика уже проведена: ${dups[0].number}. Подтвердите, если это другая поставка`, { documents: dups });
    }
  }

  private async estimateOut(tx: TenantTx, ctx: PostingContext): Promise<Decimal> {
    let sum = D(0);
    for (const l of ctx.lines) {
      if (!tracksStock(ctx.products.get(l.productId))) continue;
      sum = sum.plus((await this.ledger.currentUnitCost(tx, l.productId)).mul(l.baseQty));
    }
    return money(sum);
  }
}

function hideCost(l: any, canCost: boolean) {
  return canCost ? l : { ...l, unitCost: null, costAmount: null };
}

function slim(view: any) {
  return {
    status: view.status,
    docDate: view.docDate,
    warehouseId: view.warehouseId,
    counterpartyId: view.counterpartyId,
    totalAmount: view.totalAmount,
    lines: view.lines?.map((l: any) => ({ productId: l.productId, qty: l.qty, price: l.price })),
  };
}
