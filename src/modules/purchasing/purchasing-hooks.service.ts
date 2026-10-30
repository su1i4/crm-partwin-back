import { Injectable, OnModuleInit } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { D, money, unitCost } from '../../common/utils/decimal';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { Counterparty } from '../counterparties/entities/counterparty.entity';
import { DocumentHooks } from '../documents/document-hooks';
import { DocumentsService } from '../documents/documents.service';
import { DocumentLine } from '../documents/entities/document.entity';
import { PostingContext } from '../documents/handlers/handler.types';
import { DebtsService } from '../finance/debts.service';
import { MoneyService } from '../finance/money.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CustomerRequest, CustomerRequestItem, PurchaseOrder, PurchaseOrderLine } from './entities/purchasing.entity';
import { PurchaseOrdersService } from './purchase-orders.service';

/**
 * Закупки в проведении документов (той же транзакцией):
 * приёмка → сверка с заказом, статус заказа, долг поставщику, последняя цена, заявки «привезли»;
 * возврат поставщику → уменьшение долга; доп. расходы → долг перевозчику или оплата.
 */
@Injectable()
export class PurchasingHooksService implements OnModuleInit {
  constructor(
    private readonly hooks: DocumentHooks,
    private readonly orders: PurchaseOrdersService,
    private readonly debts: DebtsService,
    private readonly money: MoneyService,
    private readonly docs: DocumentsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.hooks.on('receiving', {
      beforePost: (ctx) => this.receivingBeforePost(ctx),
      afterPost: (ctx) => this.receivingAfterPost(ctx),
      afterUnpost: (ctx, o) => this.receivingAfterUnpost(ctx, o.forRepost),
    });
    this.hooks.on('supplier_return', {
      afterPost: (ctx) => this.supplierReturnAfterPost(ctx),
      afterUnpost: (ctx) => this.debts.cancelForDocument(ctx.tx, ctx.doc.id),
    });
    this.hooks.on('extra_costs', {
      afterPost: (ctx) => this.extraCostsAfterPost(ctx),
      afterUnpost: (ctx) => this.extraCostsAfterUnpost(ctx),
    });
  }

  // ── Приёмка ──────────────────────────────────────────────

  /**
   * Сверка с заказом (ТЗ 10.5): пришло больше — «принять всё» или «по заказу» (излишек — в акт расхождения);
   * строка «не заказана» — принять / принять и вернуть.
   */
  private async receivingBeforePost(ctx: PostingContext) {
    const orderId = ctx.doc.extra?.purchaseOrderId;
    if (!orderId) return;
    const { tx } = ctx;
    const order = await tx.repo(PurchaseOrder, 'Заказ').getById(orderId);
    if (order.supplierId !== ctx.doc.counterpartyId) throw Errors.bad('ORDER_OTHER_SUPPLIER', 'Заказ другого поставщика');
    if (['cancelled', 'closed'].includes(order.status)) throw Errors.conflict('ORDER_CLOSED', 'Заказ закрыт или отменён');
    const orderLines = await tx.repo(PurchaseOrderLine).find({ where: { orderId } });
    // Принято другими приёмками по строке
    const other = await tx.query(
      `SELECT l.extra->>'orderLineId' AS line, sum(l.qty) AS q FROM document_lines l JOIN documents d ON d.id = l.document_id
        WHERE l.tenant_id = $1 AND d.type = 'receiving' AND d.status = 'posted' AND d.id <> $2 AND d.deleted_at IS NULL AND d.extra->>'purchaseOrderId' = $3 GROUP BY 1`,
      [tx.tenantId, ctx.doc.id, orderId],
    );
    const over: any[] = [];
    const notOrdered: any[] = [];
    for (const l of ctx.lines) {
      const ol = orderLines.find((x) => x.id === l.extra?.orderLineId);
      if (!ol) {
        if (!l.extra?.notOrderedAction) notOrdered.push({ line: l.lineNo, productId: l.productId, message: `Строка ${l.lineNo}: товар не заказан — принять или принять и вернуть` });
        continue;
      }
      const left = ol.qty.minus(D(other.find((o: any) => o.line === ol.id)?.q ?? 0));
      if (l.qty.gt(left)) over.push({ line: l.lineNo, productId: l.productId, ordered: left.toFixed(), received: l.qty.toFixed(), excess: l.qty.minus(left).toFixed(), l, left });
    }
    if (notOrdered.length) throw Errors.conflict('NOT_ORDERED', 'В приёмке есть незаказанные строки', notOrdered);
    if (!over.length) return;
    const mode = ctx.doc.extra?.overMode;
    if (!mode) {
      throw Errors.conflict('OVER_RECEIVED', 'Пришло больше заказанного: принять всё (лишнее — в долг поставщику) или по заказу (излишек — в акт расхождения)', over.map(({ l: _l, left: _left, ...x }) => x));
    }
    if (mode === 'by_order') {
      const discrepancies: any[] = [];
      for (const o of over) {
        const line: DocumentLine = o.l;
        const factor = D(line.factor);
        line.qty = o.left;
        line.baseQty = o.left.mul(factor);
        line.amount = line.price ? money(line.price.mul(o.left)) : null;
        await tx.query(`UPDATE document_lines SET qty = $3, base_qty = $4, amount = $5 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, line.id, line.qty.toFixed(), line.baseQty.toFixed(), line.amount?.toFixed() ?? null]);
        discrepancies.push({ productId: line.productId, lineNo: line.lineNo, excess: o.excess, kind: 'excess' });
      }
      ctx.doc.extra = { ...ctx.doc.extra, discrepancies };
      const total = ctx.lines.reduce((a, l) => a.plus(l.amount ?? 0), D(0));
      ctx.doc.totalAmount = money(total);
      await tx.query(`UPDATE documents SET total_amount = $3, extra = $4 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, ctx.doc.id, ctx.doc.totalAmount.toFixed(), JSON.stringify(ctx.doc.extra)]);
    }
  }

  private async receivingAfterPost(ctx: PostingContext) {
    const { tx, doc } = ctx;
    // Долг поставщику — в валюте документа (ТЗ 10.7). «Ожидает цен» — долг появится после ввода цен.
    const amount = ctx.lines.reduce((a, l) => a.plus(l.amount ?? 0), D(0));
    if (doc.counterpartyId && amount.gt(0)) {
      const sup = await tx.repo(Counterparty).findById(doc.counterpartyId);
      await this.debts.open(tx, {
        counterpartyId: doc.counterpartyId,
        direction: 'payable',
        kind: 'purchase',
        currency: doc.currency,
        amount,
        documentId: doc.id,
        description: `Приёмка ${doc.number}${doc.extra?.supplierInvoiceNumber ? `, накладная ${doc.extra.supplierInvoiceNumber}` : ''}`,
        dueDays: sup?.supplierTerms?.paymentDelayDays ?? null,
        storeId: doc.storeId,
        openedAt: doc.docDate,
      });
    }
    // Последняя цена у поставщика
    if (doc.counterpartyId) {
      for (const l of ctx.lines) {
        if (l.price === null || l.price === undefined) continue;
        const perBase = unitCost(D(l.price).div(l.factor));
        await tx.query(
          `INSERT INTO supplier_products (tenant_id, created_by, supplier_id, product_id, last_price, last_currency, last_purchase_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, supplier_id, product_id) DO UPDATE SET last_price = EXCLUDED.last_price, last_currency = EXCLUDED.last_currency,
             last_purchase_at = EXCLUDED.last_purchase_at, deleted_at = NULL, updated_at = now()`,
          [tx.tenantId, tx.userId, doc.counterpartyId, l.productId, perBase.toFixed(), doc.currency, doc.docDate],
        );
      }
    }
    const orderId = doc.extra?.purchaseOrderId;
    if (orderId) {
      await this.orders.recalcReceived(tx, orderId);
      await this.markRequestsArrived(tx, orderId);
    }
    // «Принять и вернуть» и брак с возвратом — черновик возврата поставщику
    const back = ctx.lines.filter((l) => l.extra?.notOrderedAction === 'accept_return' || (l.extra?.defect && l.extra?.defectAction === 'return'));
    if (back.length && !doc.extra?.autoReturnId) {
      const ret = await this.docs.createInTx(
        tx,
        {
          type: 'supplier_return',
          warehouseId: doc.warehouseId ?? undefined,
          counterpartyId: doc.counterpartyId ?? undefined,
          currency: doc.currency,
          rate: doc.rate.toFixed(),
          baseDocumentId: doc.id,
          comment: `Возврат по приёмке ${doc.number}: ${back.some((l) => l.extra?.defect) ? 'брак' : 'не заказано'}`,
          extra: { returnReason: back.some((l) => l.extra?.defect) ? 'defect' : 'not_ordered' },
          lines: back.map((l) => ({ productId: l.productId, unitId: l.unitId, qty: l.qty.toFixed(), price: l.price?.toFixed() ?? undefined, warehouseId: l.extra?.warehouseId, serialItemIds: l.serialItemIds.length ? l.serialItemIds : undefined })),
        } as any,
        { system: true },
      );
      doc.extra = { ...doc.extra, autoReturnId: ret.id };
      await tx.query(`UPDATE documents SET extra = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, doc.id, JSON.stringify(doc.extra)]);
      await tx.query(`INSERT INTO document_links (tenant_id, from_id, to_id, kind, created_by) VALUES ($1, $2, $3, 'result', $4) ON CONFLICT DO NOTHING`, [tx.tenantId, doc.id, ret.id, tx.userId]);
    }
  }

  private async receivingAfterUnpost(ctx: PostingContext, forRepost: boolean) {
    const { tx, doc } = ctx;
    await this.debts.cancelForDocument(tx, doc.id, ['purchase']);
    if (doc.extra?.purchaseOrderId && !forRepost) await this.orders.recalcReceived(tx, doc.extra.purchaseOrderId);
  }

  /** Строки заказа из заявок клиента пришли полностью → заявка «привезли», продавцу уведомление. */
  private async markRequestsArrived(tx: TenantTx, orderId: string) {
    const lines = await tx.query(
      `SELECT l.request_item_id FROM purchase_order_lines l WHERE l.tenant_id = $1 AND l.order_id = $2 AND l.request_item_id IS NOT NULL AND l.received_qty >= l.qty`,
      [tx.tenantId, orderId],
    );
    if (!lines.length) return;
    const ids = lines.map((l: any) => l.request_item_id);
    await tx.query(`UPDATE customer_request_items SET arrived_at = coalesce(arrived_at, now()) WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tx.tenantId, ids]);
    const reqs = await tx.query(
      `SELECT DISTINCT r.id FROM customer_requests r JOIN customer_request_items i ON i.request_id = r.id
        WHERE r.tenant_id = $1 AND i.id = ANY($2::uuid[]) AND r.status IN ('ordered', 'offered', 'selecting', 'new')`,
      [tx.tenantId, ids],
    );
    for (const { id } of reqs) {
      const [{ waiting }] = await tx.query(
        `SELECT count(*)::int AS waiting FROM customer_request_items WHERE tenant_id = $1 AND request_id = $2 AND purchase_order_line_id IS NOT NULL AND arrived_at IS NULL`,
        [tx.tenantId, id],
      );
      if (waiting) continue;
      const r = (await tx.repo(CustomerRequest).findById(id))!;
      r.status = 'arrived';
      r.history = [...r.history, { at: new Date().toISOString(), status: 'arrived', by: null, note: 'Пришло по заказу поставщику' }];
      await tx.repo(CustomerRequest).save(r);
      const items = await tx.repo(CustomerRequestItem).find({ where: { requestId: id } });
      await this.notifications.notify(tx, {
        type: 'request.arrived',
        title: `Заявка ${r.number}: пришло — ${items.map((i) => i.name).join(', ').slice(0, 150)}`,
        entityType: 'customer_request',
        entityId: r.id,
        storeId: r.storeId,
        permission: 'requests.write',
        link: `/requests/${r.id}`,
      });
    }
  }

  // ── Возврат поставщику ───────────────────────────────────

  /** Возврат уменьшает долг перед поставщиком: встречная позиция сразу гасит его долги (ТЗ 10.9). */
  private async supplierReturnAfterPost(ctx: PostingContext) {
    const { tx, doc } = ctx;
    const amount = ctx.lines.reduce((a, l) => a.plus(l.amount ?? 0), D(0));
    if (!doc.counterpartyId || amount.lte(0)) return;
    await this.debts.open(tx, {
      counterpartyId: doc.counterpartyId,
      direction: 'receivable',
      kind: 'purchase_return',
      currency: doc.currency,
      amount,
      documentId: doc.id,
      description: `Возврат поставщику ${doc.number}`,
      storeId: doc.storeId,
      offsetAll: true,
    });
  }

  // ── Доп. расходы ─────────────────────────────────────────

  private async extraCostsAfterPost(ctx: PostingContext) {
    const { tx, doc } = ctx;
    const amount = D(doc.extra?.amount ?? 0);
    if (amount.lte(0)) return;
    if (doc.extra?.accountId) {
      const acc = await this.money.account(tx, doc.extra.accountId);
      await this.money.record(tx, { accountId: acc.id, amount: amount.neg(), kind: 'debt_out', documentId: doc.id, counterpartyId: doc.counterpartyId, rate: acc.currency !== 'KGS' ? doc.rate : null, comment: `Доп. расходы ${doc.number}` });
    } else if (doc.counterpartyId) {
      await this.debts.open(tx, { counterpartyId: doc.counterpartyId, direction: 'payable', kind: 'extra_costs', currency: doc.currency, amount, documentId: doc.id, description: `Доп. расходы ${doc.number}`, storeId: doc.storeId });
    }
  }

  private async extraCostsAfterUnpost(ctx: PostingContext) {
    const { tx, doc } = ctx;
    await this.debts.cancelForDocument(tx, doc.id);
    if (doc.extra?.accountId) {
      const amount = D(doc.extra?.amount ?? 0);
      const acc = await this.money.account(tx, doc.extra.accountId);
      await this.money.record(tx, { accountId: acc.id, amount, kind: 'debt_out', documentId: doc.id, rate: acc.currency !== 'KGS' ? doc.rate : null, comment: `Отмена доп. расходов ${doc.number}` });
    }
  }
}
