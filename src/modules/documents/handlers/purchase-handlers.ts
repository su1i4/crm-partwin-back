import { Injectable } from '@nestjs/common';
import { Errors } from '../../../common/errors/app.exception';
import { D } from '../../../common/utils/decimal';
import { PlannedMovement } from '../../inventory/stock-ledger.service';
import { Counterparty } from '../../counterparties/entities/counterparty.entity';
import { Document, DocumentLine } from '../entities/document.entity';
import { PostingContext, PostingHandler, tracksStock } from './handler.types';
import { checkOutgoingSerials, setSerialState } from './stock-handlers';

const lineWarehouse = (ctx: PostingContext, l: DocumentLine) => l.extra?.warehouseId ?? ctx.doc.warehouseId!;

/**
 * Возврат поставщику (ТЗ 10.9): товар уходит со склада (часто — со склада «Брак»), долг перед поставщиком
 * уменьшается (это делает хук закупок). Серийные — выбранные экземпляры.
 */
@Injectable()
export class SupplierReturnHandler implements PostingHandler {
  type = 'supplier_return' as const;

  async validateHeader(ctx: PostingContext) {
    if (!ctx.doc.warehouseId) throw Errors.bad('WAREHOUSE_REQUIRED', 'Укажите склад');
    if (ctx.doc.counterpartyId) await ctx.tx.repo(Counterparty, 'Поставщик').getById(ctx.doc.counterpartyId);
  }

  async beforePost(ctx: PostingContext) {
    await this.validateHeader(ctx);
    if (!ctx.doc.counterpartyId) throw Errors.bad('SUPPLIER_REQUIRED', 'Укажите поставщика');
    if (!ctx.lines.length) throw Errors.bad('NO_LINES', 'В документе нет строк');
    const noPrice = ctx.lines.filter((l) => l.price === null || l.price === undefined);
    if (noPrice.length) throw Errors.bad('PRICE_REQUIRED', 'Укажите цену возврата', noPrice.map((l) => ({ line: l.lineNo, message: `Строка ${l.lineNo}: нет цены` })));
    const byWh = new Map<string, DocumentLine[]>();
    for (const l of ctx.lines) if (ctx.products.get(l.productId)?.isSerial) byWh.set(lineWarehouse(ctx, l), [...(byWh.get(lineWarehouse(ctx, l)) ?? []), l]);
    for (const [wh, lines] of byWh) await checkOutgoingSerials({ ...ctx, lines }, wh);
  }

  async plan(ctx: PostingContext): Promise<PlannedMovement[]> {
    const plans: PlannedMovement[] = [];
    for (const line of ctx.lines) {
      if (!tracksStock(ctx.products.get(line.productId))) continue;
      const wh = lineWarehouse(ctx, line);
      if (line.serialItemIds.length) {
        line.serialItemIds.forEach((sid, i) =>
          plans.push({ key: `${line.id}:${i}`, lineId: line.id, lineNo: line.lineNo, warehouseId: wh, productId: line.productId, unitId: line.unitId, serialItemId: sid, kind: 'out', qty: D(-1) }),
        );
      } else {
        plans.push({ key: line.id, lineId: line.id, lineNo: line.lineNo, warehouseId: wh, productId: line.productId, unitId: line.unitId, kind: 'out', qty: line.baseQty.neg() });
      }
    }
    return plans;
  }

  async afterPost(ctx: PostingContext) {
    await setSerialState(ctx.tx, ctx.lines, 'returned', null);
  }

  async afterUnpost(ctx: PostingContext) {
    for (const l of ctx.lines) if (l.serialItemIds.length) await setSerialState(ctx.tx, [l], 'in_stock', lineWarehouse(ctx, l));
  }
}

/**
 * Доп. расходы на основании приёмки (ТЗ 10.6): доставка, карго, таможня распределяются по строкам приёмки
 * и увеличивают себестоимость движениями «корректировка» на дату приёмки — проданное после неё пересчитывается.
 */
@Injectable()
export class ExtraCostsHandler implements PostingHandler {
  type = 'extra_costs' as const;

  async beforePost(ctx: PostingContext) {
    if (!ctx.doc.baseDocumentId) throw Errors.bad('BASE_REQUIRED', 'Доп. расходы — на основании приёмки');
    const base = await ctx.tx.repo(Document, 'Приёмка').getById(ctx.doc.baseDocumentId);
    if (base.type !== 'receiving' || base.status !== 'posted') throw Errors.bad('BASE_NOT_POSTED', 'Приёмка не проведена');
    if (!ctx.lines.length) throw Errors.bad('NO_LINES', 'Нет строк распределения');
  }

  async plan(ctx: PostingContext): Promise<PlannedMovement[]> {
    return ctx.lines
      .filter((l) => tracksStock(ctx.products.get(l.productId)))
      .map((l) => ({
        key: l.id,
        lineId: l.id,
        lineNo: l.lineNo,
        warehouseId: l.extra?.warehouseId ?? ctx.doc.warehouseId!,
        productId: l.productId,
        unitId: l.unitId,
        kind: 'adjustment' as const,
        qty: D(0),
        amount: D(l.extra?.registerAmount ?? 0),
      }));
  }
}
