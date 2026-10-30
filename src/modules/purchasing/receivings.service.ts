import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { distribute } from '../../common/pricing-engine/engine';
import { D, money } from '../../common/utils/decimal';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { ScopeService } from '../auth/scope.service';
import { Counterparty } from '../counterparties/entities/counterparty.entity';
import { DocumentsService } from '../documents/documents.service';
import { Document, DocumentLine } from '../documents/entities/document.entity';
import { WarrantyClaim } from '../pos/entities/receipt.entity';
import { SerialItem } from '../inventory/entities/stock.entity';

export interface ExtraCostsInput {
  /** Сумма расходов в валюте документа */
  amount: string;
  currency?: string;
  rate?: string;
  /** sum — пропорционально сумме; qty — количеству; weight / volume — по весу / объёму строк; manual — вручную по строкам */
  method: 'sum' | 'qty' | 'weight' | 'volume' | 'manual';
  /** weight / volume — значение по строке приёмки; manual — сумма по строке (в валюте расходов) */
  values?: Record<string, string>;
  /** Перевозчик (долг ему) или счёт, с которого заплатили */
  counterpartyId?: string | null;
  accountId?: string | null;
  name?: string;
  comment?: string | null;
}

/** Приёмка — полная (ТЗ 10.5–10.7, 10.9): доп. расходы позже, возврат поставщику из гарантии. */
@Injectable()
export class ReceivingsService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly scope: ScopeService,
    private readonly docs: DocumentsService,
  ) {}

  /**
   * «Доставку оплатили через неделю»: документ «Доп. расходы» на основании приёмки — распределение по строкам,
   * себестоимость пересчитывается с даты приёмки (проданное после неё — тоже).
   */
  extraCosts(receivingId: string, dto: ExtraCostsInput) {
    return this.tenantTx.run(async (tx) => {
      const rec = await tx.repo(Document, 'Приёмка').getById(receivingId);
      if (rec.type !== 'receiving' || rec.status !== 'posted') throw Errors.bad('BASE_NOT_POSTED', 'Доп. расходы — на основании проведённой приёмки');
      if (rec.storeId) this.scope.assertStore(rec.storeId);
      const lines = (await tx.repo(DocumentLine).find({ where: { documentId: rec.id }, order: { lineNo: 'ASC' } })).filter((l) => l.baseQty.gt(0));
      const amount = money(dto.amount);
      if (amount.lte(0)) throw Errors.bad('BAD_AMOUNT', 'Сумма расходов больше нуля');
      const currency = dto.currency ?? 'KGS';
      const rate = currency === 'KGS' ? D(1) : D(dto.rate ?? 0);
      if (rate.lte(0)) throw Errors.bad('BAD_RATE', 'Укажите курс расходов');
      if (dto.counterpartyId) await tx.repo(Counterparty, 'Контрагент').getById(dto.counterpartyId);
      if (dto.counterpartyId && dto.accountId) throw Errors.bad('PAY_OR_DEBT', 'Либо долг перевозчику, либо оплата со счёта');
      const kgs = money(amount.mul(rate));
      let weights: string[];
      switch (dto.method) {
        case 'sum':
          weights = lines.map((l) => D(l.amount ?? 0).mul(rec.rate).toFixed(2));
          break;
        case 'qty':
          weights = lines.map((l) => l.baseQty.toFixed());
          break;
        case 'weight':
        case 'volume':
          weights = lines.map((l) => {
            const v = dto.values?.[l.id];
            if (!v) throw Errors.bad('VALUES_REQUIRED', `Укажите ${dto.method === 'weight' ? 'вес' : 'объём'} для каждой строки`);
            return D(v).mul(l.baseQty).toFixed();
          });
          break;
        case 'manual': {
          const sum = lines.reduce((a, l) => a.plus(D(dto.values?.[l.id] ?? 0)), D(0));
          if (!money(sum).eq(amount)) throw Errors.bad('MANUAL_MISMATCH', `Сумма по строкам ${sum.toFixed(2)} ≠ ${amount.toFixed(2)}`);
          weights = lines.map((l) => D(dto.values?.[l.id] ?? 0).toFixed());
          break;
        }
        default:
          throw Errors.bad('BAD_METHOD', 'Неизвестный способ распределения');
      }
      if (weights.every((w) => D(w).isZero())) throw Errors.bad('NOTHING_TO_SPLIT', 'Нечем распределить (нулевые суммы)');
      const shares = distribute(kgs, weights);
      const doc = await this.docs.createInTx(
        tx,
        {
          type: 'extra_costs',
          docDate: rec.docDate.toISOString(),
          warehouseId: rec.warehouseId ?? undefined,
          counterpartyId: dto.counterpartyId ?? undefined,
          currency,
          rate: rate.toFixed(),
          baseDocumentId: rec.id,
          comment: dto.comment ?? `${dto.name ?? 'Доп. расходы'} к приёмке ${rec.number}`,
        } as any,
        { system: true },
      );
      // Строки распределения пишем напрямую: сумма в сомах — на движение «корректировка»
      await tx.repo(DocumentLine).insertMany(
        lines.map((l, i) => ({
          documentId: doc.id,
          lineNo: i + 1,
          productId: l.productId,
          unitId: l.unitId,
          factor: l.factor,
          qty: l.qty,
          baseQty: l.baseQty,
          price: null,
          amount: D(shares[i]),
          extra: { receivingLineId: l.id, registerAmount: shares[i], warehouseId: l.extra?.warehouseId ?? rec.warehouseId, weight: weights[i] },
        })),
      );
      doc.extra = { method: dto.method, amount: amount.toFixed(2), name: dto.name ?? 'Доп. расходы', accountId: dto.accountId ?? null };
      doc.totalAmount = amount;
      await tx.repo(Document).save(doc);
      await this.docs.postInTx(tx, doc, { system: true });
      return this.docs.viewInTx(tx, doc.id);
    });
  }

  /** Гарантийный возврат поставщику — из гарантийного обращения (ТЗ 10.9, 15.3). */
  warrantyReturn(claimId: string, dto: { warehouseId?: string; price?: string }) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(WarrantyClaim, 'Гарантийное обращение').getForUpdate(claimId);
      if (!c.supplierId) throw Errors.bad('SUPPLIER_REQUIRED', 'У обращения не указан поставщик');
      let warehouseId = dto.warehouseId;
      if (!warehouseId && c.serialItemId) warehouseId = (await tx.repo(SerialItem).findById(c.serialItemId))?.warehouseId ?? undefined;
      if (!warehouseId) {
        const [w] = await tx.query(`SELECT id FROM warehouses WHERE tenant_id = $1 AND store_id = $2 AND type = 'defect' AND is_active LIMIT 1`, [tx.tenantId, c.storeId]);
        warehouseId = w?.id;
      }
      if (!warehouseId) throw Errors.bad('WAREHOUSE_REQUIRED', 'Укажите склад, где лежит деталь');
      const [last] = await tx.query(
        `SELECT l.price, d.currency, d.rate FROM document_lines l JOIN documents d ON d.id = l.document_id
          WHERE l.tenant_id = $1 AND l.product_id = $2 AND d.type = 'receiving' AND d.status = 'posted' AND d.counterparty_id = $3 AND l.price IS NOT NULL
          ORDER BY d.doc_date DESC LIMIT 1`,
        [tx.tenantId, c.productId, c.supplierId],
      );
      const price = dto.price ?? last?.price;
      if (!price) throw Errors.bad('PRICE_REQUIRED', 'Укажите цену возврата');
      const doc = await this.docs.createInTx(tx, {
        type: 'supplier_return',
        warehouseId,
        counterpartyId: c.supplierId,
        currency: last?.currency ?? 'KGS',
        rate: last?.rate ? D(last.rate).toFixed() : undefined,
        comment: `Гарантия ${c.number}`,
        extra: { returnReason: 'warranty', warrantyClaimId: c.id },
        lines: [{ productId: c.productId, qty: c.qty.toFixed(), price: D(price).toFixed(), serialItemIds: c.serialItemId ? [c.serialItemId] : undefined }],
      } as any);
      c.status = 'sent_to_supplier';
      c.history = [...c.history, { at: new Date().toISOString(), status: 'sent_to_supplier', by: null, note: `Возврат поставщику ${doc.number}` }];
      await tx.repo(WarrantyClaim).save(c);
      return this.docs.viewInTx(tx, doc.id);
    });
  }
}
