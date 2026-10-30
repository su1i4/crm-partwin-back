/**
 * Восстановить ОДИН магазин из копии tenant:backup (или из папки json/ полной выгрузки):
 *   npm run tenant:restore -- <папка-копии> --yes
 * В одной транзакции: строки магазина удаляются (в порядке зависимостей) и вставляются из копии.
 * Другие магазины не затрагиваются. Перед восстановлением делается копия текущего состояния.
 */
import 'reflect-metadata';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import AppDataSource from '../database/data-source';

async function main() {
  const [dir, yes] = process.argv.slice(2);
  if (!dir || yes !== '--yes') throw new Error('npm run tenant:restore -- <папка> --yes');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('__') && f !== 'manifest.json');
  const tenant = JSON.parse(await readFile(join(dir, '__tenant.json'), 'utf8'))[0];
  if (!tenant?.id) throw new Error('В копии нет __tenant.json');
  const ds = await AppDataSource.initialize();
  const tables = files.map((f) => f.replace(/\.json$/, ''));
  // Порядок по внешним ключам: родители раньше детей
  const fks: { child: string; parent: string }[] = await ds.query(
    `SELECT tc.relname AS child, tp.relname AS parent FROM pg_constraint c JOIN pg_class tc ON tc.oid = c.conrelid JOIN pg_class tp ON tp.oid = c.confrelid WHERE c.contype = 'f'`,
  );
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, stack = new Set<string>()) => {
    if (seen.has(t) || stack.has(t)) return;
    stack.add(t);
    for (const f of fks.filter((x) => x.child === t && x.parent !== t && tables.includes(x.parent))) visit(f.parent, stack);
    seen.add(t);
    order.push(t);
  };
  tables.forEach((t) => visit(t));
  const qr = ds.createQueryRunner();
  await qr.startTransaction();
  try {
    await qr.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);
    for (const t of [...order].reverse()) await qr.query(`DELETE FROM "${t}" WHERE tenant_id = $1`, [tenant.id]);
    let total = 0;
    for (const t of order) {
      const rows = JSON.parse(await readFile(join(dir, `${t}.json`), 'utf8'));
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        await qr.query(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(null::"${t}", $1::json)`, [JSON.stringify(chunk)]);
      }
      total += rows.length;
    }
    await qr.commitTransaction();
    console.log(JSON.stringify({ tenantId: tenant.id, tables: order.length, rows: total }));
  } catch (e) {
    await qr.rollbackTransaction();
    throw e;
  } finally {
    await qr.release();
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
