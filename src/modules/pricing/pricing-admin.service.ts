import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { applyMarkup, fromOtherPrice, pickMarkupRule, roundPrice } from '../../common/pricing-engine/engine';
import { D, money } from '../../common/utils/decimal';
import { RequestContext } from '../../common/context/request-context';
import { CountersService } from '../../database/tenant/counters.service';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { OutboxService } from '../../jobs/outbox.service';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from '../catalog/categories.service';
import { Category } from '../catalog/entities/category.entity';
import { Product } from '../catalog/entities/product.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { MarkupRule, PriceSetting, PriceSettingLine, PriceType, ShopRate } from './entities/price-type.entity';
import { Price } from './entities/price.entity';
import { PricesService } from './prices.service';

export interface PriceTypeInput {
  name?: string;
  code?: string;
  currency?: 'KGS' | 'USD';
  sort?: number;
}

export interface MarkupRuleInputDto {
  name?: string;
  priceTypeId?: string;
  priority?: number;
  categoryId?: string | null;
  brandId?: string | null;
  qualityClass?: string | null;
  costFrom?: string | null;
  costTo?: string | null;
  percent?: string;
  isActive?: boolean;
}

export interface PriceSettingLineInput {
  productId: string;
  priceTypeId: string;
  storeId?: string | null;
  unitId?: string | null;
  newPrice: string;
  currency?: string;
}

export interface PriceSettingGenerate {
  /** markup — от закупки по правилам наценки (или percent); from_type — от другого типа цены ±percent */
  method: 'markup' | 'from_type';
  priceTypeId: string;
  sourcePriceTypeId?: string;
  percent?: string;
  storeId?: string | null;
  productIds?: string[];
  categoryId?: string;
  brandId?: string;
  /** Только товары без цены этого типа */
  onlyMissing?: boolean;
}

/** Цены: типы цен, курс магазина, правила наценки, документ «Установка цен» (ТЗ 17.1–17.5). */
@Injectable()
export class PricingAdminService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly prices: PricesService,
    private readonly settings: SettingsService,
    private readonly categories: CategoriesService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Типы цен ─────────────────────────────────────────────

  listTypes() {
    return this.tenantTx.run((tx) => this.prices.priceTypes(tx));
  }

  createType(dto: PriceTypeInput) {
    return this.tenantTx.run(async (tx) => {
      if (!dto.name?.trim()) throw Errors.bad('NAME_REQUIRED', 'Укажите название');
      const code = (dto.code ?? dto.name).trim().toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '_').slice(0, 40);
      if (await tx.repo(PriceType).count({ where: { code } })) throw Errors.conflict('DUPLICATE', 'Такой тип цены уже есть');
      const t = await tx.repo(PriceType).insert({ name: dto.name.trim(), code, currency: dto.currency ?? 'KGS', sort: dto.sort ?? 100 });
      await this.audit.log(tx, { action: 'price_type.create', entityType: 'price_type', entityId: t.id, summary: t.name });
      return t;
    });
  }

  updateType(id: string, version: number, dto: PriceTypeInput) {
    return this.tenantTx.run(async (tx) => {
      const t = await tx.repo(PriceType, 'Тип цены').getForUpdate(id, version);
      if (dto.currency && dto.currency !== t.currency) {
        const used = await tx.repo(Price).count({ where: { priceTypeId: id } });
        if (used) throw Errors.conflict('PRICE_TYPE_USED', 'У типа уже есть цены — валюту не поменять. Создайте новый тип цены');
        t.currency = dto.currency;
      }
      if (dto.name) t.name = dto.name.trim();
      if (dto.sort !== undefined) t.sort = dto.sort;
      await tx.repo(PriceType).save(t);
      await this.audit.log(tx, { action: 'price_type.update', entityType: 'price_type', entityId: t.id, summary: t.name });
      return t;
    });
  }

  removeType(id: string, version: number) {
    return this.tenantTx.run(async (tx) => {
      const t = await tx.repo(PriceType, 'Тип цены').getForUpdate(id, version);
      if (t.isSystem || t.isRetail) throw Errors.conflict('SYSTEM_PRICE_TYPE', 'Системный тип цены не удаляется');
      const [{ n }] = await tx.query(
        `SELECT (SELECT count(*) FROM counterparties WHERE tenant_id = $1 AND price_type_id = $2 AND deleted_at IS NULL)
              + (SELECT count(*) FROM counterparty_groups WHERE tenant_id = $1 AND price_type_id = $2 AND deleted_at IS NULL) AS n`,
        [tx.tenantId, id],
      );
      if (Number(n)) throw Errors.conflict('PRICE_TYPE_USED', 'Тип цены назначен клиентам или группам');
      await tx.repo(PriceType).softDelete(t.id);
      await this.audit.log(tx, { action: 'price_type.delete', entityType: 'price_type', entityId: t.id, summary: t.name });
    });
  }

  // ── Курс магазина (ТЗ 17.2) ──────────────────────────────

  rates() {
    return this.tenantTx.run(async (tx) => {
      const current = await tx.query(
        `SELECT DISTINCT ON (currency) currency, rate, created_at AS "setAt", created_by AS "setBy"
           FROM shop_rates WHERE tenant_id = $1 ORDER BY currency, created_at DESC`,
        [tx.tenantId],
      );
      const history = await tx.query(
        `SELECT r.currency, r.rate, r.note, r.created_at AS "setAt", u.name AS "setByName"
           FROM shop_rates r LEFT JOIN users u ON u.id = r.created_by
          WHERE r.tenant_id = $1 ORDER BY r.created_at DESC LIMIT 30`,
        [tx.tenantId],
      );
      return { current, history };
    });
  }

  /** Владелец ставит курс одной кнопкой — сразу уходит на все кассы. Цены в долларах не меняются. */
  setRate(currency: string, rate: string, note?: string) {
    return this.tenantTx.run(async (tx) => {
      const r = D(rate);
      if (r.lte(0) || r.gt(100000)) throw Errors.bad('BAD_RATE', 'Неверный курс');
      const prev = await tx.repo(ShopRate).findOne({ where: { currency }, order: { createdAt: 'DESC' } });
      const row = await tx.repo(ShopRate).insert({ currency, rate: r, note: note ?? null });
      await this.audit.log(tx, {
        action: 'rate.set',
        entityType: 'shop_rate',
        entityId: row.id,
        summary: `Курс ${currency}: ${prev ? prev.rate.toFixed(2) + ' → ' : ''}${r.toFixed(2)}`,
        before: prev ? { rate: prev.rate.toFixed() } : null,
        after: { rate: r.toFixed() },
        important: true,
      });
      await this.outbox.emit(tx, 'rate.changed', { currency, rate: r.toFixed(), at: row.createdAt });
      await this.notifications.notify(tx, {
        type: 'rate.changed',
        title: `Курс магазина ${currency}: ${r.toFixed(2)}`,
        permission: 'pos.use',
        excludeUserId: tx.userId,
      });
      return { currency, rate: r.toFixed(), setAt: row.createdAt };
    });
  }

  // ── Правила наценки (ТЗ 17.4) ────────────────────────────

  listRules() {
    return this.tenantTx.run((tx) => tx.repo(MarkupRule).find({ order: { priority: 'DESC', createdAt: 'ASC' } }));
  }

  createRule(dto: MarkupRuleInputDto) {
    return this.tenantTx.run(async (tx) => {
      if (!dto.priceTypeId || dto.percent === undefined) throw Errors.bad('RULE_INVALID', 'Укажите тип цены и наценку');
      await this.validateRule(tx, dto);
      const r = await tx.repo(MarkupRule).insert({
        name: dto.name?.trim() || this.ruleName(dto),
        priceTypeId: dto.priceTypeId,
        priority: dto.priority ?? 0,
        categoryId: dto.categoryId ?? null,
        brandId: dto.brandId ?? null,
        qualityClass: dto.qualityClass ?? null,
        costFrom: dto.costFrom ? D(dto.costFrom) : null,
        costTo: dto.costTo ? D(dto.costTo) : null,
        percent: D(dto.percent).toFixed(),
        isActive: dto.isActive ?? true,
      });
      await this.audit.log(tx, { action: 'markup.create', entityType: 'markup_rule', entityId: r.id, summary: r.name });
      return r;
    });
  }

  updateRule(id: string, version: number, dto: MarkupRuleInputDto) {
    return this.tenantTx.run(async (tx) => {
      const r = await tx.repo(MarkupRule, 'Правило наценки').getForUpdate(id, version);
      await this.validateRule(tx, { ...r, ...dto, percent: dto.percent ?? r.percent } as any);
      if (dto.name !== undefined) r.name = dto.name;
      if (dto.priceTypeId) r.priceTypeId = dto.priceTypeId;
      if (dto.priority !== undefined) r.priority = dto.priority;
      if (dto.categoryId !== undefined) r.categoryId = dto.categoryId;
      if (dto.brandId !== undefined) r.brandId = dto.brandId;
      if (dto.qualityClass !== undefined) r.qualityClass = dto.qualityClass;
      if (dto.costFrom !== undefined) r.costFrom = dto.costFrom ? D(dto.costFrom) : null;
      if (dto.costTo !== undefined) r.costTo = dto.costTo ? D(dto.costTo) : null;
      if (dto.percent !== undefined) r.percent = D(dto.percent).toFixed();
      if (dto.isActive !== undefined) r.isActive = dto.isActive;
      await tx.repo(MarkupRule).save(r);
      return r;
    });
  }

  removeRule(id: string, version: number) {
    return this.tenantTx.run(async (tx) => {
      const r = await tx.repo(MarkupRule, 'Правило наценки').getForUpdate(id, version);
      await tx.repo(MarkupRule).softDelete(r.id);
    });
  }

  private ruleName(dto: MarkupRuleInputDto) {
    const range = dto.costFrom || dto.costTo ? ` ${dto.costFrom ?? 0}–${dto.costTo ?? '∞'} сом` : '';
    return `+${dto.percent}%${range}`;
  }

  private async validateRule(tx: TenantTx, dto: MarkupRuleInputDto) {
    await tx.repo(PriceType, 'Тип цены').getById(dto.priceTypeId!);
    if (dto.categoryId) await tx.repo(Category, 'Категория').getById(dto.categoryId);
    if (D(dto.percent ?? 0).lte(-100)) throw Errors.bad('BAD_PERCENT', 'Наценка меньше −100%');
    if (dto.costFrom && dto.costTo && D(dto.costFrom).gte(dto.costTo)) throw Errors.bad('BAD_RANGE', '«От» должно быть меньше «до»');
  }

  /** Цена от закупки по правилам наценки для товаров (без сохранения). */
  async suggest(tx: TenantTx, productIds: string[], priceTypeId: string, percent?: string) {
    const products = await tx.repo(Product, 'Товар').getByIds(productIds);
    const rules = (await tx.repo(MarkupRule).find({ where: { priceTypeId, isActive: true } })).map((r) => ({
      ...r,
      categoryIds: r.categoryId ? [r.categoryId] : null,
      costFrom: r.costFrom?.toFixed() ?? null,
      costTo: r.costTo?.toFixed() ?? null,
    }));
    const costs = await this.purchaseCosts(tx, productIds);
    const s = await this.settings.get(tx);
    const result = [];
    for (const p of products) {
      const cost = costs.get(p.id);
      if (!cost || D(cost).lte(0)) {
        result.push({ productId: p.id, cost: null, ruleId: null, percent: null, price: null, reason: 'Нет закупочной цены' });
        continue;
      }
      const path = p.categoryId ? await this.categoryPath(tx, p.categoryId) : [];
      const rule = percent === undefined ? pickMarkupRule(rules, { categoryPath: path, brandId: p.brandId, qualityClass: p.qualityClass, cost }) : null;
      const pct = percent ?? rule?.percent ?? null;
      if (pct === null) {
        result.push({ productId: p.id, cost, ruleId: null, percent: null, price: null, reason: 'Нет подходящего правила наценки' });
        continue;
      }
      result.push({ productId: p.id, cost, ruleId: rule?.id ?? null, percent: String(pct), price: applyMarkup(cost, pct, s.priceRounding) });
    }
    return result;
  }

  /** Закупочная цена за базовую единицу: последняя закупка, иначе средняя себестоимость. */
  private async purchaseCosts(tx: TenantTx, productIds: string[]): Promise<Map<string, string>> {
    if (!productIds.length) return new Map();
    const rows = await tx.query<{ product_id: string; cost: string }>(
      `SELECT product_id, CASE WHEN coalesce(last_unit_cost, 0) > 0 THEN last_unit_cost
                               WHEN qty > 0 THEN cost_amount / qty ELSE NULL END AS cost
         FROM product_costs WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])`,
      [tx.tenantId, productIds],
    );
    return new Map(rows.filter((r) => r.cost !== null).map((r) => [r.product_id, D(r.cost).toDecimalPlaces(6).toFixed()]));
  }

  private async categoryPath(tx: TenantTx, categoryId: string): Promise<string[]> {
    const key = `catpath:${categoryId}`;
    if (tx.memo.has(key)) return tx.memo.get(key) as string[];
    const c = await tx.repo(Category).findById(categoryId);
    const path = c ? c.path.split('/').filter(Boolean) : [];
    if (c && !path.includes(c.id)) path.push(c.id);
    tx.memo.set(key, path);
    return path;
  }

  // ── Установка цен (ТЗ 17.4) ──────────────────────────────

  listSettings(q: { status?: string; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      let w = 's.tenant_id = $1 AND s.deleted_at IS NULL';
      if (q.status) {
        params.push(q.status);
        w += ` AND s.status = $2`;
      }
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM price_settings s WHERE ${w}`, params);
      const items = await tx.query(
        `SELECT s.id, s.number, s.status, s.valid_from AS "validFrom", s.comment, s.posted_at AS "postedAt", s.version,
                (SELECT count(*)::int FROM price_setting_lines l WHERE l.tenant_id = s.tenant_id AND l.price_setting_id = s.id) AS "linesCount"
           FROM price_settings s WHERE ${w} ORDER BY s.created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total };
    });
  }

  createSetting(dto: { validFrom?: string; comment?: string; lines?: PriceSettingLineInput[]; generate?: PriceSettingGenerate }) {
    return this.tenantTx.run(async (tx) => {
      const validFrom = dto.validFrom ? new Date(dto.validFrom) : new Date();
      const year = validFrom.getUTCFullYear();
      const n = await this.counters.next(tx, `doc:price_setting:${year}`);
      const doc = await tx.repo(PriceSetting).insert({
        number: `УЦ-${year}-${String(n).padStart(6, '0')}`,
        validFrom,
        comment: dto.comment ?? null,
        status: 'draft',
      });
      const lines = [...(dto.lines ?? [])];
      if (dto.generate) lines.push(...(await this.generate(tx, dto.generate)));
      await this.replaceSettingLines(tx, doc.id, lines);
      return this.viewSetting(tx, doc.id);
    });
  }

  getSetting(id: string) {
    return this.tenantTx.run((tx) => this.viewSetting(tx, id));
  }

  updateSetting(id: string, version: number, dto: { validFrom?: string; comment?: string; lines?: PriceSettingLineInput[]; generate?: PriceSettingGenerate }) {
    return this.tenantTx.run(async (tx) => {
      const doc = await tx.repo(PriceSetting, 'Установка цен').getForUpdate(id, version);
      if (doc.status !== 'draft') throw Errors.conflict('ALREADY_POSTED', 'Установка цен уже проведена — создайте новую');
      if (dto.validFrom) doc.validFrom = new Date(dto.validFrom);
      if (dto.comment !== undefined) doc.comment = dto.comment;
      await tx.repo(PriceSetting).save(doc);
      if (dto.lines || dto.generate) {
        const lines = [...(dto.lines ?? [])];
        if (dto.generate) lines.push(...(await this.generate(tx, dto.generate)));
        await this.replaceSettingLines(tx, doc.id, lines);
      }
      return this.viewSetting(tx, doc.id);
    });
  }

  removeSetting(id: string, version: number) {
    return this.tenantTx.run(async (tx) => {
      const doc = await tx.repo(PriceSetting, 'Установка цен').getForUpdate(id, version);
      if (doc.status !== 'draft') throw Errors.conflict('ALREADY_POSTED', 'Проведённую установку цен не удалить');
      await tx.repo(PriceSettingLine).hardDelete({ priceSettingId: doc.id });
      await tx.repo(PriceSetting).softDelete(doc.id);
    });
  }

  /** Провести: цены с датой начала действия; будущие включатся сами. Возвращает список для перепечатки ценников. */
  postSetting(id: string, version: number) {
    return this.tenantTx.run(async (tx) => {
      const doc = await tx.repo(PriceSetting, 'Установка цен').getForUpdate(id, version);
      if (doc.status !== 'draft') throw Errors.conflict('ALREADY_POSTED', 'Уже проведена');
      const lines = await tx.repo(PriceSettingLine).find({ where: { priceSettingId: doc.id } });
      if (!lines.length) throw Errors.bad('NO_LINES', 'Нет строк');
      const validFrom = doc.validFrom.getTime() < Date.now() ? new Date() : doc.validFrom;
      await tx.repo(Price).insertMany(
        lines.map((l) => ({
          priceTypeId: l.priceTypeId,
          storeId: l.storeId,
          productId: l.productId,
          unitId: l.unitId,
          price: money(l.newPrice),
          currency: l.currency,
          validFrom,
          documentId: doc.id,
        })),
      );
      doc.status = 'posted';
      doc.postedAt = new Date();
      doc.postedBy = tx.userId;
      doc.validFrom = validFrom;
      await tx.repo(PriceSetting).save(doc);
      await this.audit.log(tx, {
        action: 'price_setting.post',
        entityType: 'price_setting',
        entityId: doc.id,
        summary: `Установка цен ${doc.number}: ${lines.length} строк, с ${validFrom.toISOString()}`,
        important: true,
      });
      await this.outbox.emit(tx, 'prices.changed', { priceSettingId: doc.id, validFrom, productIds: [...new Set(lines.map((l) => l.productId))] });
      const view = await this.viewSetting(tx, doc.id);
      return { ...view, relabel: [...new Set(lines.filter((l) => !l.oldPrice || !l.oldPrice.eq(l.newPrice)).map((l) => l.productId))] };
    });
  }

  private async generate(tx: TenantTx, g: PriceSettingGenerate): Promise<PriceSettingLineInput[]> {
    const type = await tx.repo(PriceType, 'Тип цены').getById(g.priceTypeId);
    const params: unknown[] = [tx.tenantId];
    const w = [`p.tenant_id = $1`, `p.deleted_at IS NULL`, `p.status = 'active'`, `p.kind <> 'service'`];
    if (g.productIds?.length) {
      params.push(g.productIds);
      w.push(`p.id = ANY($${params.length}::uuid[])`);
    }
    if (g.categoryId) {
      params.push(await this.categories.subtreeIds(tx, g.categoryId));
      w.push(`p.category_id = ANY($${params.length}::uuid[])`);
    }
    if (g.brandId) {
      params.push(g.brandId);
      w.push(`p.brand_id = $${params.length}`);
    }
    if (!g.productIds?.length && !g.categoryId && !g.brandId) throw Errors.bad('FILTER_REQUIRED', 'Выберите товары, категорию или бренд');
    const rows = await tx.query<{ id: string }>(`SELECT p.id FROM products p WHERE ${w.join(' AND ')} LIMIT 5001`, params);
    if (rows.length > 5000) throw Errors.bad('TOO_MANY', 'Больше 5000 товаров — сузьте выбор');
    const ids = rows.map((r) => r.id);
    const current = await this.prices.current(tx, ids);
    const has = (pid: string, typeId: string) =>
      current.find((c) => c.productId === pid && c.priceTypeId === typeId && !c.unitId && (c.storeId ?? null) === (g.storeId ?? null));
    const s = await this.settings.get(tx);
    const out: PriceSettingLineInput[] = [];
    if (g.method === 'markup') {
      const sug = await this.suggest(tx, ids, g.priceTypeId, g.percent);
      for (const x of sug) {
        if (!x.price) continue;
        if (g.onlyMissing && has(x.productId, g.priceTypeId)) continue;
        // Тип цены в долларах: закупка в сомах → цена в долларах по курсу
        let price = x.price;
        if (type.currency !== 'KGS') {
          const rate = await tx.repo(ShopRate).findOne({ where: { currency: type.currency }, order: { createdAt: 'DESC' } });
          if (!rate) throw Errors.bad('NO_RATE', `Не задан курс магазина ${type.currency}`);
          price = D(price).div(rate.rate).toDecimalPlaces(2).toFixed(2);
        }
        out.push({ productId: x.productId, priceTypeId: g.priceTypeId, storeId: g.storeId ?? null, newPrice: price, currency: type.currency });
      }
    } else {
      if (!g.sourcePriceTypeId) throw Errors.bad('SOURCE_REQUIRED', 'Укажите тип цены-основу');
      const source = await tx.repo(PriceType, 'Тип цены').getById(g.sourcePriceTypeId);
      if (source.currency !== type.currency) throw Errors.bad('CURRENCY_MISMATCH', 'Типы цен в разных валютах');
      for (const pid of ids) {
        const src = has(pid, source.id) ?? current.find((c) => c.productId === pid && c.priceTypeId === source.id && !c.unitId && !c.storeId);
        if (!src) continue;
        if (g.onlyMissing && has(pid, g.priceTypeId)) continue;
        const price = type.currency === 'KGS' ? fromOtherPrice(src.price, g.percent ?? 0, s.priceRounding) : D(src.price).mul(D(100).plus(g.percent ?? 0)).div(100).toDecimalPlaces(2).toFixed(2);
        out.push({ productId: pid, priceTypeId: g.priceTypeId, storeId: g.storeId ?? null, newPrice: price, currency: type.currency });
      }
    }
    return out.map((l) => ({ ...l, method: g.method }) as any);
  }

  private async replaceSettingLines(tx: TenantTx, docId: string, input: (PriceSettingLineInput & { method?: string })[]) {
    const types = await this.prices.priceTypes(tx);
    const ids = [...new Set(input.map((l) => l.productId))];
    await tx.repo(Product, 'Товар').getByIds(ids);
    const current = await this.prices.current(tx, ids);
    const s = await this.settings.get(tx);
    // Последняя строка по ключу выигрывает
    const byKey = new Map<string, PriceSettingLineInput & { method?: string }>();
    for (const l of input) byKey.set(`${l.productId}|${l.priceTypeId}|${l.storeId ?? ''}|${l.unitId ?? ''}`, l);
    const rows = [...byKey.values()].map((l) => {
      const type = types.find((t) => t.id === l.priceTypeId);
      if (!type) throw Errors.notFound('Тип цены');
      const v = D(l.newPrice);
      if (v.isNegative()) throw Errors.bad('BAD_PRICE', 'Цена не может быть отрицательной');
      const old = current.find((c) => c.productId === l.productId && c.priceTypeId === l.priceTypeId && (c.storeId ?? null) === (l.storeId ?? null) && (c.unitId ?? null) === (l.unitId ?? null));
      const currency = l.currency ?? type.currency;
      return {
        priceSettingId: docId,
        productId: l.productId,
        priceTypeId: l.priceTypeId,
        storeId: l.storeId ?? null,
        unitId: l.unitId ?? null,
        oldPrice: old ? D(old.price) : null,
        newPrice: currency === 'KGS' && l.method ? D(roundPrice(v, s.priceRounding)) : money(v),
        currency,
        method: l.method ?? 'manual',
      };
    });
    await tx.repo(PriceSettingLine).hardDelete({ priceSettingId: docId });
    if (rows.length) await tx.repo(PriceSettingLine).insertMany(rows);
  }

  private async viewSetting(tx: TenantTx, id: string) {
    const doc = await tx.repo(PriceSetting, 'Установка цен').getById(id);
    const canCost = this.ctx.can('products.view_cost');
    const lines = await tx.query(
      `SELECT l.id, l.product_id AS "productId", p.name AS "productName", p.sku, l.price_type_id AS "priceTypeId", t.name AS "priceTypeName",
              l.store_id AS "storeId", l.unit_id AS "unitId", l.old_price AS "oldPrice", l.new_price AS "newPrice", l.currency, l.method,
              CASE WHEN l.old_price > 0 THEN round((l.new_price - l.old_price) * 100 / l.old_price, 1) END AS "changePercent"
              ${canCost ? `, (SELECT CASE WHEN coalesce(c.last_unit_cost,0) > 0 THEN c.last_unit_cost WHEN c.qty > 0 THEN round(c.cost_amount / c.qty, 2) END FROM product_costs c WHERE c.tenant_id = l.tenant_id AND c.product_id = l.product_id) AS "cost"` : ''}
         FROM price_setting_lines l JOIN products p ON p.id = l.product_id JOIN price_types t ON t.id = l.price_type_id
        WHERE l.tenant_id = $1 AND l.price_setting_id = $2 ORDER BY p.name`,
      [tx.tenantId, id],
    );
    return { ...doc, lines };
  }
}
