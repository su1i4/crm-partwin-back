import { QueryRunner } from 'typeorm';

/** Имя роли приложения из DATABASE_URL (по умолчанию autoparts_app). */
export function appRoleName(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? '');
    return decodeURIComponent(u.username) || 'autoparts_app';
  } catch {
    return 'autoparts_app';
  }
}

/**
 * Права роли приложения на все таблицы схемы public. Вызывать в конце каждой миграции,
 * создающей таблицы, — на случай, если миграции запущены не под владельцем.
 */
export async function grantAppRole(qr: QueryRunner) {
  const role = appRoleName();
  const [{ exists }] = await qr.query(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`, [role]);
  if (!exists) return;
  await qr.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await qr.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
  await qr.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
  // Таблицы «только дополняются» — права на изменение снова снимаем
  for (const t of APPEND_ONLY_TABLES) {
    const [{ reg }] = await qr.query(`SELECT to_regclass($1) AS reg`, [`public.${t}`]);
    if (reg) await makeAppendOnly(qr, t);
  }
}

/** Журналы, которые нельзя менять и удалять (ТЗ 22.3). */
export const APPEND_ONLY_TABLES = ['audit_log'];

/** Журнал только дополняется: никто, кроме владельца, не может менять и удалять строки. */
export async function makeAppendOnly(qr: QueryRunner, table: string) {
  await qr.query(`
    DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
                WHERE table_schema = 'public' AND table_name = '${table}' AND grantee <> current_user LOOP
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON "${table}" FROM %I', r.grantee);
      END LOOP;
    END $$;`);
}
