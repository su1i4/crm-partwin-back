/**
 * Движок цен и скидок (ТЗ 17.3, 17.6, 17.8) — чистые функции без Nest и базы.
 * Один и тот же код считает на сервере и (на этапе 5) на офлайн-кассе, поэтому зависит только от decimal.js.
 * Все суммы — строки; внутри — Decimal, деньги округляются до тыйына (2 знака) по правилу «половина вверх».
 */
import Decimal from 'decimal.js';

const D = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0);
const money = (v: Decimal.Value) => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const out = (v: Decimal) => v.toFixed(2);

// ── Какая цена применяется (ТЗ 17.3) ──────────────────────

export interface PriceCandidate {
  priceTypeId: string;
  /** null — для всех точек */
  storeId: string | null;
  /** null — базовая единица */
  unitId: string | null;
  price: string;
  currency: string;
}

export interface ResolvePriceInput {
  candidates: PriceCandidate[];
  storeId: string | null;
  /** Единица строки и её коэффициент к базовой */
  unitId: string | null;
  unitFactor: string;
  /** own — у упаковки своя цена; computed — цена базовой × коэффициент */
  unitPriceMode: 'computed' | 'own';
  retailPriceTypeId: string;
  customerPriceTypeId?: string | null;
  /** Персональная цена клиента на товар (ТЗ 14.8), за базовую единицу */
  personalPrice?: { price: string; currency: string } | null;
  /** Курсы магазина: { USD: '87.40' } — сколько сомов за единицу */
  rates: Record<string, string>;
  /** Округление цены в сомах после пересчёта из валюты: до 1, 5 или 10 сом */
  rounding: number;
  negotiable?: boolean;
}

export type PriceSource = 'personal' | 'type_store' | 'type_all' | 'retail_store' | 'retail_all' | 'negotiable' | 'none';

export interface ResolvedPrice {
  /** Цена за единицу строки в сомах; null — цены нет (продажа запрещена или «договорная») */
  price: string | null;
  source: PriceSource;
  priceTypeId: string | null;
  /** Исходная цена и валюта (для цены в долларах — сколько долларов) */
  originalPrice: string | null;
  originalCurrency: string | null;
  /** Курс, по которому пересчитали (1 для сомов) */
  rate: string | null;
}

/** Округлить цену в сомах до шага (1, 5, 10), половина — вверх. */
export function roundPrice(value: Decimal.Value, step: number): string {
  const s = D(step > 0 ? step : 1);
  return out(D(value).div(s).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(s));
}

/** Перевести цену в сомы по курсу магазина. Валютные цены округляются по правилу магазина. */
export function toKgs(price: Decimal.Value, currency: string, rates: Record<string, string>, rounding: number): { price: string; rate: string } {
  if (!currency || currency === 'KGS') return { price: out(money(price)), rate: '1' };
  const rate = rates[currency];
  if (!rate || D(rate).lte(0)) throw new PricingError('NO_RATE', `Не задан курс магазина для ${currency}`);
  return { price: roundPrice(D(price).mul(rate), rounding), rate: D(rate).toFixed() };
}

export class PricingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function resolvePrice(i: ResolvePriceInput): ResolvedPrice {
  const factor = D(i.unitFactor || 1);
  const isBaseUnit = i.unitPriceMode !== 'own';

  const make = (c: { price: string; currency: string }, source: PriceSource, priceTypeId: string | null, multiply: boolean): ResolvedPrice => {
    const kgs = toKgs(c.price, c.currency, i.rates, i.rounding);
    const price = multiply ? out(money(D(kgs.price).mul(factor))) : kgs.price;
    return { price, source, priceTypeId, originalPrice: D(c.price).toFixed(), originalCurrency: c.currency, rate: kgs.rate };
  };

  if (i.personalPrice) return make(i.personalPrice, 'personal', null, true);

  const find = (priceTypeId: string, store: string | null) => {
    // Упаковка со своей ценой: ищем цену этой единицы; иначе — цену базовой единицы × коэффициент
    if (!isBaseUnit && i.unitId) {
      const own = i.candidates.find((c) => c.priceTypeId === priceTypeId && c.storeId === store && c.unitId === i.unitId);
      if (own) return { c: own, multiply: false };
    }
    const base = i.candidates.find((c) => c.priceTypeId === priceTypeId && c.storeId === store && !c.unitId);
    return base ? { c: base, multiply: true } : null;
  };

  const steps: { type: string | null | undefined; store: string | null; source: PriceSource }[] = [
    { type: i.customerPriceTypeId, store: i.storeId, source: 'type_store' },
    { type: i.customerPriceTypeId, store: null, source: 'type_all' },
    { type: i.retailPriceTypeId, store: i.storeId, source: 'retail_store' },
    { type: i.retailPriceTypeId, store: null, source: 'retail_all' },
  ];
  for (const s of steps) {
    if (!s.type) continue;
    if (s.store === null && s.source.endsWith('store')) continue;
    if (s.source.endsWith('_store') && !i.storeId) continue;
    const hit = find(s.type, s.store);
    if (hit && D(hit.c.price).gt(0)) return make(hit.c, s.source, s.type, hit.multiply);
  }
  return {
    price: null,
    source: i.negotiable ? 'negotiable' : 'none',
    priceTypeId: null,
    originalPrice: null,
    originalCurrency: null,
    rate: null,
  };
}

// ── Распределение скидок по строкам чека (ТЗ 17.8) ─────────

/**
 * Разделить сумму пропорционально весам так, чтобы сумма долей совпала до тыйына.
 * Остаток округления — на строку с наибольшим весом.
 */
export function distribute(amount: Decimal.Value, weights: Decimal.Value[]): string[] {
  const total = money(amount);
  const w = weights.map((x) => D(x));
  const sum = w.reduce((a, b) => a.plus(b), D(0));
  if (!w.length) return [];
  if (sum.lte(0) || total.isZero()) return w.map(() => '0.00');
  const shares = w.map((x) => money(total.mul(x).div(sum)));
  const diff = total.minus(shares.reduce((a, b) => a.plus(b), D(0)));
  if (!diff.isZero()) {
    let maxIdx = 0;
    w.forEach((x, idx) => {
      if (x.gt(w[maxIdx])) maxIdx = idx;
    });
    shares[maxIdx] = shares[maxIdx].plus(diff);
  }
  return shares.map(out);
}

export interface CalcLineInput {
  key: string;
  qty: string;
  /** Цена за единицу строки в сомах (до скидок) */
  price: string;
  /** Ручная скидка на строку: процент или сумма (одно из двух) */
  discountPercent?: string | null;
  discountAmount?: string | null;
  /** Скидка по акции на строку (этап 8) */
  promoDiscount?: string | null;
  /** Строку нельзя скидывать скидкой на чек (например, «договорная») */
  excludeFromReceiptDiscount?: boolean;
}

export interface CalcReceiptInput {
  lines: CalcLineInput[];
  receiptDiscountPercent?: string | null;
  receiptDiscountAmount?: string | null;
  /** Оплата бонусами (этап 8) */
  bonusAmount?: string | null;
}

export interface CalcLine {
  key: string;
  /** Цена × количество */
  gross: string;
  promoDiscount: string;
  lineDiscount: string;
  receiptDiscount: string;
  bonusPaid: string;
  rounding: string;
  /** Итог строки: gross − скидки − бонусы */
  total: string;
  /** Ручная скидка строки (своя + доля скидки на чек) в % от суммы — для проверки лимита роли */
  manualPercent: string;
}

export interface CalcReceiptResult {
  lines: CalcLine[];
  subtotal: string;
  discountTotal: string;
  bonusTotal: string;
  total: string;
  maxManualPercent: string;
}

/**
 * Посчитать чек: цена × количество → акции → ручная скидка строки → скидка на чек (пропорционально)
 * → бонусы (пропорционально). Сумма итогов строк = итог чека.
 */
export function calcReceipt(input: CalcReceiptInput): CalcReceiptResult {
  const rows = input.lines.map((l) => {
    const gross = money(D(l.price).mul(l.qty));
    const promo = Decimal.min(money(l.promoDiscount ?? 0), gross);
    const afterPromo = gross.minus(promo);
    let lineDisc = D(0);
    if (l.discountPercent && D(l.discountPercent).gt(0)) {
      if (D(l.discountPercent).gt(100)) throw new PricingError('BAD_DISCOUNT', 'Скидка больше 100%');
      lineDisc = money(afterPromo.mul(l.discountPercent).div(100));
    } else if (l.discountAmount && D(l.discountAmount).gt(0)) {
      lineDisc = money(l.discountAmount);
    }
    if (lineDisc.gt(afterPromo)) throw new PricingError('BAD_DISCOUNT', 'Скидка на строку больше её суммы');
    return { l, gross, promo, lineDisc, net: afterPromo.minus(lineDisc) };
  });

  // Скидка на чек
  const eligible = rows.map((r) => (r.l.excludeFromReceiptDiscount ? D(0) : r.net));
  const eligibleSum = eligible.reduce((a, b) => a.plus(b), D(0));
  let receiptDisc = D(0);
  if (input.receiptDiscountPercent && D(input.receiptDiscountPercent).gt(0)) {
    if (D(input.receiptDiscountPercent).gt(100)) throw new PricingError('BAD_DISCOUNT', 'Скидка больше 100%');
    receiptDisc = money(eligibleSum.mul(input.receiptDiscountPercent).div(100));
  } else if (input.receiptDiscountAmount && D(input.receiptDiscountAmount).gt(0)) {
    receiptDisc = money(input.receiptDiscountAmount);
  }
  if (receiptDisc.gt(eligibleSum)) throw new PricingError('BAD_DISCOUNT', 'Скидка на чек больше суммы чека');
  const receiptShares = distribute(receiptDisc, eligible);

  // Бонусы — после скидок
  const afterDisc = rows.map((r, i) => r.net.minus(receiptShares[i]));
  const afterSum = afterDisc.reduce((a, b) => a.plus(b), D(0));
  const bonus = money(input.bonusAmount ?? 0);
  if (bonus.gt(afterSum)) throw new PricingError('BAD_BONUS', 'Бонусов больше суммы чека');
  const bonusShares = distribute(bonus, afterDisc);

  const lines: CalcLine[] = rows.map((r, i) => {
    const rd = D(receiptShares[i]);
    const bp = D(bonusShares[i]);
    const total = r.net.minus(rd).minus(bp);
    const manual = r.gross.isZero() ? D(0) : r.lineDisc.plus(rd).mul(100).div(r.gross.minus(r.promo).isZero() ? 1 : r.gross.minus(r.promo));
    return {
      key: r.l.key,
      gross: out(r.gross),
      promoDiscount: out(r.promo),
      lineDiscount: out(r.lineDisc),
      receiptDiscount: out(rd),
      bonusPaid: out(bp),
      rounding: '0.00',
      total: out(total),
      manualPercent: manual.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    };
  });
  const subtotal = rows.reduce((a, r) => a.plus(r.gross), D(0));
  const total = lines.reduce((a, l) => a.plus(l.total), D(0));
  const discountTotal = lines.reduce((a, l) => a.plus(l.promoDiscount).plus(l.lineDiscount).plus(l.receiptDiscount), D(0));
  return {
    lines,
    subtotal: out(subtotal),
    discountTotal: out(discountTotal),
    bonusTotal: out(bonus),
    total: out(total),
    maxManualPercent: lines.reduce((m, l) => Decimal.max(m, l.manualPercent), D(0)).toFixed(2),
  };
}

// ── Защита маржи (ТЗ 17.5) ─────────────────────────────────

/** Цена за единицу строки после всех скидок. */
export function effectiveUnitPrice(total: Decimal.Value, qty: Decimal.Value): string {
  return D(qty).isZero() ? '0.00' : out(money(D(total).div(qty)));
}

/** Шифр владельца: слово из 10 разных букв, i-я буква = цифра i (ТЗ 17.5). 1250 при «ПРОДАВЕЦКУ» → «РОВП». */
export function cipher(value: Decimal.Value, word: string): string {
  const letters = [...word.toUpperCase()];
  if (letters.length !== 10 || new Set(letters).size !== 10) throw new PricingError('BAD_CIPHER', 'Шифр — слово из 10 разных букв');
  return D(value)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toFixed(0)
    .split('')
    .map((d) => letters[Number(d)])
    .join('');
}

// ── Наценка (ТЗ 17.4) ──────────────────────────────────────

export interface MarkupRuleInput {
  id: string;
  priority: number;
  categoryIds?: string[] | null;
  brandId?: string | null;
  qualityClass?: string | null;
  costFrom?: string | null;
  costTo?: string | null;
  percent: string;
}

export interface MarkupTarget {
  /** Категория товара и все её предки — правило на родительскую категорию действует на подкатегории */
  categoryPath: string[];
  brandId: string | null;
  qualityClass: string | null;
  /** Закупочная цена (себестоимость) за базовую единицу, сом */
  cost: string;
}

/** Подходящее правило: больше условий — точнее; при равенстве — больший приоритет. */
export function pickMarkupRule<T extends MarkupRuleInput>(rules: T[], t: MarkupTarget): T | null {
  const cost = D(t.cost);
  let best: { rule: T; score: number } | null = null;
  for (const r of rules) {
    if (r.categoryIds?.length && !r.categoryIds.some((c) => t.categoryPath.includes(c))) continue;
    if (r.brandId && r.brandId !== t.brandId) continue;
    if (r.qualityClass && r.qualityClass !== t.qualityClass) continue;
    if (r.costFrom && cost.lt(r.costFrom)) continue;
    if (r.costTo && cost.gte(r.costTo)) continue;
    const specificity = (r.categoryIds?.length ? 4 : 0) + (r.brandId ? 2 : 0) + (r.qualityClass ? 1 : 0) + (r.costFrom || r.costTo ? 1 : 0);
    const score = r.priority * 100 + specificity;
    if (!best || score > best.score) best = { rule: r, score };
  }
  return best?.rule ?? null;
}

/** Цена от закупки с наценкой, с округлением по правилу магазина. */
export function applyMarkup(cost: Decimal.Value, percent: Decimal.Value, rounding: number): string {
  return roundPrice(D(cost).mul(D(100).plus(percent)).div(100), rounding);
}

/** Цена от другого типа цены: −N% (или +N%). */
export function fromOtherPrice(price: Decimal.Value, percent: Decimal.Value, rounding: number): string {
  return roundPrice(D(price).mul(D(100).plus(percent)).div(100), rounding);
}

// ── Акции (ТЗ 17.6) ───────────────────────────────────────

export interface PromoRule {
  id: string;
  name: string;
  /** percent — % на товары; receipt_amount — % при сумме чека от N; second_item — второй такой же товар −N% */
  kind: 'percent' | 'receipt_amount' | 'second_item';
  percent: string;
  minAmount?: string | null;
  categoryIds?: string[];
  brandIds?: string[];
  qualityClasses?: string[];
  makeIds?: string[];
  productIds?: string[];
  /** Суммируется с другими акциями; иначе берётся лучшая для покупателя */
  stackable: boolean;
}

export interface PromoLine {
  key: string;
  qty: string;
  price: string;
  productId: string;
  /** Группа и её предки */
  categoryIds: string[];
  brandId: string | null;
  qualityClass: string | null;
  makeIds: string[];
  /** Своя цена продавца / свободная позиция — без акций */
  excluded?: boolean;
}

function promoMatches(p: PromoRule, l: PromoLine) {
  const has = (list: string[] | undefined, v: string | null | string[]) =>
    !list?.length || (Array.isArray(v) ? v.some((x) => list.includes(x)) : v !== null && list.includes(v));
  return has(p.productIds, l.productId) && has(p.categoryIds, l.categoryIds) && has(p.brandIds, l.brandId) && has(p.qualityClasses, l.qualityClass) && has(p.makeIds, l.makeIds);
}

/**
 * Скидка по акциям на строку: из несуммируемых — лучшая для покупателя (постоянная скидка клиента — тоже
 * несуммируемая «акция»), плюс все суммируемые; не больше суммы строки.
 */
export function promoDiscounts(lines: PromoLine[], promos: PromoRule[], clientPercent: Decimal.Value = 0): { key: string; amount: string; promoIds: string[] }[] {
  const gross = lines.map((l) => money(D(l.price).mul(l.qty)));
  const receiptGross = lines.reduce((a, l, i) => (l.excluded ? a : a.plus(gross[i])), D(0));
  return lines.map((l, i) => {
    if (l.excluded) return { key: l.key, amount: '0.00', promoIds: [] };
    const g = gross[i];
    const cands: { id: string; amount: Decimal; stackable: boolean }[] = [];
    if (D(clientPercent).gt(0)) cands.push({ id: 'client', amount: money(g.mul(clientPercent).div(100)), stackable: false });
    for (const p of promos) {
      if (!promoMatches(p, l)) continue;
      let amount = D(0);
      if (p.kind === 'percent') amount = money(g.mul(p.percent).div(100));
      else if (p.kind === 'receipt_amount' && receiptGross.gte(D(p.minAmount ?? 0))) amount = money(g.mul(p.percent).div(100));
      else if (p.kind === 'second_item') amount = money(D(Math.floor(D(l.qty).div(2).toNumber())).mul(l.price).mul(p.percent).div(100));
      if (amount.gt(0)) cands.push({ id: p.id, amount, stackable: p.stackable });
    }
    const best = cands.filter((c) => !c.stackable).sort((a, b) => b.amount.cmp(a.amount))[0];
    const chosen = [...(best ? [best] : []), ...cands.filter((c) => c.stackable)];
    const total = Decimal.min(g, chosen.reduce((a, c) => a.plus(c.amount), D(0)));
    return { key: l.key, amount: out(total), promoIds: chosen.map((c) => c.id) };
  });
}

// ── Бонусы (ТЗ 17.7) ──────────────────────────────────────

/** Сколько бонусов можно списать: не больше баланса и N% суммы чека после скидок. */
export function allowedBonus(requested: Decimal.Value, balance: Decimal.Value, totalAfterDiscounts: Decimal.Value, maxPayPercent: Decimal.Value): string {
  const cap = money(D(totalAfterDiscounts).mul(maxPayPercent).div(100));
  return out(Decimal.max(0, Decimal.min(D(requested), D(balance), cap)));
}

/** Уровень по сумме покупок: самый высокий порог, который достигнут. */
export function loyaltyLevel<T extends { threshold: string; percent: string }>(levels: T[], spent: Decimal.Value): T | null {
  return [...levels].sort((a, b) => D(b.threshold).cmp(a.threshold)).find((l) => D(spent).gte(l.threshold)) ?? null;
}
