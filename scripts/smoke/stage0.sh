#!/usr/bin/env bash
# Смоук-проверка этапа 0: запускать из папки backend при запущенном API.
#   bash scripts/smoke/stage0.sh
# Нужны curl, jq, psql. Каждый запуск создаёт новые тестовые магазины — только на dev/test базе!
set -u
set -a; [ -f .env ] && . ./.env; set +a
API=${API:-http://localhost:${PORT:-3000}/api}
APP_DB="$DATABASE_URL"
OWNER_DB="$DATABASE_OWNER_URL"
TMP=$(mktemp -d)
J='Content-Type: application/json'
pass=0; fail=0
ok(){ echo "  ✔ $1"; pass=$((pass+1)); }
bad(){ echo "  ✘ $1"; fail=$((fail+1)); }
expect(){ # name expected actual
  if [ "$2" == "$3" ]; then ok "$1"; else bad "$1 (ожидали $2, получили $3)"; fi; }
req(){ # method path token body -> prints body, sets CODE
  local m=$1 p=$2 t=${3:-} b=${4:-}
  local args=(-s -o $TMP/resp.json -w "%{http_code}" -X "$m" "$API$p" -H "$J")
  [ -n "$t" ] && args+=(-H "Authorization: Bearer $t")
  [ -n "${STORE_HDR:-}" ] && args+=(-H "X-Store-Id: $STORE_HDR")
  [ -n "$b" ] && args+=(-d "$b")
  CODE=$(curl "${args[@]}"); BODY=$(cat $TMP/resp.json)
}
R=$(printf "%04d" $((RANDOM % 10000)))
echo "1. Регистрация двух магазинов"
req POST /auth/register "" "{\"name\":\"Бакыт\",\"login\":\"0555${R}01\",\"password\":\"secret123\",\"shopName\":\"Магазин А\"}"
expect "регистрация А" 201 $CODE; TA=$(echo $BODY | jq -r .accessToken); TENANT_A=$(echo $BODY | jq -r .currentTenantId)
req POST /auth/register "" "{\"name\":\"Нурлан\",\"login\":\"nurlan${R}@mail.kg\",\"password\":\"secret123\",\"shopName\":\"Магазин Б\"}"
expect "регистрация Б" 201 $CODE; TB=$(echo $BODY | jq -r .accessToken)
req POST /auth/register "" "{\"name\":\"Дубль\",\"login\":\"+996 555 ${R}01\",\"password\":\"secret123\",\"shopName\":\"X\"}"
expect "тот же телефон в другом формате — 409" 409 $CODE
req GET /auth/me "$TA"; expect "me А" 200 $CODE
STORE_A1=$(echo $BODY | jq -r '.stores[0].id'); expect "у владельца все права" true $(echo $BODY | jq '.membership.permissions | index("period.reopen") != null')

echo "2. Мастер первого запуска"
req GET /onboarding "$TA"; expect "данные мастера" 200 $CODE; expect "3 типа магазина" 3 $(echo $BODY | jq '.shopTypes|length')
req POST /onboarding/complete "$TA" '{"shopType":"container","city":"Бишкек","ourMakes":["toyota","lexus","honda"],"storeName":"Контейнер Дордой","storeCode":"ДОР","shopRateUsd":"87.40","wallets":[{"provider":"MBank","holderName":"Бакыт","phone":"0555123456"}]}'
expect "мастер завершён" 201 $CODE; expect "категорий создано > 50" true $(echo $BODY | jq '.catalog.categories > 50')
expect "типов деталей 12" 12 $(echo $BODY | jq '.catalog.partTypes')
req POST /onboarding/complete "$TA" '{"shopType":"container"}'
expect "повторный мастер не плодит дубли" 0 $(echo $BODY | jq '.catalog.categories')
req GET /settings "$TA"; expect "вид каталога — по маркам" makes $(echo $BODY | jq -r .settings.catalogDefaultView)
SVER=$(echo $BODY | jq .version)

echo "3. Изоляция магазинов"
req GET /stores/$STORE_A1 "$TB"; expect "Б не видит точку А — 404" 404 $CODE
req GET /stores "$TB"; expect "у Б одна своя точка" 1 $(echo $BODY | jq length)
expect "у Б нет точки А" 0 $(echo $BODY | jq "[.[]|select(.id==\"$STORE_A1\")]|length")
req GET /audit "$TB"; expect "журнал Б не содержит событий А" 0 $(echo $BODY | jq "[.items[]|select(.summary|test(\"Мастер\"))]|length")
CNT=$(psql "$APP_DB" -tAc "select count(*) from stores")
expect "RLS: без app.tenant_id роль приложения видит 0 строк" 0 $CNT
CNT=$(psql "$APP_DB" -tAc "begin; select set_config('app.tenant_id','$TENANT_A',true); select count(*) from stores; commit;" | sed -n 3p)
expect "RLS: с app.tenant_id=А видна 1 точка" 1 $CNT
ERR=$(psql "$APP_DB" -tAc "begin; select set_config('app.tenant_id','$TENANT_A',true); insert into stores(tenant_id,name,code) values (gen_random_uuid(),'x','X'); commit;" 2>&1 | grep -c "row-level security")
expect "RLS: вставка с чужим tenant_id запрещена" 1 $ERR
ERR=$(psql "$APP_DB" -tAc "delete from audit_log" 2>&1 | grep -c "permission denied")
expect "журнал: роль приложения не может удалять" 1 $ERR

echo "4. Точки, кассы, режим касс"
req POST /stores "$TA" '{"name":"Ош-1"}'; expect "вторая точка" 201 $CODE; STORE_A2=$(echo $BODY | jq -r .id)
req GET "/registers?storeId=$STORE_A2" "$TA"; expect "у новой точки касса" 1 $(echo $BODY | jq length)
req POST /registers "$TA" "{\"storeId\":\"$STORE_A2\"}"; expect "вторая касса" 201 $CODE
req GET /stores/$STORE_A2 "$TA"; expect "режим «несколько касс»" multi $(echo $BODY | jq -r .registerMode)
REG2=$(psql "$OWNER_DB" -tAc "begin; select set_config('app.tenant_id','$TENANT_A',true); select id||':'||version from registers where store_id='$STORE_A2' order by code desc limit 1; commit;" | sed -n 3p)
req PATCH /registers/${REG2%%:*} "$TA" "{\"version\":${REG2##*:},\"isActive\":false}"; expect "отключили кассу" 200 $CODE
req GET /stores/$STORE_A2 "$TA"; expect "снова «одна касса»" single $(echo $BODY | jq -r .registerMode)
req PATCH /registers/${REG2%%:*} "$TA" "{\"version\":${REG2##*:},\"name\":\"x\"}"; expect "старая версия — 409 VERSION_CONFLICT" VERSION_CONFLICT $(echo $BODY | jq -r .code)

echo "5. Роли и сотрудники"
req GET /roles "$TA"; SELLER_ROLE=$(echo $BODY | jq -r '.[]|select(.code=="seller").id'); MGR_ROLE=$(echo $BODY | jq -r '.[]|select(.code=="store_manager").id'); ADMIN_ROLE=$(echo $BODY | jq -r '.[]|select(.code=="admin").id')
expect "8 системных ролей" 8 $(echo $BODY | jq length)
req POST /staff/invitations "$TA" "{\"name\":\"Азамат\",\"roleIds\":[\"$SELLER_ROLE\"],\"storeIds\":[\"$STORE_A1\"]}"
expect "приглашение продавца" 201 $CODE; CODE_S=$(echo $BODY | jq -r .code)
req GET /auth/invite/$CODE_S ""; expect "просмотр приглашения" "Магазин А" "$(echo $BODY | jq -r .tenantName)"
req POST /auth/accept-invite "" "{\"code\":\"$CODE_S\",\"login\":\"0700${R}02\",\"password\":\"seller123\"}"
expect "продавец принял приглашение" 201 $CODE; TS=$(echo $BODY | jq -r .accessToken)
req POST /auth/accept-invite "" "{\"code\":\"$CODE_S\",\"login\":\"0700${R}03\",\"password\":\"seller123\",\"name\":\"x\"}"
expect "повторно код не работает" INVITE_USED $(echo $BODY | jq -r .code)
req GET /stores "$TS"; expect "продавец видит 1 точку" 1 $(echo $BODY | jq length)
req GET /stores/$STORE_A2 "$TS"; expect "чужая точка продавцу — 404" 404 $CODE
STORE_HDR=$STORE_A2 req GET /stores "$TS"; expect "X-Store-Id чужой точки — 403" 403 $CODE
req POST /roles "$TS" '{"name":"Хакер","permissions":["settings.manage"]}'; expect "продавец не создаёт роли — 403" 403 $CODE
req PATCH /settings "$TS" "{\"version\":$SVER,\"negativeStock\":\"forbid\"}"; expect "продавец не меняет настройки" 403 $CODE

# управляющий точкой 1
req POST /staff/invitations "$TA" "{\"name\":\"Эрлан\",\"roleIds\":[\"$MGR_ROLE\"],\"storeIds\":[\"$STORE_A1\"]}"; CODE_M=$(echo $BODY | jq -r .code)
req POST /auth/accept-invite "" "{\"code\":\"$CODE_M\",\"login\":\"0777${R}04\",\"password\":\"manager123\",\"name\":\"Эрлан\"}"; TM=$(echo $BODY | jq -r .accessToken)
req POST /staff/invitations "$TM" "{\"roleIds\":[\"$ADMIN_ROLE\"],\"storeIds\":[\"$STORE_A1\"]}"
expect "управляющий не выдаёт роль админа (больше своих прав)" FORBIDDEN $(echo $BODY | jq -r .code)
req POST /staff/invitations "$TM" "{\"roleIds\":[\"$SELLER_ROLE\"],\"storeIds\":[\"$STORE_A2\"]}"
expect "управляющий не выдаёт чужую точку" 404 $CODE
req POST /staff/invitations "$TM" "{\"roleIds\":[\"$SELLER_ROLE\"],\"allStores\":true}"
expect "управляющий не выдаёт «все точки»" 403 $CODE
req POST /roles "$TM" '{"name":"Своя","permissions":["pos.use"]}'
expect "у управляющего нет roles.manage" 403 $CODE
req GET /staff "$TM"; expect "управляющий видит сотрудников своей точки (продавец + сам)" 2 $(echo $BODY | jq .total)
req POST /roles "$TA" '{"name":"Старший продавец","permissions":["pos.use","sales.discount","period.reopen"]}'
expect "period.reopen нельзя дать роли" 403 $CODE
req POST /roles "$TA" '{"name":"Старший продавец","permissions":["pos.use","sales.discount"],"maxDiscountPercent":10}'
expect "своя роль" 201 $CODE

echo "6. Сессии и токены"
JAR=$TMP/jar.txt; rm -f $JAR
curl -s -c $JAR -o $TMP/resp.json -X POST $API/auth/login -H "$J" -d "{\"login\":\"0555${R}01\",\"password\":\"secret123\"}"; TL=$(jq -r .accessToken $TMP/resp.json)
expect "вход сразу в единственный магазин" "$TENANT_A" "$(jq -r .currentTenantId $TMP/resp.json)"
C=$(curl -s -b $JAR -c $JAR -o $TMP/r2.json -w "%{http_code}" -X POST $API/auth/refresh); expect "refresh по cookie" 200 $C
OLDRT=$(grep refresh_token $JAR | awk '{print $7}')
C=$(curl -s -b $JAR -c $JAR -o /dev/null -w "%{http_code}" -X POST $API/auth/refresh); expect "второй refresh" 200 $C
req POST /auth/login "" "{\"login\":\"0555${R}01\",\"password\":\"wrong\"}"; expect "неверный пароль — 401" INVALID_CREDENTIALS $(echo $BODY | jq -r .code)
req POST /auth/logout "$TL"; expect "выход" 204 $CODE
req GET /auth/me "$TL"; expect "после выхода токен не работает" SESSION_REVOKED $(echo $BODY | jq -r .code)

echo "7. Отключение сотрудника"
SELLER_MID=$(curl -s $API/staff -H "Authorization: Bearer $TA" | jq -r '.items[]|select(.name=="Азамат").id')
req POST /staff/$SELLER_MID/disable "$TA"; expect "отключили продавца" 200 $CODE
req GET /auth/me "$TS"; expect "токен уволенного не работает" 401 $CODE
req POST /auth/login "" "{\"login\":\"0700${R}02\",\"password\":\"seller123\"}"; expect "уволенный входит, но без магазина" 0 $(echo $BODY | jq '.tenants|length')
req POST /staff/$SELLER_MID/enable "$TA"; expect "вернули" 200 $CODE

echo "8. Журнал, уведомления"
ADMIN_INV=$(curl -s -X POST $API/staff/invitations -H "$J" -H "Authorization: Bearer $TA" -d "{\"name\":\"Админ\",\"roleIds\":[\"$ADMIN_ROLE\"],\"allStores\":true}" | jq -r .code)
TAD=$(curl -s -X POST $API/auth/accept-invite -H "$J" -d "{\"code\":\"$ADMIN_INV\",\"login\":\"admin${R}@mail.kg\",\"password\":\"admin123\",\"name\":\"Админ\"}" | jq -r .accessToken)
req PATCH /settings "$TA" "{\"version\":$SVER,\"negativeStock\":\"forbid\"}"; expect "владелец изменил настройки" 200 $CODE
sleep 2
req GET "/audit?action=settings.update" "$TA"; expect "изменение видно в журнале" true $(echo $BODY | jq '.total >= 1')
expect "в журнале есть diff по negativeStock" true $(echo $BODY | jq '.items[0].diff.negativeStock != null')
req GET /notifications "$TAD"; expect "админ получил уведомление" true $(echo $BODY | jq '[.items[]|select(.type=="settings.changed")]|length >= 1')
OUT=$(psql "$OWNER_DB" -tAc "select count(*) from outbox_events where processed_at is null and tenant_id='$TENANT_A'")
expect "outbox обработан" 0 $OUT

echo "9. Файлы"
printf '\x89PNG\r\n\x1a\n0000000000000000' > $TMP/t.png
C=$(curl -s -o $TMP/resp.json -w "%{http_code}" -X POST $API/files -H "Authorization: Bearer $TA" -F "file=@$TMP/t.png;type=image/png" -F purpose=logo); expect "загрузка файла" 201 $C
FID=$(jq -r .id $TMP/resp.json)
C=$(curl -s -o /dev/null -w "%{http_code}" $API/files/$FID -H "Authorization: Bearer $TA"); expect "скачивание своим" 200 $C
C=$(curl -s -o /dev/null -w "%{http_code}" $API/files/$FID -H "Authorization: Bearer $TB"); expect "чужой магазин — 404" 404 $C
C=$(curl -s -o /dev/null -w "%{http_code}" $API/files/$FID); expect "без токена — 401" 401 $C
ls uploads/$TENANT_A >/dev/null 2>&1 && ok "файл лежит в uploads/{tenantId}/" || bad "нет папки uploads/{tenantId}"
printf 'hello' > $TMP/fake.png
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/files -H "Authorization: Bearer $TA" -F "file=@$TMP/fake.png;type=image/png" -F purpose=logo); expect "не-картинка под видом png — 400" 400 $C

echo "10. Передача владения"
ADMIN_MID=$(curl -s $API/staff -H "Authorization: Bearer $TA" | jq -r '.items[]|select(.name=="Админ").id')
req POST /staff/transfer-ownership "$TAD" "{\"membershipId\":\"$ADMIN_MID\",\"password\":\"admin123\"}"; expect "не владелец не передаёт" 403 $CODE
req POST /staff/transfer-ownership "$TA" "{\"membershipId\":\"$ADMIN_MID\",\"password\":\"secret123\"}"; expect "владелец передал" 201 $CODE
req GET /auth/me "$TAD"; expect "админ стал владельцем" true $(echo $BODY | jq .membership.isOwner)
req GET /auth/me "$TA"; expect "бывший владелец — администратор" admin $(echo $BODY | jq -r '.membership.roles[0].code')

echo; echo "Итог: ✔ $pass  ✘ $fail"
