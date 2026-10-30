import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { ScopeService } from '../auth/scope.service';
import { PdfService } from '../printing/pdf.service';
import { PriceResolverService } from '../pricing/price-resolver.service';
import { SettingsService } from '../settings/settings.service';
import { ReportView } from './entities/report.entity';
import { normalizeFilters, ReportColumn, ReportDef, ReportFilters, ReportResult } from './report-kit';
import { EXTERNAL_REPORTS, REPORT_GROUPS, REPORTS } from './reports.registry';
import { RptSalesService } from './rpt-sales.service';

const BY_CODE = new Map(REPORTS.map((r) => [r.code, r]));

/** Отчёты (ТЗ 20.2): каталог, расчёт, выгрузка в Excel и PDF, сохранённые виды. */
@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
    private readonly resolver: PriceResolverService,
    private readonly pdf: PdfService,
    private readonly rpt: RptSalesService,
  ) {}

  private allowed(r: { permission: string; needsCost?: boolean }) {
    return this.ctx.can(r.permission as any) && (!r.needsCost || this.ctx.can('products.view_cost'));
  }

  catalog() {
    const items = [
      ...REPORTS.filter((r) => this.allowed(r)).map((r) => ({ code: r.code, group: r.group, title: r.title, filters: r.filters, groupBy: r.groupBy ?? null })),
      ...EXTERNAL_REPORTS.filter((r) => this.allowed(r)).map((r) => ({ code: r.code, group: r.group, title: r.title, path: r.path })),
    ];
    return Object.entries(REPORT_GROUPS)
      .map(([group, title]) => ({ group, title, reports: items.filter((i) => i.group === group) }))
      .filter((g) => g.reports.length);
  }

  def(code: string): ReportDef {
    const r = BY_CODE.get(code);
    if (!r) throw Errors.notFound('Отчёт');
    if (!this.allowed(r)) throw Errors.forbidden('Нет доступа к этому отчёту');
    return r;
  }

  async run(code: string, raw: Partial<ReportFilters>): Promise<ReportResult & { report: { code: string; title: string }; filters: ReportFilters }> {
    const def = this.def(code);
    const f = normalizeFilters(raw);
    if (f.from > f.to) throw Errors.bad('BAD_PERIOD', 'Начало периода позже конца');
    if (f.storeId) this.scope.assertStore(f.storeId);
    const started = Date.now();
    const res = await this.tenantTx.run(async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = '60s'`);
      const s = await this.settings.get(tx);
      const rates = await this.resolver.rates(tx);
      return def.run({ tx, f, stores: this.scope.storeIds(), canSeeCost: this.ctx.can('products.view_cost'), settings: { ...s, rates } });
    });
    return { report: { code: def.code, title: def.title }, filters: f, ...res, tookMs: Date.now() - started } as any;
  }

  // ── Выгрузка ─────────────────────────────────────────────

  private cell(c: ReportColumn, v: unknown) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'да' : '';
    if (c.type === 'date' || c.type === 'datetime') {
      const d = new Date(v as string);
      if (Number.isNaN(d.getTime())) return String(v);
      return c.type === 'date' ? d.toLocaleDateString('ru-RU', { timeZone: 'Asia/Bishkek' }) : d.toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek' });
    }
    return v as any;
  }

  async xlsx(code: string, raw: Partial<ReportFilters>) {
    const r = await this.run(code, raw);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(r.report.title.slice(0, 31));
    ws.addRow([r.report.title]).font = { bold: true, size: 13 };
    ws.addRow([`Период: ${r.filters.from} — ${r.filters.to}`]);
    ws.addRow([]);
    const head = ws.addRow(r.columns.map((c) => c.title));
    head.font = { bold: true };
    for (const row of r.rows) ws.addRow(r.columns.map((c) => this.cell(c, row[c.key])));
    if (r.totals && Object.keys(r.totals).length) {
      const t = ws.addRow(r.columns.map((c, i) => (i === 0 ? 'Итого' : (r.totals![c.key] ?? ''))));
      t.font = { bold: true };
    }
    r.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = c.type === 'text' || !c.type ? 32 : 16;
      if (c.type === 'money') col.numFmt = '#,##0.00';
      if (c.type === 'qty') col.numFmt = '#,##0.###';
    });
    if (r.note) ws.addRow([]).getCell(1).value = r.note;
    return { name: `${code}_${r.filters.from}_${r.filters.to}.xlsx`, buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
  }

  async pdfFile(code: string, raw: Partial<ReportFilters>) {
    const r = await this.run(code, raw);
    const fmt = (c: ReportColumn, v: unknown) => {
      const x = this.cell(c, v);
      if (typeof x === 'number') return c.type === 'money' ? x.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : x.toLocaleString('ru-RU');
      return String(x);
    };
    const body: any[] = [r.columns.map((c) => ({ text: c.title, bold: true }))];
    for (const row of r.rows.slice(0, 3000)) body.push(r.columns.map((c) => ({ text: fmt(c, row[c.key]), alignment: c.type && c.type !== 'text' && c.type !== 'date' && c.type !== 'datetime' ? 'right' : 'left' })));
    if (r.totals && Object.keys(r.totals).length) body.push(r.columns.map((c, i) => ({ text: i === 0 ? 'Итого' : r.totals![c.key] !== undefined ? fmt(c, r.totals![c.key]) : '', bold: true, alignment: i ? 'right' : 'left' })));
    const buffer = await this.pdf.render({
      pageOrientation: r.columns.length > 6 ? 'landscape' : 'portrait',
      pageMargins: [24, 24, 24, 24],
      content: [
        { text: r.report.title, fontSize: 14, bold: true },
        { text: `Период: ${r.filters.from} — ${r.filters.to}`, fontSize: 9, margin: [0, 2, 0, 8] },
        { table: { headerRows: 1, widths: r.columns.map((c, i) => (i === 0 ? '*' : 'auto')), body }, layout: 'lightHorizontalLines', fontSize: 8 },
        ...(r.note ? [{ text: r.note, fontSize: 8, italics: true, margin: [0, 8, 0, 0] as [number, number, number, number] }] : []),
      ],
    });
    return { name: `${code}_${r.filters.from}_${r.filters.to}.pdf`, buffer };
  }

  // ── Сохранённые виды ─────────────────────────────────────

  views(report?: string) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT id, report, name, params, shared, user_id = $2 AS mine FROM report_views
          WHERE tenant_id = $1 AND (user_id = $2 OR shared) AND ($3::varchar IS NULL OR report = $3) ORDER BY name`,
        [tx.tenantId, this.ctx.userId, report ?? null],
      ),
    );
  }

  saveView(dto: { report: string; name: string; params: Record<string, unknown>; shared?: boolean }) {
    this.def(dto.report);
    return this.tenantTx.run((tx) =>
      tx.repo(ReportView).insert({ userId: this.ctx.userId!, report: dto.report, name: dto.name.trim().slice(0, 100), params: dto.params ?? {}, shared: !!dto.shared && this.ctx.isOwner }),
    );
  }

  deleteView(id: string) {
    return this.tenantTx.run(async (tx) => {
      const [rows] = await tx.query(`DELETE FROM report_views WHERE tenant_id = $1 AND id = $2 AND user_id = $3 RETURNING id`, [tx.tenantId, id, this.ctx.userId]);
      if (!rows?.length) throw Errors.notFound('Вид отчёта');
    });
  }

  rebuild(from: string, to: string) {
    if (!this.ctx.isOwner) throw Errors.forbidden('Только владелец');
    return this.rpt.rebuild(this.ctx.requireTenantId(), from, to);
  }
}
