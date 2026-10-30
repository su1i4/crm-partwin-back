import Decimal from 'decimal.js';
import { ValueTransformer } from 'typeorm';

/**
 * Деньги и количества — только Decimal (ТЗ 2.4.3).
 * Точность расчётов высокая, округление до 2 знаков — только в итогах и при выводе.
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export type DecimalLike = Decimal | string | number;

export const D = (v: DecimalLike | null | undefined): Decimal => new Decimal(v ?? 0);

/** Округление суммы до тыйынов (2 знака). */
export const money = (v: DecimalLike): Decimal => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** Количество — 3 знака. */
export const qty = (v: DecimalLike): Decimal => D(v).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
/** Себестоимость / цена за единицу — 6 знаков. */
export const unitCost = (v: DecimalLike): Decimal => D(v).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);

/** Трансформер TypeORM: numeric ↔ Decimal. В JSON Decimal сериализуется строкой. */
export const DecimalTransformer: ValueTransformer = {
  // undefined оставляем undefined — тогда TypeORM подставит DEFAULT колонки.
  to(value: DecimalLike | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return new Decimal(value).toFixed();
  },
  from(value: string | null): Decimal | null {
    if (value === null || value === undefined) return null;
    return new Decimal(value);
  },
};

/** Опции колонок по ТЗ 2.4.3 */
export const MONEY_COLUMN = { type: 'numeric' as const, precision: 18, scale: 2, transformer: DecimalTransformer };
export const QTY_COLUMN = { type: 'numeric' as const, precision: 18, scale: 3, transformer: DecimalTransformer };
export const COST_COLUMN = { type: 'numeric' as const, precision: 18, scale: 6, transformer: DecimalTransformer };
