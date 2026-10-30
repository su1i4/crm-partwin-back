# Backend — CRM для магазинов автозапчастей

NestJS 11 (CommonJS) · TypeORM 0.3 (только миграции) · PostgreSQL 16 (RLS, pg_trgm, unaccent) · pg-boss · Socket.IO

## Быстрый старт (локально или на сервере)

```bash
# 1. База и роли (один раз, под postgres). Пароли — свои.
#    Скрипт также помечает LIKE и триграммные операторы LEAKPROOF — без этого поиск при RLS не использует индексы.
sudo -u postgres psql -v owner_pass="'owner_password'" -v app_pass="'app_password'" -f scripts/init-db.sql

# 2. Настройки
cp .env.example .env        # заполнить DATABASE_URL, DATABASE_OWNER_URL, JWT_ACCESS_SECRET, ENCRYPTION_KEY

# 3. Зависимости, миграции, сборка
npm ci
npm run migration:run
npm run build

# 4. Запуск
npm run start:dev           # разработка
node dist/main.js           # прод (PM2: pm2 start dist/main.js --name autoparts-api)
```

- API: `http://localhost:3000/api`
- Swagger: `http://localhost:3000/api/docs` (кнопка Authorize → accessToken из `/auth/login`)
- Проверка: `bash scripts/smoke/stage0.sh` и `bash scripts/smoke/stage1.sh` (нужны curl, jq, psql, iconv; только на dev-базе)

## Две роли базы — это важно

| Роль | Для чего | RLS |
|---|---|---|
| `autoparts_owner` (`DATABASE_OWNER_URL`) | миграции, сиды, pg-boss | владелец таблиц |
| `autoparts_app` (`DATABASE_URL`) | приложение | **действует**: без `app.tenant_id` видит 0 строк |

Если приложение подключить под владельцем или суперпользователем — второй уровень защиты (RLS) пропадёт. Не делайте так.

## Правила кода (ТЗ 2.4)

- Данные магазина — **только** через `TenantTransaction.run(tx => …)` и `tx.repo(Entity)`. Прямой `getRepository` запрещён линтером.
- Любой `id` с клиента — `tx.repo(X).getById(id)`: чужой → 404.
- Платформенные таблицы (`users`, `tenants`, `user_sessions`, `global_*`) — через `PlatformDb`.
- Новая таблица магазина: сущность наследует `TenantEntity` / `TenantVersionedEntity`, в миграции — `enableRls(queryRunner, 'table')` и `grantAppRole(queryRunner)`.
- Деньги и количества — `Decimal` (`common/utils/decimal.ts`), колонки `MONEY_COLUMN` / `QTY_COLUMN` / `COST_COLUMN`.
- События — `OutboxService.emit(tx, type, payload)` внутри транзакции; обработчики — `OutboxRegistry.on(type, fn)`.
- Журнал — `AuditService.log(tx, …)` в той же транзакции.
- Права — `@RequirePermission('module.action')` на эндпоинте; точки — `ScopeService`.
- Ошибки — `Errors.*` / `AppException(code, message)` → `{ code, message, details }`.
- Свои индексы (GIN, COLLATE, выражения) объявляйте в сущности как `@Index('имя', { synchronize: false })` и создавайте в миграции руками — иначе `migration:generate` их удалит.
- В поиске не используйте функции, не помеченные LEAKPROOF (например `lower()`), в условиях, которые должны идти по индексу.
- После изменения названия, номеров, бренда, атрибутов товара — `SearchTextService.rebuild(tx, [id])`.
- Остаток и себестоимость меняются **только** проведением документа: `DocumentsService.createInTx / postInTx` → `StockLedgerService.apply`. Руками `stock_balances` / `stock_movements` не трогать — ночная сверка это найдёт.
- Новый вид документа: строка в `DOCUMENT_TYPES` + класс `PostingHandler` (`plan()` возвращает движения) + регистрация в `DocumentsModule`.
- Проводка «задним числом» сама ставит товар в `cost_recalc_queue`; дату документа проверяйте через `PeriodsService.assertEditable` (закрытый период → `PERIOD_CLOSED`).
- Колонки `Decimal`, не заданные при `insert`, получают DEFAULT из базы (трансформер оставляет `undefined`).
- Цены и скидки считает только движок `src/common/pricing-engine/engine.ts` — чистые функции без Nest и базы (их же возьмёт офлайн-касса). Адаптер к базе — `PriceResolverService`.
- Деньги двигаются только через `MoneyService.record` (регистр `money_movements`), долги — через `DebtsService.open / payInTx / reduceBy`. Чеки — только через `ReceiptsService` / `ReturnsService`.
- Подтверждения старшего — `PinService.approve(...)`: если у пользователя есть право, PIN не нужен; иначе 409 с `details.requiresPin`.
- Модуль, которому нужно действие при проведении чужого документа (закупки при приёмке), регистрирует хук в `DocumentHooks` (`documents/document-hooks.ts`) — он выполняется в той же транзакции.
- Загрузка прайса по ссылке: только публичные адреса (`PRICELIST_ALLOW_PRIVATE_URLS=false` на сервере), размер — `PRICELIST_MAX_MB`.
- Офлайн-операции кассы выполняются от имени устройства (`PosDevicesService.runAs`): в контексте есть `deviceId` — по нему сервисы смягчают проверки, которые касса уже прошла без сети (передача кассы, сдача). Новая проверка в продаже — подумайте, нужна ли она для офлайн-чека.
- `UPDATE … RETURNING` через `tx.query` в драйвере pg возвращает `[строки, количество]` — разбирайте как в `DevicesService.pull`.

## Команды

| Команда | Что делает |
|---|---|
| `npm run start:dev` | запуск с перезапуском |
| `npm run build` | сборка в `dist/` |
| `npm run lint` | линтер |
| `npm run migration:generate -- src/database/migrations/Name` | миграция по изменениям сущностей (потом дописать RLS!) |
| `npm run migration:run` / `migration:revert` | применить / откатить |
| `bash scripts/smoke/stage0.sh` … `stage6.sh` | смоук-проверки этапов (API запущен, только dev-база; для stage6 — `OCR_URL=http://127.0.0.1:8099/ocr`) |
| `npm run vehicles:import -- файл.csv` | пополнить справочник машин и модификаций из CSV |

Распознавание номеров с фото — отдельный сервис `../ocr-service` (PaddleOCR); адрес — `OCR_URL` в `.env`. Без него кнопка фото отвечает 503 `OCR_UNAVAILABLE`.

## Запуск на сервере (этап 10)

1. PostgreSQL 16, Node 20+, Python 3.11 (для ocr-service), Apache, PM2.
2. `scripts/init-db.sql` (две роли), `.env` по `.env.example`, `npm ci && npm run build && npm run migration:run`.
3. `pm2 start ../deploy/ecosystem.config.js && pm2 save && pm2 startup`.
4. Apache: `../deploy/apache-autoparts.conf` (домен, сертификат certbot).
5. Резервные копии: `crontab -e` → `30 2 * * * /opt/autoparts/deploy/backup.sh >> /var/log/autoparts-backup.log 2>&1`.
6. Админка: `npm run admin:create -- you@example.com "Имя" 'длинный-пароль' admin`.
7. Telegram: `TELEGRAM_*` в `.env`, затем `npm run telegram:webhook -- https://домен/api`.

| Команда | Что делает |
|---|---|
| `npm run admin:create -- email "Имя" пароль [admin\|support]` | сотрудник платформы (2FA обязательна) |
| `npm run tenant:backup -- <tenantId> [папка]` | копия одного магазина (JSON по таблицам) |
| `npm run tenant:restore -- <папка> --yes` | восстановить один магазин из копии |
