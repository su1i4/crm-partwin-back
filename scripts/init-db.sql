-- Первичная подготовка базы. Выполнить ОДИН раз под суперпользователем postgres:
--   sudo -u postgres psql -v owner_pass="'owner_password'" -v app_pass="'app_password'" -f scripts/init-db.sql
--
-- Две роли (ТЗ 2.4.5):
--   autoparts_owner — владелец таблиц, под ним идут миграции, сиды и pg-boss
--   autoparts_app   — роль приложения: НЕ владелец, БЕЗ BYPASSRLS → на неё действует Row Level Security

\set ON_ERROR_STOP on

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autoparts_owner') THEN
    CREATE ROLE autoparts_owner LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autoparts_app') THEN
    CREATE ROLE autoparts_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

ALTER ROLE autoparts_owner PASSWORD :owner_pass;
ALTER ROLE autoparts_app PASSWORD :app_pass;

SELECT 'CREATE DATABASE autoparts OWNER autoparts_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'autoparts') \gexec

\c autoparts

-- Расширения (pg_trgm, unaccent, pgcrypto — «trusted», но ставим под суперпользователем для надёжности)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

GRANT CONNECT ON DATABASE autoparts TO autoparts_app;
GRANT USAGE ON SCHEMA public TO autoparts_app;
GRANT ALL ON SCHEMA public TO autoparts_owner;

-- Всё, что создаст владелец в будущем, сразу доступно приложению
ALTER DEFAULT PRIVILEGES FOR ROLE autoparts_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autoparts_app;
ALTER DEFAULT PRIVILEGES FOR ROLE autoparts_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO autoparts_app;
ALTER DEFAULT PRIVILEGES FOR ROLE autoparts_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO autoparts_app;

-- ── Производительность поиска при Row Level Security ───────────────────────
-- С RLS PostgreSQL применяет индекс только для LEAKPROOF-операторов. LIKE/ILIKE и триграммные % по умолчанию
-- не помечены — тогда поиск по 500 000 товаров идёт полным перебором. Эти функции не раскрывают данные строк
-- в ошибках (ошибки зависят только от шаблона запроса), поэтому помечаем их LEAKPROOF. Нужен суперпользователь.
ALTER FUNCTION textlike(text, text) LEAKPROOF;
ALTER FUNCTION texticlike(text, text) LEAKPROOF;
ALTER FUNCTION similarity_op(text, text) LEAKPROOF;
ALTER FUNCTION word_similarity_op(text, text) LEAKPROOF;
ALTER FUNCTION strict_word_similarity_op(text, text) LEAKPROOF;
ALTER FUNCTION jsonb_contains(jsonb, jsonb) LEAKPROOF;
ALTER FUNCTION arraycontains(anyarray, anyarray) LEAKPROOF;
ALTER FUNCTION arrayoverlap(anyarray, anyarray) LEAKPROOF;
