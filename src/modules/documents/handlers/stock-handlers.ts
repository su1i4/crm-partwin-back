import { Injectable } from '@nestjs/common';
import { Errors } from '../../../common/errors/app.exception';
import { D, Decimal, money, unitCost } from '../../../common/utils/decimal';
import { TenantTx } from '../../../database/tenant/tenant-tx';
import { SerialItem } from '../../inventory/entities/stock.entity';
import { PlannedMovement, StockLedgerService } from '../../inventory/stock-ledger.service';
import { Counterparty } from '../../counterparties/entities/counterparty.entity';
import { Warehouse } from '../../stores/entities/warehouse.entity';
import { DocumentLine } from '../entities/document.entity';
import { PostingContext, PostingHandler, tracksStock } from './handler.types';

// ── Общее ─────────────────────────────────────────────────

async function requireWarehouse(tx: TenantTx, id: string | null, label = 'Склад') {
  if (!id) throw Errors.bad('WAREHOUSE_REQUIRED', `Укажите ${label.toLowerCase()}`);
  const wh = await tx.repo(Warehouse, label).getById(id);
  if (!wh.isActive) throw Errors.bad('WAREHOUSE_INACTIVE', `${label} «${wh.name}» отключён`);
  return wh;
}

export function lineError(line: DocumentLine, message: string) {
  return { line: line.lineNo, productId: line.productId, message: `Строка ${line.lineNo}: ${message}` };
}

/** Серийные приходы: строка содержит extra.serials — создаём экземпляры при проведении. */
async function createIncomingSerials(ctx: PostingContext, warehouseId: string) {
  const errors: any[] = [];
  for (const line of ctx.lines) {
    const p = ctx.products.get(line.productId)!;
    if (!p.isSerial) continue;
    if (line.serialItemIds.length) continue; // уже созданы (перепроведение)
    const serials: any[] = line.extra?.serials ?? [];
    if (serials.length !== Number(line.baseQty)) {
      errors.push(lineError(line, `серийный товар — укажите ${line.baseQty} экземпл. (номер, фото, состояние)`));
      continue;
    }
    const ids: string[] = [];
    for (const s of serials) {
      if (!s.serialNumber) {
        errors.push(lineError(line, 'у экземпляра нет серийного номера'));
        break;
      }
      const dup = await ctx.tx.repo(SerialItem).count({ where: { productId: p.id, serialNumber: String(s.serialNumber) } });
      if (dup) {
        errors.push(lineError(line, `экземпляр ${s.serialNumber} уже есть`));
        break;
      }
      const item = await ctx.tx.repo(SerialItem).insert({
        productId: p.id,
        serialNumber: String(s.serialNumber).slice(0, 80),
        inventoryNumber: s.inventoryNumber ?? null,
        condition: s.condition ?? null,
        note: s.note ?? null,
        photoFileIds: Array.isArray(s.photoFileIds) ? s.photoFileIds : [],
        price: s.price ? money(s.price) : null,
        warehouseId: line.extra?.warehouseId ?? warehouseId,
        place: line.place,
        status: 'in_stock',
        sourceDocumentId: ctx.doc.id,
      });
      ids.push(item.id);
    }
    line.serialItemIds = ids;
    await ctx.tx.query(`UPDATE document_lines SET serial_item_ids = $3 WHERE tenant_id = $1 AND id = $2`, [ctx.tx.tenantId, line.id, ids]);
  }
  if (errors.length) throw Errors.bad('LINES_INVALID', 'Проверьте строки документа', errors);
}

/** Отмена серийного прихода: экземпляры должны быть на месте и без других движений. */
async function removeIncomingSerials(ctx: PostingContext, warehouseId: string) {
  for (const line of ctx.lines) {
    if (!line.serialItemIds.length) continue;
    const items = await ctx.tx.repo(SerialItem).findByIds(line.serialItemIds);
    for (const it of items) {
      if (it.status !== 'in_stock' || it.warehouseId !== (line.extra?.warehouseId ?? warehouseId)) {
        throw Errors.conflict('SERIAL_MOVED', `Экземпляр ${it.serialNumber} уже продан или перемещён — отмена невозможна`);
      }
    }
    await ctx.tx.query(`UPDATE serial_items SET deleted_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [ctx.tx.tenantId, line.serialItemIds]);
    line.serialItemIds = [];
    await ctx.tx.query(`UPDATE document_lines SET serial_item_ids = '{}' WHERE tenant_id = $1 AND id = $2`, [ctx.tx.tenantId, line.id]);
  }
}

/** Серийный расход: выбраны конкретные экземпляры, они на этом складе (продажа отсутствующего — запрещена всегда). */
export async function checkOutgoingSerials(ctx: PostingContext, warehouseId: string, allowStatus: string[] = ['in_stock']) {
  const errors: any[] = [];
  for (const line of ctx.lines) {
    const p = ctx.products.get(line.productId)!;
    if (!p.isSerial) continue;
    if (line.serialItemIds.length !== Number(line.baseQty)) {
      errors.push(lineError(line, `выберите ${line.baseQty} экземпл.`));
      continue;
    }
    const items = await ctx.tx.repo(SerialItem).findByIds(line.serialItemIds);
    for (const id of line.serialItemIds) {
      const it = items.find((x) => x.id === id);
      if (!it || it.productId !== p.id) errors.push(lineError(line, 'экземпляр не найден'));
      else if (!allowStatus.includes(it.status) || it.warehouseId !== warehouseId) {
        errors.push(lineError(line, `экземпляра ${it.serialNumber} нет на этом складе`));
      }
    }
  }
  if (errors.length) throw Errors.bad('SERIAL_NOT_AVAILABLE', 'Серийные экземпляры', errors);
}

export async function setSerialState(tx: TenantTx, lines: DocumentLine[], status: string, warehouseId: string | null) {
  const ids = lines.flatMap((l) => l.serialItemIds);
  if (!ids.length) return;
  await tx.query(
    `UPDATE serial_items SET status = $3, warehouse_id = coalesce($4::uuid, warehouse_id), version = version + 1, updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tx.tenantId, ids, status, warehouseId],
  );
}

/** Приходная строка → движения (по экземплярам для серийных). */
function incomingPlans(ctx: PostingContext, warehouseId: string, costOf: (line: DocumentLine) => Decimal): PlannedMovement[] {
  const plans: PlannedMovement[] = [];
  for (const line of ctx.lines) {
    const p = ctx.products.get(line.productId);
    if (!tracksStock(p)) continue;
    const uc = costOf(line);
    // Строка может идти на свой склад (брак → «Брак»)
    const wh = line.extra?.warehouseId ?? warehouseId;
    if (line.serialItemIds.length) {
      line.serialItemIds.forEach((sid, i) =>
        plans.push({ key: `${line.id}:${i}`, lineId: line.id, lineNo: line.lineNo, warehouseId: wh, productId: line.productId, unitId: line.unitId, serialItemId: sid, kind: 'in', qty: D(1), unitCost: uc }),
      );
    } else {
      plans.push({ key: line.id, lineId: line.id, lineNo: line.lineNo, warehouseId: wh, productId: line.productId, unitId: line.unitId, kind: 'in', qty: line.baseQty, unitCost: uc });
    }
  }
  return plans;
}

function outgoingPlans(ctx: PostingContext, warehouseId: string, kind: 'out' | 'transfer_out' = 'out', keyPrefix = ''): PlannedMovement[] {
  const plans: PlannedMovement[] = [];
  for (const line of ctx.lines) {
    const p = ctx.products.get(line.productId);
    if (!tracksStock(p)) continue;
    if (line.serialItemIds.length) {
      line.serialItemIds.forEach((sid, i) =>
        plans.push({ key: `${keyPrefix}${line.id}:${i}`, lineId: line.id, lineNo: line.lineNo, warehouseId, productId: line.productId, unitId: line.unitId, serialItemId: sid, kind, qty: D(-1) }),
      );
    } else {
      plans.push({ key: `${keyPrefix}${line.id}`, lineId: line.id, lineNo: line.lineNo, warehouseId, productId: line.productId, unitId: line.unitId, kind, qty: line.baseQty.neg() });
    }
  }
  return plans;
}

/** Себестоимость строки в сомах за базовую единицу: (сумма × курс + доля доп. расходов) / количество. */
function receiptUnitCost(ctx: PostingContext, line: DocumentLine, extraShare: Decimal): Decimal {
  if (line.price === null || line.price === undefined) return D(0); // «ожидает цен»
  const amountKgs = line.baseQty.isZero() ? D(0) : D(line.price).mul(line.qty).mul(ctx.doc.rate);
  return line.baseQty.isZero() ? D(0) : unitCost(amountKgs.plus(extraShare).div(line.baseQty));
}

/** Простые доп. расходы приёмки: распределяются пропорционально сумме строк (ТЗ 10.6, базово). */
function extraShares(ctx: PostingContext): Map<string, Decimal> {
  const map = new Map<string, Decimal>();
  const costs: { amount: string }[] = ctx.doc.extra?.extraCosts ?? [];
  const total = costs.reduce((a, c) => a.plus(D(c.amount)), D(0)).mul(ctx.doc.extra?.extraCostsCurrency === 'doc' ? ctx.doc.rate : 1);
  if (total.isZero()) return map;
  const tracked = ctx.lines.filter((l) => l.price !== null);
  const sum = tracked.reduce((a, l) => a.plus(D(l.price!).mul(l.qty)), D(0));
  let rest = total;
  tracked.forEach((l, i) => {
    const share = i === tracked.length - 1 ? rest : sum.isZero() ? D(0) : total.mul(D(l.price!).mul(l.qty)).div(sum);
    map.set(l.id, share);
    rest = rest.minus(share);
  });
  return map;
}

// ── Ввод начальных остатков / Оприходование ───────────────

abstract class IncomingHandler implements PostingHandler {
  abstract type: any;
  constructor(protected readonly ledger: StockLedgerService) {}

  async validateHeader(ctx: PostingContext) {
    await requireWarehouse(ctx.tx, ctx.doc.warehouseId);
  }

  async beforePost(ctx: PostingContext) {
    await requireWarehouse(ctx.tx, ctx.doc.warehouseId);
    if (!ctx.lines.length) throw Errors.bad('NO_LINES', 'В документе нет строк');
    await createIncomingSerials(ctx, ctx.doc.warehouseId!);
    // Оприходование без себестоимости — по текущей средней
    for (const l of ctx.lines) {
      if (l.price === null || l.price === undefined) {
        const avg = await this.ledger.currentUnitCost(ctx.tx, l.productId);
        l.price = unitCost(avg.mul(l.factor));
        await ctx.tx.query(`UPDATE document_lines SET price = $3 WHERE tenant_id = $1 AND id = $2`, [ctx.tx.tenantId, l.id, l.price.toFixed()]);
      }
    }
  }

  async plan(ctx: PostingContext) {
    return incomingPlans(ctx, ctx.doc.warehouseId!, (l) => receiptUnitCost(ctx, l, D(0)));
  }

  async afterUnpost(ctx: PostingContext) {
    await removeIncomingSerials(ctx, ctx.doc.warehouseId!);
  }
}

@Injectable()
export class InitialStockHandler extends IncomingHandler {
  type = 'initial_stock' as const;
  constructor(ledger: StockLedgerService) {
    super(ledger);
  }
}

@Injectable()
export class SurplusHandler extends IncomingHandler {
  type = 'surplus' as const;
  constructor(ledger: StockLedgerService) {
    super(ledger);
  }
}

// ── Приёмка (базовая) ─────────────────────────────────────

@Injectable()
export class ReceivingHandler implements PostingHandler {
  type = 'receiving' as const;

  async validateHeader(ctx: PostingContext) {
    await requireWarehouse(ctx.tx, ctx.doc.warehouseId);
    if (ctx.doc.counterpartyId) await ctx.tx.repo(Counterparty, 'Поставщик').getById(ctx.doc.counterpartyId);
    if (ctx.doc.currency !== 'KGS' && D(ctx.doc.rate).lte(0)) throw Errors.bad('BAD_RATE', 'Укажите курс документа');
  }

  async beforePost(ctx: PostingContext) {
    await this.validateHeader(ctx);
    if (!ctx.doc.counterpartyId) throw Errors.bad('SUPPLIER_REQUIRED', 'Укажите поставщика');
    if (!ctx.lines.length) throw Errors.bad('NO_LINES', 'В документе нет строк');
    await createIncomingSerials(ctx, ctx.doc.warehouseId!);
    const pending = ctx.lines.some((l) => l.price === null || l.price === undefined);
    ctx.doc.extra = { ...ctx.doc.extra, pricesPending: pending };
  }

  async plan(ctx: PostingContext) {
    const shares = extraShares(ctx);
    return incomingPlans(ctx, ctx.doc.warehouseId!, (l) => receiptUnitCost(ctx, l, shares.get(l.id) ?? D(0)));
  }

  async afterUnpost(ctx: PostingContext) {
    await removeIncomingSerials(ctx, ctx.doc.warehouseId!);
  }
}

// ── Списание ──────────────────────────────────────────────

export const WRITEOFF_REASONS = {
  defect: 'Брак',
  damage: 'Повреждение',
  shortage: 'Недостача',
  own_needs: 'На нужды магазина',
  scrap: 'В лом',
  transfer_shortage: 'Недостача при перемещении',
  other: 'Другое',
} as const;

@Injectable()
export class WriteoffHandler implements PostingHandler {
  type = 'writeoff' as const;

  async validateHeader(ctx: PostingContext) {
    await requireWarehouse(ctx.tx, ctx.doc.warehouseId);
    const reason = ctx.doc.extra?.reason;
    if (reason && !(reason in WRITEOFF_REASONS)) throw Errors.bad('BAD_REASON', 'Неизвестная причина списания');
  }

  async beforePost(ctx: PostingContext) {
    await this.validateHeader(ctx);
    if (!ctx.lines.length) throw Errors.bad('NO_LINES', 'В документе нет строк');
    if (!ctx.doc.extra?.reason && ctx.lines.some((l) => !l.extra?.reason)) throw Errors.bad('REASON_REQUIRED', 'Укажите причину списания');
    await checkOutgoingSerials(ctx, ctx.doc.warehouseId!);
  }

  async plan(ctx: PostingContext) {
    return outgoingPlans(ctx, ctx.doc.warehouseId!);
  }

  async afterPost(ctx: PostingContext) {
    await setSerialState(ctx.tx, ctx.lines, 'written_off', null);
  }

  async afterUnpost(ctx: PostingContext) {
    await setSerialState(ctx.tx, ctx.lines, 'in_stock', ctx.doc.warehouseId);
  }
}

// ── Пересортица: товар A → товар B, на деньги не влияет ────

@Injectable()
export class ResortHandler implements PostingHandler {
  type = 'resort' as const;

  async validateHeader(ctx: PostingContext) {
    await requireWarehouse(ctx.tx, ctx.doc.warehouseId);
  }

  async beforePost(ctx: PostingContext) {
    await this.validateHeader(ctx);
    if (!ctx.lines.length) throw Errors.bad('NO_LINES', 'В документе нет строк');
    const errors: any[] = [];
    for (const l of ctx.lines) {
      const a = ctx.products.get(l.productId)!;
      const b = l.productToId ? ctx.products.get(l.productToId) : undefined;
      if (!b) errors.push(lineError(l, 'укажите, в какой товар'));
      else if (b.id === a.id) errors.push(lineError(l, 'товар «во что» совпадает с исходным'));
      else if (a.isSerial || b.isSerial) errors.push(lineError(l, 'серийные товары пересортицей не меняются'));
      else if (!tracksStock(a) || !tracksStock(b)) errors.push(lineError(l, 'оба товара должны вести остаток'));
      else if (a.baseUnit !== b.baseUnit) errors.push(lineError(l, `разные базовые единицы (${a.baseUnit} → ${b.baseUnit})`));
    }
    if (errors.length) throw Errors.bad('LINES_INVALID', 'Проверьте строки документа', errors);
  }

  async plan(ctx: PostingContext) {
    const plans: PlannedMovement[] = [];
    for (const l of ctx.lines) {
      const wh = ctx.doc.warehouseId!;
      plans.push({ key: `${l.id}:out`, lineId: l.id, lineNo: l.lineNo, warehouseId: wh, productId: l.productId, unitId: l.unitId, kind: 'out', qty: l.baseQty.neg() });
      plans.push({
        key: `${l.id}:in`,
        lineId: l.id,
        lineNo: l.lineNo,
        warehouseId: wh,
        productId: l.productToId!,
        unitId: l.unitToId!,
        kind: 'in_fixed',
        qty: l.baseQty,
        pairKey: `${l.id}:out`,
      });
    }
    return plans;
  }
}

// ── Перемещение в два этапа ───────────────────────────────

@Injectable()
export class TransferHandler implements PostingHandler {
  type = 'transfer' as const;

  async validateHeader(ctx: PostingContext) {
    const from = await requireWarehouse(ctx.tx, ctx.doc.warehouseId, 'Склад-отправитель');
    const to = await requireWarehouse(ctx.tx, ctx.doc.warehouseToId, 'Склад-получатель');
    if (from.id === to.id) throw Errors.bad('SAME_WAREHOUSE', 'Склады отправителя и получателя совпадают');
    if (from.type === 'transit' || to.type === 'transit') throw Errors.bad('TRANSIT', 'Транзитный склад выбирать не нужно');
  }

  async beforePost(ctx: PostingContext) {
    await this.validateHeader(ctx);
    if (!ctx.lines.length) throw Errors.bad('NO_LINES', 'В документе нет строк');
    await checkOutgoingSerials(ctx, ctx.doc.warehouseId!);
    ctx.doc.extra = { ...ctx.doc.extra, transferState: 'in_transit', sentAt: new Date().toISOString() };
  }

  /** Этап 1: со склада-отправителя в «транзит». Этап 2 (приёмка) — отдельный план acceptPlan. */
  async plan(ctx: PostingContext) {
    const transit = await transitWarehouse(ctx.tx);
    const out = outgoingPlans(ctx, ctx.doc.warehouseId!, 'transfer_out', 'out:');
    const ins: PlannedMovement[] = out.map((o) => ({ ...o, key: o.key.replace('out:', 'in:'), warehouseId: transit.id, kind: 'transfer_in' as const, qty: o.qty.neg(), pairKey: o.key }));
    // Если уже принято (перепроведение принятого) — добавляем второй этап
    if (ctx.doc.extra?.transferState === 'received') ins.push(...(await this.acceptPlansFor(ctx, ctx.doc.extra.accepted ?? {})));
    return [...out, ...ins];
  }

  async acceptPlansFor(ctx: PostingContext, accepted: Record<string, string>): Promise<PlannedMovement[]> {
    const transit = await transitWarehouse(ctx.tx);
    const plans: PlannedMovement[] = [];
    for (const l of ctx.lines) {
      const p = ctx.products.get(l.productId);
      if (!tracksStock(p)) continue;
      const qty = D(accepted[l.id] ?? l.baseQty);
      if (qty.isZero()) continue;
      if (l.serialItemIds.length) {
        l.serialItemIds.slice(0, Number(qty)).forEach((sid, i) => {
          plans.push({ key: `acc-out:${l.id}:${i}`, lineId: l.id, lineNo: l.lineNo, warehouseId: transit.id, productId: l.productId, unitId: l.unitId, serialItemId: sid, kind: 'transfer_out', qty: D(-1) });
          plans.push({ key: `acc-in:${l.id}:${i}`, lineId: l.id, lineNo: l.lineNo, warehouseId: ctx.doc.warehouseToId!, productId: l.productId, unitId: l.unitId, serialItemId: sid, kind: 'transfer_in', qty: D(1), pairKey: `acc-out:${l.id}:${i}` });
        });
      } else {
        plans.push({ key: `acc-out:${l.id}`, lineId: l.id, lineNo: l.lineNo, warehouseId: transit.id, productId: l.productId, unitId: l.unitId, kind: 'transfer_out', qty: qty.neg() });
        plans.push({ key: `acc-in:${l.id}`, lineId: l.id, lineNo: l.lineNo, warehouseId: ctx.doc.warehouseToId!, productId: l.productId, unitId: l.unitId, kind: 'transfer_in', qty, pairKey: `acc-out:${l.id}` });
      }
    }
    return plans;
  }

  async afterPost(ctx: PostingContext) {
    const transit = await transitWarehouse(ctx.tx);
    if (ctx.doc.extra?.transferState === 'received') await setSerialState(ctx.tx, ctx.lines, 'in_stock', ctx.doc.warehouseToId);
    else await setSerialState(ctx.tx, ctx.lines, 'in_transit', transit.id);
  }

  async beforeUnpost(ctx: PostingContext) {
    if (ctx.doc.extra?.transferState === 'received') {
      throw Errors.conflict('TRANSFER_RECEIVED', 'Перемещение уже принято на складе-получателе — отмена невозможна');
    }
  }

  async afterUnpost(ctx: PostingContext) {
    await setSerialState(ctx.tx, ctx.lines, 'in_stock', ctx.doc.warehouseId);
    ctx.doc.extra = { ...ctx.doc.extra, transferState: null, sentAt: null };
  }
}

/** Виртуальный склад «в пути» магазина — создаётся сам. */
export async function transitWarehouse(tx: TenantTx): Promise<Warehouse> {
  const cached = tx.memo.get('wh:transit') as Warehouse | undefined;
  if (cached) return cached;
  let wh = await tx.repo(Warehouse).findOne({ where: { type: 'transit' } });
  if (!wh) {
    wh = await tx.repo(Warehouse).insert({ storeId: null, name: 'В пути (перемещения)', code: 'ТРАНЗИТ', type: 'transit', storageLevel: 1 });
  }
  tx.memo.set('wh:transit', wh);
  return wh;
}

// ── Корректировка себестоимости (автоматическая) ──────────

@Injectable()
export class CostAdjustmentHandler implements PostingHandler {
  type = 'cost_adjustment' as const;
  async plan(ctx: PostingContext): Promise<PlannedMovement[]> {
    return ctx.lines.map((l) => ({
      key: l.id,
      lineId: l.id,
      lineNo: l.lineNo,
      warehouseId: ctx.doc.warehouseId!,
      productId: l.productId,
      unitId: l.unitId,
      kind: 'adjustment' as const,
      qty: D(0),
      amount: D(l.extra?.registerAmount ?? 0),
    }));
  }
}

// ── Инвентаризация: сама не двигает товар, итог — оприходование и списание ──

@Injectable()
export class InventoryHandler implements PostingHandler {
  type = 'inventory' as const;
  async validateHeader(ctx: PostingContext) {
    await requireWarehouse(ctx.tx, ctx.doc.warehouseId);
  }
  async plan(): Promise<PlannedMovement[]> {
    return [];
  }
}


// ── Перемещение в один шаг: на «склад клиента» и обратно (подбор, реализация) ──

abstract class MoveHandler implements PostingHandler {
  abstract type: any;

  async validateHeader(ctx: PostingContext) {
    const from = await requireWarehouse(ctx.tx, ctx.doc.warehouseId, 'Откуда');
    const to = await requireWarehouse(ctx.tx, ctx.doc.warehouseToId, 'Куда');
    if (from.id === to.id) throw Errors.bad('SAME_WAREHOUSE', 'Склады совпадают');
  }

  async beforePost(ctx: PostingContext) {
    await this.validateHeader(ctx);
    if (!ctx.lines.length) throw Errors.bad('NO_LINES', 'В документе нет строк');
    await checkOutgoingSerials(ctx, ctx.doc.warehouseId!);
  }

  async plan(ctx: PostingContext) {
    const out = outgoingPlans(ctx, ctx.doc.warehouseId!, 'transfer_out', 'out:');
    return [...out, ...out.map((o) => ({ ...o, key: o.key.replace('out:', 'in:'), warehouseId: ctx.doc.warehouseToId!, kind: 'transfer_in' as const, qty: o.qty.neg(), pairKey: o.key }))];
  }

  async afterPost(ctx: PostingContext) {
    await setSerialState(ctx.tx, ctx.lines, 'in_stock', ctx.doc.warehouseToId);
  }

  async afterUnpost(ctx: PostingContext) {
    await setSerialState(ctx.tx, ctx.lines, 'in_stock', ctx.doc.warehouseId);
  }
}

@Injectable()
export class SelectionIssueHandler extends MoveHandler {
  type = 'selection_issue' as const;
}

@Injectable()
export class SelectionReturnHandler extends MoveHandler {
  type = 'selection_return' as const;
}

@Injectable()
export class ConsignmentHandler extends MoveHandler {
  type = 'consignment' as const;
}

@Injectable()
export class ConsignmentReturnHandler extends MoveHandler {
  type = 'consignment_return' as const;
}

/** Покупка у клиента и лом (ТЗ 14.11): приход с себестоимостью = цене покупки. */
@Injectable()
export class CustomerPurchaseHandler extends IncomingHandler {
  type = 'customer_purchase' as const;
  constructor(ledger: StockLedgerService) {
    super(ledger);
  }
}

/**
 * Разборка донора (ТЗ 14.12): детали приходуют частями; себестоимость каждой — её доля стоимости донора
 * (цена строки — «оценка»; доля = оценка / сумма оценок всего донора × стоимость донора).
 */
@Injectable()
export class DonorHandler extends IncomingHandler {
  type = 'donor' as const;
  constructor(ledger: StockLedgerService) {
    super(ledger);
  }

  async plan(ctx: PostingContext) {
    const factor = D(ctx.doc.extra?.costFactor ?? 1);
    return incomingPlans(ctx, ctx.doc.warehouseId!, (l) => unitCost(receiptUnitCost(ctx, l, D(0)).mul(factor)));
  }
}
