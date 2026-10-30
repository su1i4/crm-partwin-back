import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { D, Decimal } from '../../common/utils/decimal';
import { CountersService } from '../../database/tenant/counters.service';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { JobsService } from '../../jobs/jobs.service';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { PdfService } from '../printing/pdf.service';
import { Warehouse } from '../stores/entities/warehouse.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { CellStock, CellType, ProductLocation, StorageLocation, TaskLine, WarehouseTask } from './entities/storage.entity';

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/**
 * Хранение уровней 2 и 3 (ТЗ 8): справочник мест, привязка к группам и маркам, генератор ячеек, этикетки,
 * остаток по ячейкам, задания размещения / подбора / пополнения, циклическая инвентаризация.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger('Storage');

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    private readonly pdf: PdfService,
    private readonly registry: OutboxRegistry,
    private readonly jobs: JobsService,
    private readonly platform: PlatformDb,
  ) {}

  async onModuleInit() {
    // Приёмка на склад уровня 3 → задание на размещение (после COMMIT)
    this.registry.on('document.posted', async (e) => {
      if (!['receiving', 'surplus', 'initial_stock', 'customer_purchase', 'donor'].includes(e.payload.type) || e.payload.repost) return;
      await this.tenantTx.run((tx) => this.placementForDocument(tx, e.payload.id), { tenantId: e.tenantId, userId: null }).catch((err) => this.log.warn(`размещение: ${err.message}`));
    });
    await this.jobs.work('storage.cycle_count', async () => {
      const tenants = await this.platform.repo(Tenant).find({ select: { id: true } });
      for (const t of tenants) await this.tenantTx.run((tx) => this.cycleCount(tx), { tenantId: t.id, userId: null }).catch(() => undefined);
    });
    await this.jobs.schedule('storage.cycle_count', '0 7 * * *');
  }

  private async warehouse(tx: TenantTx, id: string) {
    const w = await tx.repo(Warehouse, 'Склад').getById(id);
    this.scope.assertStore(w.storeId);
    return w;
  }

  // ── Справочник мест ──────────────────────────────────────

  tree(warehouseId: string) {
    return this.tenantTx.run(async (tx) => {
      await this.warehouse(tx, warehouseId);
      return tx.query(
        `SELECT l.*, coalesce((SELECT sum(c.qty) FROM cell_stock c WHERE c.location_id = l.id), 0) AS qty,
                (SELECT count(*)::int FROM product_locations pl WHERE pl.location_id = l.id) AS products
           FROM storage_locations l WHERE l.tenant_id = $1 AND l.warehouse_id = $2 AND l.deleted_at IS NULL ORDER BY l.walk_order, l.code`,
        [tx.tenantId, warehouseId],
      );
    });
  }

  saveLocation(id: string | null, dto: Partial<StorageLocation> & { version?: number }) {
    return this.tenantTx.run(async (tx) => {
      const repo = tx.repo(StorageLocation, 'Место');
      const { version, ...data } = dto as any;
      if (id) return repo.save(Object.assign(await repo.getForUpdate(id, version ?? 0), data));
      if (!data.warehouseId || !data.code) throw Errors.bad('CODE_REQUIRED', 'Склад и код места');
      await this.warehouse(tx, data.warehouseId);
      return repo.insert({ kind: 'shelf', ...data, code: String(data.code).toUpperCase() });
    });
  }

  /**
   * Генератор ячеек по маске {зона}-{ряд}-{стеллаж}-{полка}-{ячейка}: «ряд A, стеллажи 1–20, полки 1–5,
   * ячейки 1–4» → 400 ячеек (S1-A-03-2-05); порядок обхода — змейкой по стеллажам.
   */
  generate(dto: { warehouseId: string; zone: string; row: string; racks: [number, number]; shelves: [number, number]; cells: [number, number]; cellType?: CellType; sizeClass?: string; capacity?: string }) {
    return this.tenantTx.run(async (tx) => {
      await this.warehouse(tx, dto.warehouseId);
      const total = (dto.racks[1] - dto.racks[0] + 1) * (dto.shelves[1] - dto.shelves[0] + 1) * (dto.cells[1] - dto.cells[0] + 1);
      if (total <= 0 || total > 5000) throw Errors.bad('BAD_RANGE', 'От 1 до 5000 ячеек за раз');
      const existing = new Set((await tx.query(`SELECT code FROM storage_locations WHERE tenant_id = $1 AND warehouse_id = $2`, [tx.tenantId, dto.warehouseId])).map((r: any) => r.code));
      const [{ m }] = await tx.query(`SELECT coalesce(max(walk_order), 0) AS m FROM storage_locations WHERE tenant_id = $1 AND warehouse_id = $2`, [tx.tenantId, dto.warehouseId]);
      let order = Number(m);
      const rows: Partial<StorageLocation>[] = [];
      for (let r = dto.racks[0]; r <= dto.racks[1]; r++) {
        const shelves = [];
        for (let s = dto.shelves[0]; s <= dto.shelves[1]; s++) shelves.push(s);
        for (const s of shelves) {
          const cells = [];
          for (let c = dto.cells[0]; c <= dto.cells[1]; c++) cells.push(c);
          if ((r - dto.racks[0]) % 2) cells.reverse();
          for (const c of cells) {
            const code = `${dto.zone}-${dto.row}-${pad(r, 2)}-${s}-${pad(c, 2)}`.toUpperCase();
            if (existing.has(code)) continue;
            rows.push({ warehouseId: dto.warehouseId, code, kind: 'cell', cellType: dto.cellType ?? 'storage', sizeClass: dto.sizeClass ?? null, capacity: dto.capacity ?? null, walkOrder: ++order, barcode: code } as any);
          }
        }
      }
      if (rows.length) await tx.repo(StorageLocation).insertMany(rows as any);
      await tx.query(`UPDATE warehouses SET storage_level = 3 WHERE tenant_id = $1 AND id = $2 AND storage_level < 3`, [tx.tenantId, dto.warehouseId]);
      await this.audit.log(tx, { action: 'storage.generate', entityType: 'warehouse', entityId: dto.warehouseId, summary: `Создано ячеек: ${rows.length}` });
      return { created: rows.length, skipped: total - rows.length };
    });
  }

  /** Переход 1→2: текстовые места товаров → справочник мест одной кнопкой, товары привязываются. */
  fromTextPlaces(warehouseId: string) {
    return this.tenantTx.run(async (tx) => {
      await this.warehouse(tx, warehouseId);
      const places = await tx.query(`SELECT DISTINCT upper(trim(place)) AS code FROM product_places WHERE tenant_id = $1 AND warehouse_id = $2 AND coalesce(trim(place), '') <> ''`, [tx.tenantId, warehouseId]);
      let created = 0;
      for (const p of places) {
        const [loc] = await tx.query(
          `INSERT INTO storage_locations (tenant_id, warehouse_id, code, kind) VALUES ($1, $2, $3, 'shelf')
           ON CONFLICT (tenant_id, warehouse_id, code) DO UPDATE SET updated_at = now() RETURNING id, (xmax = 0) AS inserted`,
          [tx.tenantId, warehouseId, p.code.slice(0, 40)],
        );
        if (loc.inserted) created++;
        await tx.query(
          `INSERT INTO product_locations (tenant_id, product_id, location_id, warehouse_id, is_main)
           SELECT tenant_id, product_id, $3, warehouse_id, true FROM product_places WHERE tenant_id = $1 AND warehouse_id = $2 AND upper(trim(place)) = $4
           ON CONFLICT (tenant_id, product_id, location_id) DO NOTHING`,
          [tx.tenantId, warehouseId, loc.id, p.code],
        );
      }
      await tx.query(`UPDATE warehouses SET storage_level = greatest(storage_level, 2) WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, warehouseId]);
      return { places: places.length, created };
    });
  }

  /** Переход 3→2: остатки по ячейкам сворачиваются, ячейки остаются справочными местами. */
  downgrade(warehouseId: string) {
    return this.tenantTx.run(async (tx) => {
      await this.warehouse(tx, warehouseId);
      await tx.query(`DELETE FROM cell_stock WHERE tenant_id = $1 AND warehouse_id = $2`, [tx.tenantId, warehouseId]);
      await tx.query(`UPDATE warehouse_tasks SET status = 'cancelled' WHERE tenant_id = $1 AND warehouse_id = $2 AND status IN ('open', 'in_progress')`, [tx.tenantId, warehouseId]);
      await tx.query(`UPDATE warehouses SET storage_level = 2 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, warehouseId]);
      return { storageLevel: 2 };
    });
  }

  /** Этикетки ячеек пачкой (PDF, штрихкод Code128). */
  async labels(warehouseId: string, codes?: string[]) {
    const rows = await this.tenantTx.run(async (tx) => {
      await this.warehouse(tx, warehouseId);
      return tx.query(`SELECT code FROM storage_locations WHERE tenant_id = $1 AND warehouse_id = $2 AND ($3::text[] IS NULL OR code = ANY($3)) ORDER BY walk_order, code LIMIT 2000`, [tx.tenantId, warehouseId, codes?.length ? codes : null]);
    });
    const content: any[] = [];
    for (const r of rows) content.push({ stack: [{ image: await this.pdf.barcode(r.code), width: 150 }, { text: r.code, fontSize: 14, bold: true, alignment: 'center' }], margin: [0, 0, 0, 14], unbreakable: true });
    return this.pdf.render({ pageSize: { width: 170, height: 85 } as any, pageMargins: [8, 6, 8, 4], content: content.length ? content : [{ text: 'Нет мест' }] });
  }

  // ── Места товаров ────────────────────────────────────────

  setProductLocation(dto: { productId: string; locationId: string; isMain?: boolean; minQty?: string | null }) {
    return this.tenantTx.run(async (tx) => {
      const loc = await tx.repo(StorageLocation, 'Место').getById(dto.locationId);
      if (dto.isMain) await tx.query(`UPDATE product_locations SET is_main = false WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3`, [tx.tenantId, dto.productId, loc.warehouseId]);
      await tx.query(
        `INSERT INTO product_locations (tenant_id, product_id, location_id, warehouse_id, is_main, min_qty) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, product_id, location_id) DO UPDATE SET is_main = EXCLUDED.is_main, min_qty = EXCLUDED.min_qty, updated_at = now()`,
        [tx.tenantId, dto.productId, loc.id, loc.warehouseId, !!dto.isMain, dto.minQty ?? null],
      );
      return this.productLocationsInTx(tx, dto.productId);
    });
  }

  async productLocationsInTx(tx: TenantTx, productId: string) {
    return tx.query(
      `SELECT pl.location_id AS "locationId", l.code, l.warehouse_id AS "warehouseId", pl.is_main AS "isMain", pl.min_qty AS "minQty",
              coalesce((SELECT c.qty FROM cell_stock c WHERE c.location_id = l.id AND c.product_id = pl.product_id), 0) AS qty
         FROM product_locations pl JOIN storage_locations l ON l.id = pl.location_id WHERE pl.tenant_id = $1 AND pl.product_id = $2 ORDER BY pl.is_main DESC, l.code`,
      [tx.tenantId, productId],
    );
  }

  productLocations(productId: string) {
    return this.tenantTx.run((tx) => this.productLocationsInTx(tx, productId));
  }

  /**
   * Куда положить товар: своя (основная) ячейка → ячейка с этим товаром → свободная подходящая
   * (привязка к группе или первой марке применимости, класс габарита, вместимость, не заблокирована).
   * Подходит к маркам из разных зон — варианты (спросить).
   */
  async suggest(tx: TenantTx, warehouseId: string, productId: string, qty = D(1)) {
    const [own] = await tx.query(
      `SELECT l.id, l.code, l.capacity, coalesce((SELECT sum(c.qty) FROM cell_stock c WHERE c.location_id = l.id), 0) AS used
         FROM product_locations pl JOIN storage_locations l ON l.id = pl.location_id
        WHERE pl.tenant_id = $1 AND pl.product_id = $2 AND l.warehouse_id = $3 AND NOT l.blocked ORDER BY pl.is_main DESC LIMIT 1`,
      [tx.tenantId, productId, warehouseId],
    );
    if (own && (!own.capacity || D(own.used).plus(qty).lte(own.capacity))) return { locationId: own.id, code: own.code, reason: 'own', alternatives: [] };
    const [p] = await tx.query(
      `SELECT p.category_id, c.path, coalesce((SELECT array_agg(DISTINCT a.make_id::text) FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id), '{}') AS makes
         FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.tenant_id = $1 AND p.id = $2`,
      [tx.tenantId, productId],
    );
    const cats = p?.category_id ? [p.category_id, ...String(p.path ?? '').split('/').filter(Boolean)] : [];
    const free = await tx.query(
      `SELECT l.id, l.code, l.category_ids, l.make_ids, l.mixed, l.capacity, l.parent_id,
              coalesce((SELECT sum(c.qty) FROM cell_stock c WHERE c.location_id = l.id), 0) AS used,
              EXISTS (SELECT 1 FROM cell_stock c WHERE c.location_id = l.id AND c.product_id = $3 AND c.qty > 0) AS has_product
         FROM storage_locations l
        WHERE l.tenant_id = $1 AND l.warehouse_id = $2 AND l.deleted_at IS NULL AND NOT l.blocked AND l.kind IN ('cell', 'shelf') AND l.cell_type IN ('storage', 'pick')
        ORDER BY l.walk_order LIMIT 3000`,
      [tx.tenantId, warehouseId, productId],
    );
    const fits = (l: any) => (!l.capacity || D(l.used).plus(qty).lte(l.capacity)) && (l.mixed || D(l.used).isZero() || l.has_product);
    const bound = (l: any) => (l.category_ids?.length ? l.category_ids.some((c: string) => cats.includes(c)) : false) || (l.make_ids?.length ? l.make_ids.some((m: string) => (p?.makes ?? []).includes(m)) : false);
    const unbound = (l: any) => !l.category_ids?.length && !l.make_ids?.length;
    const withProduct = free.find((l: any) => l.has_product && fits(l));
    if (withProduct) return { locationId: withProduct.id, code: withProduct.code, reason: 'same_product', alternatives: [] };
    const byBinding = free.filter((l: any) => bound(l) && fits(l));
    const zones = new Set(byBinding.map((l: any) => l.parent_id ?? l.code.split('-')[0]));
    if (byBinding.length) return { locationId: byBinding[0].id, code: byBinding[0].code, reason: 'binding', alternatives: zones.size > 1 ? byBinding.slice(1, 6).map((l: any) => ({ locationId: l.id, code: l.code })) : [], ask: zones.size > 1 };
    const any = free.find((l: any) => unbound(l) && fits(l));
    return any ? { locationId: any.id, code: any.code, reason: 'free', alternatives: [] } : { locationId: null, code: null, reason: 'none', alternatives: [] };
  }

  suggestFor(warehouseId: string, productId: string, qty?: string) {
    return this.tenantTx.run((tx) => this.suggest(tx, warehouseId, productId, D(qty ?? 1)));
  }

  /** Товары без места (уровень 2+). */
  withoutPlace(warehouseId: string) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT p.id, p.name, p.sku, sum(b.qty) AS qty FROM stock_balances b JOIN products p ON p.id = b.product_id
          WHERE b.tenant_id = $1 AND b.warehouse_id = $2 AND b.qty > 0
            AND NOT EXISTS (SELECT 1 FROM product_locations pl WHERE pl.tenant_id = b.tenant_id AND pl.product_id = b.product_id AND pl.warehouse_id = b.warehouse_id)
          GROUP BY p.id, p.name, p.sku ORDER BY p.name LIMIT 2000`,
        [tx.tenantId, warehouseId],
      ),
    );
  }

  // ── Остаток по ячейкам ───────────────────────────────────

  private async cellAdd(tx: TenantTx, warehouseId: string, locationId: string, productId: string, qty: string | number | Decimal) {
    await tx.query(
      `INSERT INTO cell_stock (tenant_id, warehouse_id, location_id, product_id, qty) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, location_id, product_id) DO UPDATE SET qty = cell_stock.qty + EXCLUDED.qty, updated_at = now()`,
      [tx.tenantId, warehouseId, locationId, productId, D(qty).toFixed()],
    );
  }

  /** Перемещение между ячейками — не меняет остаток склада. */
  move(dto: { productId: string; fromLocationId: string; toLocationId: string; qty: string }) {
    return this.tenantTx.run(async (tx) => {
      const from = await tx.repo(StorageLocation, 'Ячейка').getById(dto.fromLocationId);
      const to = await tx.repo(StorageLocation, 'Ячейка').getById(dto.toLocationId);
      if (from.warehouseId !== to.warehouseId) throw Errors.bad('OTHER_WAREHOUSE', 'Ячейки разных складов — это перемещение между складами');
      const [have] = await tx.query(`SELECT qty FROM cell_stock WHERE tenant_id = $1 AND location_id = $2 AND product_id = $3`, [tx.tenantId, from.id, dto.productId]);
      if (D(have?.qty ?? 0).lt(dto.qty)) throw Errors.bad('CELL_SHORT', `В ячейке ${from.code} только ${D(have?.qty ?? 0).toFixed()}`);
      await this.cellAdd(tx, from.warehouseId, from.id, dto.productId, D(dto.qty).neg());
      await this.cellAdd(tx, to.warehouseId, to.id, dto.productId, dto.qty);
      await this.audit.log(tx, { action: 'storage.move', entityType: 'product', entityId: dto.productId, summary: `${from.code} → ${to.code}: ${dto.qty}` });
      return { from: from.code, to: to.code, qty: dto.qty };
    });
  }

  cellContents(locationId: string) {
    return this.tenantTx.run((tx) =>
      tx.query(`SELECT c.product_id AS "productId", p.name, p.sku, c.qty FROM cell_stock c JOIN products p ON p.id = c.product_id WHERE c.tenant_id = $1 AND c.location_id = $2 AND c.qty <> 0 ORDER BY p.name`, [tx.tenantId, locationId]),
    );
  }

  // ── Задания ──────────────────────────────────────────────

  private async newTask(tx: TenantTx, warehouseId: string, kind: WarehouseTask['kind'], lines: TaskLine[], source?: { type: string; id: string }, assigneeId?: string | null) {
    const n = await this.counters.next(tx, 'wh_task');
    return tx.repo(WarehouseTask).insert({ number: `ЗД-${n}`, warehouseId, kind, lines, sourceType: source?.type ?? null, sourceId: source?.id ?? null, assigneeId: assigneeId ?? null });
  }

  /** Приёмка → товар в зоне приёмки → задание «положи 20 шт в S1-A-03-2-05». */
  async placementForDocument(tx: TenantTx, documentId: string) {
    const [doc] = await tx.query(`SELECT d.id, d.warehouse_id, w.storage_level FROM documents d JOIN warehouses w ON w.id = d.warehouse_id WHERE d.tenant_id = $1 AND d.id = $2`, [tx.tenantId, documentId]);
    if (!doc || doc.storage_level < 3) return null;
    const [exists] = await tx.query(`SELECT 1 FROM warehouse_tasks WHERE tenant_id = $1 AND source_id = $2 AND kind = 'placement'`, [tx.tenantId, documentId]);
    if (exists) return null;
    const lines = await tx.query(`SELECT product_id, sum(base_qty) AS qty FROM document_lines WHERE tenant_id = $1 AND document_id = $2 GROUP BY product_id`, [tx.tenantId, documentId]);
    const [recv] = await tx.query(`SELECT id FROM storage_locations WHERE tenant_id = $1 AND warehouse_id = $2 AND cell_type = 'receiving' AND NOT blocked ORDER BY walk_order LIMIT 1`, [tx.tenantId, doc.warehouse_id]);
    const out: TaskLine[] = [];
    for (const l of lines) {
      const s = await this.suggest(tx, doc.warehouse_id, l.product_id, D(l.qty));
      if (recv) await this.cellAdd(tx, doc.warehouse_id, recv.id, l.product_id, l.qty);
      out.push({ productId: l.product_id, qty: D(l.qty).toFixed(), fromLocationId: recv?.id ?? null, toLocationId: s.locationId });
    }
    return out.length ? this.newTask(tx, doc.warehouse_id, 'placement', out, { type: 'document', id: documentId }) : null;
  }

  /** Подбор по маршруту (порядок обхода): из ячеек, где есть товар, сначала ячейки отбора. */
  pickTask(dto: { warehouseId: string; lines: { productId: string; qty: string }[]; sourceType?: string; sourceId?: string; assigneeId?: string }) {
    return this.tenantTx.run(async (tx) => {
      await this.warehouse(tx, dto.warehouseId);
      const out: (TaskLine & { walk: number })[] = [];
      for (const l of dto.lines) {
        let left = D(l.qty);
        const cells = await tx.query(
          `SELECT c.location_id, c.qty, s.walk_order FROM cell_stock c JOIN storage_locations s ON s.id = c.location_id
            WHERE c.tenant_id = $1 AND c.warehouse_id = $2 AND c.product_id = $3 AND c.qty > 0 AND NOT s.blocked AND s.cell_type <> 'defect'
            ORDER BY (s.cell_type = 'pick') DESC, s.pick_priority DESC, s.walk_order`,
          [tx.tenantId, dto.warehouseId, l.productId],
        );
        for (const c of cells) {
          if (left.lte(0)) break;
          const take = Decimal.min(left, D(c.qty));
          out.push({ productId: l.productId, qty: take.toFixed(), fromLocationId: c.location_id, walk: c.walk_order });
          left = left.minus(take);
        }
        if (left.gt(0)) out.push({ productId: l.productId, qty: left.toFixed(), fromLocationId: null, shortage: true, walk: 1e9 });
      }
      out.sort((a, b) => a.walk - b.walk);
      return this.newTask(tx, dto.warehouseId, 'pick', out.map(({ walk: _w, ...x }) => x), dto.sourceId ? { type: dto.sourceType ?? 'order', id: dto.sourceId } : undefined, dto.assigneeId);
    });
  }

  tasks(q: { warehouseId?: string; status?: string; mine?: boolean }) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT t.*, u.name AS "assigneeName" FROM warehouse_tasks t LEFT JOIN memberships m ON m.id = t.assignee_id LEFT JOIN users u ON u.id = m.user_id
          WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND ($2::uuid IS NULL OR t.warehouse_id = $2) AND ($3::varchar IS NULL OR t.status = $3)
            AND ($4::uuid IS NULL OR t.assignee_id = $4 OR t.assignee_id IS NULL) ORDER BY t.created_at LIMIT 500`,
        [tx.tenantId, q.warehouseId ?? null, q.status ?? null, q.mine ? this.ctx.membershipId : null],
      ),
    );
  }

  /**
   * Выполнить строку задания (скан ячейки и товара, количество): размещение — в ячейку,
   * подбор — из ячейки, пересчёт — фиксирует факт. «Недостача в ячейке» — ищем другую ячейку и ставим пересчёт.
   */
  doLine(taskId: string, dto: { index: number; locationId?: string; productId: string; qty: string; shortage?: boolean }) {
    return this.tenantTx.run(async (tx) => {
      const [lock] = await tx.query(`SELECT id FROM warehouse_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, taskId]);
      if (!lock) throw Errors.notFound('Задание');
      const t = await tx.repo(WarehouseTask, 'Задание').getById(taskId);
      const l = t.lines[dto.index];
      if (!l || l.productId !== dto.productId) throw Errors.bad('WRONG_PRODUCT', 'Не тот товар');
      if (t.status === 'done' || t.status === 'cancelled') throw Errors.conflict('TASK_CLOSED', 'Задание закрыто');
      const loc = dto.locationId ?? (t.kind === 'placement' ? l.toLocationId : l.fromLocationId);
      if (!loc) throw Errors.bad('CELL_REQUIRED', 'Отсканируйте ячейку');
      const extra: any = {};
      if (t.kind === 'placement' || t.kind === 'replenish') {
        if (l.fromLocationId) await this.cellAdd(tx, t.warehouseId, l.fromLocationId, l.productId, D(dto.qty).neg());
        await this.cellAdd(tx, t.warehouseId, loc, l.productId, dto.qty);
        l.toLocationId = loc;
      } else if (t.kind === 'pick') {
        if (dto.shortage) {
          l.shortage = true;
          const [have] = await tx.query(`SELECT qty FROM cell_stock WHERE tenant_id = $1 AND location_id = $2 AND product_id = $3`, [tx.tenantId, loc, l.productId]);
          await this.newTask(tx, t.warehouseId, 'count', [{ productId: l.productId, qty: D(have?.qty ?? 0).toFixed(), fromLocationId: loc }], { type: 'task', id: t.id });
          const [other] = await tx.query(
            `SELECT location_id, qty FROM cell_stock WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND location_id <> $4 AND qty > 0 ORDER BY qty DESC LIMIT 1`,
            [tx.tenantId, t.warehouseId, l.productId, loc],
          );
          extra.alternative = other ? { locationId: other.location_id, qty: other.qty } : null;
        }
        if (D(dto.qty).gt(0)) await this.cellAdd(tx, t.warehouseId, loc, l.productId, D(dto.qty).neg());
        l.fromLocationId = loc;
      } else if (t.kind === 'count') {
        const [have] = await tx.query(`SELECT qty FROM cell_stock WHERE tenant_id = $1 AND location_id = $2 AND product_id = $3`, [tx.tenantId, loc, l.productId]);
        await this.cellAdd(tx, t.warehouseId, loc, l.productId, D(dto.qty).minus(have?.qty ?? 0));
        l.countedQty = D(dto.qty).toFixed();
        extra.diff = D(dto.qty).minus(have?.qty ?? 0).toFixed();
        await tx.query(`UPDATE storage_locations SET last_counted_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, loc]);
      }
      l.doneQty = D(l.doneQty ?? 0).plus(dto.qty).toFixed();
      t.status = t.lines.every((x) => D(x.doneQty ?? 0).gte(x.qty) || x.shortage || x.countedQty !== undefined) ? 'done' : 'in_progress';
      t.startedAt ??= new Date();
      if (t.status === 'done') t.doneAt = new Date();
      t.assigneeId ??= this.ctx.membershipId ?? null;
      await tx.repo(WarehouseTask).save(t);
      return { task: t, ...extra };
    });
  }

  /** Пополнение: в ячейке отбора меньше минимума — «переложи из ячейки хранения». */
  replenish(warehouseId: string) {
    return this.tenantTx.run(async (tx) => {
      await this.warehouse(tx, warehouseId);
      const rows = await tx.query(
        `SELECT pl.product_id, pl.location_id, pl.min_qty, coalesce(c.qty, 0) AS qty
           FROM product_locations pl JOIN storage_locations l ON l.id = pl.location_id LEFT JOIN cell_stock c ON c.location_id = pl.location_id AND c.product_id = pl.product_id
          WHERE pl.tenant_id = $1 AND pl.warehouse_id = $2 AND l.cell_type = 'pick' AND pl.min_qty IS NOT NULL AND coalesce(c.qty, 0) < pl.min_qty
            AND NOT EXISTS (SELECT 1 FROM warehouse_tasks t WHERE t.tenant_id = pl.tenant_id AND t.kind = 'replenish' AND t.status IN ('open', 'in_progress') AND t.lines @> jsonb_build_array(jsonb_build_object('productId', pl.product_id::text)))`,
        [tx.tenantId, warehouseId],
      );
      const lines: TaskLine[] = [];
      for (const r of rows) {
        const [src] = await tx.query(
          `SELECT c.location_id, c.qty FROM cell_stock c JOIN storage_locations s ON s.id = c.location_id
            WHERE c.tenant_id = $1 AND c.warehouse_id = $2 AND c.product_id = $3 AND s.cell_type = 'storage' AND c.qty > 0 ORDER BY c.qty DESC LIMIT 1`,
          [tx.tenantId, warehouseId, r.product_id],
        );
        if (!src) continue;
        lines.push({ productId: r.product_id, qty: Decimal.min(D(src.qty), D(r.min_qty).mul(2).minus(r.qty)).toFixed(), fromLocationId: src.location_id, toLocationId: r.location_id });
      }
      return lines.length ? this.newTask(tx, warehouseId, 'replenish', lines) : { created: false };
    });
  }

  /** Циклическая инвентаризация: каждый день N ячеек, давно не считанных (без остановки работы). */
  async cycleCount(tx: TenantTx, perWarehouse = 20) {
    const whs = await tx.query(`SELECT id FROM warehouses WHERE tenant_id = $1 AND storage_level = 3 AND is_active`, [tx.tenantId]);
    let created = 0;
    for (const w of whs) {
      const cells = await tx.query(
        `SELECT c.location_id, c.product_id, c.qty FROM cell_stock c JOIN storage_locations s ON s.id = c.location_id
          WHERE c.tenant_id = $1 AND c.warehouse_id = $2 AND c.qty <> 0 ORDER BY s.last_counted_at NULLS FIRST, s.walk_order LIMIT $3`,
        [tx.tenantId, w.id, perWarehouse],
      );
      if (!cells.length) continue;
      await this.newTask(tx, w.id, 'count', cells.map((c: any) => ({ productId: c.product_id, qty: D(c.qty).toFixed(), fromLocationId: c.location_id })), { type: 'cycle', id: w.id });
      created++;
    }
    return { created };
  }

  /** «Возможная пересортица по ячейкам»: недостача в одной ячейке и излишек того же товара в другой. */
  misplaced(warehouseId: string) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `WITH diffs AS (
           SELECT (l->>'productId')::uuid AS product_id, (l->>'fromLocationId')::uuid AS location_id, (l->>'countedQty')::numeric - (l->>'qty')::numeric AS diff, t.done_at
             FROM warehouse_tasks t CROSS JOIN LATERAL jsonb_array_elements(t.lines) l
            WHERE t.tenant_id = $1 AND t.warehouse_id = $2 AND t.kind = 'count' AND t.done_at > now() - interval '30 days' AND l ? 'countedQty')
         SELECT p.name, s1.code AS "shortCell", -a.diff AS "short", s2.code AS "surplusCell", b.diff AS surplus
           FROM diffs a JOIN diffs b ON b.product_id = a.product_id AND b.location_id <> a.location_id AND b.diff > 0
           JOIN products p ON p.id = a.product_id JOIN storage_locations s1 ON s1.id = a.location_id JOIN storage_locations s2 ON s2.id = b.location_id
          WHERE a.diff < 0 ORDER BY p.name`,
        [tx.tenantId, warehouseId],
      ),
    );
  }

  /** Загрузка и скорость кладовщиков. */
  workload(warehouseId: string) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT coalesce(u.name, 'Не назначено') AS name, count(*) FILTER (WHERE t.status IN ('open', 'in_progress'))::int AS open,
                count(*) FILTER (WHERE t.status = 'done' AND t.done_at > now() - interval '7 days')::int AS "doneWeek",
                round(avg(extract(epoch FROM t.done_at - t.started_at) / 60) FILTER (WHERE t.status = 'done' AND t.started_at IS NOT NULL))::int AS "avgMinutes"
           FROM warehouse_tasks t LEFT JOIN memberships m ON m.id = t.assignee_id LEFT JOIN users u ON u.id = m.user_id
          WHERE t.tenant_id = $1 AND t.warehouse_id = $2 GROUP BY 1 ORDER BY open DESC`,
        [tx.tenantId, warehouseId],
      ),
    );
  }
}
