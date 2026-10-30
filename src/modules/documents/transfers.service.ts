import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { D } from '../../common/utils/decimal';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { SettingsService } from '../settings/settings.service';
import { DocumentsService } from './documents.service';
import { DocumentLink } from './entities/document.entity';
import { TransferHandler, transitWarehouse } from './handlers/stock-handlers';

/**
 * Перемещение в два этапа (ТЗ 9.3): отправлено (в пути) → принято на складе-получателе.
 * Недостача при приёмке — автоматическое списание с транзита («акт расхождения»).
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly docs: DocumentsService,
    private readonly handler: TransferHandler,
    private readonly ledger: StockLedgerService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async accept(id: string, version: number, lines?: { lineId: string; qty: string }[]) {
    return this.tenantTx.run(async (tx) => {
      const doc = await this.docs.lockDoc(tx, id, version);
      if (doc.type !== 'transfer') throw Errors.bad('NOT_TRANSFER', 'Это не перемещение');
      if (doc.status !== 'posted' || doc.extra?.transferState !== 'in_transit') throw Errors.conflict('NOT_IN_TRANSIT', 'Перемещение не в пути');
      await this.scope.assertWarehouse(tx, doc.warehouseToId!);
      const ctx = await this.docs.context(tx, doc);

      const accepted: Record<string, string> = {};
      const shortages: { lineId: string; productId: string; unitId: string; qty: string; serialItemIds: string[] }[] = [];
      for (const l of ctx.lines) {
        const given = lines?.find((x) => x.lineId === l.id);
        const q = given ? D(given.qty) : l.baseQty;
        if (q.isNegative()) throw Errors.bad('BAD_QTY', `Строка ${l.lineNo}: отрицательное количество`);
        if (q.gt(l.baseQty)) throw Errors.bad('ACCEPT_TOO_MUCH', `Строка ${l.lineNo}: принято больше, чем отправлено (${l.baseQty})`);
        if (l.serialItemIds.length && !q.isInteger()) throw Errors.bad('BAD_QTY', `Строка ${l.lineNo}: серийный товар — целое количество`);
        accepted[l.id] = q.toFixed();
        const short = l.baseQty.minus(q);
        if (short.gt(0)) {
          shortages.push({ lineId: l.id, productId: l.productId, unitId: l.unitId, qty: short.toFixed(), serialItemIds: l.serialItemIds.slice(Number(q)) });
        }
      }

      const plans = await this.handler.acceptPlansFor(ctx, accepted);
      const res = await this.ledger.apply(tx, doc.id, new Date(), plans);
      if (res.negatives.length) throw Errors.conflict('STOCK_NOT_ENOUGH', 'В транзите нет отправленного товара', res.negatives);
      await tx.query(
        `UPDATE serial_items SET status = 'in_stock', warehouse_id = $3, version = version + 1
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tx.tenantId, ctx.lines.flatMap((l) => l.serialItemIds.slice(0, Number(accepted[l.id]))), doc.warehouseToId],
      );

      doc.extra = { ...doc.extra, transferState: 'received', accepted, receivedAt: new Date().toISOString(), receivedBy: tx.userId };
      await tx.query(`UPDATE documents SET extra = $3, version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [
        tx.tenantId,
        doc.id,
        JSON.stringify(doc.extra),
      ]);

      // Недостача — акт расхождения: списание с транзита
      if (shortages.length) {
        const transit = await transitWarehouse(tx);
        const act = await this.docs.createInTx(
          tx,
          {
            type: 'writeoff',
            warehouseId: transit.id,
            comment: `Расхождение при приёмке ${doc.number}`,
            extra: { reason: 'transfer_shortage' },
            lines: shortages.map((s) => ({ productId: s.productId, qty: s.qty, serialItemIds: s.serialItemIds.length ? s.serialItemIds : undefined })),
          },
          { system: true },
        );
        await tx.query(`UPDATE serial_items SET status = 'in_stock', warehouse_id = $3 WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [
          tx.tenantId,
          shortages.flatMap((s) => s.serialItemIds),
          transit.id,
        ]);
        await this.docs.postInTx(tx, act, { system: true });
        await tx.repo(DocumentLink).insert({ fromId: doc.id, toId: act.id, kind: 'discrepancy' });
      }
      await this.audit.log(tx, {
        action: 'transfer.accept',
        entityType: 'document',
        entityId: doc.id,
        storeId: doc.storeId,
        summary: `Принято перемещение ${doc.number}${shortages.length ? ', с расхождением' : ''}`,
        important: shortages.length > 0,
      });
      return this.docs.viewInTx(tx, doc.id);
    });
  }

  /** «Зависшие перемещения»: в пути дольше N дней (ТЗ 9.3). */
  async stale() {
    return this.tenantTx.run(async (tx) => {
      const s = await this.settings.get(tx);
      const rows = await tx.query(
        `SELECT d.id, d.number, d.doc_date AS "docDate", d.warehouse_id AS "warehouseId", d.warehouse_to_id AS "warehouseToId",
                w.name AS "fromName", wt.name AS "toName", d.total_qty AS "totalQty",
                extract(day FROM now() - d.doc_date)::int AS days
           FROM documents d JOIN warehouses w ON w.id = d.warehouse_id JOIN warehouses wt ON wt.id = d.warehouse_to_id
          WHERE d.tenant_id = $1 AND d.type = 'transfer' AND d.status = 'posted' AND d.deleted_at IS NULL
            AND d.extra->>'transferState' = 'in_transit' AND d.doc_date < now() - ($2 || ' days')::interval
          ORDER BY d.doc_date`,
        [tx.tenantId, String(s.transferStaleDays)],
      );
      const allowed = await this.scope.warehouseIds(tx);
      return allowed === null ? rows : rows.filter((r: any) => allowed.includes(r.warehouseId) || allowed.includes(r.warehouseToId));
    });
  }
}
