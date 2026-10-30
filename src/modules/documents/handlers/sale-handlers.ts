import { Injectable } from '@nestjs/common';
import { Errors } from '../../../common/errors/app.exception';
import { D, Decimal } from '../../../common/utils/decimal';
import { Product } from '../../catalog/entities/product.entity';
import { PlannedMovement } from '../../inventory/stock-ledger.service';
import { DocumentLine } from '../entities/document.entity';
import { PostingContext, PostingHandler, tracksStock } from './handler.types';
import { checkOutgoingSerials, setSerialState } from './stock-handlers';

/** Компонент комплекта в строке чека: количество на 1 базовую единицу комплекта, доля цены, себестоимость (для возврата). */
export interface KitComponentLine {
  productId: string;
  unitId: string;
  qty: string;
  /** Доля суммы строки (распределение цены комплекта, ТЗ 15.2) */
  amount?: string;
  /** Себестоимость за базовую единицу на момент продажи */
  unitCost?: string;
}

/** Строка без движения товара: свободная позиция, «взял у соседа», услуга. */
export const lineMovesStock = (line: DocumentLine, p: Product | undefined) => !line.extra?.free && !line.extra?.neighbor && (p?.kind === 'kit' || tracksStock(p));

async function loadComponents(ctx: PostingContext) {
  const ids = [...new Set(ctx.lines.flatMap((l) => ((l.extra?.kitComponents ?? []) as KitComponentLine[]).map((c) => c.productId)))].filter((id) => !ctx.products.has(id));
  if (ids.length) for (const p of await ctx.tx.repo(Product).findByIds(ids, { withDeleted: true })) ctx.products.set(p.id, p);
}

function linePlans(ctx: PostingContext, warehouseOf: (line: DocumentLine) => string, sign: 1 | -1, costOf?: (line: DocumentLine, productId: string) => Decimal): PlannedMovement[] {
  const plans: PlannedMovement[] = [];
  for (const line of ctx.lines) {
    const p = ctx.products.get(line.productId);
    if (!lineMovesStock(line, p)) continue;
    const wh = warehouseOf(line);
    const kind = sign < 0 ? ('out' as const) : ('in' as const);
    if (p?.kind === 'kit') {
      // Комплект: двигаются компоненты (ТЗ 4.1)
      for (const c of (line.extra?.kitComponents ?? []) as KitComponentLine[]) {
        const cp = ctx.products.get(c.productId);
        if (!tracksStock(cp)) continue;
        plans.push({
          key: `${line.id}:${c.productId}`,
          lineId: line.id,
          lineNo: line.lineNo,
          warehouseId: wh,
          productId: c.productId,
          unitId: c.unitId,
          kind,
          qty: D(c.qty).mul(line.baseQty).mul(sign),
          unitCost: sign > 0 ? costOf?.(line, c.productId) : undefined,
        });
      }
      continue;
    }
    if (line.serialItemIds.length) {
      line.serialItemIds.forEach((sid, i) =>
        plans.push({ key: `${line.id}:${i}`, lineId: line.id, lineNo: line.lineNo, warehouseId: wh, productId: line.productId, unitId: line.unitId, serialItemId: sid, kind, qty: D(sign), unitCost: sign > 0 ? costOf?.(line, line.productId) : undefined }),
      );
    } else {
      plans.push({ key: line.id, lineId: line.id, lineNo: line.lineNo, warehouseId: wh, productId: line.productId, unitId: line.unitId, kind, qty: line.baseQty.mul(sign), unitCost: sign > 0 ? costOf?.(line, line.productId) : undefined });
    }
  }
  return plans;
}

/** Продажа (чек): товар уходит со склада кассы. Отмена — только возвратом. */
@Injectable()
export class SaleHandler implements PostingHandler {
  type = 'sale' as const;

  async beforePost(ctx: PostingContext) {
    if (!ctx.doc.warehouseId) throw Errors.bad('WAREHOUSE_REQUIRED', 'У кассы не указан склад');
    if (!ctx.lines.length) throw Errors.bad('NO_LINES', 'В чеке нет позиций');
    await loadComponents(ctx);
    const serialLines = ctx.lines.filter((l) => ctx.products.get(l.productId)?.isSerial && !l.extra?.neighbor && !l.extra?.free);
    // Офлайн-чек уже продан на кассе: экземпляр не проверяем строго — принимаем с пометкой (ТЗ 16.4)
    if (serialLines.length && !ctx.doc.extra?.offline) await checkOutgoingSerials({ ...ctx, lines: serialLines }, ctx.doc.warehouseId);
  }

  async plan(ctx: PostingContext) {
    await loadComponents(ctx);
    return linePlans(ctx, () => ctx.doc.warehouseId!, -1);
  }

  async afterPost(ctx: PostingContext) {
    await setSerialState(ctx.tx, ctx.lines, 'sold', null);
  }

  async beforeUnpost(ctx: PostingContext) {
    if (!ctx.doc.extra?.allowUnpost) throw Errors.conflict('USE_RETURN', 'Проданный чек не отменяется — оформите возврат');
  }

  async afterUnpost(ctx: PostingContext) {
    await setSerialState(ctx.tx, ctx.lines, 'in_stock', ctx.doc.warehouseId);
  }
}

/**
 * Возврат покупателя: товар приходит по себестоимости исходной продажи (ТЗ 15.2) на склад продаж
 * или на склад «Брак» (extra.warehouseId строки).
 */
@Injectable()
export class SaleReturnHandler implements PostingHandler {
  type = 'sale_return' as const;

  async beforePost(ctx: PostingContext) {
    if (!ctx.doc.warehouseId) throw Errors.bad('WAREHOUSE_REQUIRED', 'Не указан склад возврата');
    if (!ctx.lines.length) throw Errors.bad('NO_LINES', 'Нет позиций возврата');
    await loadComponents(ctx);
  }

  async plan(ctx: PostingContext) {
    await loadComponents(ctx);
    return linePlans(
      ctx,
      (l) => l.extra?.warehouseId ?? ctx.doc.warehouseId!,
      1,
      (l, productId) => {
        if (productId !== l.productId) {
          const c = ((l.extra?.kitComponents ?? []) as KitComponentLine[]).find((x) => x.productId === productId);
          return D(c?.unitCost ?? 0);
        }
        return D(l.extra?.unitCost ?? 0);
      },
    );
  }

  async afterPost(ctx: PostingContext) {
    for (const l of ctx.lines) {
      if (!l.serialItemIds.length) continue;
      await setSerialState(ctx.tx, [l], 'in_stock', l.extra?.warehouseId ?? ctx.doc.warehouseId);
    }
  }

  async beforeUnpost() {
    throw Errors.conflict('RETURN_FINAL', 'Возврат не отменяется — оформите продажу');
  }
}
