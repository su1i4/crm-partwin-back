import { Injectable } from '@nestjs/common';
import archiver from 'archiver';
import ExcelJS from 'exceljs';
import { PassThrough, Readable } from 'stream';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';

/** Таблицы для Excel (человекочитаемо); в JSON — все таблицы магазина. */
const EXCEL_TABLES: [string, string][] = [
  ['products', 'Товары'],
  ['part_numbers', 'Номера'],
  ['prices', 'Цены'],
  ['stock_balances', 'Остатки'],
  ['counterparties', 'Контрагенты'],
  ['debt_items', 'Долги'],
  ['receipts', 'Чеки'],
  ['documents', 'Документы'],
  ['money_movements', 'Движение денег'],
];

/** Секреты не выгружаются (ТЗ 24: пароли, PIN, токены). */
const SECRET_COLUMNS = ['pin_lookup', 'pin_offline_hash', 'token_hash', 'secret_enc', 'password_hash', 'totp_secret_enc', 'public_token'];

/**
 * Полная выгрузка магазина (ТЗ 21.3) и «резервная копия одного магазина» (ТЗ 10.2):
 * все строки всех таблиц с tenant_id → JSON по таблицам + Excel основных; восстановление — scripts/tenant-restore.
 */
@Injectable()
export class TenantExportService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly platform: PlatformDb,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  async tenantTables(): Promise<string[]> {
    const rows = await this.platform.ds.query(
      `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
          AND c.table_name NOT IN ('outbox_events', 'user_sessions', 'device_pairing_codes') ORDER BY 1`,
    );
    return rows.map((r: any) => r.table_name);
  }

  /** Строки магазина по таблицам (в транзакции магазина — RLS). */
  async dump(tenantId: string): Promise<Record<string, any[]>> {
    const tables = await this.tenantTables();
    return this.tenantTx.run(
      async (tx) => {
        const out: Record<string, any[]> = {};
        for (const t of tables) {
          const rows = await tx.query(`SELECT * FROM "${t}" WHERE tenant_id = $1`, [tx.tenantId]);
          out[t] = rows.map((r: any) => {
            for (const c of SECRET_COLUMNS) if (c in r) r[c] = null;
            return r;
          });
        }
        const [tenant] = await tx.query(`SELECT * FROM tenants WHERE id = $1`, [tx.tenantId]);
        out.__tenant = [tenant];
        return out;
      },
      { tenantId, userId: null },
    );
  }

  async archive(tenantId: string): Promise<{ name: string; stream: Readable }> {
    const data = await this.dump(tenantId);
    const zip = archiver('zip', { zlib: { level: 6 } });
    const out = new PassThrough();
    zip.pipe(out);
    zip.append(JSON.stringify({ exportedAt: new Date().toISOString(), tenantId, format: 1, tables: Object.keys(data) }, null, 2), { name: 'manifest.json' });
    for (const [t, rows] of Object.entries(data)) zip.append(JSON.stringify(rows), { name: `json/${t}.json` });
    const wb = new ExcelJS.Workbook();
    for (const [t, title] of EXCEL_TABLES) {
      const rows = data[t] ?? [];
      const ws = wb.addWorksheet(title);
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]).filter((c) => c !== 'tenant_id' && c !== 'search_text');
      ws.addRow(cols).font = { bold: true };
      for (const r of rows.slice(0, 200000)) ws.addRow(cols.map((c) => (r[c] !== null && typeof r[c] === 'object' && !(r[c] instanceof Date) ? JSON.stringify(r[c]) : r[c])));
    }
    zip.append(Buffer.from(await wb.xlsx.writeBuffer()), { name: 'shop.xlsx' });
    void zip.finalize();
    return { name: `shop-export-${new Date().toISOString().slice(0, 10)}.zip`, stream: out };
  }

  async archiveForCurrent() {
    if (!this.ctx.isOwner) throw Errors.forbidden('Полную выгрузку делает владелец');
    const tenantId = this.ctx.requireTenantId();
    await this.tenantTx.run((tx) => this.audit.log(tx, { action: 'tenant.export_full', entityType: 'tenant', entityId: tenantId, summary: 'Полная выгрузка данных', important: true }));
    return this.archive(tenantId);
  }
}
