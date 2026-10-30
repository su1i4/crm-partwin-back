import { QueryRunner } from 'typeorm';

/** Выражение текущего магазина: '' (после конца транзакции в пуле) превращается в NULL. */
export const CURRENT_TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
export const CURRENT_USER = `nullif(current_setting('app.user_id', true), '')::uuid`;

/**
 * Включить Row Level Security на таблице магазина (ТЗ 2.4.5, второй уровень защиты).
 * Вызывать в миграции каждой новой таблицы с tenant_id.
 */
export async function enableRls(qr: QueryRunner, table: string) {
  await qr.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
  await qr.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  await qr.query(`DROP POLICY IF EXISTS tenant_isolation ON "${table}"`);
  await qr.query(
    `CREATE POLICY tenant_isolation ON "${table}" USING (tenant_id = ${CURRENT_TENANT}) WITH CHECK (tenant_id = ${CURRENT_TENANT})`,
  );
}

export async function disableRls(qr: QueryRunner, table: string) {
  await qr.query(`DROP POLICY IF EXISTS tenant_isolation ON "${table}"`);
  await qr.query(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
  await qr.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
}
