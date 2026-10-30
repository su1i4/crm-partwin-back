import { D } from '../../common/utils/decimal';
import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { PricingError, PriceCandidate, ResolvedPrice, resolvePrice } from '../../common/pricing-engine/engine';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { Product, ProductUnit } from '../catalog/entities/product.entity';
import { SettingsService } from '../settings/settings.service';
import { ShopRate } from './entities/price-type.entity';
import { PricesService } from './prices.service';

export interface QuoteItem {
  productId: string;
  unitId?: string | null;
}

export interface QuotedPrice extends ResolvedPrice {
  productId: string;
  unitId: string;
  unitName: string;
  factor: string;
  /** Минимальная цена за единицу строки (сом) — продавцу по долгому нажатию, клиенту не показывается */
  minPrice: string | null;
  negotiable: boolean;
  recommendedPrice: string | null;
}

/** Адаптер движка цен к базе: собирает цены, курсы, настройки и отдаёт цену строки (ТЗ 17.3). */
@Injectable()
export class PriceResolverService {
  constructor(
    private readonly prices: PricesService,
    private readonly settings: SettingsService,
  ) {}

  /** Текущие курсы магазина: { USD: '87.40' }. */
  async rates(tx: TenantTx): Promise<Record<string, string>> {
    if (tx.memo.has('rates')) return tx.memo.get('rates') as Record<string, string>;
    const rows = await tx.query<{ currency: string; rate: string }>(
      `SELECT DISTINCT ON (currency) currency, rate FROM shop_rates WHERE tenant_id = $1 ORDER BY currency, created_at DESC`,
      [tx.tenantId],
    );
    const map = Object.fromEntries(rows.map((r) => [r.currency, String(Number(r.rate))]));
    tx.memo.set('rates', map);
    return map;
  }

  async currentRate(tx: TenantTx, currency = 'USD'): Promise<ShopRate | null> {
    return tx.repo(ShopRate).findOne({ where: { currency }, order: { createdAt: 'DESC' } });
  }

  async quote(tx: TenantTx, opts: { storeId: string | null; priceTypeId?: string | null; counterpartyId?: string | null; items: QuoteItem[] }): Promise<QuotedPrice[]> {
    const ids = [...new Set(opts.items.map((i) => i.productId))];
    // Персональная цена «клиент × товар» (ТЗ 14.8) — раньше типа цены клиента; задаётся за базовую единицу
    const personal = new Map<string, { price: string; currency: string }>();
    if (opts.counterpartyId && ids.length) {
      const rows = await tx.query(
        `SELECT product_id, price, currency FROM personal_prices WHERE tenant_id = $1 AND counterparty_id = $2 AND product_id = ANY($3::uuid[])`,
        [tx.tenantId, opts.counterpartyId, ids],
      );
      for (const r of rows) personal.set(r.product_id, { price: String(r.price), currency: r.currency });
    }
    const products = new Map((await tx.repo(Product, 'Товар').getByIds(ids)).map((p) => [p.id, p]));
    const units = ids.length ? await tx.repo(ProductUnit).find({ where: ids.map((productId) => ({ productId })) }) : [];
    const all = await this.prices.current(tx, ids);
    const retail = await this.prices.retailType(tx);
    const rates = await this.rates(tx);
    const s = await this.settings.get(tx);
    return opts.items.map((i) => {
      const p = products.get(i.productId)!;
      const unit = i.unitId ? units.find((u) => u.id === i.unitId && u.productId === p.id) : units.find((u) => u.productId === p.id && u.isBase);
      if (!unit) throw Errors.bad('BAD_UNIT', `Единица не относится к товару «${p.name}»`);
      const candidates: PriceCandidate[] = all
        .filter((c) => c.productId === p.id)
        .map((c) => ({ priceTypeId: c.priceTypeId, storeId: c.storeId, unitId: c.unitId, price: c.price, currency: c.currency }));
      let resolved: ResolvedPrice;
      try {
        resolved = resolvePrice({
          candidates,
          storeId: opts.storeId,
          unitId: unit.id,
          unitFactor: String(unit.factor),
          unitPriceMode: unit.isBase ? 'computed' : unit.priceMode,
          retailPriceTypeId: retail.id,
          customerPriceTypeId: opts.priceTypeId ?? null,
          rates,
          rounding: s.priceRounding,
          negotiable: p.priceNegotiable,
          personalPrice: personal.has(p.id)
            ? { price: D(personal.get(p.id)!.price).mul(unit.factor).toFixed(2), currency: personal.get(p.id)!.currency }
            : null,
        });
      } catch (e) {
        if (e instanceof PricingError) throw Errors.bad(e.code, e.message);
        throw e;
      }
      const factor = unit.factor;
      return {
        ...resolved,
        productId: p.id,
        unitId: unit.id,
        unitName: unit.name,
        factor: String(factor),
        minPrice: p.minPrice ? p.minPrice.mul(factor).toFixed(2) : null,
        negotiable: p.priceNegotiable,
        recommendedPrice: p.recommendedPrice ? p.recommendedPrice.mul(factor).toFixed(2) : null,
      };
    });
  }
}
