#!/usr/bin/env bash
# Смоук-проверка этапа 5 (касса без интернета: устройства, кэш, офлайн-очередь, PIN без сети, режимы точки).
#   bash scripts/smoke/stage5.sh      (из папки backend, API запущен; только dev-база)
set -u
set -a; [ -f .env ] && . ./.env; set +a
API=${API:-http://localhost:${PORT:-3000}/api}
TMP=$(mktemp -d)
J='Content-Type: application/json'
pass=0; fail=0
ok(){ echo "  ✔ $1"; pass=$((pass+1)); }
bad(){ echo "  ✘ $1"; fail=$((fail+1)); [ -n "${BODY:-}" ] && echo "      $(echo "$BODY" | head -c 400)"; }
expect(){ if [ "$2" == "$3" ]; then ok "$1"; else bad "$1 (ожидали $2, получили $3)"; fi; }
req(){ local m=$1 p=$2 t=${3:-} b=${4:-}
  local args=(-s -o $TMP/r.json -w "%{http_code}" -X "$m" "$API$p" -H "$J")
  [ -n "$t" ] && args+=(-H "Authorization: Bearer $t"); [ -n "$b" ] && args+=(-d "$b")
  CODE=$(curl "${args[@]}"); BODY=$(cat $TMP/r.json); }
dev(){ local m=$1 p=$2 b=${3:-}; local args=(-s -o $TMP/r.json -w "%{http_code}" -X "$m" "$API$p" -H "$J" -H "X-Device-Token: $DT"); [ -n "$b" ] && args+=(--data-binary "@$b")
  CODE=$(curl "${args[@]}"); BODY=$(cat $TMP/r.json); }
devj(){ echo "$2" > $TMP/b.json; dev POST "$1" $TMP/b.json; }
get(){ req GET "$1" "${2:-$T}"; }
post(){ req POST "$1" "${3:-$T}" "$2"; }
put(){ req PUT "$1" "${3:-$T}" "$2"; }
patch(){ req PATCH "$1" "${3:-$T}" "$2"; }
j(){ echo "$BODY" | jq -r "$1"; }
n(){ python3 -c "import sys;print(f'{float(sys.argv[1]):.2f}')" "$1"; }
uuid(){ python3 -c "import uuid;print(uuid.uuid4())"; }
R=$(printf "%05d" $((RANDOM)))
NOW(){ date -u +%Y-%m-%dT%H:%M:%S.000Z; }

echo "0. Подготовка"
req POST /auth/register "" "{\"name\":\"Офлайн\",\"login\":\"off${R}@x.kg\",\"password\":\"secret123\",\"shopName\":\"Офлайн ${R}\"}"; T=$(j .accessToken); TENANT=$(j .currentTenantId)
post /onboarding/complete '{"shopType":"container","shopRateUsd":"87.50"}' >/dev/null
get /registers; REG=$(j '.[0].id'); STORE=$(j '.[0].storeId'); REGCODE=$(j '.[0].code')
get /warehouses; WH=$(j '[.[]|select(.type=="sales_floor")][0].id')
get /price-types; RETAIL=$(j '.[]|select(.code=="retail").id')
mk(){ post /products "$1"; echo $BODY | jq -r .id; }
price(){ put /products/$1/prices "{\"items\":[{\"priceTypeId\":\"$RETAIL\",\"price\":\"$2\"}]}" >/dev/null; }
A=$(mk '{"name":"Фильтр","brand":"Bosch","number":"F-1","barcodes":["4600000000017"]}'); price $A 500
B=$(mk '{"name":"Свеча","brand":"NGK","number":"S-1"}'); price $B 150
OLD=$(mk '{"name":"Старый товар","brand":"Febi","number":"O-1"}'); price $OLD 100
NOSTOCK=$(mk '{"name":"Без остатка и продаж","brand":"Febi","number":"N-1"}'); price $NOSTOCK 100
post /documents "{\"type\":\"initial_stock\",\"warehouseId\":\"$WH\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"100\",\"price\":\"300\"},{\"productId\":\"$B\",\"qty\":\"10\",\"price\":\"80\"},{\"productId\":\"$OLD\",\"qty\":\"3\",\"price\":\"50\"}],\"post\":true}" >/dev/null
get /settings; patch /settings "{\"version\":$(j .version),\"negativeStock\":\"forbid\"}" >/dev/null
get /roles; SELLER_ROLE=$(j '.[]|select(.code=="seller").id')
post /staff/invitations "{\"name\":\"Нурлан\",\"roleIds\":[\"$SELLER_ROLE\"],\"allStores\":true}"; IC=$(j .code)
req POST /auth/accept-invite "" "{\"code\":\"$IC\",\"login\":\"nur${R}@x.kg\",\"password\":\"secret123\",\"name\":\"Нурлан\"}"
get /staff; SELLER=$(j '.items[]|select(.name=="Нурлан").id'); OWNER_M=$(j '.items[]|select(.isOwner==true).id')
put /pos/staff/$SELLER/pin '{}'; SELLER_PIN=$(j .pin); expect "продавцу выдан PIN" 5 "${#SELLER_PIN}"

echo "5.1 Устройство и кэш"
post /pos-devices "{\"registerId\":\"$REG\",\"name\":\"Ноутбук на кассе\"}"; DT=$(j .token); DEV=$(j .deviceId); SECRET=$(j .secret); PREFIX=$(j .numberPrefix)
expect "устройство привязано, серия А" "${REGCODE}А" "$PREFIX"
post /pos-devices "{\"registerId\":\"$REG\",\"name\":\"Переустановка\"}"; DT2=$(j .token); DEV2=$(j .deviceId); expect "переустановка — новая серия Б" "${REGCODE}Б" "$(j .numberPrefix)"
post /devices/pairing-code "{\"registerId\":\"$REG\"}"; PC=$(j .code); req POST /agent/pair "" "{\"code\":\"$PC\"}"; AGENT=$(j .token)
C=$(curl -s -o /dev/null -w "%{http_code}" "$API/pos-device/cache" -H "X-Device-Token: $AGENT"); expect "токен агента печати кассой не принимается" 401 $C
C=$(curl -s -o /dev/null -w "%{http_code}" "$API/agent/jobs" -H "X-Device-Token: $DT"); expect "токен кассы — не агент" 401 $C
dev GET /pos-device/cache; CURSOR=$(j .cursor)
expect "полная выгрузка" true "$(j .full)"
expect "в кэше товар с остатком" true "$(j "[.products[]|select(.id==\"$A\")]|length == 1")"
expect "товар без остатка и продаж — ищется онлайн" 0 "$(j "[.products[]|select(.id==\"$NOSTOCK\")]|length")"
expect "штрихкоды" 4600000000017 "$(j ".barcodes[]|select(.productId==\"$A\").barcode")"
expect "номера деталей" F1 "$(j ".numbers[]|select(.productId==\"$A\").normalized")"
expect "цены точки" 500.00 "$(n $(j ".prices[]|select(.productId==\"$A\").price"))"
expect "остатки складов точки" 100.00 "$(n $(j ".stock[]|select(.productId==\"$A\").qty"))"
expect "курс магазина" 87.50 "$(n $(j '.rates[0].rate'))"
expect "режим «одна касса»: долг без сети можно" true "$(j .offlineRules.debt)"
expect "распознавание номера без сети нельзя" false "$(j .offlineRules.ocr)"
PINHASH=$(j ".staff[]|select(.membershipId==\"$SELLER\").pinHash")
CHECK=$(python3 -c "
import hashlib,hmac,base64,sys
pin,tenant,m,secret=sys.argv[1:5]
k=hashlib.pbkdf2_hmac('sha256',pin.encode(),f'pin:{tenant}:{m}'.encode(),20000,32)
print(base64.b64encode(hmac.new(secret.encode(),base64.b64encode(k),hashlib.sha256).digest()).decode())" "$SELLER_PIN" "$TENANT" "$SELLER" "$SECRET")
expect "PIN без сети: касса проверяет хэш секретом устройства" "$PINHASH" "$CHECK"
dev GET /pos-device/cache; OTHER=$(echo "$BODY" | jq -r ".staff[]|select(.membershipId==\"$SELLER\").pinHash")
DT_SAVE=$DT; DT=$DT2; dev GET /pos-device/cache; expect "на другом устройстве хэш другой" true "$(j ".staff[]|select(.membershipId==\"$SELLER\").pinHash != \"$OTHER\"")"; DT=$DT_SAVE
sleep 11
dev GET /pos-device/cache; CURSOR=$(j .cursor)
devj /pos-device/pin-login "{\"pin\":\"$SELLER_PIN\"}"; TS=$(j .accessToken); expect "вход продавца по PIN на кассе" Нурлан "$(j .name)"
get /auth/me "$TS"; expect "сессия продавца работает" 200 $CODE
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/pos-device/pin-login" -H "$J" -d "{\"pin\":\"$SELLER_PIN\"}"); expect "PIN без зарегистрированного устройства не работает" 401 $C
sleep 1
price $A 520
patch /products/$OLD "{\"version\":$(get /products/$OLD; j .version),\"status\":\"archived\"}" >/dev/null
dev GET "/pos-device/cache?cursor=$CURSOR"; CURSOR2=$(j .cursor)
expect "изменения по курсору — не полная выгрузка" false "$(j .full)"
expect "новая цена пришла изменением" 520.00 "$(n $(j ".prices[]|select(.productId==\"$A\").price"))"
expect "архивный товар — в «удалённых»" true "$(j ".removed.products|index(\"$OLD\") != null")"
expect "неизменённое не гоняется повторно" 0 "$(j "[.products[]|select(.id==\"$B\")]|length")"

echo "5.2 Продажи без интернета"
GEN=$(python3 scripts/smoke/lib/offline_ops.py "{\"prefix\":\"$PREFIX\",\"member\":\"$SELLER\",\"A\":\"$A\",\"B\":\"$B\",\"priceA\":\"500\",\"priceB\":\"150\",\"at\":\"$(NOW)\"}")
echo "$GEN" | jq "{deviceTime:\"$(NOW)\",ops:.ops}" > $TMP/q.json
SHIFT_C=$(echo "$GEN" | jq -r .shift)
dev POST /pos-device/sync $TMP/q.json
expect "50 продаж + смена приняты" 51 "$(j '[.results[]|select(.status=="accepted")]|length')"
expect "очередь подтверждена до №51" 51 "$(j .lastOpSeq)"
get "/pos/receipts?registerId=$REG&status=completed&limit=100"; expect "на сервере ровно 50 чеков" 50 "$(j .total)"
expect "номера по серии устройства" true "$(j "[.items[].number|startswith(\"$PREFIX-\")]|all")"
dev POST /pos-device/sync $TMP/q.json
expect "повторная отправка — без дублей" 51 "$(j '[.results[]|select(.duplicate==true)]|length')"
get "/pos/receipts?registerId=$REG&status=completed&limit=100"; expect "чеков по-прежнему 50" 50 "$(j .total)"
get "/stock?warehouseId=$WH"; expect "остаток A: 100 − 50" 50 "$(j ".items[]|select(.productId==\"$A\").qty|tonumber")"
expect "B продали 50 при остатке 10 — чек принят, минус с пометкой" -40 "$(j ".items[]|select(.productId==\"$B\").qty|tonumber")"
get /pos/reports/offline; expect "отчёт офлайн-чеков: пометка «минус»" true "$(j '[.[]|select(.flags.negativeStock==true)]|length > 0')"
expect "цена A изменилась (520), чек сохранил 500 — «устаревшая цена»" true "$(j '[.[]|select(.flags.stalePrice==true)]|length > 0')"
get /pos/reports/stale-prices; expect "отчёт «Продажи по устаревшей цене»" 520.00 "$(n $(j '.[0].current'))"
R7=$(echo "$GEN" | jq -r '.ops[7].id'); get /pos/receipts/$R7; expect "скидка на чек посчитана тем же движком: 500 − 10" 490.00 "$(n $(j .total))"
expect "время устройства и время получения хранятся" true "$(j '.deviceCreatedAt != null and .receivedAt != null')"
mkop(){ python3 -c "import json,sys,uuid;print(json.dumps({'id':str(uuid.uuid4()),'seq':int(sys.argv[1]),'type':sys.argv[2],'at':sys.argv[3],'membershipId':sys.argv[4],'payload':json.loads(sys.argv[5])}))" "$@"; }
CUST_C=$(uuid)
OP52=$(python3 -c "import json;print(json.dumps({'id':'$CUST_C','seq':52,'type':'customer','at':'$(NOW)','membershipId':'$SELLER','payload':{'name':'Новый с кассы','phone':'0700${R}1'}}))")
OP53=$(mkop 53 sale "$(NOW)" "$SELLER" "{\"number\":\"$PREFIX-000051\",\"createdAt\":\"$(NOW)\",\"shiftId\":\"$SHIFT_C\",\"customerId\":\"$CUST_C\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\",\"price\":\"500\"}],\"total\":\"499\",\"payments\":[{\"method\":\"cash\",\"amount\":\"499\"}]}")
OP54=$(mkop 54 sale "$(NOW)" "$SELLER" "{\"number\":\"$PREFIX-000052\",\"createdAt\":\"$(NOW)\",\"shiftId\":\"$SHIFT_C\",\"customerId\":\"$CUST_C\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"2\",\"price\":\"500\"}],\"total\":\"1000\",\"payments\":[{\"method\":\"debt\",\"amount\":\"1000\"}]}")
echo "{\"deviceTime\":\"$(NOW)\",\"ops\":[$OP52,$OP53,$OP54]}" > $TMP/q2.json; dev POST /pos-device/sync $TMP/q2.json
expect "новый клиент с кассы создан" accepted "$(j '.results[0].status')"
expect "итог не сходится с движком — операция отклонена" TOTAL_MISMATCH "$(j '.results[1].code')"
expect "очередь идёт дальше: продажа в долг принята" accepted "$(j '.results[2].status')"
CUST=$(j '.results[0].result.customerId'); R54=$(j '.results[2].result.receiptId')
get /pos/receipts/$R54; expect "клиент из офлайн-UUID привязан" $CUST "$(j .customerId)"
expect "долг сверх лимита (розница — 0) — чек принят с пометкой" true "$(j '.flags.debtOverLimit != null')"
get "/counterparties/$CUST/debts"; expect "долг клиента записан" 1000.00 "$(n $(j '.[0].remaining'))"
OP55=$(mkop 55 customer "$(NOW)" "$SELLER" "{\"name\":\"Тот же клиент\",\"phone\":\"+996 700 ${R}1\"}")
OP57=$(mkop 57 sale "$(NOW)" "$SELLER" "{}")
echo "{\"ops\":[$OP55,$OP57]}" > $TMP/q3.json; dev POST /pos-device/sync $TMP/q3.json
expect "клиент с тем же телефоном — объединён" true "$(j '.results[0].result.merged')"; expect "объединён с существующим" $CUST "$(j '.results[0].result.customerId')"
expect "пропуск в очереди — «повторить», по порядку" OUT_OF_ORDER "$(j '.results[1].code')"
dev GET /pos-device/sync/state; expect "состояние очереди" 55 "$(j .lastOpSeq)"; expect "отклонённые видны кассе" 1 "$(j '.rejected|length')"
SKEW=$(date -u -d '-10 min' +%Y-%m-%dT%H:%M:%S.000Z)
OP56=$(mkop 56 sale "$SKEW" "$SELLER" "{\"number\":\"$PREFIX-000053\",\"createdAt\":\"$SKEW\",\"shiftId\":\"$SHIFT_C\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\",\"price\":\"520\"}],\"total\":\"520\",\"payments\":[{\"method\":\"cash\",\"amount\":\"520\"}]}")
echo "{\"deviceTime\":\"$SKEW\",\"ops\":[$OP56]}" > $TMP/q4.json; dev POST /pos-device/sync $TMP/q4.json
expect "часы сбиты на 10 мин — предупреждение" CLOCK_SKEW "$(j '.warnings[0].code')"
get /pos/receipts/$(j '.results[0].result.receiptId'); expect "в чеке — пометка о часах" true "$(j '.flags.clockSkew != null')"
expect "время продажи поправлено на сдвиг часов" true "$(python3 -c "
from datetime import datetime,timezone;import sys
d=datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'));print(str(abs((datetime.now(timezone.utc)-d).total_seconds())<120).lower())" "$(j .completedAt)")"
post /periods/close '{"month":"2026-09"}' >/dev/null
OLDT=2026-09-15T10:00:00.000Z
OP57=$(mkop 57 sale "$OLDT" "$SELLER" "{\"number\":\"$PREFIX-000054\",\"createdAt\":\"$OLDT\",\"shiftId\":\"$SHIFT_C\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\",\"price\":\"520\"}],\"total\":\"520\",\"payments\":[{\"method\":\"cash\",\"amount\":\"520\"}]}")
R_SALE=$(echo "$GEN" | jq -r '.ops[1].id'); R_LINE=$(get /pos/receipts/$R_SALE; j '.lines[0].id')
OP58=$(mkop 58 return "$(NOW)" "$SELLER" "{\"saleReceiptId\":\"$R_SALE\",\"lines\":[{\"saleLineId\":\"$R_LINE\",\"qty\":\"1\",\"reason\":\"changed_mind\"}]}")
OP59=$(mkop 59 cash_op "$(NOW)" "$SELLER" "{\"shiftId\":\"$SHIFT_C\",\"type\":\"cash_in\",\"amount\":\"1000\"}")
echo "{\"deviceTime\":\"$(NOW)\",\"ops\":[$OP57,$OP58,$OP59]}" > $TMP/q5.json; dev POST /pos-device/sync $TMP/q5.json
expect "чек в закрытом периоде принят" accepted "$(j '.results[0].status')"
get /pos/receipts/$(j '.results[0].result.receiptId'); expect "проведён текущим периодом, исходное время — в пометке" true "$(j '.flags.closedPeriod.originalAt|startswith("2026-09-15T10:00")')"; expect "дата документа — сегодня" true "$(j '.completedAt|startswith("2026-10")')"
dev GET /pos-device/sync/state >/dev/null; dev POST /pos-device/sync $TMP/q5.json
expect "офлайн-возврат по чеку этой кассы" accepted "$(j '.results[1].status')"; expect "внесение в офлайн-смене" accepted "$(j '.results[2].status')"
get "/shifts/current?registerId=$REG"; SHIFT_S=$(j .shift.id); expect "офлайн-смена открыта на сервере" open "$(j .shift.status)"
OP60=$(mkop 60 shift_close "$(NOW)" "$SELLER" "{\"shiftId\":\"$SHIFT_C\",\"counted\":{}}")
echo "{\"ops\":[$OP60]}" > $TMP/q6.json; dev POST /pos-device/sync $TMP/q6.json
expect "закрытие смены — последним" accepted "$(j '.results[0].status')"
get /shifts/$SHIFT_S/x-report; expect "Z-отчёт: 52 продажи офлайн" true "$(j '.salesCount >= 52')"

echo "16.1 Режим «несколько касс»"
post /registers "{\"storeId\":\"$STORE\",\"name\":\"Касса 2\"}" >/dev/null
dev GET /pos-device/cache; expect "вторая касса — режим «несколько касс»: долг без сети нельзя" false "$(j .offlineRules.debt)"
expect "товар без сети — только свободная позиция" free_item_only "$(j .offlineRules.createProduct)"
SH2=$(uuid)
OP61=$(python3 -c "import json;print(json.dumps({'id':'$SH2','seq':61,'type':'shift_open','at':'$(NOW)','membershipId':'$SELLER','payload':{'cash':{}}}))")
OP62=$(mkop 62 product_draft "$(NOW)" "$SELLER" '{"name":"Новая деталь","number":"ZZ-1","brand":"Febi"}')
OP63=$(mkop 63 sale "$(NOW)" "$SELLER" "{\"number\":\"$PREFIX-000055\",\"createdAt\":\"$(NOW)\",\"shiftId\":\"$SH2\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\",\"price\":\"520\"}],\"total\":\"520\",\"payments\":[{\"method\":\"debt\",\"amount\":\"520\"}]}")
echo "{\"ops\":[$OP61,$OP62,$OP63]}" > $TMP/q7.json; dev POST /pos-device/sync $TMP/q7.json
expect "товар без сети в режиме «несколько касс» — отклонён" OFFLINE_NOT_ALLOWED "$(j '.results[1].code')"
expect "долг без сети в «несколько касс» — принят с пометкой нарушения" true "$(get /pos/receipts/$(echo "$BODY" | jq -r '.results[2].result.receiptId'); j '.flags.offlineViolation != null')"

echo "PIN на кассе: блокировка"
for i in 1 2 3 4 5; do devj /pos-device/pin-login "{\"pin\":\"0000$i\"}" >/dev/null; done
devj /pos-device/pin-login "{\"pin\":\"$SELLER_PIN\"}"; expect "5 неверных PIN на кассе — блокировка" TOO_MANY_ATTEMPTS "$(j .code)"
DT_SAVE=$DT; DT=$DT2; devj /pos-device/pin-login "{\"pin\":\"$SELLER_PIN\"}"; expect "блокировка — на этом устройстве" Нурлан "$(j .name)"; DT=$DT_SAVE

echo "Отзыв и изоляция"
req DELETE /pos-devices/$DEV2 "$T"; DT_SAVE=$DT; DT=$DT2; dev GET /pos-device/cache; expect "отозванное устройство не работает" 401 $CODE; DT=$DT_SAVE
req POST /auth/register "" "{\"name\":\"Чужой\",\"login\":\"oth${R}@x.kg\",\"password\":\"secret123\",\"shopName\":\"Чужой\"}"; T2=$(j .accessToken)
get /pos-devices "$T2"; expect "чужие устройства не видны" 0 "$(j length)"
get /pos/receipts/$R54 "$T2"; expect "чужой офлайн-чек — 404" 404 $CODE
get /stock/reconcile; expect "кэш остатков = движения" true "$(j .ok)"

echo; echo "Итог: ✔ $pass  ✘ $fail"
