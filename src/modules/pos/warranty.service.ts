import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { dayjs } from '../../common/utils/dates';
import { D, money } from '../../common/utils/decimal';
import { CountersService } from '../../database/tenant/counters.service';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { Product } from '../catalog/entities/product.entity';
import { Counterparty } from '../counterparties/entities/counterparty.entity';
import { Document, DocumentLine } from '../documents/entities/document.entity';
import { SerialItem } from '../inventory/entities/stock.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Receipt, WarrantyClaim, WarrantyDecision, WarrantyStatus } from './entities/receipt.entity';
import { ReceiptsService } from './receipts.service';
import { ReturnsService } from './returns.service';

/** Гарантийные обращения (ТЗ 15.3): приём → проверка или поставщику → решение (замена, возврат денег, отказ). */
@Injectable()
export class WarrantyService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly receipts: ReceiptsService,
    private readonly returns: ReturnsService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  list(q: { status?: string; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const w = ['w.tenant_id = $1', 'w.deleted_at IS NULL'];
      if (q.status) {
        params.push(q.status);
        w.push(`w.status = $${params.length}`);
      }
      const allowed = this.scope.storeIds();
      if (allowed) {
        params.push(allowed);
        w.push(`(w.store_id IS NULL OR w.store_id = ANY($${params.length}::uuid[]))`);
      }
      const where = w.join(' AND ');
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM warranty_claims w WHERE ${where}`, params);
      const items = await tx.query(
        `SELECT w.id, w.number, w.status, w.decision, w.in_warranty AS "inWarranty", w.created_at AS "createdAt", w.product_id AS "productId", p.name AS "productName",
                b.name AS "brandName", c.name AS "customerName", s.name AS "supplierName", w.version
           FROM warranty_claims w JOIN products p ON p.id = w.product_id LEFT JOIN brands b ON b.id = p.brand_id
           LEFT JOIN counterparties c ON c.id = w.customer_id LEFT JOIN counterparties s ON s.id = w.supplier_id
          WHERE ${where} ORDER BY w.created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total };
    });
  }

  get(id: string) {
    return this.tenantTx.run((tx) => tx.repo(WarrantyClaim, 'Гарантийное обращение').getById(id));
  }

  /** Приём детали от клиента. Срок гарантии — из правил позиции на момент продажи. */
  create(dto: { saleReceiptId?: string; saleLineId?: string; productId?: string; serialItemId?: string; customerId?: string; qty?: string; complaint: string; photoFileIds?: string[] }) {
    return this.tenantTx.run(async (tx) => {
      let productId = dto.productId ?? null;
      let customerId = dto.customerId ?? null;
      let inWarranty = true;
      let storeId = this.scope.currentStoreId() ?? null;
      let sale: Receipt | null = null;
      if (dto.saleReceiptId) {
        sale = await tx.repo(Receipt, 'Чек').getById(dto.saleReceiptId);
        if (sale.kind !== 'sale' || sale.status !== 'completed') throw Errors.bad('NOT_SALE', 'Это не чек продажи');
        const line = await tx.repo(DocumentLine, 'Позиция').getById(dto.saleLineId ?? '');
        if (line.documentId !== sale.documentId) throw Errors.bad('LINE_NOT_IN_RECEIPT', 'Позиция не из этого чека');
        productId = line.productId;
        customerId = customerId ?? sale.customerId;
        storeId = sale.storeId;
        const days = line.extra?.rules?.warrantyDays;
        inWarranty = days === null || days === undefined ? false : dayjs().diff(dayjs(sale.completedAt!), 'day') <= days;
        if (dto.serialItemId && !line.serialItemIds.includes(dto.serialItemId)) throw Errors.bad('SERIAL_NOT_IN_LINE', 'Экземпляр не из этой продажи');
      }
      if (!productId) throw Errors.bad('PRODUCT_REQUIRED', 'Укажите продажу или товар');
      await tx.repo(Product, 'Товар').getById(productId);
      const supplierId = await this.supplierOf(tx, productId, dto.serialItemId);
      const year = new Date().getFullYear();
      const n = await this.counters.next(tx, `warranty:${year}`);
      const claim = await tx.repo(WarrantyClaim).insert({
        number: `ГО-${year}-${String(n).padStart(5, '0')}`,
        status: 'accepted',
        storeId,
        saleReceiptId: sale?.id ?? null,
        saleLineId: dto.saleLineId ?? null,
        productId,
        serialItemId: dto.serialItemId ?? null,
        customerId,
        supplierId,
        qty: D(dto.qty ?? 1),
        complaint: dto.complaint.trim(),
        photoFileIds: dto.photoFileIds ?? [],
        inWarranty,
        history: [{ at: new Date().toISOString(), status: 'accepted', by: this.ctx.membershipId ?? null }],
      });
      await this.audit.log(tx, { action: 'warranty.create', entityType: 'warranty_claim', entityId: claim.id, storeId, summary: `${claim.number}: ${claim.complaint.slice(0, 100)}` });
      await this.notifications.notify(tx, {
        type: 'warranty.new',
        title: `Гарантийное обращение ${claim.number}${inWarranty ? '' : ' (срок гарантии истёк)'}`,
        entityType: 'warranty_claim',
        entityId: claim.id,
        storeId,
        permission: 'sales.warranty',
        excludeUserId: tx.userId,
      });
      return claim;
    });
  }

  /** Поставщик детали: откуда пришёл экземпляр, иначе последняя приёмка товара. */
  private async supplierOf(tx: any, productId: string, serialItemId?: string): Promise<string | null> {
    if (serialItemId) {
      const it = await tx.repo(SerialItem).findById(serialItemId);
      if (it?.sourceDocumentId) {
        const d = await tx.repo(Document).findById(it.sourceDocumentId);
        if (d?.type === 'receiving' && d.counterpartyId) return d.counterpartyId;
      }
    }
    const [r] = await tx.query(
      `SELECT d.counterparty_id FROM documents d JOIN document_lines l ON l.document_id = d.id
        WHERE d.tenant_id = $1 AND d.type = 'receiving' AND d.status = 'posted' AND l.product_id = $2 ORDER BY d.doc_date DESC LIMIT 1`,
      [tx.tenantId, productId],
    );
    return r?.counterparty_id ?? null;
  }

  setStatus(id: string, version: number, dto: { status: Exclude<WarrantyStatus, 'decided'>; supplierId?: string; note?: string }) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(WarrantyClaim, 'Гарантийное обращение').getForUpdate(id, version);
      if (c.status === 'decided') throw Errors.conflict('CLAIM_DECIDED', 'По обращению уже принято решение');
      if (dto.supplierId) {
        const s = await tx.repo(Counterparty, 'Поставщик').getById(dto.supplierId);
        c.supplierId = s.id;
      }
      c.status = dto.status;
      c.history = [...c.history, { at: new Date().toISOString(), status: dto.status, by: this.ctx.membershipId ?? null, note: dto.note }];
      return tx.repo(WarrantyClaim).save(c);
    });
  }

  /**
   * Решение: refund — возврат денег (товар на «Брак»); replace — возврат + выдача такого же товара без доплаты;
   * reject — отказ с причиной.
   */
  decide(id: string, version: number, dto: { decision: WarrantyDecision; reason?: string; registerId?: string; replacementProductId?: string; serialItemIds?: string[]; pin?: string }) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(WarrantyClaim, 'Гарантийное обращение').getForUpdate(id, version);
      if (c.status === 'decided') throw Errors.conflict('CLAIM_DECIDED', 'По обращению уже принято решение');
      if (dto.decision === 'reject') {
        if (!dto.reason?.trim()) throw Errors.bad('REASON_REQUIRED', 'Укажите причину отказа');
      } else {
        if (!c.saleReceiptId || !c.saleLineId) throw Errors.bad('SALE_REQUIRED', 'Замена и возврат денег — только по продаже');
        if (!dto.registerId) throw Errors.bad('REGISTER_REQUIRED', 'Укажите кассу');
        const ret = await this.returns.createInTx(
          tx,
          {
            registerId: dto.registerId,
            saleReceiptId: c.saleReceiptId,
            lines: [{ saleLineId: c.saleLineId, qty: c.qty.toFixed(3), reason: 'warranty', condition: 'defect', serialItemIds: c.serialItemId ? [c.serialItemId] : undefined }],
            refundMode: dto.decision === 'replace' ? 'credit' : 'same',
            pin: dto.pin,
          },
          { system: true, skipPeriodCheck: true },
        );
        c.returnReceiptId = ret.id;
        if (dto.decision === 'replace') {
          // Выдаём такую же (или выбранную) деталь по цене возврата — без доплаты
          const line = await tx.repo(DocumentLine).getById(c.saleLineId);
          const sale = await tx.repo(Receipt).getById(c.saleReceiptId);
          const unitPrice = money(ret.total.div(c.qty));
          const repl = await this.receipts.createInTx(
            tx,
            {
              registerId: dto.registerId,
              customerId: sale.customerId,
              customerVehicleId: sale.customerVehicleId,
              lines: [{ productId: dto.replacementProductId ?? line.productId, unitId: dto.replacementProductId ? undefined : line.unitId, qty: c.qty.toFixed(3), price: unitPrice.toFixed(2), serialItemIds: dto.serialItemIds }],
            },
            { system: true },
          );
          const doc = await tx.repo(Document).getById(repl.documentId);
          await this.receipts.payInTx(tx, repl, doc, { payments: [{ method: 'return_credit', amount: repl.total.toFixed(2), sourceReceiptId: ret.id }] }, { system: true });
          c.replacementReceiptId = repl.id;
        }
      }
      c.status = 'decided';
      c.decision = dto.decision;
      c.decisionReason = dto.reason ?? null;
      c.decidedAt = new Date();
      c.decidedBy = this.ctx.membershipId ?? null;
      c.history = [...c.history, { at: new Date().toISOString(), status: 'decided', by: this.ctx.membershipId ?? null, note: `${DECISIONS[dto.decision]}${dto.reason ? `: ${dto.reason}` : ''}` }];
      const saved = await tx.repo(WarrantyClaim).save(c);
      await this.audit.log(tx, { action: 'warranty.decide', entityType: 'warranty_claim', entityId: c.id, summary: `${c.number}: ${DECISIONS[dto.decision]}`, important: true });
      return saved;
    });
  }

  /** Отчёт «Гарантийные обращения» по брендам и поставщикам. */
  report(q: { from?: string; to?: string }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId, q.from ?? '1970-01-01', q.to ?? '2999-01-01'];
      const base = `FROM warranty_claims w JOIN products p ON p.id = w.product_id LEFT JOIN brands b ON b.id = p.brand_id
                    LEFT JOIN counterparties s ON s.id = w.supplier_id
                   WHERE w.tenant_id = $1 AND w.deleted_at IS NULL AND w.created_at >= $2 AND w.created_at < $3`;
      const agg = `count(*)::int AS total, count(*) FILTER (WHERE w.decision = 'replace')::int AS replaced,
                   count(*) FILTER (WHERE w.decision = 'refund')::int AS refunded, count(*) FILTER (WHERE w.decision = 'reject')::int AS rejected,
                   count(*) FILTER (WHERE w.status <> 'decided')::int AS open`;
      const byBrand = await tx.query(`SELECT coalesce(b.name, 'Без бренда') AS brand, ${agg} ${base} GROUP BY 1 ORDER BY 2 DESC`, params);
      const bySupplier = await tx.query(`SELECT coalesce(s.name, 'Неизвестен') AS supplier, s.id AS "supplierId", ${agg} ${base} GROUP BY 1, 2 ORDER BY 3 DESC`, params);
      return { byBrand, bySupplier };
    });
  }
}

const DECISIONS: Record<WarrantyDecision, string> = { replace: 'Замена', refund: 'Возврат денег', reject: 'Отказ' };
