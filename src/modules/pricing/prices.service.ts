import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { D, Decimal, money } from '../../common/utils/decimal';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { PriceType } from './entities/price-type.entity';
import { Price } from './entities/price.entity';

export interface CurrentPrice {
  productId: string;
  priceTypeId: string;
  storeId: string | null;
  unitId: string | null;
  price: string;
  currency: string;
  validFrom: Date;
}

export interface SetPriceInput {
  productId: string;
  priceTypeId: string;
  storeId?: string | null;
  unitId?: string | null;
  price: string | Decimal;
  currency?: string;
  validFrom?: Date;
}

/**
 * Цены (ТЗ 17). Этап 1 — хранение и установка цены вручную из карточки.
 * Документ «Установка цен», наценки, курс в кассе и движок цен — этап 3.1.
 */
@Injectable()
export class PricesService {
  constructor(private readonly audit: AuditService) {}

  async retailType(tx: TenantTx): Promise<PriceType> {
    if (tx.memo.has('priceType:retail')) return tx.memo.get('priceType:retail') as PriceType;
    const t = await tx.repo(PriceType).findOne({ where: { isRetail: true } });
    if (t) tx.memo.set('priceType:retail', t);
    if (!t) throw Errors.bad('NO_RETAIL_PRICE_TYPE', 'Нет розничного типа цены');
    return t;
  }

  async priceTypes(tx: TenantTx) {
    return tx.repo(PriceType).find({ order: { sort: 'ASC' } });
  }

  /** Действующие цены товаров (последняя с valid_from ≤ now по каждому ключу). */
  async current(tx: TenantTx, productIds: string[]): Promise<CurrentPrice[]> {
    if (!productIds.length) return [];
    const rows = await tx.query(
      `SELECT DISTINCT ON (product_id, price_type_id, store_id, unit_id)
              product_id, price_type_id, store_id, unit_id, price, currency, valid_from
         FROM prices
        WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND valid_from <= now()
        ORDER BY product_id, price_type_id, store_id, unit_id, valid_from DESC, created_at DESC`,
      [tx.tenantId, productIds],
    );
    return rows.map((r: any) => ({
      productId: r.product_id,
      priceTypeId: r.price_type_id,
      storeId: r.store_id,
      unitId: r.unit_id,
      price: money(r.price).toFixed(2),
      currency: r.currency,
      validFrom: r.valid_from,
    }));
  }

  /** Розничная цена базовой единицы (для всех точек или точки) — для списков. */
  async retailMap(tx: TenantTx, productIds: string[], storeId?: string | null): Promise<Map<string, CurrentPrice>> {
    if (!productIds.length) return new Map();
    const retail = await this.retailType(tx);
    const all = await this.current(tx, productIds);
    const map = new Map<string, CurrentPrice>();
    for (const p of all) {
      if (p.priceTypeId !== retail.id || p.unitId) continue;
      if (p.storeId && p.storeId !== storeId) continue;
      const prev = map.get(p.productId);
      // Цена точки важнее цены «для всех точек» (ТЗ 17.3)
      if (!prev || (p.storeId && !prev.storeId)) map.set(p.productId, p);
    }
    return map;
  }

  async set(tx: TenantTx, items: SetPriceInput[], reason = 'Изменение цены в карточке', audit = true): Promise<void> {
    if (!items.length) return;
    const types = await this.priceTypes(tx);
    const before = await this.current(tx, [...new Set(items.map((i) => i.productId))]);
    for (const i of items) {
      const type = types.find((t) => t.id === i.priceTypeId);
      if (!type) throw Errors.notFound('Тип цены');
      const value = D(i.price);
      if (value.isNegative()) throw Errors.bad('BAD_PRICE', 'Цена не может быть отрицательной');
      await tx.repo(Price).insert({
        priceTypeId: i.priceTypeId,
        storeId: i.storeId ?? null,
        productId: i.productId,
        unitId: i.unitId ?? null,
        price: money(value),
        currency: i.currency ?? type.currency,
        validFrom: i.validFrom ?? new Date(),
      });
    }
    if (!audit) return;
    await this.audit.log(tx, {
      action: 'price.change',
      entityType: 'product',
      entityId: items.length === 1 ? items[0].productId : null,
      summary: reason,
      before: { prices: before },
      after: { prices: items.map((i) => ({ ...i, price: String(i.price) })) },
      important: true,
    });
  }
}
