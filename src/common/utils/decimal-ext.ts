import { DecimalTransformer } from './decimal';

/** Сумма себестоимости в регистрах: 6 знаков, чтобы средняя не «плыла» от округлений; округление — при выводе. */
export const COST_AMOUNT_COLUMN = { type: 'numeric' as const, precision: 20, scale: 6, transformer: DecimalTransformer };
