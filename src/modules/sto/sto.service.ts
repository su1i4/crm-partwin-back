import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'crypto';
import ExcelJS from 'exceljs';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { dayjs } from '../../common/utils/dates';
import { D, Decimal, money } from '../../common/utils/decimal';
import { AppConfig } from '../../config/app.config';
import { CountersService } from '../../database/tenant/counters.service';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { CounterpartiesService } from '../counterparties/counterparties.service';
import { DocumentsService } from '../documents/documents.service';
import { DebtsService } from '../finance/debts.service';
import { MoneyService } from '../finance/money.service';
import { CustomerBotService } from '../loyalty/customer-bot.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReceiptsService } from '../pos/receipts.service';
import { PriceResolverService } from '../pricing/price-resolver.service';
import { PdfService } from '../printing/pdf.service';
import { Warehouse } from '../stores/entities/warehouse.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { CustomerActivity, MasterBonus, MasterBonusRule, MessageTemplate, OilReminderRule, PersonalPrice, SelectionIssue, Task } from './entities/sto.entity';

const DEFAULT_TEMPLATES: [string, string, string, string][] = [
  ['request_arrived', 'Деталь пришла', '{имя}, здравствуйте! Ваша деталь по заявке {номер_заявки} пришла. Ждём вас в {магазин}.', '{имя}, саламатсызбы! {номер_заявки} өтүнмө боюнча тетигиңиз келди. {магазин} дүкөнүндө күтөбүз.'],
  ['debt_reminder', 'Напоминание о долге', '{имя}, напоминаем: долг в {магазин} — {сумма} сом. Спасибо!', '{имя}, эскертебиз: {магазин} дүкөнүнө карызыңыз — {сумма} сом. Рахмат!'],
  ['oil_reminder', 'Замена масла', '{имя}, прошло полгода с замены масла — пора менять! {магазин} подберёт масло и фильтр.', '{имя}, май алмаштырганга жарым жыл болду — алмаштыруу убагы келди! {магазин}.'],
  ['receipt', 'Электронный чек', '{магазин}: чек на {сумма} сом. {ссылка}', '{магазин}: {сумма} сомго чек. {ссылка}'],
  ['selection_overdue', 'Вернуть подбор', '{имя}, напоминаем про детали, взятые на подбор ({номер}). Подошедшее оплатите, остальное верните, пожалуйста.', '{имя}, тандоого алган тетиктер боюнча ({номер}) эскертебиз.'],
];

/**
 * СТО и мастера, персональные цены, прайс-лист оптовым клиентам, покупка у клиента, задачи и автозадачи,
 * шаблоны сообщений, лента по клиенту (ТЗ 14.5, 14.7–14.9, 14.11, 18.3, 18.5).
 */
@Injectable()
export class StoService implements OnModuleInit {
  private readonly log = new Logger('Sto');

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly docs: DocumentsService,
    private readonly receipts: ReceiptsService,
    private readonly debts: DebtsService,
    private readonly money: MoneyService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly counterparties: CounterpartiesService,
    private readonly resolver: PriceResolverService,
    private readonly pdf: PdfService,
    private readonly bot: CustomerBotService,
    private readonly registry: OutboxRegistry,
    private readonly jobs: JobsService,
    private readonly platform: PlatformDb,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    this.registry.on('receipt.completed', async (e) => {
      if (e.payload.kind === 'return') return;
      await this.tenantTx.run((tx) => this.accrueMasterBonus(tx, e.payload.receiptId), { tenantId: e.tenantId, userId: null }).catch((err) => this.log.warn(`бонус мастеру: ${err.message}`));
    });
    await this.jobs.work('crm.auto_tasks', async () => {
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) await this.autoTasks(t.id).catch((err) => this.log.warn(`автозадачи ${t.id}: ${err.message}`));
    });
    await this.jobs.schedule('crm.auto_tasks', '25 * * * *');
    await this.jobs.work('crm.pricelists', async () => {
      const subs = await this.platform.ds.query(`SELECT tenant_id, counterparty_id FROM customer_telegram WHERE price_list_subscribed`);
      for (const s of subs) {
        const link = this.priceListLink(s.tenant_id, s.counterparty_id);
        await this.bot.notify(s.tenant_id, s.counterparty_id, 'Свежий прайс-лист — по ссылке:', [[{ text: 'Открыть прайс', url: link }]]).catch(() => undefined);
      }
    });
    await this.jobs.schedule('crm.pricelists', '5 9 * * 1');
  }

  // ── Выдача на подбор (ТЗ 14.5) ───────────────────────────

  private async customerWarehouse(tx: TenantTx, storeId: string, counterpartyId: string) {
    const [cp] = await tx.query(`SELECT name FROM counterparties WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, counterpartyId]);
    if (!cp) throw Errors.notFound('Клиент');
    const name = `У клиента: ${cp.name}`.slice(0, 100);
    const found = await tx.repo(Warehouse).findOne({ where: { storeId, type: 'customer', name } });
    return found ?? (await tx.repo(Warehouse).insert({ storeId, type: 'customer', name } as any));
  }

  issueSelection(dto: { counterpartyId: string; customerVehicleId?: string; warehouseId?: string; lines: { productId: string; qty: string }[]; days?: number; comment?: string }) {
    return this.tenantTx.run(async (tx) => {
      if (!dto.lines?.length) throw Errors.bad('NO_LINES', 'Что выдаём на подбор');
      const src = dto.warehouseId
        ? await tx.repo(Warehouse, 'Склад').getById(dto.warehouseId)
        : await tx.repo(Warehouse).findOne({ where: { storeId: this.scope.currentStoreId() ?? undefined, type: 'sales_floor' } });
      if (!src) throw Errors.bad('WAREHOUSE_REQUIRED', 'Укажите склад');
      this.scope.assertStore(src.storeId);
      const cw = await this.customerWarehouse(tx, src.storeId!, dto.counterpartyId);
      const doc = await this.docs.createInTx(tx, { type: 'selection_issue', warehouseId: src.id, warehouseToId: cw.id, counterpartyId: dto.counterpartyId, comment: dto.comment, lines: dto.lines.map((l) => ({ productId: l.productId, qty: l.qty })) } as any);
      await this.docs.postInTx(tx, doc);
      const s = await tx.query(`SELECT data FROM tenant_settings WHERE tenant_id = $1`, [tx.tenantId]);
      const days = dto.days ?? s[0]?.data?.selectionDays ?? 3;
      const n = await this.counters.next(tx, 'selection_issue');
      const issue = await tx.repo(SelectionIssue).insert({
        number: `ВД-${n}`,
        storeId: src.storeId!,
        counterpartyId: dto.counterpartyId,
        customerVehicleId: dto.customerVehicleId ?? null,
        warehouseId: src.id,
        customerWarehouseId: cw.id,
        issueDocumentId: doc.id,
        lines: dto.lines.map((l) => ({ productId: l.productId, qty: D(l.qty).toFixed() })),
        dueDate: dayjs().add(days, 'day').format('YYYY-MM-DD'),
        comment: dto.comment ?? null,
      });
      await this.audit.log(tx, { action: 'selection.issue', entityType: 'selection_issue', entityId: issue.id, storeId: issue.storeId, summary: `${issue.number}: ${dto.lines.length} поз. на ${days} дн.` });
      return issue;
    });
  }

  /**
   * Закрытие: всё возвращается со склада клиента, подошедшее — продажей (в долг или с оплатой) одним чеком,
   * без возвратных чеков.
   */
  closeSelection(id: string, dto: { registerId: string; fitted: { productId: string; qty: string }[]; payments?: any[]; changeCurrency?: 'KGS' | 'USD'; pin?: string }) {
    return this.tenantTx.run(async (tx) => {
      const [lock] = await tx.query(`SELECT id FROM selection_issues WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, id]);
      if (!lock) throw Errors.notFound('Выдача');
      const s = await tx.repo(SelectionIssue, 'Выдача').getById(id);
      if (s.status !== 'open') throw Errors.conflict('ALREADY_CLOSED', 'Выдача уже закрыта');
      for (const f of dto.fitted ?? []) {
        const l = s.lines.find((x) => x.productId === f.productId);
        if (!l || D(f.qty).gt(l.qty)) throw Errors.bad('FITTED_INVALID', 'Подошло больше, чем выдали');
      }
      const back = await this.docs.createInTx(tx, { type: 'selection_return', warehouseId: s.customerWarehouseId, warehouseToId: s.warehouseId, counterpartyId: s.counterpartyId, comment: `Закрытие ${s.number}`, lines: s.lines.map((l) => ({ productId: l.productId, qty: l.qty })) } as any);
      await this.docs.postInTx(tx, back);
      let receiptId: string | null = null;
      const fitted = (dto.fitted ?? []).filter((f) => D(f.qty).gt(0));
      if (fitted.length) {
        const sale: any = await this.receipts.sale({
          registerId: dto.registerId,
          idempotencyKey: `selection-${s.id}`,
          customerId: s.counterpartyId,
          customerVehicleId: s.customerVehicleId,
          label: s.number,
          lines: fitted.map((f) => ({ productId: f.productId, qty: f.qty })) as any,
          payments: dto.payments ?? [],
          changeCurrency: dto.changeCurrency,
          pin: dto.pin,
        } as any);
        receiptId = sale.id;
      }
      s.lines = s.lines.map((l) => ({ ...l, soldQty: fitted.find((f) => f.productId === l.productId)?.qty ?? '0' }));
      s.status = 'closed';
      s.closedAt = new Date();
      s.returnDocumentId = back.id;
      s.receiptId = receiptId;
      await tx.repo(SelectionIssue).save(s);
      await tx.query(`UPDATE tasks SET status = 'done', done_at = now() WHERE tenant_id = $1 AND auto_key = $2 AND status = 'open'`, [tx.tenantId, `sel:${s.id}`]);
      await this.audit.log(tx, { action: 'selection.close', entityType: 'selection_issue', entityId: s.id, storeId: s.storeId, summary: `${s.number} закрыта: продано ${fitted.length} поз., остальное вернули` });
      return s;
    });
  }

  listSelections(q: { status?: string; counterpartyId?: string }) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT s.id, s.number, s.status, s.due_date AS "dueDate", s.due_date < current_date AND s.status = 'open' AS overdue, s.lines,
                s.counterparty_id AS "counterpartyId", c.name AS customer, c.phone, s.receipt_id AS "receiptId", s.created_at AS "createdAt", s.closed_at AS "closedAt"
           FROM selection_issues s JOIN counterparties c ON c.id = s.counterparty_id
          WHERE s.tenant_id = $1 AND s.deleted_at IS NULL AND ($2::varchar IS NULL OR s.status = $2) AND ($3::uuid IS NULL OR s.counterparty_id = $3)
            AND ($4::uuid[] IS NULL OR s.store_id = ANY($4))
          ORDER BY s.status, s.due_date LIMIT 500`,
        [tx.tenantId, q.status ?? null, q.counterpartyId ?? null, this.scope.storeIds()],
      ),
    );
  }

  // ── Бонусы мастерам (ТЗ 14.7) ────────────────────────────

  rules() {
    return this.tenantTx.run((tx) => tx.repo(MasterBonusRule).find({ order: { createdAt: 'DESC' } }));
  }

  saveRule(id: string | null, dto: Partial<MasterBonusRule> & { version?: number }) {
    return this.tenantTx.run(async (tx) => {
      if (dto.kind && !['percent_sales', 'percent_margin', 'fixed'].includes(dto.kind)) throw Errors.bad('BAD_KIND', 'Неизвестный вид бонуса');
      const repo = tx.repo(MasterBonusRule, 'Правило');
      const { version, ...data } = dto as any;
      return id ? repo.save(Object.assign(await repo.getForUpdate(id, version ?? 0), data)) : repo.insert(data);
    });
  }

  /** Бонус за чек — долг магазина перед мастером. Правило: мастер+группа → мастер → группа → общее. */
  async accrueMasterBonus(tx: TenantTx, receiptId: string) {
    const [r] = await tx.query(`SELECT id, number, master_id, document_id, store_id FROM receipts WHERE tenant_id = $1 AND id = $2 AND kind = 'sale'`, [tx.tenantId, receiptId]);
    if (!r?.master_id) return;
    const [done] = await tx.query(`SELECT 1 FROM master_bonuses WHERE tenant_id = $1 AND receipt_id = $2`, [tx.tenantId, receiptId]);
    if (done) return;
    const rules: MasterBonusRule[] = (await tx.repo(MasterBonusRule).find({ where: { isActive: true } })).filter((x) => !x.masterId || x.masterId === r.master_id);
    if (!rules.length) return;
    const lines = await tx.query(
      `SELECT l.amount, l.cost_amount, c.id AS category_id, c.path FROM document_lines l JOIN products p ON p.id = l.product_id LEFT JOIN categories c ON c.id = p.category_id
        WHERE l.tenant_id = $1 AND l.document_id = $2`,
      [tx.tenantId, r.document_id],
    );
    const score = (x: MasterBonusRule) => (x.masterId ? 2 : 0) + (x.categoryId ? 1 : 0);
    let total = D(0);
    const fixedUsed = new Set<string>();
    for (const l of lines) {
      const cats = l.category_id ? [l.category_id, ...String(l.path ?? '').split('/').filter(Boolean)] : [];
      const rule = rules.filter((x) => !x.categoryId || cats.includes(x.categoryId)).sort((a, b) => score(b) - score(a))[0];
      if (!rule) continue;
      if (rule.kind === 'percent_sales') total = total.plus(D(l.amount).mul(rule.value).div(100));
      else if (rule.kind === 'percent_margin') total = total.plus(Decimal.max(0, D(l.amount).minus(l.cost_amount)).mul(rule.value).div(100));
      else if (!fixedUsed.has(rule.id)) {
        fixedUsed.add(rule.id);
        total = total.plus(rule.value);
      }
    }
    const amount = money(total);
    if (amount.lte(0)) return;
    const item = await this.debts.open(tx, { counterpartyId: r.master_id, direction: 'payable', kind: 'master_bonus', amount, documentId: r.document_id, description: `Бонус за чек ${r.number}`, storeId: r.store_id } as any);
    await tx.repo(MasterBonus).insert({ masterId: r.master_id, receiptId: r.id, amount, debtItemId: item.id });
  }

  masterBonuses(q: { from?: string; to?: string; masterId?: string }) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT c.id AS "masterId", c.name, count(*)::int AS receipts, sum(b.amount) AS accrued,
                coalesce(sum(d.amount - d.remaining), 0) AS paid, coalesce(sum(d.remaining), 0) AS owed
           FROM master_bonuses b JOIN counterparties c ON c.id = b.master_id LEFT JOIN debt_items d ON d.id = b.debt_item_id
          WHERE b.tenant_id = $1 AND ($2::date IS NULL OR b.created_at >= $2::date) AND ($3::date IS NULL OR b.created_at < $3::date + 1) AND ($4::uuid IS NULL OR b.master_id = $4)
          GROUP BY c.id, c.name ORDER BY accrued DESC`,
        [tx.tenantId, q.from ?? null, q.to ?? null, q.masterId ?? null],
      ),
    );
  }

  // ── Персональные цены (ТЗ 14.8) ──────────────────────────

  personalPrices(counterpartyId: string) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT pp.id, pp.product_id AS "productId", p.name, p.sku, pp.price, pp.currency, pp.updated_at AS "updatedAt"
           FROM personal_prices pp JOIN products p ON p.id = pp.product_id WHERE pp.tenant_id = $1 AND pp.counterparty_id = $2 ORDER BY p.name`,
        [tx.tenantId, counterpartyId],
      ),
    );
  }

  setPersonalPrice(counterpartyId: string, dto: { productId: string; price: string | null; currency?: string }) {
    if (!this.ctx.can('prices.write')) throw Errors.forbidden();
    return this.tenantTx.run(async (tx) => {
      if (dto.price === null || dto.price === '') {
        await tx.query(`DELETE FROM personal_prices WHERE tenant_id = $1 AND counterparty_id = $2 AND product_id = $3`, [tx.tenantId, counterpartyId, dto.productId]);
        return { deleted: true };
      }
      if (money(dto.price).lte(0)) throw Errors.bad('BAD_PRICE', 'Цена должна быть больше нуля');
      await tx.query(
        `INSERT INTO personal_prices (tenant_id, counterparty_id, product_id, price, currency) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, counterparty_id, product_id) DO UPDATE SET price = EXCLUDED.price, currency = EXCLUDED.currency, updated_at = now()`,
        [tx.tenantId, counterpartyId, dto.productId, money(dto.price).toFixed(2), dto.currency ?? 'KGS'],
      );
      await this.audit.log(tx, { action: 'price.personal', entityType: 'counterparty', entityId: counterpartyId, summary: `Персональная цена ${money(dto.price).toFixed(2)} ${dto.currency ?? 'KGS'}` });
      return { productId: dto.productId, price: money(dto.price).toFixed(2) };
    });
  }

  // ── Прайс-лист оптовым клиентам (ТЗ 14.9) ────────────────

  private priceToken(tenantId: string, counterpartyId: string) {
    return createHmac('sha256', this.config.encryptionKey).update(`pl:${tenantId}:${counterpartyId}`).digest('base64url').slice(0, 22);
  }

  priceListLink(tenantId: string, counterpartyId: string) {
    return `${this.config.publicUrl}/api/public/price-list/${tenantId}/${counterpartyId}/${this.priceToken(tenantId, counterpartyId)}`;
  }

  /** Строки прайса по типу цены клиента (группы): только в наличии или все; фильтр по маркам и группам. */
  async priceListRows(tx: TenantTx, counterpartyId: string, f: { inStockOnly?: boolean; categoryId?: string; makeId?: string }) {
    const terms = await this.counterparties.terms(tx, counterpartyId);
    const products = await tx.query(
      `SELECT p.id, p.name, p.sku, b.name AS brand,
              (SELECT n.number FROM part_numbers n WHERE n.tenant_id = p.tenant_id AND n.product_id = p.id ORDER BY (n.type = 'manufacturer') DESC LIMIT 1) AS number,
              coalesce((SELECT sum(sb.qty) FROM stock_balances sb WHERE sb.tenant_id = p.tenant_id AND sb.product_id = p.id), 0) AS stock
         FROM products p LEFT JOIN brands b ON b.id = p.brand_id
        WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.status = 'active' AND p.merged_into_id IS NULL
          AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id AND (c.id = $2 OR c.path LIKE '%/' || $2::text || '/%')))
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id AND a.make_id = $3))
        ORDER BY p.name LIMIT 5000`,
      [tx.tenantId, f.categoryId ?? null, f.makeId ?? null],
    );
    const list = products.filter((p: any) => !f.inStockOnly || D(p.stock).gt(0));
    if (!list.length) return [];
    const quotes = await this.resolver.quote(tx, { storeId: null, priceTypeId: terms.priceTypeId, counterpartyId, items: list.map((p: any) => ({ productId: p.id, unitId: null })) });
    return list.map((p: any, i: number) => ({ name: p.name, brand: p.brand, number: p.number ?? p.sku, stock: D(p.stock).gt(0) ? 'есть' : 'под заказ', price: (quotes[i] as any)?.price ?? null }));
  }

  async priceListFile(counterpartyId: string, format: 'xlsx' | 'pdf', f: { inStockOnly?: boolean; categoryId?: string; makeId?: string }) {
    const { rows, shop, customer } = await this.tenantTx.run(async (tx) => {
      const [t] = await tx.query(`SELECT name FROM tenants WHERE id = $1`, [tx.tenantId]);
      const [c] = await tx.query(`SELECT name FROM counterparties WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, counterpartyId]);
      if (!c) throw Errors.notFound('Клиент');
      return { rows: await this.priceListRows(tx, counterpartyId, f), shop: t?.name ?? '', customer: c.name };
    });
    const title = `Прайс-лист ${shop} для ${customer} на ${dayjs().format('DD.MM.YYYY')}`;
    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Прайс');
      ws.addRow([title]).font = { bold: true };
      ws.addRow([]);
      ws.addRow(['Номер', 'Наименование', 'Бренд', 'Наличие', 'Цена, сом']).font = { bold: true };
      for (const r of rows) ws.addRow([r.number, r.name, r.brand, r.stock, r.price ? Number(r.price) : '']);
      ws.columns = [{ width: 20 }, { width: 50 }, { width: 18 }, { width: 12 }, { width: 14 }];
      return { name: 'price-list.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
    }
    const body: any[] = [['Номер', 'Наименование', 'Бренд', 'Наличие', 'Цена'].map((t) => ({ text: t, bold: true }))];
    for (const r of rows) body.push([r.number ?? '', r.name, r.brand ?? '', r.stock, { text: r.price ?? '—', alignment: 'right' }]);
    const buffer = await this.pdf.render({ content: [{ text: title, bold: true, fontSize: 13, margin: [0, 0, 0, 8] }, { table: { headerRows: 1, widths: [80, '*', 70, 55, 60], body }, layout: 'lightHorizontalLines', fontSize: 8 }] });
    return { name: 'price-list.pdf', mime: 'application/pdf', buffer };
  }

  /** Публичная страница прайса по ссылке (без входа, подпись в ссылке). */
  async publicPriceList(tenantId: string, counterpartyId: string, token: string) {
    if (token !== this.priceToken(tenantId, counterpartyId)) throw Errors.notFound('Прайс');
    return this.tenantTx.run(
      async (tx) => {
        const [t] = await tx.query(`SELECT name, phone FROM tenants WHERE id = $1`, [tenantId]);
        const rows = await this.priceListRows(tx, counterpartyId, { inStockOnly: false });
        const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
        return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Прайс ${esc(t?.name)}</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;color:#111;background:#fff}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}td:last-child{text-align:right;white-space:nowrap}input{width:100%;padding:8px;margin:8px 0;font-size:16px;box-sizing:border-box}</style></head>
<body><h2>${esc(t?.name)} — прайс-лист</h2><p>${esc(t?.phone ?? '')} · ${dayjs().format('DD.MM.YYYY')}</p><input placeholder="Поиск по номеру или названию" oninput="const q=this.value.toLowerCase();document.querySelectorAll('tbody tr').forEach(r=>r.style.display=r.textContent.toLowerCase().includes(q)?'':'none')">
<table><thead><tr><th>Номер</th><th>Наименование</th><th>Бренд</th><th>Наличие</th><th>Цена</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.number)}</td><td>${esc(r.name)}</td><td>${esc(r.brand)}</td><td>${esc(r.stock)}</td><td>${esc(r.price ?? '—')}</td></tr>`).join('')}</tbody></table></body></html>`;
      },
      { tenantId, userId: null },
    );
  }

  async subscribePriceList(counterpartyId: string, on: boolean) {
    const tenantId = this.ctx.requireTenantId();
    const [r] = await this.platform.ds.query(`UPDATE customer_telegram SET price_list_subscribed = $3, updated_at = now() WHERE tenant_id = $1 AND counterparty_id = $2 RETURNING id`, [tenantId, counterpartyId, on]);
    if (!r?.length) throw Errors.bad('TELEGRAM_NOT_LINKED', 'Клиент не подключён к Telegram-боту');
    return { subscribed: on, link: this.priceListLink(tenantId, counterpartyId) };
  }

  // ── Покупка у клиента (ТЗ 14.11) ─────────────────────────

  customerPurchase(dto: { warehouseId: string; counterpartyId?: string; sellerName?: string; sellerPhone?: string; accountId: string; lines: { productId: string; qty: string; price: string }[]; comment?: string }) {
    return this.tenantTx.run(async (tx) => {
      if (!dto.lines?.length) throw Errors.bad('NO_LINES', 'Что покупаем');
      if (!dto.counterpartyId && !dto.sellerName) throw Errors.bad('SELLER_REQUIRED', 'Укажите продавца: клиента или имя и телефон');
      const wh = await tx.repo(Warehouse, 'Склад').getById(dto.warehouseId);
      this.scope.assertStore(wh.storeId);
      const total = dto.lines.reduce((a, l) => a.plus(money(D(l.price).mul(l.qty))), D(0));
      const acc = await this.money.account(tx, dto.accountId);
      if (acc.currency !== 'KGS') throw Errors.bad('KGS_ONLY', 'Выплата — из сомового счёта');
      if (acc.type === 'cash') {
        const bal = await this.money.balance(tx, acc.id);
        if (bal.lt(total)) throw Errors.conflict('NOT_ENOUGH_CASH', `На счёте «${acc.name}» ${bal.toFixed(2)}`);
      }
      const doc = await this.docs.createInTx(tx, {
        type: 'customer_purchase',
        warehouseId: wh.id,
        counterpartyId: dto.counterpartyId ?? null,
        comment: dto.comment ?? (dto.sellerName ? `Продавец: ${dto.sellerName} ${dto.sellerPhone ?? ''}`.trim() : null),
        extra: { sellerName: dto.sellerName ?? null, sellerPhone: dto.sellerPhone ?? null },
        lines: dto.lines,
      } as any);
      await this.docs.postInTx(tx, doc);
      let shiftId: string | null = null;
      if (acc.registerId) {
        const [s] = await tx.query(`SELECT id FROM shifts WHERE tenant_id = $1 AND register_id = $2 AND status = 'open' LIMIT 1`, [tx.tenantId, acc.registerId]);
        shiftId = s?.id ?? null;
      }
      await this.money.record(tx, { accountId: acc.id, amount: total.neg(), kind: 'cash_out', documentId: doc.id, shiftId, counterpartyId: dto.counterpartyId ?? null, comment: `Покупка у клиента ${doc.number}` });
      return this.docs.viewInTx(tx, doc.id);
    });
  }

  // ── Задачи (ТЗ 18.3) ─────────────────────────────────────

  tasks(q: { status?: string; mine?: boolean; counterpartyId?: string }) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT t.*, u.name AS "assigneeName", c.name AS "customerName" FROM tasks t
           LEFT JOIN memberships m ON m.id = t.assignee_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN counterparties c ON c.id = t.counterparty_id
          WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND ($2::varchar IS NULL OR t.status = $2) AND ($3::uuid IS NULL OR t.assignee_id = $3 OR t.assignee_id IS NULL)
            AND ($4::uuid IS NULL OR t.counterparty_id = $4) AND ($5::uuid[] IS NULL OR t.store_id IS NULL OR t.store_id = ANY($5))
          ORDER BY t.status, t.due_at NULLS LAST LIMIT 500`,
        [tx.tenantId, q.status ?? 'open', q.mine ? this.ctx.membershipId : null, q.counterpartyId ?? null, this.scope.storeIds()],
      ),
    );
  }

  saveTask(id: string | null, dto: Partial<Task> & { version?: number }) {
    return this.tenantTx.run(async (tx) => {
      const repo = tx.repo(Task, 'Задача');
      const { version, ...data } = dto as any;
      if (data.status === 'done') data.doneAt = new Date();
      if (id) return repo.save(Object.assign(await repo.getForUpdate(id, version ?? 0), data));
      if (!data.title) throw Errors.bad('TITLE_REQUIRED', 'Что сделать');
      return repo.insert({ storeId: this.scope.currentStoreId() ?? null, assigneeId: this.ctx.membershipId ?? null, ...data });
    });
  }

  /**
   * Автозадачи (каждый час): замена масла через N месяцев после покупки, клиент не забрал заказ,
   * просрочена выдача на подбор, просрочен долг, проверить применимость. Каждая — один раз (autoKey).
   */
  async autoTasks(tenantId: string) {
    return this.tenantTx.run(
      async (tx) => {
        const add = async (kind: string, key: string, t: Partial<Task>) => {
          const [r] = await tx.query(
            `INSERT INTO tasks (tenant_id, title, description, store_id, due_at, counterparty_id, customer_vehicle_id, entity_type, entity_id, auto_kind, auto_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (tenant_id, auto_key) WHERE auto_key IS NOT NULL DO NOTHING RETURNING id`,
            [tx.tenantId, t.title, t.description ?? null, t.storeId ?? null, t.dueAt ?? new Date(), t.counterpartyId ?? null, t.customerVehicleId ?? null, t.entityType ?? null, t.entityId ?? null, kind, key],
          );
          return !!r;
        };
        let created = 0;
        // Замена масла: покупка товаров группы «масла» N месяцев назад (окно — неделя, чтобы не пропустить)
        const rules = await tx.repo(OilReminderRule).find({ where: { isActive: true } });
        for (const rule of rules) {
          const rows = await tx.query(
            `SELECT DISTINCT ON (r.customer_id) r.id, r.customer_id, r.customer_vehicle_id, r.store_id, c.name, r.completed_at
               FROM receipts r JOIN document_lines l ON l.document_id = r.document_id JOIN products p ON p.id = l.product_id
               LEFT JOIN categories cat ON cat.id = p.category_id JOIN counterparties c ON c.id = r.customer_id
              WHERE r.tenant_id = $1 AND r.kind = 'sale' AND r.status = 'completed' AND r.customer_id IS NOT NULL
                AND r.completed_at < now() - ($2 || ' months')::interval AND r.completed_at >= now() - ($2 || ' months')::interval - interval '7 days'
                AND ($3::uuid IS NULL OR cat.id = $3 OR cat.path LIKE '%/' || $3::text || '/%')
              ORDER BY r.customer_id, r.completed_at DESC`,
            [tx.tenantId, String(rule.months), rule.categoryId],
          );
          for (const r of rows) {
            if (await add('oil_change', `oil:${r.id}`, { title: `Напомнить о замене масла: ${r.name}`, description: `Покупка ${dayjs(r.completed_at).format('DD.MM.YYYY')}, прошло ${rule.months} мес.`, storeId: r.store_id, counterpartyId: r.customer_id, customerVehicleId: r.customer_vehicle_id, entityType: 'receipt', entityId: r.id })) {
              created++;
              const text = await this.render(tx, 'oil_reminder', { имя: r.name });
              await this.bot.notify(tx.tenantId, r.customer_id, text.text).catch(() => undefined);
            }
          }
        }
        for (const r of await tx.query(
          `SELECT r.id, r.number, r.store_id, r.customer_id, coalesce(c.name, r.customer_name) AS name FROM customer_requests r LEFT JOIN counterparties c ON c.id = r.customer_id
            WHERE r.tenant_id = $1 AND r.deleted_at IS NULL AND r.status = 'arrived' AND r.updated_at < now() - interval '3 days'`,
          [tx.tenantId],
        ))
          if (await add('order_not_picked', `pick:${r.id}`, { title: `Клиент не забрал заказ ${r.number}: ${r.name ?? ''}`, storeId: r.store_id, counterpartyId: r.customer_id, entityType: 'customer_request', entityId: r.id })) created++;
        for (const s of await tx.query(
          `SELECT s.id, s.number, s.store_id, s.counterparty_id, c.name FROM selection_issues s JOIN counterparties c ON c.id = s.counterparty_id
            WHERE s.tenant_id = $1 AND s.status = 'open' AND s.due_date < current_date`,
          [tx.tenantId],
        ))
          if (await add('selection_overdue', `sel:${s.id}`, { title: `Просрочена выдача на подбор ${s.number}: ${s.name}`, storeId: s.store_id, counterpartyId: s.counterparty_id, entityType: 'selection_issue', entityId: s.id })) created++;
        for (const d of await tx.query(
          `SELECT d.id, d.counterparty_id, d.remaining, d.currency, d.store_id, c.name FROM debt_items d JOIN counterparties c ON c.id = d.counterparty_id
            WHERE d.tenant_id = $1 AND d.direction = 'receivable' AND d.remaining > 0 AND d.due_date < current_date AND d.kind <> 'prepayment'`,
          [tx.tenantId],
        ))
          if (await add('debt_overdue', `debt:${d.id}`, { title: `Просрочен долг: ${d.name} — ${money(d.remaining).toFixed(0)} ${d.currency}`, storeId: d.store_id, counterpartyId: d.counterparty_id, entityType: 'debt_item', entityId: d.id })) created++;
        for (const f of await tx.query(
          `SELECT i.id, i.product_id, i.vehicle_title, p.name FROM product_fit_issues i JOIN products p ON p.id = i.product_id WHERE i.tenant_id = $1 AND NOT i.resolved`,
          [tx.tenantId],
        ))
          if (await add('fit_check', `fit:${f.id}`, { title: `Проверить применимость: «${f.name}» не подошёл на ${f.vehicle_title}`, entityType: 'product', entityId: f.product_id })) created++;
        return { created };
      },
      { tenantId, userId: null },
    );
  }

  oilRules() {
    return this.tenantTx.run((tx) => tx.repo(OilReminderRule).find());
  }

  addOilRule(dto: { categoryId?: string; months?: number }) {
    return this.tenantTx.run((tx) => tx.repo(OilReminderRule).insert({ categoryId: dto.categoryId ?? null, months: dto.months ?? 6 }));
  }

  // ── Шаблоны сообщений и лента по клиенту (ТЗ 18.5, 18.3) ──

  async ensureTemplates(tx: TenantTx) {
    const [{ n }] = await tx.query(`SELECT count(*)::int AS n FROM message_templates WHERE tenant_id = $1`, [tx.tenantId]);
    if (n) return;
    await tx.repo(MessageTemplate).insertMany(DEFAULT_TEMPLATES.map(([code, name, textRu, textKy]) => ({ code, name, textRu, textKy })));
  }

  templates() {
    return this.tenantTx.run(async (tx) => {
      await this.ensureTemplates(tx);
      return tx.repo(MessageTemplate).find({ order: { code: 'ASC' } });
    });
  }

  saveTemplate(code: string, dto: { name?: string; textRu?: string; textKy?: string | null }) {
    return this.tenantTx.run(async (tx) => {
      await this.ensureTemplates(tx);
      const t = await tx.repo(MessageTemplate).findOne({ where: { code } });
      if (t) return tx.repo(MessageTemplate).save(Object.assign(t, dto));
      if (!dto.textRu) throw Errors.bad('TEXT_REQUIRED', 'Текст шаблона');
      return tx.repo(MessageTemplate).insert({ code, name: dto.name ?? code, textRu: dto.textRu, textKy: dto.textKy ?? null });
    });
  }

  /** Подставить переменные: {имя}, {номер_заявки}, {сумма}, {магазин}, {ссылка}… */
  async render(tx: TenantTx, code: string, vars: Record<string, string>, lang: 'ru' | 'ky' = 'ru') {
    await this.ensureTemplates(tx);
    const t = await tx.repo(MessageTemplate).findOne({ where: { code } });
    if (!t) throw Errors.notFound('Шаблон');
    if (!vars['магазин']) {
      const [s] = await tx.query(`SELECT name FROM tenants WHERE id = $1`, [tx.tenantId]);
      vars['магазин'] = s?.name ?? '';
    }
    const text = (lang === 'ky' && t.textKy ? t.textKy : t.textRu).replace(/\{([а-яё_a-z]+)\}/gi, (m, k) => vars[k] ?? m);
    return { code, text };
  }

  /** Текст по шаблону для клиента + ссылка WhatsApp (продавец нажимает «отправить» сам) и отправка в бот. */
  message(dto: { counterpartyId: string; code: string; vars?: Record<string, string>; lang?: 'ru' | 'ky'; sendTelegram?: boolean }) {
    return this.tenantTx.run(async (tx) => {
      const [c] = await tx.query(`SELECT name, phone FROM counterparties WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, dto.counterpartyId]);
      if (!c) throw Errors.notFound('Клиент');
      const { text } = await this.render(tx, dto.code, { имя: c.name, ...(dto.vars ?? {}) }, dto.lang);
      const phone = String(c.phone ?? '').replace(/\D/g, '');
      const telegram = dto.sendTelegram ? await this.bot.notify(tx.tenantId, dto.counterpartyId, text) : 0;
      await tx.repo(CustomerActivity).insert({ counterpartyId: dto.counterpartyId, kind: 'message', text: text.slice(0, 2000) });
      return { text, whatsappUrl: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null, telegramSent: telegram };
    });
  }

  addActivity(counterpartyId: string, dto: { kind: 'call' | 'note'; text: string }) {
    return this.tenantTx.run((tx) => tx.repo(CustomerActivity).insert({ counterpartyId, kind: dto.kind, text: dto.text.slice(0, 2000) }));
  }

  /** Лента по клиенту: покупки, возвраты, заявки, звонки и заметки, задачи. */
  feed(counterpartyId: string) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT * FROM (
           SELECT 'receipt' AS type, r.id, r.completed_at AS at, (CASE WHEN r.kind = 'sale' THEN 'Покупка ' ELSE 'Возврат ' END) || r.number || ' на ' || r.total || ' сом' AS text
             FROM receipts r WHERE r.tenant_id = $1 AND r.customer_id = $2 AND r.status = 'completed'
           UNION ALL SELECT 'request', q.id, q.created_at, 'Заявка ' || q.number || ' (' || q.status || ')' FROM customer_requests q WHERE q.tenant_id = $1 AND q.customer_id = $2 AND q.deleted_at IS NULL
           UNION ALL SELECT a.kind, a.id, a.created_at, a.text FROM customer_activities a WHERE a.tenant_id = $1 AND a.counterparty_id = $2
           UNION ALL SELECT 'task', t.id, t.created_at, t.title || CASE WHEN t.status = 'done' THEN ' ✓' ELSE '' END FROM tasks t WHERE t.tenant_id = $1 AND t.counterparty_id = $2 AND t.deleted_at IS NULL
           UNION ALL SELECT 'selection', s.id, s.created_at, 'Выдача на подбор ' || s.number || ' (' || s.status || ')' FROM selection_issues s WHERE s.tenant_id = $1 AND s.counterparty_id = $2
         ) f ORDER BY at DESC NULLS LAST LIMIT 200`,
        [tx.tenantId, counterpartyId],
      ),
    );
  }

  priceLink(counterpartyId: string) {
    return { link: this.priceListLink(this.ctx.requireTenantId(), counterpartyId) };
  }
}
