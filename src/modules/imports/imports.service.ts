import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { normalizeBarcode } from '../../common/utils/barcode';
import { D, money } from '../../common/utils/decimal';
import { normalizePartNumber, partNumberSkeleton } from '../../common/utils/part-number';
import { readTable, tableKind } from '../../common/utils/table-reader';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { AuditService } from '../audit/audit.service';
import { BrandsService } from '../catalog/brands.service';
import { Category } from '../catalog/entities/category.entity';
import { PartType } from '../catalog/entities/part-type.entity';
import { Product, ProductBarcode, ProductPhoto } from '../catalog/entities/product.entity';
import { ProductsService } from '../catalog/products.service';
import { SearchTextService } from '../catalog/search-text.service';
import { StoredFile } from '../files/entities/file.entity';
import { FilesService } from '../files/files.service';
import { StockProbeService } from '../inventory/stock-probe.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CrossesService } from '../parts/crosses.service';
import { PartCross, PartNumber } from '../parts/entities/part-number.entity';
import { Price } from '../pricing/entities/price.entity';
import { PricesService } from '../pricing/prices.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ApplicabilityService } from '../vehicles/applicability.service';
import { ProductApplicability } from '../vehicles/entities/vehicle.entity';
import { VehicleDirectoryService } from '../vehicles/vehicle-directory.service';
import { ImportJob, ImportType } from './entities/import-job.entity';
import { IMPORT_FIELDS, guessMapping, qualityFromText } from './import-fields';

const QUEUE = 'import.run';
const CHUNK = 200;
const MAX_ERRORS = 2000;
const SYNC_PREVIEW_ROWS = 20000;

interface RowCtx {
  categories: Map<string, string | null>;
  partTypes: Map<string, string | null>;
  vehicles: Map<string, boolean>;
  options: ImportOptions;
}

export interface ImportOptions {
  /** Обновлять найденные товары (по бренду+номеру или артикулу). По умолчанию да */
  updateExisting?: boolean;
  /** Создавать отсутствующие категории */
  createCategories?: boolean;
  /** Строка заголовков (с 1). По умолчанию 1 */
  headerRow?: number;
}

/**
 * Импорт Excel/CSV (ТЗ 4.8, 21.2): загрузка → сопоставление колонок (угадывается само) → предпросмотр с ошибками
 * по строкам → запуск в фоне (pg-boss) с прогрессом в реальном времени → отчёт. Загружаются только корректные строки.
 * Откат загрузки целиком — пока по созданным товарам нет ни одного документа.
 */
@Injectable()
export class ImportsService implements OnModuleInit {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly files: FilesService,
    private readonly jobs: JobsService,
    private readonly products: ProductsService,
    private readonly brands: BrandsService,
    private readonly crosses: CrossesService,
    private readonly applicability: ApplicabilityService,
    private readonly vehicles: VehicleDirectoryService,
    private readonly prices: PricesService,
    private readonly searchText: SearchTextService,
    private readonly stock: StockProbeService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit() {
    await this.jobs.work<{ tenantId: string; userId: string | null; jobId: string }>(
      QUEUE,
      async (data) => {
        await this.execute(data.tenantId, data.userId, data.jobId);
      },
      { batchSize: 1 },
    );
  }

  fields(type: ImportType) {
    return IMPORT_FIELDS[type];
  }

  // ── 1. Загрузка ─────────────────────────────────────────

  async create(type: ImportType, fileId: string, headerRow = 1) {
    const file = await this.tenantTx.repo(StoredFile, 'Файл').getById(fileId);
    const kind = tableKind(file.originalName, file.mime);
    if (!kind) throw Errors.bad('FILE_TYPE', 'Нужен файл Excel (.xlsx) или CSV');
    const { header, sample, total } = await this.peek(this.files.pathOf(file), kind, headerRow);
    if (!header.length) throw Errors.bad('EMPTY_FILE', 'В файле нет строки заголовков');
    const mapping = guessMapping(type, header);
    const job = await this.tenantTx.repo(ImportJob).insert({
      type,
      fileId,
      fileName: file.originalName,
      columns: header,
      mapping,
      options: { headerRow },
      totalRows: total,
      status: 'uploaded',
    });
    return { job, columns: header, sample, suggestedMapping: mapping, fields: IMPORT_FIELDS[type] };
  }

  private async peek(path: string, kind: 'xlsx' | 'csv', headerRow: number) {
    let header: string[] = [];
    const sample: string[][] = [];
    let total = 0;
    await readTable(path, kind, (rowNo, cells) => {
      if (rowNo < headerRow) return;
      if (rowNo === headerRow) header = cells.map((c, i) => c || `Колонка ${i + 1}`);
      else {
        total++;
        if (sample.length < 20) sample.push(cells);
      }
    });
    return { header, sample, total };
  }

  // ── 2. Предпросмотр ─────────────────────────────────────

  async preview(jobId: string, mapping: Record<string, number>, options: ImportOptions = {}) {
    const job = await this.tenantTx.repo(ImportJob, 'Импорт').getById(jobId);
    if (!['uploaded', 'previewed'].includes(job.status)) throw Errors.conflict('IMPORT_STATE', 'Импорт уже запущен');
    this.validateMapping(job.type, mapping, job.columns.length);
    const file = await this.tenantTx.repo(StoredFile, 'Файл').getById(job.fileId);
    const kind = tableKind(file.originalName, file.mime)!;
    const headerRow = options.headerRow ?? Number(job.options.headerRow ?? 1);

    const rows: { rowNo: number; data: Record<string, string> }[] = [];
    await readTable(this.files.pathOf(file), kind, (rowNo, cells) => {
      if (rowNo <= headerRow) return;
      if (rows.length >= SYNC_PREVIEW_ROWS) return false;
      rows.push({ rowNo, data: pick(cells, mapping) });
    });

    return this.tenantTx.run(async (tx) => {
      const ctx = await this.makeCtx(tx, { ...job.options, ...options });
      const errors: { row: number; field?: string; message: string }[] = [];
      let valid = 0;
      for (const r of rows) {
        const e = await this.validateRow(tx, job.type, r.data, ctx);
        if (e.length) errors.push(...e.map((x) => ({ row: r.rowNo, ...x })));
        else valid++;
      }
      const matches = job.type === 'products' ? await this.countExisting(tx, rows.map((r) => r.data)) : null;
      job.mapping = mapping;
      job.options = { ...job.options, ...options, headerRow };
      job.status = 'previewed';
      await tx.repo(ImportJob).save(job);
      return {
        jobId: job.id,
        checkedRows: rows.length,
        totalRows: job.totalRows,
        partial: job.totalRows > rows.length,
        validRows: valid,
        errorRows: new Set(errors.map((e) => e.row)).size,
        errors: errors.slice(0, 500),
        wouldUpdate: matches,
        wouldCreate: matches === null ? null : Math.max(0, valid - matches),
        sample: rows.slice(0, 10),
      };
    });
  }

  private validateMapping(type: ImportType, mapping: Record<string, number>, columns: number) {
    const fields = IMPORT_FIELDS[type];
    for (const [k, v] of Object.entries(mapping)) {
      if (!fields.some((f) => f.key === k) && !k.startsWith('attr:')) throw Errors.bad('BAD_MAPPING', `Неизвестное поле: ${k}`);
      if (!Number.isInteger(v) || v < 0 || v >= columns) throw Errors.bad('BAD_MAPPING', `Нет колонки №${v + 1} для «${k}»`);
    }
    for (const f of fields.filter((x) => x.required)) {
      if (mapping[f.key] === undefined) throw Errors.bad('BAD_MAPPING', `Не выбрана колонка для «${f.label}»`);
    }
    if (type === 'products' && mapping.name === undefined && mapping.number === undefined && mapping.sku === undefined) {
      throw Errors.bad('BAD_MAPPING', 'Выберите колонку с названием, номером или артикулом');
    }
    if (type === 'applicability' && mapping.sku === undefined && mapping.number === undefined) {
      throw Errors.bad('BAD_MAPPING', 'Чтобы найти товар, нужен артикул или номер');
    }
  }

  // ── 3. Запуск в фоне ────────────────────────────────────

  async run(jobId: string) {
    const job = await this.tenantTx.run(async (tx) => {
      const j = await tx.repo(ImportJob, 'Импорт').getById(jobId, { lock: { mode: 'pessimistic_write' } } as any);
      if (j.status !== 'previewed') throw Errors.conflict('IMPORT_STATE', 'Сначала выполните предпросмотр');
      j.status = 'queued';
      return tx.repo(ImportJob).save(j);
    });
    await this.jobs.send(QUEUE, { tenantId: job.tenantId, userId: job.createdBy, jobId: job.id }, { retryLimit: 0 });
    return job;
  }

  /** Обработчик pg-boss: идёт кусками по 200 строк, каждая строка — в своей точке сохранения. */
  async execute(tenantId: string, userId: string | null, jobId: string) {
    const opts = { tenantId, userId };
    const job = await this.tenantTx.run((tx) => tx.repo(ImportJob).getById(jobId), opts);
    if (job.status !== 'queued') return;
    const file = await this.tenantTx.run((tx) => tx.repo(StoredFile).getById(job.fileId), opts);
    const kind = tableKind(file.originalName, file.mime)!;
    const headerRow = Number(job.options.headerRow ?? 1);

    await this.tenantTx.run(async (tx) => {
      await tx.query(`UPDATE import_jobs SET status = 'running', started_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, jobId]);
    }, opts);

    const stats = { processed: 0, created: 0, updated: 0, errors: 0 };
    const errors: { row: number; field?: string; message: string }[] = [];
    let buffer: { rowNo: number; data: Record<string, string> }[] = [];

    const flush = async () => {
      if (!buffer.length) return;
      const chunk = buffer;
      buffer = [];
      await this.tenantTx.run(async (tx) => {
        const ctx = await this.makeCtx(tx, job.options as ImportOptions);
        const touched: string[] = [];
        for (const r of chunk) {
          await tx.query('SAVEPOINT import_row');
          try {
            const e = await this.validateRow(tx, job.type, r.data, ctx);
            if (e.length) throw new RowError(e);
            const res = await this.applyRow(tx, job, r.data, ctx);
            if (res.productId) touched.push(res.productId);
            if (res.created) stats.created++;
            else if (res.updated) stats.updated++;
            await tx.query('RELEASE SAVEPOINT import_row');
          } catch (err) {
            await tx.query('ROLLBACK TO SAVEPOINT import_row');
            stats.errors++;
            const list = err instanceof RowError ? err.errors : [{ message: humanError(err) }];
            if (errors.length < MAX_ERRORS) errors.push(...list.map((x) => ({ row: r.rowNo, ...x })));
          }
          stats.processed++;
        }
        if (touched.length) await this.searchText.rebuild(tx, [...new Set(touched)]);
        await tx.query(
          `UPDATE import_jobs SET processed_rows = $3, created_count = $4, updated_count = $5, error_count = $6, errors = $7
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, jobId, stats.processed, stats.created, stats.updated, stats.errors, JSON.stringify(errors.slice(0, MAX_ERRORS))],
        );
      }, opts);
      if (userId) {
        this.realtime.toUser(tenantId, userId, 'import.progress', {
          jobId,
          processed: stats.processed,
          total: job.totalRows,
          created: stats.created,
          updated: stats.updated,
          errors: stats.errors,
        });
      }
    };

    try {
      await readTable(this.files.pathOf(file), kind, async (rowNo, cells) => {
        if (rowNo <= headerRow) return;
        if (cells.every((c) => !c)) return;
        buffer.push({ rowNo, data: pick(cells, job.mapping) });
        if (buffer.length >= CHUNK) await flush();
      });
      await flush();
      await this.finish(tenantId, userId, jobId, 'done', null, stats);
    } catch (e) {
      this.logger.error(`Импорт ${jobId}: ${(e as Error).message}`);
      await this.finish(tenantId, userId, jobId, 'failed', humanError(e), stats);
    }
  }

  private async finish(tenantId: string, userId: string | null, jobId: string, status: 'done' | 'failed', reason: string | null, stats: any) {
    await this.tenantTx.run(async (tx) => {
      await tx.query(
        `UPDATE import_jobs SET status = $3, fail_reason = $4, finished_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, jobId, status, reason],
      );
      await this.audit.log(tx, {
        action: 'import.finish',
        entityType: 'import',
        entityId: jobId,
        summary: `Импорт: создано ${stats.created}, обновлено ${stats.updated}, ошибок ${stats.errors}`,
        after: stats,
        important: true,
      });
      if (userId) {
        await this.notifications.notify(tx, {
          type: 'import.finished',
          title: status === 'done' ? `Импорт завершён: +${stats.created}, обновлено ${stats.updated}, ошибок ${stats.errors}` : `Импорт не выполнен: ${reason}`,
          entityType: 'import',
          entityId: jobId,
          userIds: [userId],
          link: `/settings/imports/${jobId}`,
        });
      }
    }, { tenantId, userId });
    if (userId) this.realtime.toUser(tenantId, userId, 'import.finished', { jobId, status, ...stats });
  }

  // ── Строки ──────────────────────────────────────────────

  private async makeCtx(tx: TenantTx, options: ImportOptions): Promise<RowCtx> {
    const cats = await tx.repo(Category).find();
    const categories = new Map<string, string | null>();
    const byId = new Map(cats.map((c) => [c.id, c]));
    for (const c of cats) {
      categories.set(c.name.toLowerCase(), c.id);
      const pathNames = c.path.split('/').filter(Boolean).map((id) => byId.get(id)?.name.toLowerCase()).filter(Boolean);
      categories.set(pathNames.join('/'), c.id);
    }
    const types = await tx.repo(PartType).find();
    const partTypes = new Map<string, string | null>(types.flatMap((t) => [[t.name.toLowerCase(), t.id], [t.code.toLowerCase(), t.id]] as [string, string][]));
    return { categories, partTypes, vehicles: new Map(), options };
  }

  private async validateRow(tx: TenantTx, type: ImportType, d: Record<string, string>, ctx: RowCtx) {
    const e: { field?: string; message: string }[] = [];
    if (type === 'products') {
      if (!d.name && !d.number && !d.sku) e.push({ field: 'name', message: 'Пустая строка: нет названия, номера и артикула' });
      if (d.name && d.name.length > 300) e.push({ field: 'name', message: 'Название длиннее 300 символов' });
      if (d.number && !normalizePartNumber(d.number)) e.push({ field: 'number', message: 'Номер без букв и цифр' });
      for (const f of ['price', 'minPrice'] as const) {
        if (d[f] && !isMoney(d[f])) e.push({ field: f, message: `Цена «${d[f]}» — не число` });
      }
      if (d.qualityClass && !qualityFromText(d.qualityClass)) e.push({ field: 'qualityClass', message: `Неизвестный класс «${d.qualityClass}»` });
      if (d.category && !ctx.categories.has(d.category.toLowerCase().replace(/\s*\/\s*/g, '/')) && !ctx.options.createCategories) {
        e.push({ field: 'category', message: `Нет категории «${d.category}» (включите «создавать категории»)` });
      }
      if (d.partType && !ctx.partTypes.has(d.partType.toLowerCase())) e.push({ field: 'partType', message: `Нет типа детали «${d.partType}»` });
      if (d.baseUnit && !['шт', 'л', 'м', 'кг', 'компл', 'пара'].includes(unitAlias(d.baseUnit))) e.push({ field: 'baseUnit', message: `Неизвестная единица «${d.baseUnit}»` });
    }
    if (type === 'crosses') {
      if (!normalizePartNumber(d.aNumber)) e.push({ field: 'aNumber', message: 'Пустой номер 1' });
      if (!normalizePartNumber(d.bNumber)) e.push({ field: 'bNumber', message: 'Пустой номер 2' });
    }
    if (type === 'applicability' && !d.vehicles) e.push({ field: 'vehicles', message: 'Не указана машина' });
    if (d.vehicles) {
      for (const v of splitList(d.vehicles, /[;\n]/)) {
        if (!ctx.vehicles.has(v)) ctx.vehicles.set(v, (await this.vehicles.resolve(tx, v, 1)).length > 0);
        if (!ctx.vehicles.get(v)) e.push({ field: 'vehicles', message: `Не нашли машину «${v}»` });
      }
    }
    return e;
  }

  private async applyRow(tx: TenantTx, job: ImportJob, d: Record<string, string>, ctx: RowCtx): Promise<{ productId?: string; created?: boolean; updated?: boolean }> {
    if (job.type === 'crosses') {
      const r = await this.crosses.addInTx(
        tx,
        { aBrand: d.aBrand || null, aNumber: d.aNumber, bBrand: d.bBrand || null, bNumber: d.bNumber, crossType: crossType(d.crossType) },
        'import',
        job.id,
      );
      return { created: r.created };
    }
    if (job.type === 'applicability') {
      const p = await this.findProduct(tx, d);
      if (!p) throw new RowError([{ message: 'Товар не найден по артикулу/номеру' }]);
      const items = splitList(d.vehicles, /[;\n]/).map((text) => ({
        text,
        yearFrom: d.yearFrom ? Number(d.yearFrom) || undefined : undefined,
        yearTo: d.yearTo ? Number(d.yearTo) || undefined : undefined,
      }));
      await this.applicability.add(tx, [p.id], items);
      return { productId: p.id, updated: true };
    }

    // Товары
    const categoryId = await this.categoryId(tx, d.category, ctx);
    const partTypeId = d.partType ? (ctx.partTypes.get(d.partType.toLowerCase()) ?? null) : undefined;
    const attributes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) if (k.startsWith('attr:') && v) attributes[k.slice(5)] = v;
    const existing = await this.findProduct(tx, d);
    const oem = d.oem ? splitList(d.oem, /[,;\n]/) : undefined;
    const barcodes = d.barcode ? splitList(d.barcode, /[,;\s]/).map(normalizeBarcode) : [];

    if (existing) {
      if (ctx.options.updateExisting === false) return { productId: existing.id };
      if (d.name) existing.name = d.name.slice(0, 300);
      if (d.brand && !existing.brandId) existing.brandId = (await this.brands.resolve(tx, d.brand, true))?.id ?? null;
      if (categoryId !== undefined) existing.categoryId = categoryId;
      if (partTypeId !== undefined) existing.partTypeId = partTypeId;
      if (d.qualityClass) existing.qualityClass = qualityFromText(d.qualityClass) as any;
      if (d.description) existing.description = d.description;
      if (d.minPrice) existing.minPrice = money(toMoney(d.minPrice));
      if (d.tags) existing.tags = [...new Set([...existing.tags, ...splitList(d.tags, /,/)])];
      if (Object.keys(attributes).length) {
        existing.attributes = { ...existing.attributes, ...(await this.products.validateAttributes(tx, existing.partTypeId, attributes, false)) };
      }
      await tx.repo(Product).save(existing);
      if (oem) {
        for (const o of oem) {
          const n = normalizePartNumber(o);
          if (!n) continue;
          const has = await tx.repo(PartNumber).count({ where: { productId: existing.id, normalized: n } });
          if (!has) {
            await tx.repo(PartNumber).insert({ productId: existing.id, number: o, normalized: n, skeleton: partNumberSkeleton(n), type: 'oem', brandId: null });
          }
        }
      }
      const base = await this.products.baseUnit(tx, existing.id);
      for (const b of barcodes) {
        if (!(await tx.repo(ProductBarcode).count({ where: { productId: existing.id, barcode: b } }))) {
          await this.products.addBarcodeInTx(tx, existing.id, base.id, b, true);
        }
      }
      if (d.price) await this.setRetailIfChanged(tx, existing.id, d.price);
      if (d.vehicles) await this.applicability.add(tx, [existing.id], splitList(d.vehicles, /[;\n]/).map((text) => ({ text })));
      return { productId: existing.id, updated: true };
    }

    if (!d.name) throw new RowError([{ field: 'name', message: 'Товар не найден, а для нового нужно название' }]);
    const p = await this.products.createInTx(
      tx,
      {
        name: d.name.slice(0, 300),
        sku: d.sku || undefined,
        brand: d.brand || undefined,
        number: d.number || undefined,
        oemNumbers: oem,
        categoryId: categoryId ?? undefined,
        partTypeId: partTypeId ?? undefined,
        qualityClass: d.qualityClass ? (qualityFromText(d.qualityClass) as any) : undefined,
        attributes,
        baseUnit: d.baseUnit ? unitAlias(d.baseUnit) : undefined,
        barcodes,
        confirmDuplicateBarcode: true,
        retailPrice: d.price ? toMoney(d.price) : undefined,
        minPrice: d.minPrice ? toMoney(d.minPrice) : undefined,
        description: d.description || undefined,
        tags: d.tags ? splitList(d.tags, /,/) : undefined,
        applicability: d.vehicles ? splitList(d.vehicles, /[;\n]/).map((text) => ({ text })) : undefined,
      },
      { importJobId: job.id },
    );
    return { productId: p.id, created: true };
  }

  private async findProduct(tx: TenantTx, d: Record<string, string>): Promise<Product | null> {
    if (d.number) {
      const n = normalizePartNumber(d.number);
      if (n) {
        const brand = d.brand ? await this.brands.resolve(tx, d.brand, false) : null;
        const rows = await tx.query<{ product_id: string }>(
          brand
            ? `SELECT product_id FROM part_numbers WHERE tenant_id = $1 AND normalized = $2 AND type = 'manufacturer' AND brand_id = $3 LIMIT 1`
            : `SELECT n.product_id FROM part_numbers n JOIN products p ON p.id = n.product_id
                WHERE n.tenant_id = $1 AND n.normalized = $2 AND p.brand_id IS NULL AND p.deleted_at IS NULL LIMIT 1`,
          brand ? [tx.tenantId, n, brand.id] : [tx.tenantId, n],
        );
        if (rows[0]) return tx.repo(Product).findById(rows[0].product_id);
        if (d.brand) return null;
      }
    }
    if (d.sku) return tx.repo(Product).findOne({ where: { sku: d.sku } });
    return null;
  }

  private async countExisting(tx: TenantTx, rows: Record<string, string>[]): Promise<number> {
    const nums = rows.map((r) => normalizePartNumber(r.number ?? '')).filter(Boolean);
    const skus = rows.map((r) => r.sku).filter(Boolean);
    const [{ n }] = await tx.query(
      `SELECT count(DISTINCT p.id)::int AS n FROM products p
        WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND (p.sku = ANY($3) OR EXISTS (
          SELECT 1 FROM part_numbers x WHERE x.tenant_id = p.tenant_id AND x.product_id = p.id AND x.normalized = ANY($2)))`,
      [tx.tenantId, nums, skus],
    );
    return n;
  }

  private async categoryId(tx: TenantTx, raw: string | undefined, ctx: RowCtx): Promise<string | null | undefined> {
    if (!raw) return undefined;
    const key = raw.toLowerCase().replace(/\s*\/\s*/g, '/');
    if (ctx.categories.has(key)) return ctx.categories.get(key)!;
    if (!ctx.options.createCategories) throw new RowError([{ field: 'category', message: `Нет категории «${raw}»` }]);
    // Создаём путь «Группа/Подгруппа»
    let parent: Category | null = null;
    const parts = raw.split('/').map((s) => s.trim()).filter(Boolean);
    let pathKey = '';
    for (const name of parts) {
      pathKey = pathKey ? `${pathKey}/${name.toLowerCase()}` : name.toLowerCase();
      const known = ctx.categories.get(pathKey);
      if (known) {
        parent = await tx.repo(Category).findById(known);
        continue;
      }
      const cat: Category = await tx.repo(Category).insert({
        name,
        parentId: parent?.id ?? null,
        level: parent ? parent.level + 1 : 0,
        path: '/',
        settings: {},
      });
      cat.path = `${parent ? parent.path : '/'}${cat.id}/`;
      await tx.query(`UPDATE categories SET path = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, cat.id, cat.path]);
      ctx.categories.set(pathKey, cat.id);
      parent = cat;
    }
    ctx.categories.set(key, parent!.id);
    return parent!.id;
  }

  private async setRetailIfChanged(tx: TenantTx, productId: string, raw: string) {
    const price = toMoney(raw);
    const map = await this.prices.retailMap(tx, [productId]);
    const cur = map.get(productId);
    if (cur && D(cur.price).eq(price)) return;
    const retail = await this.prices.retailType(tx);
    await tx.repo(Price).insert({ priceTypeId: retail.id, productId, price: money(price), currency: retail.currency, storeId: null, unitId: null });
  }

  // ── Список, откат ───────────────────────────────────────

  async list() {
    return this.tenantTx.run((tx) => tx.repo(ImportJob).find({ order: { createdAt: 'DESC' }, take: 100 }).then((r) => r.map(({ errors: _e, ...x }) => x)));
  }

  async get(id: string) {
    return this.tenantTx.repo(ImportJob, 'Импорт').getById(id);
  }

  async rollback(id: string) {
    return this.tenantTx.run(async (tx) => {
      const job = await tx.repo(ImportJob, 'Импорт').getById(id, { lock: { mode: 'pessimistic_write' } } as any);
      if (job.status !== 'done' && job.status !== 'failed') throw Errors.conflict('IMPORT_STATE', 'Откатить можно только завершённый импорт');
      const created = await tx.repo(Product).find({ where: { importJobId: id } });
      for (const p of created) {
        if (await this.stock.hasMovements(tx, p.id)) {
          throw Errors.conflict('IMPORT_HAS_DOCUMENTS', `По товару «${p.name}» уже есть документы — откат невозможен`);
        }
      }
      const ids = created.map((p) => p.id);
      if (ids.length) {
        for (const entity of [PartNumber, ProductBarcode, ProductPhoto, ProductApplicability, Price]) {
          await tx.manager.createQueryBuilder().delete().from(entity).where('tenant_id = :t AND product_id = ANY(:ids)', { t: tx.tenantId, ids }).execute();
        }
        await tx.query(`UPDATE products SET deleted_at = now(), status = 'archived' WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tx.tenantId, ids]);
      }
      const crossRes = await tx.manager.createQueryBuilder().delete().from(PartCross).where('tenant_id = :t AND source_ref_id = :id', { t: tx.tenantId, id }).execute();
      job.status = 'rolled_back';
      await tx.repo(ImportJob).save(job);
      await this.audit.log(tx, {
        action: 'import.rollback',
        entityType: 'import',
        entityId: id,
        summary: `Откат импорта: удалено товаров ${ids.length}, кроссов ${crossRes.affected ?? 0}`,
        important: true,
      });
      return {
        removedProducts: ids.length,
        removedCrosses: crossRes.affected ?? 0,
        notReverted: job.updatedCount ? `Изменения ${job.updatedCount} существующих товаров не откатываются` : null,
      };
    });
  }
}

class RowError extends Error {
  constructor(readonly errors: { field?: string; message: string }[]) {
    super(errors.map((e) => e.message).join('; '));
  }
}

function pick(cells: string[], mapping: Record<string, number>) {
  const out: Record<string, string> = {};
  for (const [k, i] of Object.entries(mapping)) out[k] = (cells[i] ?? '').trim();
  return out;
}

const splitList = (s: string, re: RegExp) => s.split(re).map((x) => x.trim()).filter(Boolean);
const isMoney = (s: string) => /^-?\d+([.,]\d+)?$/.test(s.replace(/[\s\u00a0]/g, '').replace(/(сом|kgs|с)$/i, ''));
const toMoney = (s: string) => s.replace(/[\s\u00a0]/g, '').replace(/(сом|kgs|с)$/i, '').replace(',', '.');

function unitAlias(s: string) {
  const v = s.toLowerCase().replace(/\.$/, '').trim();
  const map: Record<string, string> = { шт: 'шт', штука: 'шт', pcs: 'шт', pc: 'шт', л: 'л', литр: 'л', l: 'л', м: 'м', метр: 'м', кг: 'кг', компл: 'компл', комплект: 'компл', к: 'компл', пара: 'пара', пар: 'пара' };
  return map[v] ?? v;
}

function crossType(s?: string) {
  const v = (s ?? '').toLowerCase();
  if (v.includes('част') || v.includes('partial')) return 'partial' as const;
  if (v.includes('ориг') || v.includes('oem') || v.includes('замен')) return 'oem_replacement' as const;
  return 'full' as const;
}

function humanError(e: unknown): string {
  const anyE = e as any;
  if (anyE?.response?.message) {
    const d = anyE.response.details;
    return Array.isArray(d) ? `${anyE.response.message}: ${d.map((x: any) => x.message ?? x).join('; ')}` : anyE.response.message;
  }
  if (anyE?.driverError?.code === '23505') return 'Дубль: такая запись уже есть';
  return anyE?.message ?? 'Ошибка';
}

