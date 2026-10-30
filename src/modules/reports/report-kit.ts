import { dayjs, DEFAULT_TZ, localDateString } from '../../common/utils/dates';
import type { Permission } from '../roles/permissions';
import type { TenantTx } from '../../database/tenant/tenant-tx';

export type ColType = 'text' | 'money' | 'qty' | 'percent' | 'int' | 'date' | 'datetime';

export interface ReportColumn {
  key: string;
  title: string;
  type?: ColType;
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: Record<string, any>[];
  totals?: Record<string, any>;
  /** Пояснение к отчёту (как считается) */
  note?: string;
}

/** Фильтры всех отчётов (ТЗ 20). */
export interface ReportFilters {
  from: string;
  to: string;
  date?: string;
  storeId?: string;
  warehouseId?: string;
  categoryId?: string;
  brandId?: string;
  qualityClass?: string;
  makeId?: string;
  modelId?: string;
  sellerId?: string;
  customerId?: string;
  productId?: string;
  groupBy?: string;
  days?: number;
  limit: number;
}

export interface ReportCtx {
  tx: TenantTx;
  f: ReportFilters;
  /** Точки, доступные пользователю (null — все) */
  stores: string[] | null;
  canSeeCost: boolean;
  settings: Record<string, any>;
}

export interface ReportDef {
  code: string;
  group: 'sales' | 'profit' | 'stock' | 'parts' | 'purchases' | 'customers' | 'staff' | 'money';
  title: string;
  permission: Permission;
  /** Какие фильтры имеют смысл */
  filters: (keyof ReportFilters)[];
  groupBy?: { value: string; label: string }[];
  /** Отчёт на себестоимости — без права видеть себестоимость недоступен */
  needsCost?: boolean;
  run(c: ReportCtx): Promise<ReportResult>;
}

/** Сборщик параметров SQL: p(v) → $n. */
export class Sql {
  readonly params: unknown[];
  constructor(tenantId: string) {
    this.params = [tenantId];
  }
  p(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
}

/** Начало локального дня как timestamptz-выражение. */
export const dayStart = (q: Sql, date: string) => `(${q.p(date)}::date::timestamp AT TIME ZONE '${DEFAULT_TZ}')`;
export const dayEnd = (q: Sql, date: string) => `((${q.p(date)}::date + 1)::timestamp AT TIME ZONE '${DEFAULT_TZ}')`;
export const localDay = (col: string) => `(${col} AT TIME ZONE '${DEFAULT_TZ}')::date`;

export function normalizeFilters(raw: Partial<ReportFilters>): ReportFilters {
  const today = localDateString(new Date());
  const to = raw.to ?? today;
  const from = raw.from ?? dayjs(to).startOf('month').format('YYYY-MM-DD');
  return { ...raw, from, to, limit: Math.min(Math.max(raw.limit ?? 500, 1), 5000) } as ReportFilters;
}

/** Фильтр по товару: группа (с подгруппами), бренд, класс качества, марка/модель по применимости. */
export function productFilter(q: Sql, f: ReportFilters, p = 'p'): string {
  const w: string[] = [];
  if (f.productId) w.push(`${p}.id = ${q.p(f.productId)}`);
  if (f.categoryId) {
    const c = q.p(f.categoryId);
    w.push(`EXISTS (SELECT 1 FROM categories c WHERE c.id = ${p}.category_id AND (c.id = ${c} OR c.path LIKE '%/' || ${c}::text || '/%'))`);
  }
  if (f.brandId) w.push(`${p}.brand_id = ${q.p(f.brandId)}`);
  if (f.qualityClass) w.push(`${p}.quality_class = ${q.p(f.qualityClass)}`);
  if (f.makeId || f.modelId) {
    const conds = [`a.product_id = ${p}.id`, `a.tenant_id = ${p}.tenant_id`];
    if (f.makeId) conds.push(`a.make_id = ${q.p(f.makeId)}`);
    if (f.modelId) conds.push(`(a.model_id = ${q.p(f.modelId)} OR a.model_id IS NULL)`);
    w.push(`EXISTS (SELECT 1 FROM product_applicability a WHERE ${conds.join(' AND ')})`);
  }
  return w.length ? ' AND ' + w.join(' AND ') : '';
}

/** Фильтр по точке: выбранная и доступные пользователю. */
export function storeFilter(q: Sql, c: ReportCtx, col: string): string {
  const w: string[] = [];
  if (c.f.storeId) w.push(`${col} = ${q.p(c.f.storeId)}`);
  if (c.stores) w.push(`${col} = ANY(${q.p(c.stores)}::uuid[])`);
  return w.length ? ' AND ' + w.join(' AND ') : '';
}

export const num = (v: unknown) => Number(v ?? 0);
export const r2 = (v: number) => Math.round(v * 100) / 100;

/** Итоги по числовым колонкам. */
export function sumTotals(rows: Record<string, any>[], cols: ReportColumn[]): Record<string, any> {
  const t: Record<string, any> = {};
  for (const c of cols) {
    if (c.type === 'money' || c.type === 'qty' || c.type === 'int') t[c.key] = r2(rows.reduce((a, r) => a + num(r[c.key]), 0));
  }
  return t;
}

export const C = (key: string, title: string, type: ColType = 'text'): ReportColumn => ({ key, title, type });
