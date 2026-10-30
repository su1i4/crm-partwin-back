import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { allowedBonus, loyaltyLevel, PromoLine, PromoRule, promoDiscounts } from '../../common/pricing-engine/engine';
import { ean13CheckDigit } from '../../common/utils/barcode';
import { localDateString } from '../../common/utils/dates';
import { D, Decimal, money } from '../../common/utils/decimal';
import { CountersService } from '../../database/tenant/counters.service';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { Tenant } from '../tenants/entities/tenant.entity';
import { BonusEntry, LoyaltyCard, PromoCode, Promotion } from './entities/loyalty.entity';

export interface PromoRowInput {
  productId: string;
  qty: string;
  price: string;
  excluded: boolean;
}

/**
 * Акции, промокоды, карты и бонусы (ТЗ 17.6–17.7).
 * Порядок расчёта чека: цена (персональная / тип цены) → акции → ручная скидка → бонусы → проверка минимальной цены.
 */
@Injectable()
export class LoyaltyService implements OnModuleInit {
  private readonly log = new Logger('Loyalty');

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly settings: SettingsService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    private readonly registry: OutboxRegistry,
    private readonly jobs: JobsService,
    private readonly platform: PlatformDb,
  ) {}

  async onModuleInit() {
    // Чек оплачен / возврат проведён → бонусы (после COMMIT; повтор события не задваивает — уникальный ключ)
    this.registry.on('receipt.completed', async (e) => {
      await this.tenantTx
        .run((tx) => this.onReceipt(tx, e.payload.receiptId), { tenantId: e.tenantId, userId: null })
        .catch((err) => this.log.warn(`бонусы по чеку ${e.payload.receiptId}: ${err.message}`));
    });
    await this.jobs.work('loyalty.expire', async () => {
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) await this.tenantTx.run((tx) => this.expire(tx), { tenantId: t.id, userId: null }).catch(() => undefined);
    });
    await this.jobs.schedule('loyalty.expire', '20 4 * * *');
  }

  // ── Акции в чеке ─────────────────────────────────────────

  /** Действующие акции точки на сегодня (+ акция по промокоду). */
  async activePromos(tx: TenantTx, storeId: string, promoCode?: string | null): Promise<(PromoRule & { name: string })[]> {
    const today = localDateString(new Date());
    const rows = await tx.query(
      `SELECT p.* FROM promotions p
        WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.is_active AND (p.starts_on IS NULL OR p.starts_on <= $2) AND (p.ends_on IS NULL OR p.ends_on >= $2)
          AND (jsonb_array_length(p.store_ids) = 0 OR p.store_ids ? $3::text)
          AND (NOT p.by_code OR EXISTS (SELECT 1 FROM promo_codes c WHERE c.tenant_id = p.tenant_id AND c.promotion_id = p.id AND c.is_active
                                         AND upper(c.code) = upper($4) AND (c.max_uses IS NULL OR c.used_count < c.max_uses)))`,
      [tx.tenantId, today, storeId, promoCode ?? ''],
    );
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      percent: String(r.percent),
      minAmount: r.min_amount,
      categoryIds: r.category_ids,
      brandIds: r.brand_ids,
      qualityClasses: r.quality_classes,
      makeIds: r.make_ids,
      productIds: r.product_ids,
      stackable: r.stackable,
    }));
  }

  /** Скидки акций по строкам чека (с постоянной скидкой клиента как несуммируемой акцией). */
  async promoForLines(tx: TenantTx, storeId: string, promoCode: string | null, rows: PromoRowInput[], clientPercent: Decimal) {
    const promos = await this.activePromos(tx, storeId, promoCode);
    if (!promos.length && clientPercent.lte(0)) return { amounts: rows.map(() => null as string | null), applied: [] as { id: string; name: string }[] };
    const ids = [...new Set(rows.map((r) => r.productId))];
    const info = new Map<string, any>();
    if (promos.length && ids.length) {
      const ps = await tx.query(
        `SELECT p.id, p.brand_id, p.quality_class, c.id AS category_id, c.path,
                coalesce((SELECT array_agg(DISTINCT a.make_id::text) FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id), '{}') AS makes
           FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[])`,
        [tx.tenantId, ids],
      );
      for (const p of ps) info.set(p.id, p);
    }
    const lines: PromoLine[] = rows.map((r, i) => {
      const p = info.get(r.productId);
      const cats = p?.category_id ? [p.category_id, ...String(p.path ?? '').split('/').filter(Boolean)] : [];
      return { key: String(i), qty: r.qty, price: r.price, productId: r.productId, categoryIds: cats, brandId: p?.brand_id ?? null, qualityClass: p?.quality_class ?? null, makeIds: p?.makes ?? [], excluded: r.excluded };
    });
    const res = promoDiscounts(lines, promos, clientPercent);
    const used = new Set(res.flatMap((r) => r.promoIds));
    return {
      amounts: res.map((r) => (D(r.amount).gt(0) ? r.amount : null)),
      applied: promos.filter((p) => used.has(p.id)).map((p) => ({ id: p.id, name: p.name })),
    };
  }

  /** Проверить промокод при вводе в чек. */
  async checkCode(tx: TenantTx, code: string) {
    const [c] = await tx.query(
      `SELECT c.*, p.name FROM promo_codes c JOIN promotions p ON p.id = c.promotion_id
        WHERE c.tenant_id = $1 AND upper(c.code) = upper($2) AND c.is_active AND p.is_active AND p.deleted_at IS NULL`,
      [tx.tenantId, code.trim()],
    );
    if (!c) throw Errors.bad('PROMO_NOT_FOUND', 'Промокод не найден');
    if (c.max_uses !== null && c.used_count >= c.max_uses) throw Errors.bad('PROMO_USED', 'Промокод уже использован');
    return c.code as string;
  }

  // ── Бонусы ───────────────────────────────────────────────

  async balance(tx: TenantTx, counterpartyId: string): Promise<Decimal> {
    const [r] = await tx.query(`SELECT coalesce(sum(amount), 0) AS s FROM bonus_entries WHERE tenant_id = $1 AND counterparty_id = $2`, [tx.tenantId, counterpartyId]);
    return money(r.s);
  }

  /** Сколько бонусов можно списать в этом чеке. */
  async bonusCap(tx: TenantTx, counterpartyId: string | null, requested: Decimal, totalAfterDiscounts: Decimal): Promise<Decimal> {
    if (!counterpartyId || requested.lte(0)) return D(0);
    const s = await this.settings.get(tx);
    if (!s.loyaltyEnabled) throw Errors.bad('LOYALTY_OFF', 'Бонусы в магазине не включены');
    const bal = await this.balance(tx, counterpartyId);
    return D(allowedBonus(requested, bal, totalAfterDiscounts, s.bonusMaxPayPercent));
  }

  private async percentFor(tx: TenantTx, counterpartyId: string) {
    const s = await this.settings.get(tx);
    if (!s.loyaltyLevels?.length) return { percent: D(s.bonusAccrualPercent), level: null as string | null };
    const [r] = await tx.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'sale' THEN total ELSE -total END), 0) AS spent FROM receipts WHERE tenant_id = $1 AND customer_id = $2 AND status = 'completed'`,
      [tx.tenantId, counterpartyId],
    );
    const lvl = loyaltyLevel(s.loyaltyLevels, r.spent);
    return { percent: D(lvl?.percent ?? s.bonusAccrualPercent), level: lvl?.name ?? null };
  }

  /** Начисление и списание по чеку; возврат — обратно пропорционально. */
  async onReceipt(tx: TenantTx, receiptId: string) {
    const s = await this.settings.get(tx);
    const [r] = await tx.query(
      `SELECT r.id, r.kind, r.customer_id, r.total, r.bonus_amount, r.promo_code, r.original_receipt_id, r.document_id FROM receipts r WHERE r.tenant_id = $1 AND r.id = $2`,
      [tx.tenantId, receiptId],
    );
    if (!r) return;
    // Промокод использован
    if (r.kind === 'sale' && r.promo_code) {
      await tx.query(`UPDATE promo_codes SET used_count = used_count + 1 WHERE tenant_id = $1 AND upper(code) = upper($2)`, [tx.tenantId, r.promo_code]);
    }
    if (!r.customer_id || !s.loyaltyEnabled) return;
    const card = await tx.repo(LoyaltyCard).findOne({ where: { counterpartyId: r.customer_id, isActive: true } });
    if (!card) return;
    if (r.kind === 'sale') {
      const bonusPaid = money(r.bonus_amount ?? 0);
      if (bonusPaid.gt(0)) await this.spend(tx, r.customer_id, bonusPaid, r.id);
      const { percent } = await this.percentFor(tx, r.customer_id);
      const base = money(r.total);
      const accrual = money(base.mul(percent).div(100));
      if (accrual.gt(0)) {
        await tx.repo(BonusEntry).insert({
          counterpartyId: r.customer_id,
          kind: 'accrual',
          amount: accrual,
          remaining: accrual,
          receiptId: r.id,
          expiresAt: s.bonusExpireDays ? new Date(Date.now() + s.bonusExpireDays * 86400000) : null,
          comment: `Начислено ${percent.toFixed(2)}% за чек`,
        });
      }
    } else if (r.original_receipt_id) {
      // Возврат: снять начисленное пропорционально и вернуть списанные бонусы строк
      const [orig] = await tx.query(`SELECT total FROM receipts WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, r.original_receipt_id]);
      const [acc] = await tx.query(`SELECT amount FROM bonus_entries WHERE tenant_id = $1 AND receipt_id = $2 AND kind = 'accrual'`, [tx.tenantId, r.original_receipt_id]);
      const share = orig && D(orig.total).gt(0) ? Decimal.min(1, D(r.total).abs().div(orig.total)) : D(0);
      const reverse = acc ? money(D(acc.amount).mul(share)) : D(0);
      if (reverse.gt(0)) await this.spend(tx, r.customer_id, reverse, r.id, 'reverse');
      const [bp] = await tx.query(`SELECT coalesce(sum(bonus_paid), 0) AS s FROM document_lines WHERE tenant_id = $1 AND document_id = $2`, [tx.tenantId, r.document_id]);
      const refund = money(D(bp.s).abs());
      if (refund.gt(0)) await tx.repo(BonusEntry).insert({ counterpartyId: r.customer_id, kind: 'refund', amount: refund, remaining: refund, receiptId: r.id, expiresAt: null, comment: 'Возврат бонусов по возврату товара' });
    }
  }

  /** Списать: по очереди из самых ранних начислений. */
  private async spend(tx: TenantTx, counterpartyId: string, amount: Decimal, receiptId: string | null, kind: 'spend' | 'reverse' | 'manual' = 'spend', comment?: string) {
    let rest = amount;
    const lots = await tx.query(
      `SELECT id, remaining FROM bonus_entries WHERE tenant_id = $1 AND counterparty_id = $2 AND remaining > 0 ORDER BY coalesce(expires_at, 'infinity'), created_at FOR UPDATE`,
      [tx.tenantId, counterpartyId],
    );
    for (const l of lots) {
      if (rest.lte(0)) break;
      const take = Decimal.min(rest, D(l.remaining));
      await tx.query(`UPDATE bonus_entries SET remaining = remaining - $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, l.id, take.toFixed(2)]);
      rest = rest.minus(take);
    }
    await tx.repo(BonusEntry).insert({ counterpartyId, kind, amount: amount.neg(), remaining: D(0), receiptId, expiresAt: null, comment: comment ?? null });
  }

  /** Сгорание просроченных бонусов (ночью). */
  async expire(tx: TenantTx) {
    const rows = await tx.query(
      `SELECT id, counterparty_id, remaining FROM bonus_entries WHERE tenant_id = $1 AND remaining > 0 AND expires_at < now() FOR UPDATE`,
      [tx.tenantId],
    );
    for (const r of rows) {
      await tx.query(`UPDATE bonus_entries SET remaining = 0 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, r.id]);
      await tx.repo(BonusEntry).insert({ counterpartyId: r.counterparty_id, kind: 'expire', amount: money(r.remaining).neg(), remaining: D(0), receiptId: null, expiresAt: null, comment: 'Сгорели по сроку' });
    }
    return { expired: rows.length };
  }

  // ── Карты ────────────────────────────────────────────────

  /** Выдать карту клиенту (номер — внутренний EAN-13 с префиксом 27, печатается штрихкодом и QR). */
  issueCard(counterpartyId: string, number?: string) {
    return this.tenantTx.run(async (tx) => {
      await tx.query(`SELECT 1 FROM counterparties WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, counterpartyId]).then((r) => {
        if (!r.length) throw Errors.notFound('Клиент');
      });
      const existing = await tx.repo(LoyaltyCard).findOne({ where: { counterpartyId } });
      if (existing) return existing;
      let num = number?.replace(/\s/g, '');
      if (!num) {
        const n = await this.counters.next(tx, 'loyalty_card');
        const body = `27${String(n).padStart(10, '0')}`;
        num = body + ean13CheckDigit(body);
      }
      const card = await tx.repo(LoyaltyCard).insert({ counterpartyId, number: num });
      await this.audit.log(tx, { action: 'loyalty.card_issue', entityType: 'counterparty', entityId: counterpartyId, summary: `Карта ${num}` });
      return card;
    });
  }

  card(counterpartyId: string) {
    return this.tenantTx.run((tx) => this.cardInTx(tx, counterpartyId));
  }

  async cardInTx(tx: TenantTx, counterpartyId: string) {
    const card = await tx.repo(LoyaltyCard).findOne({ where: { counterpartyId } });
    const bal = await this.balance(tx, counterpartyId);
    const { percent, level } = await this.percentFor(tx, counterpartyId);
    const history = await tx.query(
      `SELECT id, kind, amount, receipt_id AS "receiptId", expires_at AS "expiresAt", comment, created_at AS "createdAt" FROM bonus_entries
        WHERE tenant_id = $1 AND counterparty_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [tx.tenantId, counterpartyId],
    );
    const [soon] = await tx.query(
      `SELECT coalesce(sum(remaining), 0) AS s, min(expires_at) AS at FROM bonus_entries WHERE tenant_id = $1 AND counterparty_id = $2 AND remaining > 0 AND expires_at < now() + interval '30 days'`,
      [tx.tenantId, counterpartyId],
    );
    return { card, balance: bal.toFixed(2), level, accrualPercent: percent.toFixed(2), expiringSoon: { amount: money(soon.s).toFixed(2), at: soon.at }, history };
  }

  findByNumber(number: string) {
    return this.tenantTx.run(async (tx) => {
      const card = await tx.repo(LoyaltyCard).findOne({ where: { number: number.replace(/\s/g, '') } });
      if (!card) throw Errors.notFound('Карта');
      return this.cardInTx(tx, card.counterpartyId);
    });
  }

  adjust(counterpartyId: string, amount: string, comment: string) {
    if (!this.ctx.isOwner && !this.ctx.can('customers.bonuses')) throw Errors.forbidden();
    return this.tenantTx.run(async (tx) => {
      const a = money(amount);
      if (a.isZero()) throw Errors.bad('BAD_AMOUNT', 'Сумма не может быть нулевой');
      if (a.gt(0)) await tx.repo(BonusEntry).insert({ counterpartyId, kind: 'manual', amount: a, remaining: a, receiptId: null, expiresAt: null, comment });
      else {
        const bal = await this.balance(tx, counterpartyId);
        if (bal.lt(a.abs())) throw Errors.bad('BONUS_NOT_ENOUGH', `На карте ${bal.toFixed(2)}`);
        await this.spend(tx, counterpartyId, a.abs(), null, 'manual', comment);
      }
      await this.audit.log(tx, { action: 'loyalty.adjust', entityType: 'counterparty', entityId: counterpartyId, summary: `Бонусы ${a.toFixed(2)}: ${comment}`, important: true });
      return this.cardInTx(tx, counterpartyId);
    });
  }

  /** Бонусы на картах — обязательство магазина (ТЗ 17.7). */
  liability() {
    return this.tenantTx.run(async (tx) => {
      const [r] = await tx.query(
        `SELECT coalesce(sum(amount), 0) AS total, count(DISTINCT counterparty_id) FILTER (WHERE true)::int AS customers FROM bonus_entries WHERE tenant_id = $1`,
        [tx.tenantId],
      );
      const [m] = await tx.query(
        `SELECT coalesce(sum(-amount) FILTER (WHERE kind = 'spend'), 0) AS spent, coalesce(sum(-amount) FILTER (WHERE kind = 'expire'), 0) AS expired,
                coalesce(sum(amount) FILTER (WHERE kind = 'accrual'), 0) AS accrued
           FROM bonus_entries WHERE tenant_id = $1 AND created_at > date_trunc('month', now())`,
        [tx.tenantId],
      );
      return { onCards: money(r.total).toFixed(2), customers: r.customers, thisMonth: { accrued: money(m.accrued).toFixed(2), spent: money(m.spent).toFixed(2), expired: money(m.expired).toFixed(2) } };
    });
  }

  // ── Акции и промокоды (CRUD) ─────────────────────────────

  listPromotions() {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT p.*, (SELECT json_agg(json_build_object('id', c.id, 'code', c.code, 'maxUses', c.max_uses, 'usedCount', c.used_count, 'isActive', c.is_active))
                        FROM promo_codes c WHERE c.promotion_id = p.id) AS codes
           FROM promotions p WHERE p.tenant_id = $1 AND p.deleted_at IS NULL ORDER BY p.is_active DESC, p.created_at DESC`,
        [tx.tenantId],
      ),
    );
  }

  savePromotion(id: string | null, dto: Partial<Promotion> & { version?: number }) {
    if (!this.ctx.can('promotions.manage')) throw Errors.forbidden();
    return this.tenantTx.run(async (tx) => {
      if (dto.percent !== undefined && (D(dto.percent).lte(0) || D(dto.percent).gt(100))) throw Errors.bad('BAD_PERCENT', 'Процент от 0 до 100');
      if (dto.kind === 'receipt_amount' && !dto.minAmount) throw Errors.bad('MIN_AMOUNT_REQUIRED', 'Укажите сумму чека, от которой действует скидка');
      const repo = tx.repo(Promotion, 'Акция');
      const { version, ...data } = dto as any;
      const saved = id ? await repo.save(Object.assign(await repo.getForUpdate(id, version ?? 0), data)) : await repo.insert(data);
      await this.audit.log(tx, { action: 'promotion.save', entityType: 'promotion', entityId: saved.id, summary: saved.name, important: true });
      return saved;
    });
  }

  addCodes(promotionId: string, dto: { codes?: string[]; generate?: number; maxUses?: number | null }) {
    if (!this.ctx.can('promotions.manage')) throw Errors.forbidden();
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Promotion, 'Акция').getById(promotionId);
      const codes = [...(dto.codes ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean)];
      const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let i = 0; i < Math.min(dto.generate ?? 0, 1000); i++) {
        let c = '';
        for (let k = 0; k < 8; k++) c += ALPH[Math.floor(Math.random() * ALPH.length)];
        codes.push(c);
      }
      if (!codes.length) throw Errors.bad('NO_CODES', 'Укажите коды или сколько сгенерировать');
      const maxUses = dto.maxUses === undefined ? (dto.generate ? 1 : null) : dto.maxUses;
      const rows = await tx.repo(PromoCode).insertMany(codes.map((code) => ({ code, promotionId, maxUses })));
      await tx.query(`UPDATE promotions SET by_code = true WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, promotionId]);
      return rows;
    });
  }
}
