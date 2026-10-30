/**
 * Резервная копия ОДНОГО магазина (ТЗ 10.2): все строки всех таблиц с tenant_id → JSON-файлы в папке.
 *   npm run tenant:backup -- <tenantId> /var/backups/autoparts/tenants
 * В отличие от выгрузки владельцу — полная (с хэшами PIN и токенами устройств): хранить только на сервере.
 */
import 'reflect-metadata';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import AppDataSource from '../database/data-source';

async function main() {
  const [tenantId, dir = './backups'] = process.argv.slice(2);
  if (!tenantId) throw new Error('npm run tenant:backup -- <tenantId> [папка]');
  const ds = await AppDataSource.initialize();
  const out = join(dir, `${tenantId}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(out, { recursive: true });
  const tables: string[] = (
    await ds.query(
      `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' AND c.table_name NOT IN ('outbox_events', 'user_sessions', 'device_pairing_codes', 'platform_admin_log', 'support_sessions', 'support_grants')`,
    )
  ).map((r: any) => r.table_name);
  const qr = ds.createQueryRunner();
  await qr.startTransaction('REPEATABLE READ');
  await qr.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  let total = 0;
  for (const t of tables) {
    const rows = await qr.query(`SELECT * FROM "${t}" WHERE tenant_id = $1`, [tenantId]);
    await writeFile(join(out, `${t}.json`), JSON.stringify(rows));
    total += rows.length;
  }
  const [tenant] = await qr.query(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
  await writeFile(join(out, '__tenant.json'), JSON.stringify([tenant]));
  await qr.commitTransaction();
  await qr.release();
  console.log(JSON.stringify({ dir: out, tables: tables.length, rows: total }));
  await ds.destroy();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
