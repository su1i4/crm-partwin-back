import { Injectable } from '@nestjs/common';
import { D, Decimal, unitCost } from '../../common/utils/decimal';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { OutboxService } from '../../jobs/outbox.service';
import { MovementKind } from './entities/stock.entity';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** Движение, которое документ хочет провести. */
export interface PlannedMovement {
  /** Ключ внутри документа — на него ссылаются парные приходы */
  key: string;
  lineId: string;
  lineNo: number;
  warehouseId: string;
  productId: string;
  unitId: string;
  serialItemId?: string | null;
  kind: MovementKind;
  /** В базовой единице, со знаком */
  qty: Decimal;
  /** Для kind = in: себестоимость за базовую единицу в сомах */
  unitCost?: Decimal;
  /** Для in_fixed / transfer_in: ключ парного расхода */
  pairKey?: string;
  /** Для adjustment: сумма со знаком */
  amount?: Decimal;
}

export interface NegativeLine {
  lineNo: number;
  productId: string;
  warehouseId: string;
  need: string;
  available: string;
}

export interface CoverAdjustment {
  productId: string;
  warehouseId: string;
  /** На сколько увеличилась себестоимость ранее проданного в минус (со знаком) */
  amount: Decimal;
  qty: Decimal;
}

export interface ApplyResult {
  movements: { key: string; id: string; lineId: string; costAmount: Decimal; qty: Decimal; productId: string }[];
  negatives: NegativeLine[];
  adjustments: CoverAdjustment[];
}

interface CostState {
  qty: Decimal;
  amount: Decimal;
  last: Decimal;
}
interface BalanceState {
  qty: Decimal;
  amount: Decimal;
  startQty: Decimal;
}

/**
 * Регистр остатков и себестоимости (ТЗ 2.4.1, 2.4.7, 7.3, 7.4).
 * Проведение: INSERT … ON CONFLICT DO NOTHING строк остатков → SELECT … FOR UPDATE в порядке product_id →
 * расчёт по средней скользящей → запись движений → обновление остатков. Всё — в транзакции документа.
 */
@Injectable()
export class StockLedgerService {
  constructor(private readonly outbox: OutboxService) {}

  async apply(
    tx: TenantTx,
    documentId: string,
    movedAt: Date,
    plans: PlannedMovement[],
    /** Остатки «до» для проверки минуса при перепроведении (ТЗ 9.2: по итоговому результату) */
    baseline?: Map<string, Decimal>,
  ): Promise<ApplyResult> {
    if (!plans.length) return { movements: [], negatives: [], adjustments: [] };
    const t = tx.tenantId;
    const productIds = [...new Set(plans.map((p) => p.productId))].sort();
    const pairs = [...new Set(plans.map((p) => `${p.warehouseId}|${p.productId}`))].sort();

    // 1. Строки остатков и себестоимости — создать, если нет
    await tx.query(
      `INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, qty, cost_amount)
       SELECT $1, split_part(x, '|', 1)::uuid, split_part(x, '|', 2)::uuid, 0, 0 FROM unnest($2::text[]) x
       ON CONFLICT (tenant_id, warehouse_id, product_id, COALESCE(location_id, '${ZERO_UUID}'::uuid)) DO NOTHING`,
      [t, pairs],
    );
    await tx.query(
      `INSERT INTO product_costs (tenant_id, product_id, qty, cost_amount, last_unit_cost)
       SELECT $1, x, 0, 0, 0 FROM unnest($2::uuid[]) x ON CONFLICT (tenant_id, product_id) DO NOTHING`,
      [t, productIds],
    );

    // 2. Блокировки в порядке product_id — против взаимных блокировок
    const costRows = await tx.query(
      `SELECT product_id, qty, cost_amount, last_unit_cost FROM product_costs
        WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) ORDER BY product_id FOR UPDATE`,
      [t, productIds],
    );
    const balRows = await tx.query(
      `SELECT warehouse_id, product_id, qty, cost_amount FROM stock_balances
        WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND location_id IS NULL
          AND (warehouse_id::text || '|' || product_id::text) = ANY($3::text[])
        ORDER BY product_id, warehouse_id FOR UPDATE`,
      [t, productIds, pairs],
    );
    const costs = new Map<string, CostState>(
      costRows.map((r: any) => [r.product_id, { qty: D(r.qty), amount: D(r.cost_amount), last: D(r.last_unit_cost) }]),
    );
    const bals = new Map<string, BalanceState>(
      balRows.map((r: any) => [`${r.warehouse_id}|${r.product_id}`, { qty: D(r.qty), amount: D(r.cost_amount), startQty: D(r.qty) }]),
    );

    // 3. Расчёт
    const amountByKey = new Map<string, Decimal>();
    const rows: { plan: PlannedMovement; amount: Decimal }[] = [];
    const adjustments: CoverAdjustment[] = [];
    const lowestByPair = new Map<string, { value: Decimal; lineNo: number }>();

    for (const plan of plans) {
      const c = costs.get(plan.productId)!;
      const b = bals.get(`${plan.warehouseId}|${plan.productId}`)!;
      let amount: Decimal;
      switch (plan.kind) {
        case 'in': {
          const uc = unitCost(plan.unitCost ?? 0);
          amount = plan.qty.mul(uc);
          // Покрытие продаж в минус: проданное без остатка дооценивается по новой цене (ТЗ 7.4)
          if (c.qty.lt(0)) {
            const oldAvg = c.amount.div(c.qty);
            const covered = Decimal.min(c.qty.neg(), plan.qty);
            const diff = covered.mul(uc.minus(oldAvg));
            // Движение «корректировка» на −diff проводится отдельным документом (вызывающий создаёт его сразу)
            if (!diff.isZero()) adjustments.push({ productId: plan.productId, warehouseId: plan.warehouseId, amount: diff, qty: covered });
          }
          if (uc.gt(0)) c.last = uc;
          break;
        }
        case 'out':
        case 'transfer_out': {
          const avg = c.qty.gt(0) ? c.amount.div(c.qty) : c.last;
          amount = plan.qty.mul(avg);
          break;
        }
        case 'in_fixed':
        case 'transfer_in': {
          const paired = plan.pairKey ? amountByKey.get(plan.pairKey) : undefined;
          if (paired === undefined) throw new Error(`Нет парного расхода для ${plan.key}`);
          amount = paired.neg();
          if (plan.kind === 'in_fixed' && plan.qty.gt(0) && amount.gt(0)) c.last = unitCost(amount.div(plan.qty));
          break;
        }
        case 'adjustment':
          amount = plan.amount ?? D(0);
          break;
      }
      amountByKey.set(plan.key, amount);
      c.qty = c.qty.plus(plan.qty);
      c.amount = c.amount.plus(amount);
      b.qty = b.qty.plus(plan.qty);
      b.amount = b.amount.plus(amount);
      if (c.qty.isZero()) c.amount = D(0); // нет остатка — нет суммы (хвосты округлений)
      rows.push({ plan, amount });

      const pk = `${plan.warehouseId}|${plan.productId}`;
      if (plan.qty.lt(0)) {
        const low = lowestByPair.get(pk);
        if (!low || b.qty.lt(low.value)) lowestByPair.set(pk, { value: b.qty, lineNo: plan.lineNo });
      }
    }

    // Минус — по итогу документа (ТЗ 9.2): строка, на которой остаток ушёл ниже нуля
    const negatives: NegativeLine[] = [];
    for (const [pk, low] of lowestByPair) {
      const b = bals.get(pk)!;
      const before = baseline?.get(pk) ?? b.startQty;
      if (b.qty.lt(0) && b.qty.lt(before)) {
        const [warehouseId, productId] = pk.split('|');
        const need = rows.filter((r) => `${r.plan.warehouseId}|${r.plan.productId}` === pk && r.plan.qty.lt(0)).reduce((a, r) => a.plus(r.plan.qty.neg()), D(0));
        negatives.push({ lineNo: low.lineNo, productId, warehouseId, need: need.toFixed(), available: before.toFixed() });
      }
    }

    // 4. Запись движений
    const inserted = await tx.query(
      `INSERT INTO stock_movements (tenant_id, created_by, document_id, line_id, warehouse_id, product_id, unit_id, serial_item_id,
                                    kind, qty, cost_amount, moved_at)
       SELECT $1, $2, $3, x.line_id, x.warehouse_id, x.product_id, x.unit_id, x.serial_item_id, x.kind, x.qty, x.cost_amount, $4
         FROM jsonb_to_recordset($5::jsonb) AS x(ord int, line_id uuid, warehouse_id uuid, product_id uuid, unit_id uuid,
              serial_item_id uuid, kind text, qty numeric, cost_amount numeric)
        ORDER BY x.ord
       RETURNING id, line_id, product_id, qty, cost_amount, seq`,
      [
        t,
        tx.userId,
        documentId,
        movedAt,
        JSON.stringify(
          rows.map((r, i) => ({
            ord: i,
            line_id: r.plan.lineId,
            warehouse_id: r.plan.warehouseId,
            product_id: r.plan.productId,
            unit_id: r.plan.unitId,
            serial_item_id: r.plan.serialItemId ?? null,
            kind: r.plan.kind,
            qty: r.plan.qty.toFixed(),
            cost_amount: r.amount.toFixed(),
          })),
        ),
      ],
    );
    inserted.sort((a: any, b: any) => Number(a.seq) - Number(b.seq));
    const movements = inserted.map((m: any, i: number) => ({
      key: rows[i].plan.key,
      id: m.id,
      lineId: m.line_id,
      productId: m.product_id,
      qty: D(m.qty),
      costAmount: D(m.cost_amount),
    }));
    // Пары: приход ссылается на свой расход
    const byKey = new Map(movements.map((m: any) => [m.key, m.id]));
    const pairUpdates = rows
      .map((r, i) => (r.plan.pairKey ? { id: movements[i].id, pair: byKey.get(r.plan.pairKey) } : null))
      .filter(Boolean) as { id: string; pair: string }[];
    if (pairUpdates.length) {
      await tx.query(
        `UPDATE stock_movements m SET pair_of_id = x.pair FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, pair uuid)
          WHERE m.tenant_id = $1 AND m.id = x.id`,
        [t, JSON.stringify(pairUpdates)],
      );
    }

    // 5. Остатки и себестоимость
    await this.writeStates(tx, bals, costs);
    return { movements, negatives, adjustments };
  }

  /**
   * Отменить движения документа: вычесть из остатков и удалить (ТЗ 2.4.2).
   * Возвращает затронутые товары и итоговые минусы (решение — у вызывающего).
   */
  async reverse(tx: TenantTx, documentId: string): Promise<{ productIds: string[]; negatives: NegativeLine[]; movedAt: Date | null }> {
    const t = tx.tenantId;
    const moves = await tx.query(
      `SELECT id, warehouse_id, product_id, qty, cost_amount, moved_at FROM stock_movements WHERE tenant_id = $1 AND document_id = $2`,
      [t, documentId],
    );
    if (!moves.length) return { productIds: [], negatives: [], movedAt: null };
    const productIds = [...new Set<string>(moves.map((m: any) => m.product_id))].sort();
    const pairs = [...new Set<string>(moves.map((m: any) => `${m.warehouse_id}|${m.product_id}`))].sort();
    const costRows = await tx.query(
      `SELECT product_id, qty, cost_amount, last_unit_cost FROM product_costs WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])
        ORDER BY product_id FOR UPDATE`,
      [t, productIds],
    );
    const balRows = await tx.query(
      `SELECT warehouse_id, product_id, qty, cost_amount FROM stock_balances
        WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND location_id IS NULL
          AND (warehouse_id::text || '|' || product_id::text) = ANY($3::text[])
        ORDER BY product_id, warehouse_id FOR UPDATE`,
      [t, productIds, pairs],
    );
    const costs = new Map<string, CostState>(costRows.map((r: any) => [r.product_id, { qty: D(r.qty), amount: D(r.cost_amount), last: D(r.last_unit_cost) }]));
    const bals = new Map<string, BalanceState>(
      balRows.map((r: any) => [`${r.warehouse_id}|${r.product_id}`, { qty: D(r.qty), amount: D(r.cost_amount), startQty: D(r.qty) }]),
    );
    for (const m of moves) {
      const c = costs.get(m.product_id)!;
      const b = bals.get(`${m.warehouse_id}|${m.product_id}`)!;
      c.qty = c.qty.minus(m.qty);
      c.amount = c.amount.minus(m.cost_amount);
      if (c.qty.isZero()) c.amount = D(0);
      b.qty = b.qty.minus(m.qty);
      b.amount = b.amount.minus(m.cost_amount);
    }
    const negatives: NegativeLine[] = [];
    for (const [pk, b] of bals) {
      if (b.qty.lt(0) && b.qty.lt(b.startQty)) {
        const [warehouseId, productId] = pk.split('|');
        negatives.push({ lineNo: 0, productId, warehouseId, need: b.startQty.minus(b.qty).toFixed(), available: b.startQty.toFixed() });
      }
    }
    // Парные приходы других документов (пересортица) не трогаем — у них свой документ
    await tx.query(`UPDATE stock_movements SET pair_of_id = NULL WHERE tenant_id = $1 AND pair_of_id = ANY($2::uuid[])`, [t, moves.map((m: any) => m.id)]);
    await tx.query(`DELETE FROM stock_movements WHERE tenant_id = $1 AND document_id = $2`, [t, documentId]);
    await this.writeStates(tx, bals, costs);
    return { productIds, negatives, movedAt: moves[0].moved_at };
  }

  /**
   * Поставить «пересчёт товара X с даты Д», если после этой даты есть движения других документов (ТЗ 7.3).
   * Несколько пересчётов одного товара объединяются в один с самой ранней датой.
   */
  async enqueueRecalcIfBackdated(tx: TenantTx, productIds: string[], fromDate: Date, exceptDocumentId?: string) {
    if (!productIds.length) return [];
    const rows = await tx.query<{ product_id: string }>(
      `SELECT DISTINCT product_id FROM stock_movements
        WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND moved_at > $3 AND ($4::uuid IS NULL OR document_id <> $4)`,
      [tx.tenantId, productIds, fromDate, exceptDocumentId ?? null],
    );
    const ids = rows.map((r) => r.product_id);
    await this.enqueue(tx, ids, fromDate);
    return ids;
  }

  async enqueue(tx: TenantTx, productIds: string[], fromDate: Date) {
    if (!productIds.length) return;
    await tx.query(
      `INSERT INTO cost_recalc_queue (tenant_id, product_id, from_date, created_by)
       SELECT $1, x, $3, $4 FROM unnest($2::uuid[]) x
       ON CONFLICT (tenant_id, product_id) DO UPDATE SET from_date = LEAST(cost_recalc_queue.from_date, EXCLUDED.from_date), updated_at = now()`,
      [tx.tenantId, productIds, fromDate, tx.userId],
    );
    await this.outbox.emit(tx, 'cost.recalc_requested', { productIds: productIds.slice(0, 100) });
  }

  private async writeStates(tx: TenantTx, bals: Map<string, BalanceState>, costs: Map<string, CostState>) {
    const t = tx.tenantId;
    await tx.query(
      `UPDATE stock_balances b SET qty = x.qty, cost_amount = x.amount, updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS x(warehouse_id uuid, product_id uuid, qty numeric, amount numeric)
        WHERE b.tenant_id = $1 AND b.warehouse_id = x.warehouse_id AND b.product_id = x.product_id AND b.location_id IS NULL`,
      [
        t,
        JSON.stringify(
          [...bals].map(([pk, b]) => {
            const [warehouse_id, product_id] = pk.split('|');
            return { warehouse_id, product_id, qty: b.qty.toFixed(), amount: (b.qty.isZero() ? D(0) : b.amount).toFixed() };
          }),
        ),
      ],
    );
    await tx.query(
      `UPDATE product_costs c SET qty = x.qty, cost_amount = x.amount, last_unit_cost = x.last, updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS x(product_id uuid, qty numeric, amount numeric, last numeric)
        WHERE c.tenant_id = $1 AND c.product_id = x.product_id`,
      [
        t,
        JSON.stringify([...costs].map(([product_id, c]) => ({ product_id, qty: c.qty.toFixed(), amount: c.amount.toFixed(), last: c.last.toFixed() }))),
      ],
    );
  }

  /** Текущие остатки по парам «склад|товар» (база для проверки минуса при перепроведении). */
  async balancesFor(tx: TenantTx, documentId: string): Promise<Map<string, Decimal>> {
    const rows = await tx.query(
      `SELECT b.warehouse_id, b.product_id, b.qty FROM stock_balances b
        WHERE b.tenant_id = $1 AND b.location_id IS NULL AND (b.warehouse_id, b.product_id) IN (
          SELECT warehouse_id, product_id FROM stock_movements WHERE tenant_id = $1 AND document_id = $2)`,
      [tx.tenantId, documentId],
    );
    return new Map(rows.map((r: any) => [`${r.warehouse_id}|${r.product_id}`, D(r.qty)]));
  }

  /** Средняя себестоимость за единицу сейчас (для оприходования без цены, отчётов). */
  async currentUnitCost(tx: TenantTx, productId: string): Promise<Decimal> {
    const [r] = await tx.query(`SELECT qty, cost_amount, last_unit_cost FROM product_costs WHERE tenant_id = $1 AND product_id = $2`, [tx.tenantId, productId]);
    if (!r) return D(0);
    return D(r.qty).gt(0) ? unitCost(D(r.cost_amount).div(r.qty)) : D(r.last_unit_cost);
  }
}
