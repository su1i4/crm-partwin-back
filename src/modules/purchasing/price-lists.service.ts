import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as dns } from 'dns';
import { isIP } from 'net';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { D, Decimal } from '../../common/utils/decimal';
import { normalizePartNumber } from '../../common/utils/part-number';
import { readTable, tableKind } from '../../common/utils/table-reader';
import { AppConfig } from '../../config/app.config';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { AuditService } from '../audit/audit.service';
import { BrandsService } from '../catalog/brands.service';
import { ProductsService } from '../catalog/products.service';
import { Counterparty } from '../counterparties/entities/counterparty.entity';
import { StoredFile } from '../files/entities/file.entity';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PriceResolverService } from '../pricing/price-resolver.service';
import { Tenant } from '../tenants/entities/tenant.entity';
import { PriceList, PriceListLoad, PriceListMapping, PriceListRow } from './entities/purchasing.entity';

export const PRICE_LIST_FIELDS: { key: keyof PriceListMapping; label: string; required?: boolean; guess: string[] }[] = [
  { key: 'brand', label: 'Бренд', guess: ['бренд', 'производитель', 'brand', 'manufacturer', 'марка', 'фирма', 'изготовитель'] },
  { key: 'number', label: 'Номер', required: true, guess: ['номер', 'артикул', 'каталожный номер', 'part number', 'partnumber', 'код производителя', 'number', 'код детали', 'part no'] },
  { key: 'name', label: 'Название', guess: ['наименование', 'название', 'name', 'описание', 'description', 'товар'] },
  { key: 'price', label: 'Цена', required: true, guess: ['цена', 'price', 'стоимость', 'цена закупки', 'опт', 'цена опт', 'цена, сом', 'цена, $'] },
  { key: 'currency', label: 'Валюта', guess: ['валюта', 'currency', 'вал'] },
  { key: 'stock', label: 'Остаток', guess: ['остаток', 'наличие', 'кол-во', 'количество', 'qty', 'stock', 'склад', 'в наличии'] },
  { key: 'leadDays', label: 'Срок, дней', guess: ['срок', 'срок поставки', 'доставка', 'дней', 'delivery', 'срок, дн'] },
  { key: 'multiplicity', label: 'Кратность', guess: ['кратность', 'упаковка', 'мин. заказ', 'кратно', 'multiplicity', 'min qty'] },
  { key: 'oem', label: 'OEM / кроссы', guess: ['oem', 'оем', 'оригинал', 'оригинальный номер', 'кросс', 'cross', 'аналоги'] },
  { key: 'applicability', label: 'Применимость', guess: ['применимость', 'модель', 'для машин', 'авто', 'применение'] },
];

const BATCH = 1000;
const QUEUE = 'pricelist.load';
const SCHEDULE_HOURS: Record<string, number> = { hourly: 1, every_6h: 6, daily: 24 };

const CURRENCY_ALIASES: Record<string, string> = {
  сом: 'KGS', kgs: 'KGS', som: 'KGS', с: 'KGS', '': '',
  usd: 'USD', $: 'USD', 'у.е.': 'USD', долл: 'USD', доллар: 'USD',
  cny: 'CNY', rmb: 'CNY', юань: 'CNY', '¥': 'CNY',
  rub: 'RUB', руб: 'RUB', '₽': 'RUB', aed: 'AED', kzt: 'KZT', тенге: 'KZT', eur: 'EUR', '€': 'EUR',
};

export function guessPriceListMapping(header: string[]): PriceListMapping {
  const norm = header.map((h) => h.toLowerCase().replace(/\s+/g, ' ').trim());
  const out: PriceListMapping = {};
  const used = new Set<number>();
  for (const pass of [0, 1]) {
    for (const f of PRICE_LIST_FIELDS) {
      if (out[f.key] !== undefined) continue;
      const idx = norm.findIndex((h, i) => !used.has(i) && (pass === 0 ? f.guess.includes(h) : f.guess.some((g) => g.length > 3 && h.includes(g))));
      if (idx >= 0) {
        out[f.key] = idx;
        used.add(idx);
      }
    }
  }
  return out;
}

const parseNumber = (s?: string): Decimal | null => {
  const clean = (s ?? '').replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (!clean) return null;
  const v = clean.includes(',') && clean.includes('.') ? clean.replace(/,/g, '') : clean.replace(',', '.');
  return isNaN(Number(v)) ? null : D(v);
};

/** Прайсы поставщиков (ТЗ 10.2): загрузка файлом и по ссылке, сопоставление колонок, расписание, поиск. */
@Injectable()
export class PriceListsService implements OnModuleInit {
  private readonly logger = new Logger(PriceListsService.name);

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly files: FilesService,
    private readonly jobs: JobsService,
    private readonly brands: BrandsService,
    private readonly products: ProductsService,
    private readonly resolver: PriceResolverService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly platform: PlatformDb,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    await this.jobs.work<{ tenantId: string; userId: string | null; loadId: string }>(QUEUE, (d) => this.execute(d.tenantId, d.userId, d.loadId), { batchSize: 1 });
    await this.jobs.work('pricelists.refresh_due', async () => {
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) await this.refreshDue(t.id).catch((e) => this.logger.warn(`refresh ${t.id}: ${e.message}`));
    });
    await this.jobs.schedule('pricelists.refresh_due', '*/15 * * * *');
  }

  fields() {
    return PRICE_LIST_FIELDS;
  }

  // ── CRUD ─────────────────────────────────────────────────

  list(supplierId?: string) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT l.id, l.name, l.supplier_id AS "supplierId", c.name AS "supplierName", l.currency, l.url, l.schedule, l.status, l.rows_count AS "rowsCount",
                l.loaded_at AS "loadedAt", l.last_error AS "lastError", l.is_active AS "isActive", l.default_lead_days AS "defaultLeadDays", l.version
           FROM price_lists l JOIN counterparties c ON c.id = l.supplier_id
          WHERE l.tenant_id = $1 AND l.deleted_at IS NULL ${supplierId ? 'AND l.supplier_id = $2' : ''} ORDER BY c.name, l.name`,
        supplierId ? [tx.tenantId, supplierId] : [tx.tenantId],
      ),
    );
  }

  get(id: string) {
    return this.tenantTx.run(async (tx) => {
      const l = await tx.repo(PriceList, 'Прайс').getById(id);
      const loads = await tx.repo(PriceListLoad).find({ where: { priceListId: id }, order: { createdAt: 'DESC' }, take: 20 });
      return { ...l, loads };
    });
  }

  create(dto: { supplierId: string; name?: string; currency?: string; url?: string | null; schedule?: string | null; defaultLeadDays?: number | null; headerRow?: number }) {
    return this.tenantTx.run(async (tx) => {
      const s = await tx.repo(Counterparty, 'Поставщик').getById(dto.supplierId);
      if (!s.roles.includes('supplier') && !s.roles.includes('neighbor')) throw Errors.bad('NOT_SUPPLIER', `«${s.name}» не отмечен как поставщик`);
      if (dto.url) this.checkUrlSyntax(dto.url);
      const l = await tx.repo(PriceList).insert({
        supplierId: s.id,
        name: dto.name?.trim() || `Прайс ${s.name}`,
        currency: dto.currency ?? s.supplierTerms?.currency ?? 'KGS',
        url: dto.url ?? null,
        schedule: dto.url ? (dto.schedule ?? null) : null,
        defaultLeadDays: dto.defaultLeadDays ?? s.supplierTerms?.leadTimeDays ?? null,
        headerRow: dto.headerRow ?? 1,
      });
      await this.audit.log(tx, { action: 'pricelist.create', entityType: 'price_list', entityId: l.id, summary: l.name });
      return l;
    });
  }

  update(id: string, version: number, dto: { name?: string; currency?: string; url?: string | null; schedule?: string | null; defaultLeadDays?: number | null; headerRow?: number; mapping?: PriceListMapping; isActive?: boolean }) {
    return this.tenantTx.run(async (tx) => {
      const l = await tx.repo(PriceList, 'Прайс').getForUpdate(id, version);
      if (dto.url) this.checkUrlSyntax(dto.url);
      if (dto.name) l.name = dto.name.trim();
      if (dto.currency) l.currency = dto.currency;
      if (dto.url !== undefined) l.url = dto.url;
      if (dto.schedule !== undefined) l.schedule = l.url ? dto.schedule : null;
      if (dto.defaultLeadDays !== undefined) l.defaultLeadDays = dto.defaultLeadDays;
      if (dto.headerRow) l.headerRow = dto.headerRow;
      if (dto.mapping) l.mapping = this.validMapping(dto.mapping);
      if (dto.isActive !== undefined) l.isActive = dto.isActive;
      return tx.repo(PriceList).save(l);
    });
  }

  remove(id: string, version: number) {
    return this.tenantTx.run(async (tx) => {
      const l = await tx.repo(PriceList, 'Прайс').getForUpdate(id, version);
      await tx.query(`DELETE FROM price_list_rows WHERE tenant_id = $1 AND price_list_id = $2`, [tx.tenantId, l.id]);
      await tx.repo(PriceList).softDelete(l.id);
      await this.audit.log(tx, { action: 'pricelist.delete', entityType: 'price_list', entityId: l.id, summary: l.name });
    });
  }

  private validMapping(m: PriceListMapping): PriceListMapping {
    if (m.number === undefined || m.price === undefined) throw Errors.bad('MAPPING_REQUIRED', 'Укажите колонки «Номер» и «Цена»');
    const out: PriceListMapping = {};
    for (const f of PRICE_LIST_FIELDS) if (m[f.key] !== undefined && m[f.key] !== null && Number(m[f.key]) >= 0) out[f.key] = Number(m[f.key]);
    return out;
  }

  // ── Загрузка ─────────────────────────────────────────────

  /** Шаг 1: файл → колонки, образец строк, предложенное сопоставление (запомненное для прайса или угаданное). */
  preview(id: string, fileId: string, headerRow?: number) {
    return this.tenantTx.run(async (tx) => {
      const l = await tx.repo(PriceList, 'Прайс').getById(id);
      const f = await tx.repo(StoredFile, 'Файл').getById(fileId);
      const hr = headerRow ?? l.headerRow;
      const { header, sample, total } = await this.peek(f, hr);
      const saved = Object.keys(l.mapping ?? {}).length && Math.max(...Object.values(l.mapping).map(Number)) < header.length ? l.mapping : null;
      return { columns: header, sample, totalRows: total, mapping: saved ?? guessPriceListMapping(header), mappingSource: saved ? 'saved' : 'guessed', fields: PRICE_LIST_FIELDS };
    });
  }

  private async peek(f: StoredFile, headerRow: number) {
    const kind = tableKind(f.originalName, f.mime);
    if (!kind) throw Errors.bad('FILE_TYPE', 'Нужен файл Excel (.xlsx) или CSV');
    let header: string[] = [];
    const sample: string[][] = [];
    let total = 0;
    await readTable(this.files.pathOf(f), kind, (no, cells) => {
      if (no < headerRow) return;
      if (no === headerRow) header = cells.map((c, i) => c || `Колонка ${i + 1}`);
      else {
        total++;
        if (sample.length < 10) sample.push(cells);
      }
    });
    if (!header.length) throw Errors.bad('EMPTY_FILE', 'В файле нет строки заголовков');
    return { header, sample, total };
  }

  /** Шаг 2: запустить загрузку (файл или ссылка). Сопоставление запоминается для поставщика. */
  load(id: string, dto: { fileId?: string; mapping?: PriceListMapping; headerRow?: number }) {
    return this.tenantTx.run(async (tx) => {
      const l = await tx.repo(PriceList, 'Прайс').getForUpdate(id);
      if (l.status === 'loading') throw Errors.conflict('PRICELIST_LOADING', 'Прайс уже загружается');
      if (dto.mapping) l.mapping = this.validMapping(dto.mapping);
      if (dto.headerRow) l.headerRow = dto.headerRow;
      if (!dto.fileId && !l.url) throw Errors.bad('FILE_REQUIRED', 'Загрузите файл или укажите ссылку');
      if (dto.fileId) await tx.repo(StoredFile, 'Файл').getById(dto.fileId);
      if (!Object.keys(l.mapping ?? {}).length && !dto.fileId) throw Errors.bad('MAPPING_REQUIRED', 'Сначала загрузите файл и сопоставьте колонки');
      l.status = 'loading';
      await tx.repo(PriceList).save(l);
      const load = await tx.repo(PriceListLoad).insert({ priceListId: l.id, fileId: dto.fileId ?? null, source: dto.fileId ? 'file' : 'url', status: 'queued' });
      const tenantId = tx.tenantId;
      const userId = tx.userId;
      tx.onCommit(async () => {
        await this.jobs.send(QUEUE, { tenantId, userId, loadId: load.id }, { singletonKey: `pl:${l.id}` } as any);
      });
      return load;
    });
  }

  private async refreshDue(tenantId: string) {
    const due = await this.tenantTx.run(
      (tx) =>
        tx.query(
          `SELECT id, schedule, loaded_at FROM price_lists WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active AND url IS NOT NULL AND schedule IS NOT NULL AND status <> 'loading'`,
          [tenantId],
        ),
      { tenantId, userId: null },
    );
    for (const l of due) {
      const hours = SCHEDULE_HOURS[l.schedule] ?? 24;
      if (l.loaded_at && Date.now() - new Date(l.loaded_at).getTime() < hours * 3600_000 - 60_000) continue;
      await this.tenantTx.run(
        async (tx) => {
          await tx.query(`UPDATE price_lists SET status = 'loading' WHERE tenant_id = $1 AND id = $2`, [tenantId, l.id]);
          const load = await tx.repo(PriceListLoad).insert({ priceListId: l.id, source: 'url', status: 'queued' });
          tx.onCommit(() => this.jobs.send(QUEUE, { tenantId, userId: null, loadId: load.id }).then(() => undefined));
        },
        { tenantId, userId: null },
      );
    }
  }

  /** Выполнение загрузки (pg-boss): читаем файл пачками, upsert строк, история цен, удаление пропавших, кроссы. */
  async execute(tenantId: string, userId: string | null, loadId: string) {
    const opts = { tenantId, userId };
    const { load, list } = await this.tenantTx.run(async (tx) => {
      const load = await tx.repo(PriceListLoad, 'Загрузка').getById(loadId);
      const list = await tx.repo(PriceList, 'Прайс').getById(load.priceListId);
      await tx.query(`UPDATE price_list_loads SET status = 'running', started_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, load.id]);
      return { load, list };
    }, opts);
    const stats = { rows: 0, added: 0, updated: 0, removed: 0, priceChanges: 0, skipped: 0, crossesAdded: 0 };
    try {
      let file: StoredFile;
      if (load.fileId) file = await this.tenantTx.run((tx) => tx.repo(StoredFile, 'Файл').getById(load.fileId!), opts);
      else file = await this.download(tenantId, list);
      const kind = tableKind(file.originalName, file.mime);
      if (!kind) throw new Error('Нужен файл Excel (.xlsx) или CSV');
      let mapping = list.mapping;
      let batch: Record<string, any>[] = [];
      const flush = async () => {
        if (!batch.length) return;
        const rows = batch;
        batch = [];
        await this.tenantTx.run((tx) => this.upsertBatch(tx, list, load.id, rows, stats), opts);
      };
      await readTable(this.files.pathOf(file), kind, async (no, cells) => {
        if (no < list.headerRow) return;
        if (no === list.headerRow) {
          if (!Object.keys(mapping ?? {}).length) mapping = this.validMapping(guessPriceListMapping(cells));
          return;
        }
        const row = this.parseRow(cells, mapping, list);
        if (!row) {
          stats.skipped++;
          return;
        }
        stats.rows++;
        batch.push(row);
        if (batch.length >= BATCH) await flush();
      });
      await flush();
      await this.tenantTx.run(async (tx) => {
        // Пропавшие из нового прайса строки удаляются
        const del = await tx.rows(`DELETE FROM price_list_rows WHERE tenant_id = $1 AND price_list_id = $2 AND load_id IS DISTINCT FROM $3 RETURNING id`, [tenantId, list.id, load.id]);
        stats.removed = del.length;
        await this.matchProducts(tx, list.id);
        stats.crossesAdded = await this.addCrosses(tx, list.id, load.id);
        await tx.query(
          `UPDATE price_lists SET status = 'ready', rows_count = (SELECT count(*) FROM price_list_rows WHERE tenant_id = $1 AND price_list_id = $2),
                  loaded_at = now(), last_error = NULL, mapping = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2`,
          [tenantId, list.id, JSON.stringify(mapping)],
        );
        await tx.query(
          `UPDATE price_list_loads SET status = 'done', finished_at = now(), rows = $3, added = $4, updated = $5, removed = $6, price_changes = $7, skipped = $8, crosses_added = $9, file_id = coalesce(file_id, $10)
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, load.id, stats.rows, stats.added, stats.updated, stats.removed, stats.priceChanges, stats.skipped, stats.crossesAdded, file.id],
        );
        await this.notifications.notify(tx, {
          type: 'import.finished',
          title: `Прайс «${list.name}» загружен: ${stats.rows} строк, изменений цен ${stats.priceChanges}`,
          entityType: 'price_list',
          entityId: list.id,
          permission: 'purchasing.pricelists',
        });
      }, opts);
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 1000) ?? 'Ошибка загрузки';
      this.logger.warn(`Прайс ${list.id}: ${msg}`);
      await this.tenantTx.run(async (tx) => {
        await tx.query(`UPDATE price_lists SET status = CASE WHEN rows_count > 0 THEN 'ready' ELSE 'failed' END, last_error = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, list.id, msg]);
        await tx.query(`UPDATE price_list_loads SET status = 'failed', error = $3, finished_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, load.id, msg]);
      }, opts);
    }
  }

  private parseRow(cells: string[], m: PriceListMapping, list: PriceList) {
    const get = (k: keyof PriceListMapping) => (m[k] !== undefined ? (cells[m[k]!] ?? '').trim() : '');
    const number = get('number');
    const normalized = normalizePartNumber(number);
    if (!normalized || normalized.length > 80) return null;
    const price = parseNumber(get('price'));
    const curRaw = get('currency').toLowerCase().replace(/\.$/, '');
    const currency = (curRaw && (CURRENCY_ALIASES[curRaw] ?? (curRaw.length === 3 ? curRaw.toUpperCase() : ''))) || list.currency;
    const stockText = get('stock').slice(0, 30) || null;
    const stockNum = stockText ? parseNumber(stockText.replace(/^[<>~]+/, '')) : null;
    const lead = parseNumber(get('leadDays'));
    const mult = parseNumber(get('multiplicity'));
    return {
      number: number.slice(0, 80),
      normalized,
      brandText: get('brand').slice(0, 100) || null,
      name: get('name').slice(0, 300) || null,
      price: price && price.gte(0) ? price.toDecimalPlaces(4).toFixed() : null,
      currency,
      stockText,
      stockQty: stockNum ? stockNum.toFixed() : null,
      leadDays: lead ? Math.round(Number(lead)) : list.defaultLeadDays,
      multiplicity: mult && mult.gt(0) ? mult.toFixed() : null,
      oem: get('oem').slice(0, 500) || null,
      applicability: get('applicability').slice(0, 1000) || null,
    };
  }

  private async upsertBatch(tx: TenantTx, list: PriceList, loadId: string, rows: Record<string, any>[], stats: Record<string, number>) {
    // Бренд: известный (общий или свой) → brand_id; иначе — текстом
    for (const r of rows) {
      const b = r.brandText ? await this.brands.resolve(tx, r.brandText, false) : null;
      r.brandId = b?.id ?? null;
      r.brandKey = b ? b.id : r.brandText ? `txt:${r.brandText.toLowerCase()}` : '';
    }
    const byKey = new Map<string, Record<string, any>>();
    for (const r of rows) byKey.set(`${r.normalized}|${r.brandKey}`, r);
    const uniq = [...byKey.values()];
    const existing = await tx.query(
      `SELECT normalized, brand_key, price, currency FROM price_list_rows
        WHERE tenant_id = $1 AND price_list_id = $2 AND (normalized, brand_key) IN (SELECT * FROM unnest($3::text[], $4::text[]))`,
      [tx.tenantId, list.id, uniq.map((r) => r.normalized), uniq.map((r) => r.brandKey)],
    );
    const ex = new Map(existing.map((e: any) => [`${e.normalized}|${e.brand_key}`, e]));
    const history: any[] = [];
    for (const r of uniq) {
      const e: any = ex.get(`${r.normalized}|${r.brandKey}`);
      if (!e) stats.added++;
      else {
        stats.updated++;
        const oldP = e.price === null ? null : D(e.price);
        const newP = r.price === null ? null : D(r.price);
        if ((oldP === null) !== (newP === null) || (oldP && newP && !oldP.eq(newP)) || e.currency !== r.currency) {
          stats.priceChanges++;
          history.push(r);
          r.__old = e.price;
        }
      }
    }
    if (history.length) {
      await tx.query(
        `INSERT INTO price_list_price_history (tenant_id, created_by, price_list_id, normalized, brand_key, old_price, new_price, currency, load_id)
         SELECT $1, $2, $3, n, k, o::numeric, p::numeric, c, $4 FROM unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::text[]) AS x(n, k, o, p, c)`,
        [tx.tenantId, tx.userId, list.id, loadId, history.map((r) => r.normalized), history.map((r) => r.brandKey), history.map((r) => r.__old), history.map((r) => r.price), history.map((r) => r.currency)],
      );
    }
    const col = (k: string) => uniq.map((r) => r[k] ?? null);
    await tx.query(
      `INSERT INTO price_list_rows (tenant_id, created_by, price_list_id, supplier_id, brand_id, brand_text, brand_key, number, normalized, name, price, currency,
                                    stock_text, stock_qty, lead_days, multiplicity, oem, applicability, load_id)
       SELECT $1, $2, $3, $4, b::uuid, bt, bk, num, nrm, nm, pr::numeric, cur, st, sq::numeric, ld::int, ml::numeric, oem, app, $5
         FROM unnest($6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[], $17::text[], $18::text[], $19::text[])
           AS x(b, bt, bk, num, nrm, nm, pr, cur, st, sq, ld, ml, oem, app)
       ON CONFLICT (tenant_id, price_list_id, normalized, brand_key) DO UPDATE SET
         brand_id = EXCLUDED.brand_id, brand_text = EXCLUDED.brand_text, number = EXCLUDED.number, name = EXCLUDED.name, price = EXCLUDED.price,
         currency = EXCLUDED.currency, stock_text = EXCLUDED.stock_text, stock_qty = EXCLUDED.stock_qty, lead_days = EXCLUDED.lead_days,
         multiplicity = EXCLUDED.multiplicity, oem = EXCLUDED.oem, applicability = EXCLUDED.applicability, load_id = EXCLUDED.load_id, updated_at = now()`,
      [
        tx.tenantId, tx.userId, list.id, list.supplierId, loadId,
        col('brandId'), col('brandText'), col('brandKey'), col('number'), col('normalized'), col('name'), col('price'), col('currency'),
        col('stockText'), col('stockQty'), uniq.map((r) => (r.leadDays === null || r.leadDays === undefined ? null : String(r.leadDays))), col('multiplicity'), col('oem'), col('applicability'),
      ],
    );
  }

  /** Связь строк прайса с каталогом: тот же номер и бренд (бренд в прайсе не указан — по номеру, если товар один). */
  private async matchProducts(tx: TenantTx, listId: string) {
    await tx.query(
      `UPDATE price_list_rows r SET product_id = m.product_id FROM (
         SELECT DISTINCT ON (r2.id) r2.id, pn.product_id
           FROM price_list_rows r2 JOIN part_numbers pn ON pn.tenant_id = r2.tenant_id AND pn.normalized = r2.normalized AND pn.type IN ('manufacturer', 'oem')
           JOIN products p ON p.id = pn.product_id AND p.deleted_at IS NULL AND p.merged_into_id IS NULL
          WHERE r2.tenant_id = $1 AND r2.price_list_id = $2 AND (r2.brand_id IS NULL OR pn.brand_id = r2.brand_id OR pn.brand_id IS NULL)
          ORDER BY r2.id, (pn.brand_id = r2.brand_id) DESC NULLS LAST, pn.type) m
        WHERE r.id = m.id AND r.tenant_id = $1`,
      [tx.tenantId, listId],
    );
  }

  /** Аналоги из строк с OEM-номерами → кроссы (источник «прайс»). */
  private async addCrosses(tx: TenantTx, listId: string, loadId: string): Promise<number> {
    const rows = await tx.query(
      `SELECT number, normalized, brand_id, oem FROM price_list_rows WHERE tenant_id = $1 AND price_list_id = $2 AND load_id = $3 AND oem IS NOT NULL LIMIT 200000`,
      [tx.tenantId, listId, loadId],
    );
    const a: any[] = [];
    for (const r of rows) {
      for (const o of String(r.oem).split(/[,;/|\n]+/)) {
        const raw = o.trim();
        const n = normalizePartNumber(raw);
        if (!n || n === r.normalized || n.length > 80) continue;
        // Упорядочиваем пару, как CrossesService: A↔B и B↔A — одна запись
        let x = { brand: r.brand_id as string | null, number: r.number, normalized: r.normalized };
        let y = { brand: null as string | null, number: raw.slice(0, 80), normalized: n };
        if (`${x.normalized}|${x.brand ?? ''}` > `${y.normalized}|${y.brand ?? ''}`) [x, y] = [y, x];
        a.push([x, y]);
      }
    }
    let added = 0;
    for (let i = 0; i < a.length; i += 2000) {
      const part = a.slice(i, i + 2000);
      const res = await tx.query(
        `INSERT INTO part_crosses (tenant_id, created_by, a_brand_id, a_number, a_normalized, a_brand_key, b_brand_id, b_number, b_normalized, b_brand_key, cross_type, source, source_ref_id)
         SELECT $1, $2, ab::uuid, an, anr, coalesce(ab, ''), bb::uuid, bn, bnr, coalesce(bb, ''), 'full', 'pricelist', $3
           FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]) AS x(ab, an, anr, bb, bn, bnr)
         ON CONFLICT (tenant_id, a_normalized, a_brand_key, b_normalized, b_brand_key) DO NOTHING RETURNING id`,
        [
          tx.tenantId, tx.userId, listId,
          part.map((p) => p[0].brand), part.map((p) => p[0].number), part.map((p) => p[0].normalized),
          part.map((p) => p[1].brand), part.map((p) => p[1].number), part.map((p) => p[1].normalized),
        ],
      );
      added += res.length;
    }
    return added;
  }

  // ── Загрузка по ссылке ───────────────────────────────────

  private checkUrlSyntax(url: string) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw Errors.bad('BAD_URL', 'Неверная ссылка');
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw Errors.bad('BAD_URL', 'Ссылка должна начинаться с http:// или https://');
  }

  /** Защита от запросов во внутреннюю сеть сервера (SSRF): только публичные адреса. */
  private async assertPublicHost(host: string) {
    if (this.config.pricelistAllowPrivateUrls) return;
    const addrs = isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error('Адрес прайса не найден');
    for (const { address } of addrs) {
      if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address) || /^(::1|fc|fd|fe80|::ffff:(10|127|192\.168)\.)/i.test(address)) {
        throw new Error('Ссылка ведёт во внутреннюю сеть — запрещено');
      }
    }
  }

  private async download(tenantId: string, list: PriceList): Promise<StoredFile> {
    if (!list.url) throw new Error('У прайса нет ссылки');
    let url = list.url;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(url);
      await this.assertPublicHost(u.hostname);
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'AutopartsCRM-PriceList/1.0' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, url).toString();
        continue;
      }
      break;
    }
    if (!res || !res.ok) throw new Error(`Ссылка не открылась: ${res?.status ?? 'нет ответа'}`);
    const max = this.config.pricelistMaxBytes;
    if (Number(res.headers.get('content-length') ?? 0) > max) throw new Error('Файл прайса слишком большой');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new Error('Файл прайса слишком большой');
    const isXlsx = buf.subarray(0, 2).toString() === 'PK';
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'price') || 'price';
    const fileName = /\.(xlsx|csv)$/i.test(name) ? name : `${name}.${isXlsx ? 'xlsx' : 'csv'}`;
    const mime = isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv';
    return this.tenantTx.run(
      () => this.files.save({ originalname: fileName, mimetype: mime, buffer: buf, size: buf.length } as Express.Multer.File, { purpose: 'import', entityType: 'price_list', entityId: list.id }),
      { tenantId, userId: null },
    );
  }

  // ── Поиск и строки ───────────────────────────────────────

  /**
   * Строки прайсов по номерам (и их аналогам из кроссов): «у кого есть, почём, за сколько привезут» (ТЗ 5.1, 10.2).
   * Закупочная цена — только с правом видеть себестоимость.
   */
  async searchByNumbers(tx: TenantTx, normalized: string[], opts: { withAnalogs?: boolean; limit?: number } = {}) {
    const nums = [...new Set(normalized.filter(Boolean))];
    if (!nums.length) return [];
    let all = nums;
    const via = new Map<string, string>();
    if (opts.withAnalogs !== false) {
      const cr = await tx.query(
        `SELECT a_normalized AS src, b_normalized AS dst FROM part_crosses WHERE tenant_id = $1 AND a_normalized = ANY($2::text[])
         UNION SELECT b_normalized, a_normalized FROM part_crosses WHERE tenant_id = $1 AND b_normalized = ANY($2::text[]) LIMIT 500`,
        [tx.tenantId, nums],
      );
      for (const c of cr) if (!nums.includes(c.dst)) via.set(c.dst, c.src);
      all = [...nums, ...via.keys()];
    }
    const rows = await tx.query(
      `SELECT r.id, r.price_list_id AS "priceListId", l.name AS "priceListName", r.supplier_id AS "supplierId", c.name AS "supplierName",
              r.number, r.normalized, coalesce(b.name, r.brand_text) AS brand, r.name, r.price, r.currency, r.stock_text AS "stockText",
              r.stock_qty AS "stockQty", r.lead_days AS "leadDays", r.multiplicity, r.product_id AS "productId", l.loaded_at AS "updatedAt"
         FROM price_list_rows r JOIN price_lists l ON l.id = r.price_list_id AND l.deleted_at IS NULL AND l.is_active
         JOIN counterparties c ON c.id = r.supplier_id LEFT JOIN brands b ON b.id = r.brand_id
        WHERE r.tenant_id = $1 AND r.normalized = ANY($2::text[])
        ORDER BY (r.stock_qty IS NULL OR r.stock_qty > 0) DESC, r.lead_days NULLS LAST, r.price NULLS LAST LIMIT $3`,
      [tx.tenantId, all, opts.limit ?? 50],
    );
    const canCost = this.ctx.can('products.view_cost');
    const rates = await this.resolver.rates(tx);
    return rows.map((r: any) => {
      const rate = r.currency === 'KGS' ? 1 : Number(rates[r.currency] ?? 0);
      return {
        ...r,
        price: canCost ? r.price : undefined,
        priceKgs: canCost && r.price !== null && rate ? D(r.price).mul(rate).toDecimalPlaces(2).toFixed(2) : undefined,
        analog: via.has(r.normalized) ? { via: via.get(r.normalized) } : null,
      };
    });
  }

  search(q: string, limit?: number) {
    return this.tenantTx.run(async (tx) => this.searchByNumbers(tx, [normalizePartNumber(q)], { limit }));
  }

  rows(id: string, q: { q?: string; page: number; limit: number }) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(PriceList, 'Прайс').getById(id);
      const params: unknown[] = [tx.tenantId, id];
      let w = 'r.tenant_id = $1 AND r.price_list_id = $2';
      if (q.q) {
        params.push(`${normalizePartNumber(q.q)}%`, `%${q.q}%`);
        w += ` AND (r.normalized LIKE $3 OR r.name ILIKE $4)`;
      }
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM price_list_rows r WHERE ${w}`, params);
      const canCost = this.ctx.can('products.view_cost');
      const items = await tx.query(
        `SELECT r.id, r.number, coalesce(b.name, r.brand_text) AS brand, r.name, ${canCost ? 'r.price,' : ''} r.currency, r.stock_text AS "stockText",
                r.lead_days AS "leadDays", r.multiplicity, r.oem, r.applicability, r.product_id AS "productId", r.updated_at AS "updatedAt"
           FROM price_list_rows r LEFT JOIN brands b ON b.id = r.brand_id WHERE ${w} ORDER BY r.normalized LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total };
    });
  }

  /** История цены номера в прайсе. */
  history(rowId: string) {
    return this.tenantTx.run(async (tx) => {
      const r = await tx.repo(PriceListRow, 'Строка прайса').getById(rowId);
      return tx.query(
        `SELECT old_price AS "oldPrice", new_price AS "newPrice", currency, created_at AS "at" FROM price_list_price_history
          WHERE tenant_id = $1 AND price_list_id = $2 AND normalized = $3 AND brand_key = $4 ORDER BY created_at DESC LIMIT 100`,
        [tx.tenantId, r.priceListId, r.normalized, r.brandKey],
      );
    });
  }

  /** Создать товар в каталоге из строки прайса одной кнопкой — номер, бренд, аналоги (OEM), применимость. */
  createProduct(rowId: string, dto: { name?: string; categoryId?: string; retailPrice?: string }) {
    return this.tenantTx.run(async (tx) => {
      const r = await tx.repo(PriceListRow, 'Строка прайса').getById(rowId);
      if (r.productId) throw Errors.conflict('ALREADY_IN_CATALOG', 'Товар уже есть в каталоге', { productId: r.productId });
      const oem = (r.oem ?? '').split(/[,;/|\n]+/).map((x) => x.trim()).filter((x) => x && normalizePartNumber(x) !== r.normalized).slice(0, 20);
      const p = await this.products.createInTx(
        tx,
        {
          name: dto.name?.trim() || r.name || `${r.brandText ?? ''} ${r.number}`.trim(),
          brand: r.brandText ?? undefined,
          brandId: r.brandId ?? undefined,
          number: r.number,
          oemNumbers: oem,
          categoryId: dto.categoryId,
          applicability: r.applicability ? r.applicability.split(/[;\n]+/).map((t) => ({ text: t.trim() })).filter((a) => a.text).slice(0, 30) : undefined,
          retailPrice: dto.retailPrice,
        } as any,
        { quick: true },
      );
      await tx.query(`UPDATE price_list_rows SET product_id = $3 WHERE tenant_id = $1 AND normalized = $2 AND (brand_id = $4 OR brand_id IS NULL)`, [tx.tenantId, r.normalized, p.id, r.brandId]);
      return p;
    });
  }
}
