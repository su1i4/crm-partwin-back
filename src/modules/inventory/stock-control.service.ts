import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { Product } from '../catalog/entities/product.entity';
import { SearchTextService } from '../catalog/search-text.service';
import { DocumentsService } from '../documents/documents.service';

/** Снятие флага «без контроля остатка» — через ввод фактического остатка (ТЗ 4.7). */
@Injectable()
export class StockControlService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly docs: DocumentsService,
    private readonly audit: AuditService,
    private readonly searchText: SearchTextService,
  ) {}

  async enable(productId: string, items: { warehouseId: string; qty: string; unitCost?: string; place?: string }[]) {
    return this.tenantTx.run(async (tx) => {
      const p = await tx.repo(Product, 'Товар').getById(productId, { lock: { mode: 'pessimistic_write' } } as any);
      if (!p.noStockControl) throw Errors.conflict('ALREADY_CONTROLLED', 'Остаток товара уже ведётся');
      if (p.kind !== 'goods') throw Errors.bad('NOT_GOODS', 'У услуг и комплектов нет остатка');
      if (p.isSerial) throw Errors.bad('SERIAL', 'Серийный товар — оприходуйте экземпляры документом');
      await tx.query(`UPDATE products SET no_stock_control = false, version = version + 1 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, p.id]);
      const docIds: string[] = [];
      for (const it of items.filter((i) => Number(i.qty) > 0)) {
        const doc = await this.docs.createInTx(tx, {
          type: 'initial_stock',
          warehouseId: it.warehouseId,
          comment: `Ввод фактического остатка «${p.name}» (включён учёт остатка)`,
          lines: [{ productId: p.id, qty: it.qty, price: it.unitCost ?? undefined, place: it.place }],
        });
        await this.docs.postInTx(tx, doc);
        docIds.push(doc.id);
      }
      await this.audit.log(tx, { action: 'product.stock_control_on', entityType: 'product', entityId: p.id, after: { documents: docIds }, important: true });
      await this.searchText.rebuild(tx, [p.id]);
      return { productId: p.id, documents: docIds };
    });
  }
}
