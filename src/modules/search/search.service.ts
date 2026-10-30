import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { normalizeBarcode } from '../../common/utils/barcode';
import { D } from '../../common/utils/decimal';
import { normalizePartNumber, partNumberSkeleton } from '../../common/utils/part-number';
import { baseNormalize, fixLayout, looksLikeNumber, sizeVariant, stem, translitToRu } from '../../common/utils/text-search';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { ScopeService } from '../auth/scope.service';
import { QUALITY_LABELS, QUALITY_ORDER, QualityClass } from '../catalog/entities/product.entity';
import { StockProbeService } from '../inventory/stock-probe.service';
import { CrossesService } from '../parts/crosses.service';
import { PricesService } from '../pricing/prices.service';
import { PriceListsService } from '../purchasing/price-lists.service';
import { CustomerVehicle } from '../counterparties/entities/counterparty.entity';
import { VehicleDirectoryService, VehicleMatch } from '../vehicles/vehicle-directory.service';
import { VinService } from '../vehicles/vin.service';
import { UnfoundQuery } from './entities/search.entity';
import { SynonymPair, SynonymsService } from './synonyms.service';

export type MatchKind = 'barcode' | 'sku' | 'number' | 'number_confusable' | 'number_prefix' | 'number_fuzzy' | 'size' | 'text' | 'vehicle';

export interface SearchOptions {
  q: string;
  limit?: number;
  context?: string;
  log?: boolean;
  makeId?: string;
  modelId?: string;
  generationId?: string;
  includeArchived?: boolean;
  /** Умный подбор (ТЗ 5.2): машина клиента, VIN, код кузова, модификация, год, руль, сторона, ось */
  customerVehicleId?: string;
  vin?: string;
  bodyCode?: string;
  modificationId?: string;
  year?: number;
  steering?: 'right' | 'left';
  side?: string;
  axle?: string;
}

interface VehicleFilter {
  makeId?: string;
  modelId?: string;
  generationId?: string;
  modificationId?: string;
  year?: number;
  steering?: string;
}

export interface ClarifyQuestion {
  /** Параметр поиска, который задаёт ответ */
  key: 'year' | 'steering' | 'modificationId' | 'side' | 'axle';
  question: string;
  options: { label: string; value: string | number }[];
}

const SIDE_WORDS: [RegExp, 'side' | 'axle', string][] = [
  [/^лев/, 'side', 'Левая'],
  [/^прав/, 'side', 'Правая'],
  [/^(перед|пер$|передн)/, 'axle', 'Передняя'],
  [/^(зад|задн)/, 'axle', 'Задняя'],
];
/** Слова противоположной стороны в названии — для товаров без атрибута */
const OPPOSITE_TEXT: Record<string, string> = { Левая: '(^| )прав', Правая: '(^| )лев', Передняя: '(^| )задн', Задняя: '(^| )передн' };

/** «лев», «правый», «перед», «зад» → фильтр по атрибутам; «правый руль» → руль. */
export function parseSelectionWords(text: string) {
  const out: { text: string; side?: string; axle?: string; steering?: 'right' | 'left' } = { text };
  const words = text.split(' ').filter(Boolean);
  const keep: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (next && /^руль/.test(next) && /^(лев|прав|пр$|л$)/.test(w)) {
      out.steering = /^(прав|пр$)/.test(w) ? 'right' : 'left';
      i++;
      continue;
    }
    const hit = SIDE_WORDS.find(([re]) => re.test(w));
    if (hit && !out[hit[1]]) {
      out[hit[1]] = hit[2];
      continue;
    }
    keep.push(w);
  }
  out.text = keep.join(' ');
  return out;
}

interface Candidate {
  productId: string;
  score: number;
  kind: MatchKind;
}

/**
 * Единый поиск (ТЗ 5.1): касса, каталог, документы, Ctrl+K.
 * Номер в любом формате, артикул, штрихкод, название со сленгом, транслит, раскладка, кыргызские буквы,
 * размеры, путаница символов. Машина в запросе («колодки камри 40») становится фильтром по применимости.
 * Порядок групп: в наличии здесь → в других точках → аналоги → (прайсы поставщиков — этап 4) → ничего.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly synonyms: SynonymsService,
    private readonly vehicles: VehicleDirectoryService,
    private readonly crosses: CrossesService,
    private readonly prices: PricesService,
    private readonly stock: StockProbeService,
    private readonly priceLists: PriceListsService,
    private readonly vin: VinService,
  ) {}

  async search(opts: SearchOptions) {
    const started = Date.now();
    const limit = Math.min(opts.limit ?? 30, 100);
    return this.tenantTx.run(async (tx) => {
      await tx.query(`SET LOCAL pg_trgm.similarity_threshold = 0.45`);
      const raw = (opts.q ?? '').trim().slice(0, 200);
      const words = parseSelectionWords(baseNormalize(raw));
      const sel = await this.selectionContext(tx, opts);
      const side = opts.side ?? words.side;
      const axle = opts.axle ?? words.axle;
      const steering = opts.steering ?? words.steering ?? sel.steering;
      // Только «лев»/«перед» без остального — ищем как текст
      const text = words.text || (sel.makeId ? '' : baseNormalize(raw));
      const sideFilter = words.text || sel.makeId ? { side, axle } : { side: opts.side, axle: opts.axle };
      if (!text && !sel.makeId) return this.empty(raw, started);

      // Машина в запросе → фильтр по применимости
      let vehicle: VehicleMatch | null = null;
      let rest = text;
      if (!sel.makeId && text) {
        const [best] = await this.vehicles.resolve(tx, text, 1);
        if (best && best.precision !== 'make') {
          vehicle = best;
          const consumed = new Set(best.consumed);
          rest = text.split(' ').filter((t) => !consumed.has(t)).join(' ');
        }
      }
      const vehicleFilter: VehicleFilter = {
        makeId: sel.makeId ?? vehicle?.makeId,
        modelId: sel.modelId ?? vehicle?.modelId ?? undefined,
        generationId: sel.generationId ?? vehicle?.generationId ?? undefined,
        modificationId: sel.modificationId,
        year: opts.year ?? sel.year,
        steering,
      };

      const cands = new Map<string, Candidate>();
      const add = (productId: string, score: number, kind: MatchKind) => {
        const cur = cands.get(productId);
        if (!cur || cur.score < score) cands.set(productId, { productId, score, kind });
      };

      if (rest) {
        await this.exactMatches(tx, raw, rest, add);
        await this.textMatches(tx, rest, add, vehicleFilter);
      } else {
        // Только машина: всё, что к ней подходит
        for (const r of await this.byVehicle(tx, vehicleFilter, 300)) add(r, 300, 'vehicle');
      }

      let ids = [...cands.keys()];
      if (vehicleFilter.makeId && ids.length) {
        const allowed = await this.filterByVehicle(tx, ids, vehicleFilter);
        ids = ids.filter((id) => allowed.has(id));
      }
      if ((sideFilter.side || sideFilter.axle) && ids.length) {
        const allowed = await this.filterBySide(tx, ids, sideFilter);
        ids = ids.filter((id) => allowed.has(id));
      }
      const ranked = ids.map((id) => cands.get(id)!).sort((a, b) => b.score - a.score).slice(0, 200);

      // Аналоги для точных совпадений по номеру/штрихкоду/артикулу
      const exactIds = ranked.filter((c) => ['barcode', 'sku', 'number', 'number_confusable'].includes(c.kind)).slice(0, 5).map((c) => c.productId);
      const analogRows = exactIds.length ? await this.crosses.analogsInTx(tx, exactIds, 2) : [];
      const analogIds = analogRows.map((a) => a.productId).filter((id) => !cands.has(id));

      const allIds = [...ranked.map((r) => r.productId), ...analogIds];
      const info = await this.loadInfo(tx, allIds, opts.includeArchived);
      const applicabilityFlags = vehicleFilter.makeId ? await this.applicabilityFlags(tx, allIds, vehicleFilter) : new Map<string, boolean>();
      const currentStore = this.scope.currentStoreId();

      const toItem = (id: string, extra: Record<string, unknown>) => {
        const p = info.get(id);
        if (!p) return null;
        const here = p.stock.filter((s) => s.storeId === currentStore).reduce((a, s) => a.plus(s.qty), D(0));
        const total = p.stock.reduce((a, s) => a.plus(s.qty), D(0));
        return {
          ...p.view,
          stockHere: here.toFixed(),
          stockTotal: total.toFixed(),
          stockByStore: p.stock,
          availableHere: p.view.noStockControl || here.gt(0),
          availableElsewhere: total.minus(here).gt(0),
          applicabilityUnverified: applicabilityFlags.get(id) ?? false,
          ...extra,
        };
      };

      const exactItems = ranked.map((c) => toItem(c.productId, { matchKind: c.kind, score: Math.round(c.score) })).filter(Boolean) as any[];
      const analogItems = analogRows
        .filter((a) => !cands.has(a.productId))
        .map((a) => toItem(a.productId, { matchKind: 'analog', analog: { level: a.level, via: a.via, crossType: a.crossType, throughAnalog: a.throughAnalog } }))
        .filter(Boolean) as any[];

      const groups = {
        /** 1. Совпадения, есть в этой точке */
        here: ladder(exactItems.filter((i) => i.availableHere)),
        /** 2. Есть в других точках и складах */
        elsewhere: ladder(exactItems.filter((i) => !i.availableHere && i.availableElsewhere)),
        /** 3. Аналоги (в наличии — выше) */
        analogs: ladder(analogItems).sort((a: any, b: any) => Number(b.availableHere || b.availableElsewhere) - Number(a.availableHere || a.availableElsewhere)),
        /** Найдено, но нет в наличии */
        noStock: ladder(exactItems.filter((i) => !i.availableHere && !i.availableElsewhere)),
        /** 4. В прайсах поставщиков: у кого есть, почём, за сколько привезут (ТЗ 10.2) */
        suppliers: [] as unknown[],
      };
      // Номер из запроса (даже если его нет в каталоге) и номера точных совпадений → строки прайсов (с аналогами)
      const numbers: string[] = [];
      if (rest && looksLikeNumber(raw)) numbers.push(normalizePartNumber(raw));
      for (const it of exactItems.filter((i: any) => ['number', 'number_confusable', 'sku', 'barcode'].includes(i.matchKind)).slice(0, 5)) {
        if (it.mainNumber) numbers.push(normalizePartNumber(it.mainNumber));
      }
      if (numbers.length) groups.suppliers = await this.priceLists.searchByNumbers(tx, numbers, { limit: 30 });
      const totalFound = exactItems.length + analogItems.length;
      const inPriceLists = groups.suppliers.length;
      const anyAvailable = [...exactItems, ...analogItems].some((i) => i.availableHere || i.availableElsewhere);

      if (opts.log !== false && raw.length >= 2 && (!totalFound || !anyAvailable)) {
        await this.logUnfound(tx, raw, text, totalFound ? 'no_stock' : 'none', vehicleFilter, opts.context);
      }

      const clarify = vehicleFilter.makeId || ranked.length > 1 ? await this.clarify(tx, ranked.map((r) => r.productId), vehicleFilter, sideFilter) : [];

      return {
        query: raw,
        vehicle: vehicle ? { ...vehicle, consumed: undefined } : null,
        /** Что применено при подборе: откуда машина, год, руль, модификация, сторона, ось */
        selection: {
          source: sel.source,
          title: sel.title,
          makeId: vehicleFilter.makeId ?? null,
          modelId: vehicleFilter.modelId ?? null,
          generationId: vehicleFilter.generationId ?? null,
          modificationId: vehicleFilter.modificationId ?? null,
          year: vehicleFilter.year ?? null,
          steering: vehicleFilter.steering ?? null,
          side: sideFilter.side ?? null,
          axle: sideFilter.axle ?? null,
        },
        /** Уточняющие вопросы: ответ — параметр поиска (key = value) */
        clarify,
        textQuery: rest,
        groups: {
          here: groups.here.slice(0, limit),
          elsewhere: groups.elsewhere.slice(0, limit),
          analogs: groups.analogs.slice(0, limit),
          noStock: groups.noStock.slice(0, limit),
          suppliers: groups.suppliers,
        },
        ladder: ladderSummary([...exactItems, ...analogItems]),
        total: totalFound,
        /** 5. Ничего нет → кнопки «Создать товар», «Взял у соседа», «Заявка клиента» */
        actions: totalFound ? [] : [...(inPriceLists ? ['create_from_pricelist'] : []), 'create_product', 'take_from_neighbor', 'customer_request'],
        tookMs: Date.now() - started,
      };
    });
  }

  private empty(q: string, started: number) {
    return {
      query: q,
      vehicle: null,
      selection: null,
      clarify: [],
      textQuery: '',
      groups: { here: [], elsewhere: [], analogs: [], noStock: [], suppliers: [] },
      ladder: [],
      total: 0,
      actions: [],
      tookMs: Date.now() - started,
    };
  }

  // ── Совпадения ──────────────────────────────────────────

  private async exactMatches(tx: TenantTx, raw: string, text: string, add: (id: string, s: number, k: MatchKind) => void) {
    const t = tx.tenantId;
    const barcode = normalizeBarcode(raw);
    if (/^[\dA-Za-z-]{4,64}$/.test(barcode)) {
      for (const r of await tx.query(`SELECT product_id FROM product_barcodes WHERE tenant_id = $1 AND barcode = $2`, [t, barcode])) {
        add(r.product_id, 1000, 'barcode');
      }
    }
    for (const r of await tx.query(`SELECT id FROM products WHERE tenant_id = $1 AND deleted_at IS NULL AND sku IN ($2, $3)`, [t, raw, raw.toUpperCase()])) {
      add(r.id, 950, 'sku');
    }

    // Номер: весь запрос, а также каждое «похожее на номер» слово
    const candidatesNum = new Set<string>();
    if (looksLikeNumber(raw)) candidatesNum.add(normalizePartNumber(raw));
    for (const tok of text.split(' ')) if (looksLikeNumber(tok)) candidatesNum.add(normalizePartNumber(tok));
    for (const num of candidatesNum) {
      if (num.length < 3) continue;
      for (const r of await tx.query(`SELECT product_id FROM part_numbers WHERE tenant_id = $1 AND normalized = $2`, [t, num])) {
        add(r.product_id, 900, 'number');
      }
      const skel = partNumberSkeleton(num);
      for (const r of await tx.query(`SELECT product_id FROM part_numbers WHERE tenant_id = $1 AND skeleton = $2 LIMIT 200`, [t, skel])) {
        add(r.product_id, 860, 'number_confusable');
      }
      let found = 0;
      if (num.length >= 4) {
        // Начало номера: индекс (tenant_id, normalized COLLATE "C")
        for (const r of await tx.query(
          `SELECT product_id, length(normalized) AS len FROM part_numbers
            WHERE tenant_id = $1 AND normalized COLLATE "C" >= $2 AND normalized COLLATE "C" < $3 LIMIT 200`,
          [t, num, `${num}\uffff`],
        )) {
          add(r.product_id, 800 - Math.min(50, Number(r.len) - num.length), 'number_prefix');
          found++;
        }
      }
      if (num.length >= 6 && !found) {
        // Опечатка в 1–2 символах (ввод, распознавание) — только если точного и по началу нет
        await tx.query(`SET LOCAL pg_trgm.similarity_threshold = 0.5`);
        for (const r of await tx.query(
          `SELECT product_id, sim FROM (
             SELECT product_id, similarity(normalized, $2) AS sim FROM part_numbers
              WHERE tenant_id = $1 AND normalized % $2 LIMIT 300) s
            ORDER BY sim DESC LIMIT 50`,
          [t, num],
        )) {
          add(r.product_id, 500 + 250 * Number(r.sim), 'number_fuzzy');
        }
        await tx.query(`SET LOCAL pg_trgm.similarity_threshold = 0.45`);
      }
    }

    // Размеры: «35 52 7», «205/55 R16», «6PK1200»
    const size = sizeVariant(raw);
    if (size) {
      for (const r of await tx.query(
        `SELECT id FROM products WHERE tenant_id = $1 AND deleted_at IS NULL AND search_text LIKE $2 LIMIT 200`,
        [t, `%${size}%`],
      )) {
        add(r.id, 780, 'size');
      }
    }
  }

  /** Название: каждое слово — набор вариантов (основа, синонимы, раскладка, транслит). Слова — через И. */
  private async textMatches(
    tx: TenantTx,
    text: string,
    add: (id: string, s: number, k: MatchKind) => void,
    vehicle: { makeId?: string; modelId?: string; generationId?: string },
  ) {
    const syn = await this.synonyms.all(tx);
    const alternatives = expandQuery(text, syn);
    for (const alt of alternatives.slice(0, 4)) {
      const params: unknown[] = [tx.tenantId];
      const conds: string[] = [];
      for (const variants of alt) {
        const ors = variants.map((words) =>
          words
            .map((w) => {
              params.push(`%${w}%`);
              return `p.search_text LIKE $${params.length}`;
            })
            .join(' AND '),
        );
        conds.push(`(${ors.map((o) => `(${o})`).join(' OR ')})`);
      }
      if (!conds.length) continue;
      params.push(text);
      const simIdx = params.length;
      let vehicleSql = '';
      if (vehicle.makeId) {
        params.push(vehicle.makeId);
        vehicleSql = ` AND EXISTS (SELECT 1 FROM product_applicability a WHERE a.tenant_id = p.tenant_id AND a.product_id = p.id AND a.make_id = $${params.length})`;
      }
      // Сначала до 1000 совпадений по индексу, затем ранжирование по похожести — без сортировки всех совпадений
      const rows = await tx.query(
        `SELECT id, similarity(search_text, $${simIdx}) AS sim FROM (
           SELECT p.id, p.search_text FROM products p
            WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND ${conds.join(' AND ')}${vehicleSql}
            LIMIT 1000) s
          ORDER BY sim DESC LIMIT 200`,
        params,
      );
      for (const r of rows) add(r.id, 400 + 300 * Number(r.sim), 'text');
    }
  }

  private async byVehicle(tx: TenantTx, v: VehicleFilter, limit: number) {
    if (!v.makeId) return [];
    const rows = await tx.query(
      `SELECT DISTINCT a.product_id FROM product_applicability a JOIN products p ON p.id = a.product_id AND p.deleted_at IS NULL
        WHERE a.tenant_id = $1 AND a.make_id = $2 AND ($3::uuid IS NULL OR a.model_id = $3) AND
              ($4::uuid IS NULL OR a.generation_id = $4 OR a.generation_id IS NULL)
        LIMIT $5`,
      [tx.tenantId, v.makeId, v.modelId ?? null, v.generationId ?? null, limit],
    );
    return rows.map((r: any) => r.product_id as string);
  }

  /** Подходит к машине: точное поколение, либо метка на модель/марку без поколения (с пометкой «не уточнено»). */
  private async filterByVehicle(tx: TenantTx, ids: string[], v: VehicleFilter) {
    const rows = await tx.query(
      `SELECT DISTINCT product_id FROM product_applicability
        WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND make_id = $3
          AND ($4::uuid IS NULL OR model_id = $4 OR model_id IS NULL)
          AND ($5::uuid IS NULL OR generation_id = $5 OR generation_id IS NULL)
          AND ($6::uuid IS NULL OR modification_id = $6 OR modification_id IS NULL)
          AND ($7::int IS NULL OR ((year_from IS NULL OR year_from <= $7) AND (year_to IS NULL OR year_to >= $7)))
          AND ($8::varchar IS NULL OR steering IS NULL OR steering = $8)`,
      [tx.tenantId, ids, v.makeId, v.modelId ?? null, v.generationId ?? null, v.modificationId ?? null, v.year ?? null, v.steering ?? null],
    );
    return new Set(rows.map((r: any) => r.product_id as string));
  }

  /** Сторона/ось: атрибут совпал, либо атрибута нет и в названии нет противоположного слова. */
  private async filterBySide(tx: TenantTx, ids: string[], f: { side?: string; axle?: string }) {
    const rows = await tx.query(
      `SELECT id FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[])
          AND ($3::text IS NULL OR attributes->>'side' = $3 OR (attributes->>'side' IS NULL AND search_text !~ $4))
          AND ($5::text IS NULL OR attributes->>'axle' = $5 OR (attributes->>'axle' IS NULL AND search_text !~ $6))`,
      [tx.tenantId, ids, f.side ?? null, f.side ? OPPOSITE_TEXT[f.side] : '', f.axle ?? null, f.axle ? OPPOSITE_TEXT[f.axle] : ''],
    );
    return new Set(rows.map((r: any) => r.id as string));
  }

  /** Машина из машины клиента / VIN / кода кузова / модификации (ТЗ 5.2). Явные параметры важнее. */
  private async selectionContext(tx: TenantTx, o: SearchOptions) {
    const s: VehicleFilter & { source: string | null; title: string | null } = {
      source: o.makeId || o.modelId || o.generationId ? 'params' : null,
      title: null,
      makeId: o.makeId,
      modelId: o.modelId,
      generationId: o.generationId,
      modificationId: o.modificationId,
      year: o.year,
      steering: o.steering,
    };
    let vin = o.vin;
    let bodyCode = o.bodyCode;
    if (o.customerVehicleId) {
      const v = await tx.repo(CustomerVehicle, 'Машина клиента').getById(o.customerVehicleId);
      s.source = 'customer_vehicle';
      s.title = v.title ?? null;
      s.makeId ??= v.makeId ?? undefined;
      s.modelId ??= v.modelId ?? undefined;
      s.generationId ??= v.generationId ?? undefined;
      s.modificationId ??= v.modificationId ?? undefined;
      s.year ??= v.year ?? undefined;
      vin ??= v.vin ?? undefined;
      bodyCode ??= v.bodyCode ?? undefined;
    }
    if (s.modificationId) {
      const [m] = await tx.query(
        `SELECT m.generation_id, g.model_id, mo.make_id, m.steering, m.name FROM global_vehicle_modifications m
           JOIN global_vehicle_generations g ON g.id = m.generation_id JOIN global_vehicle_models mo ON mo.id = g.model_id WHERE m.id = $1`,
        [s.modificationId],
      );
      if (m) {
        s.generationId ??= m.generation_id;
        s.modelId ??= m.model_id;
        s.makeId ??= m.make_id;
        s.steering ??= m.steering ?? undefined;
        s.source ??= 'modification';
      }
    }
    if (bodyCode && !s.generationId) {
      const b: any = await this.vin.bodyCode(tx, bodyCode);
      if (b.found) {
        s.makeId ??= b.makeId;
        s.modelId ??= b.modelId;
        s.generationId = b.generation.id;
        if (!s.modificationId && b.modifications.length === 1) s.modificationId = b.modifications[0].id;
        s.source ??= 'body_code';
        s.title ??= `${b.makeName} ${b.modelName} ${b.generation.name}`;
      }
    }
    if (vin && !s.generationId) {
      const d = await this.vin.decode(tx, vin);
      if (d.makeId && (!s.makeId || s.makeId === d.makeId)) {
        s.makeId = d.makeId;
        s.modelId ??= d.modelId ?? undefined;
        if (d.generations.length === 1 && d.modelId) s.generationId = d.generations[0].id;
        s.year ??= d.year ?? undefined;
        s.source ??= 'vin';
        s.title ??= [d.makeName, d.modelName, d.year].filter(Boolean).join(' ');
      }
    }
    return s;
  }

  /**
   * Уточняющие вопросы (ТЗ 5.2): только если ответ реально сужает выдачу.
   * «До или после рестайлинга?», «Правый руль?», «Какой двигатель?», «Левая или правая?», «Передняя или задняя?».
   */
  private async clarify(tx: TenantTx, ids: string[], v: VehicleFilter, f: { side?: string; axle?: string }): Promise<ClarifyQuestion[]> {
    const out: ClarifyQuestion[] = [];
    if (ids.length < 2) return out;
    if (v.makeId) {
      const rows: any[] = await tx.query(
        `SELECT a.product_id, a.year_from, a.year_to, a.steering, a.modification_id, m.name AS mod_name, m.engine_code
           FROM product_applicability a LEFT JOIN global_vehicle_modifications m ON m.id = a.modification_id
          WHERE a.tenant_id = $1 AND a.product_id = ANY($2::uuid[]) AND a.make_id = $3
            AND ($4::uuid IS NULL OR a.model_id = $4 OR a.model_id IS NULL)
            AND ($5::uuid IS NULL OR a.generation_id = $5 OR a.generation_id IS NULL)`,
        [tx.tenantId, ids, v.makeId, v.modelId ?? null, v.generationId ?? null],
      );
      const narrows = (match: (r: any) => boolean) => {
        // Вариант сужает, если какой-то товар подходит не под все ответы
        const by = new Map<string, boolean>();
        for (const r of rows) by.set(r.product_id, (by.get(r.product_id) ?? false) || match(r));
        return [...by.values()].some((x) => !x);
      };
      if (!v.year && v.generationId) {
        const ranges = new Map<string, { from: number | null; to: number | null }>();
        for (const r of rows) if (r.year_from || r.year_to) ranges.set(`${r.year_from}-${r.year_to}`, { from: r.year_from, to: r.year_to });
        const list = [...ranges.values()].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
        if (list.length >= 2) {
          const pick = (x: { from: number | null; to: number | null }) => {
            // Год внутри диапазона и, по возможности, вне остальных (граничный год рестайлинга — в обоих)
            const lo = x.from ?? (x.to ?? 2000) - 3;
            const hi = x.to ?? lo + 3;
            for (let y = lo; y <= hi; y++) if (!list.some((o) => o !== x && (o.from ?? 0) <= y && (o.to ?? 9999) >= y)) return y;
            return lo;
          };
          const span = (x: { from: number | null; to: number | null }) => `${x.from ?? '…'}–${x.to ?? '…'}`;
          out.push({
            key: 'year',
            question: list.length === 2 ? 'До или после рестайлинга?' : 'Какой год выпуска?',
            options: list.map((x, i) => ({
              label: list.length === 2 ? `${i ? 'После' : 'До'} рестайлинга (${span(x)})` : span(x),
              value: pick(x),
            })),
          });
        }
      }
      if (!v.steering) {
        const vals = new Set(rows.map((r) => r.steering).filter(Boolean));
        if (vals.size && (vals.size > 1 || narrows((r) => !r.steering || r.steering !== [...vals][0]))) {
          out.push(
            vals.size > 1
              ? { key: 'steering', question: 'Правый или левый руль?', options: [{ label: 'Правый', value: 'right' }, { label: 'Левый', value: 'left' }] }
              : vals.has('right')
                ? { key: 'steering', question: 'Правый руль?', options: [{ label: 'Да, правый', value: 'right' }, { label: 'Нет, левый', value: 'left' }] }
                : { key: 'steering', question: 'Левый руль?', options: [{ label: 'Да, левый', value: 'left' }, { label: 'Нет, правый', value: 'right' }] },
          );
        }
      }
      if (!v.modificationId) {
        const mods = new Map<string, string>();
        for (const r of rows) if (r.modification_id) mods.set(r.modification_id, r.engine_code ? `${r.engine_code} (${r.mod_name})` : r.mod_name);
        if (mods.size >= 2 || (mods.size === 1 && narrows((r) => !r.modification_id))) {
          out.push({ key: 'modificationId', question: 'Какой двигатель?', options: [...mods].map(([value, label]) => ({ label, value })) });
        }
      }
    }
    const attrs: any[] = await tx.query(
      `SELECT attributes->>'side' AS side, attributes->>'axle' AS axle FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tx.tenantId, ids],
    );
    const sides = [...new Set(attrs.map((a) => a.side).filter(Boolean))];
    const axles = [...new Set(attrs.map((a) => a.axle).filter(Boolean))];
    if (!f.side && sides.length >= 2) out.push({ key: 'side', question: 'Левая или правая?', options: ['Левая', 'Правая'].map((x) => ({ label: x, value: x })) });
    if (!f.axle && axles.length >= 2) out.push({ key: 'axle', question: 'Передняя или задняя?', options: ['Передняя', 'Задняя'].map((x) => ({ label: x, value: x })) });
    return out;
  }

  private async applicabilityFlags(tx: TenantTx, ids: string[], v: { makeId?: string; modelId?: string; generationId?: string }) {
    const map = new Map<string, boolean>();
    if (!ids.length || !v.makeId) return map;
    const rows = await tx.query(
      `SELECT product_id, bool_or(($3::uuid IS NOT NULL AND generation_id = $3) OR ($3::uuid IS NULL AND $4::uuid IS NOT NULL AND model_id = $4)) AS exact
         FROM product_applicability WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) GROUP BY product_id`,
      [tx.tenantId, ids, v.generationId ?? null, v.modelId ?? null],
    );
    for (const r of rows) map.set(r.product_id, !r.exact && !!(v.generationId || v.modelId));
    return map;
  }

  // ── Карточки результатов ────────────────────────────────

  private async loadInfo(tx: TenantTx, ids: string[], includeArchived = false) {
    const map = new Map<string, { view: any; stock: { storeId: string | null; warehouseId: string; qty: string }[] }>();
    if (!ids.length) return map;
    const rows = await tx.query(
      `SELECT p.id, p.sku, p.name, p.kind, p.quality_class AS "qualityClass", p.status, p.no_stock_control AS "noStockControl",
              p.is_serial AS "isSerial", p.price_negotiable AS "priceNegotiable", p.base_unit AS "baseUnit",
              p.seller_note AS "sellerNote", b.name AS "brandName",
              (SELECT n.number FROM part_numbers n WHERE n.tenant_id = p.tenant_id AND n.product_id = p.id
                ORDER BY (n.type = 'manufacturer') DESC, n.created_at LIMIT 1) AS "mainNumber",
              (SELECT ph.file_id FROM product_photos ph WHERE ph.tenant_id = p.tenant_id AND ph.product_id = p.id ORDER BY ph.sort LIMIT 1) AS "photoFileId"
         FROM products p LEFT JOIN brands b ON b.id = p.brand_id
        WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[]) AND p.deleted_at IS NULL AND p.merged_into_id IS NULL
          ${includeArchived ? `AND p.status <> 'system'` : `AND p.status = 'active'`}`,
      [tx.tenantId, ids],
    );
    const priceMap = await this.prices.retailMap(tx, rows.map((r: any) => r.id), this.scope.currentStoreId());
    const stock = await this.stock.balances(tx, rows.map((r: any) => r.id));
    const allowedStores = this.scope.storeIds();
    for (const r of rows) {
      map.set(r.id, {
        view: {
          ...r,
          qualityLabel: QUALITY_LABELS[r.qualityClass as QualityClass],
          price: priceMap.get(r.id)?.price ?? null,
          currency: priceMap.get(r.id)?.currency ?? null,
        },
        stock: stock
          .filter((s) => s.productId === r.id && (allowedStores === null || (s.storeId && allowedStores.includes(s.storeId))))
          .map((s) => ({ storeId: s.storeId, warehouseId: s.warehouseId, qty: s.qty })),
      });
    }
    return map;
  }

  // ── Ненайденные ─────────────────────────────────────────

  private async logUnfound(
    tx: TenantTx,
    raw: string,
    normalized: string,
    reason: 'none' | 'no_stock',
    v: { makeId?: string; modelId?: string; generationId?: string },
    context?: string,
  ) {
    // Поиск при наборе текста: «кол» → «колод» → «колодки» — храним одну, последнюю запись
    const recent = await tx.query<{ id: string; normalized: string }>(
      `SELECT id, normalized FROM unfound_queries
        WHERE tenant_id = $1 AND created_by IS NOT DISTINCT FROM $2 AND created_at > now() - interval '2 minutes'
        ORDER BY created_at DESC LIMIT 1`,
      [tx.tenantId, tx.userId],
    );
    const prev = recent[0];
    if (prev && (normalized.startsWith(prev.normalized) || prev.normalized.startsWith(normalized))) {
      await tx.query(
        `UPDATE unfound_queries SET query = $3, normalized = $4, reason = $5, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, prev.id, raw, normalized, reason],
      );
      return;
    }
    await tx.repo(UnfoundQuery).insert({
      query: raw,
      normalized,
      reason,
      storeId: this.scope.currentStoreId() ?? null,
      makeId: v.makeId ?? null,
      modelId: v.modelId ?? null,
      generationId: v.generationId ?? null,
      context: context ?? null,
    });
  }

  /** Отчёт «Что спрашивают, но нет» (ТЗ 5.4). */
  async unfoundReport(from?: string, to?: string, limit = 100) {
    return this.tenantTx.run(async (tx) => {
      const stores = this.scope.storeIds();
      return tx.query(
        `SELECT u.normalized, max(u.query) AS example, count(*)::int AS times, max(u.created_at) AS "lastAt",
                sum(CASE WHEN u.reason = 'none' THEN 1 ELSE 0 END)::int AS "notFound",
                sum(CASE WHEN u.reason = 'no_stock' THEN 1 ELSE 0 END)::int AS "noStock",
                array_remove(array_agg(DISTINCT coalesce(g.name, m.name)), NULL) AS vehicles
           FROM unfound_queries u
           LEFT JOIN global_vehicle_generations g ON g.id = u.generation_id
           LEFT JOIN global_vehicle_models m ON m.id = u.model_id
          WHERE u.tenant_id = $1 AND ($2::timestamptz IS NULL OR u.created_at >= $2) AND ($3::timestamptz IS NULL OR u.created_at < $3)
            AND ($4::uuid[] IS NULL OR u.store_id = ANY($4::uuid[]))
          GROUP BY u.normalized ORDER BY times DESC, "lastAt" DESC LIMIT $5`,
        [tx.tenantId, from ?? null, to ?? null, stores, limit],
      );
    });
  }
}

// ── Разбор запроса ────────────────────────────────────────

/** Варианты одного слова: каждый вариант — набор слов, которые должны встретиться все. */
function wordVariants(word: string, syn: SynonymPair[]): string[][] {
  const out: string[][] = [];
  const push = (v: string[]) => {
    const clean = v.map((x) => stem(x)).filter((x) => x.length >= 2 || /\d/.test(x));
    if (clean.length && !out.some((o) => o.join(' ') === clean.join(' '))) out.push(clean);
  };
  push([word]);
  for (const s of syn) if (s.word === word) push(s.target.split(' '));
  if (/^[a-z;',.[\]`]+$/.test(word)) {
    const layout = fixLayout(word);
    if (/^[а-яё]+$/.test(layout)) {
      push([layout]);
      for (const s of syn) if (s.word === layout) push(s.target.split(' '));
    }
    if (/^[a-z]+$/.test(word) && word.length >= 4) {
      const tr = translitToRu(word);
      push([tr]);
      for (const s of syn) if (s.word === tr) push(s.target.split(' '));
    }
  }
  return out;
}

/** Альтернативы всего запроса: исходный по словам + замены многословных синонимов («стойка стаба»). */
export function expandQuery(text: string, syn: SynonymPair[]): string[][][][] {
  const words = text.split(' ').filter(Boolean).slice(0, 8);
  const base = words.map((w) => wordVariants(w, syn));
  const alts: string[][][][] = [base];
  for (const s of syn) {
    if (!s.word.includes(' ')) continue;
    const phrase = ` ${s.word} `;
    if (!` ${text} `.includes(phrase)) continue;
    const replaced = ` ${text} `.replace(phrase, ` ${s.target} `).trim();
    alts.push(replaced.split(' ').filter(Boolean).map((w) => wordVariants(w, [])));
  }
  return alts;
}

/** «Лестница» качества: оригинал → OEM → аналог → копия → б/у (ТЗ 5.1). */
function ladder<T extends { qualityClass: QualityClass; score?: number }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => QUALITY_ORDER.indexOf(a.qualityClass) - QUALITY_ORDER.indexOf(b.qualityClass) || (b.score ?? 0) - (a.score ?? 0),
  );
}

function ladderSummary(items: { qualityClass: QualityClass; price: string | null; stockTotal: string }[]) {
  return QUALITY_ORDER.map((qc) => {
    const list = items.filter((i) => i.qualityClass === qc);
    if (!list.length) return null;
    const prices = list.map((i) => i.price).filter(Boolean).map((p) => D(p!));
    return {
      qualityClass: qc,
      label: QUALITY_LABELS[qc],
      count: list.length,
      minPrice: prices.length ? prices.reduce((a, b) => (a.lt(b) ? a : b)).toFixed(2) : null,
      stockTotal: list.reduce((a, i) => a.plus(i.stockTotal), D(0)).toFixed(),
    };
  }).filter(Boolean);
}
