#!/usr/bin/env bash
# Смоук-проверка этапа 2 (документы, остатки, себестоимость, приёмка, инвентаризация, закрытие периода).
#   bash scripts/smoke/stage2.sh      (из папки backend, API запущен; только dev-база)
set -u
set -a; [ -f .env ] && . ./.env; set +a
API=${API:-http://localhost:${PORT:-3000}/api}
OWNER_DB="$DATABASE_OWNER_URL"
TMP=$(mktemp -d)
J='Content-Type: application/json'
pass=0; fail=0
ok(){ echo "  ✔ $1"; pass=$((pass+1)); }
bad(){ echo "  ✘ $1"; fail=$((fail+1)); }
expect(){ if [ "$2" == "$3" ]; then ok "$1"; else bad "$1 (ожидали $2, получили $3)"; fi; }
req(){ local m=$1 p=$2 t=${3:-} b=${4:-}
  local args=(-s -o $TMP/r.json -w "%{http_code}" -X "$m" "$API$p" -H "$J")
  [ -n "$t" ] && args+=(-H "Authorization: Bearer $t"); [ -n "$b" ] && args+=(-d "$b")
  CODE=$(curl "${args[@]}"); BODY=$(cat $TMP/r.json); }
get(){ req GET "$1" "${2:-$T}"; }
post(){ req POST "$1" "${3:-$T}" "$2"; }
patch(){ req PATCH "$1" "${3:-$T}" "$2"; }
num(){ python3 -c "import sys;print(float(sys.argv[1]))" "$1"; }
R=$(printf "%05d" $((RANDOM)))
stock(){ get "/stock?q=$1&warehouseId=$2"; echo $BODY | jq -r "[.items[]|select(.productId==\"$3\")][0].qty // \"0\""; }
cost(){ get "/stock?warehouseId=$1"; echo $BODY | jq -r "[.items[]|select(.productId==\"$2\")][0].amount // \"0\""; }
wait_recalc(){ for i in $(seq 1 30); do get "/stock"; [ "$(echo $BODY | jq .costRecalcPending)" == "false" ] && return 0; sleep 1; done; return 1; }
newdoc(){ post /documents "$1"; DOC=$(echo $BODY | jq -r .id); VER=$(echo $BODY | jq .version); }
postdoc(){ post /documents/$1/post "{\"version\":$2}"; }

echo "0. Подготовка"
req POST /auth/register "" "{\"name\":\"Склад\",\"login\":\"wh${R}@x.kg\",\"password\":\"secret123\",\"shopName\":\"Склад ${R}\"}"; T=$(echo $BODY | jq -r .accessToken); TENANT=$(echo $BODY | jq -r .currentTenantId)
post /onboarding/complete '{"shopType":"city"}' >/dev/null
get /warehouses; W1=$(echo $BODY | jq -r '[.[]|select(.type=="sales_floor")][0].id'); STORE1=$(echo $BODY | jq -r '[.[]|select(.type=="sales_floor")][0].storeId')
post /stores '{"name":"Ош-2"}'; STORE2=$(echo $BODY | jq -r .id)
get "/warehouses?storeId=$STORE2"; W2=$(echo $BODY | jq -r '.[0].id')
post /counterparties '{"name":"Поставщик Авто","roles":["supplier"],"phone":"0555000111"}'; SUP=$(echo $BODY | jq -r .id); expect "поставщик" 201 $CODE
post /counterparties '{"name":"Дубль","roles":["supplier"],"phone":"+996 555 000 111"}'; expect "дубль телефона — предупреждение" DUPLICATE_PHONE $(echo $BODY | jq -r .code)
mk(){ post /products "$1"; echo $BODY | jq -r .id; }
A=$(mk '{"name":"Фильтр A","brand":"Bosch","number":"A-1"}'); B=$(mk '{"name":"Фильтр B","brand":"Mann","number":"B-1"}')
S=$(mk '{"name":"АКБ 60Ач","brand":"Varta","number":"S-60","isSerial":true}'); N=$(mk '{"name":"Свеча N","brand":"NGK","number":"N-1"}')
NC=$(mk '{"name":"Без учёта","brand":"Febi","number":"NC-1","noStockControl":true}'); D=$(mk '{"name":"Фильтр A дубль","brand":"Swag","number":"D-1"}')
req PATCH /settings "$T" '{"version":3,"negativeStock":"forbid"}'; [ "$CODE" != "200" ] && { get /settings; V=$(echo $BODY | jq .version); patch /settings "{\"version\":$V,\"negativeStock\":\"forbid\"}"; }
expect "минус запрещён" forbid "$(echo $BODY | jq -r .settings.negativeStock)"

echo "2.1 Движок документов и себестоимость"
newdoc "{\"type\":\"receiving\",\"warehouseId\":\"$W1\",\"counterpartyId\":\"$SUP\",\"docDate\":\"2026-10-20T10:00:00+06:00\",\"extra\":{\"supplierInvoiceNumber\":\"INV-1\"},\"lines\":[{\"productId\":\"$A\",\"qty\":\"10\",\"price\":\"100\"},{\"productId\":\"$B\",\"qty\":\"5\",\"price\":\"200\"}]}"
R1=$DOC; expect "черновик приёмки" draft $(echo $BODY | jq -r .status); NUMBER=$(echo $BODY | jq -r .number)
[[ $NUMBER =~ ^ПН-Т1-2026-[0-9]{6}$ ]] && ok "номер $NUMBER" || bad "номер $NUMBER"
postdoc $R1 999; expect "старая версия — 409" VERSION_CONFLICT $(echo $BODY | jq -r .code)
postdoc $R1 $VER; expect "проведена" posted $(echo $BODY | jq -r .status)
expect "остаток A = 10" 10 $(stock "" $W1 $A)
expect "себестоимость A = 1000" 1000.00 $(cost $W1 $A)
newdoc "{\"type\":\"receiving\",\"warehouseId\":\"$W1\",\"counterpartyId\":\"$SUP\",\"docDate\":\"2026-10-21T10:00:00+06:00\",\"extra\":{\"supplierInvoiceNumber\":\"INV-1\"},\"lines\":[{\"productId\":\"$A\",\"qty\":\"10\",\"price\":\"200\"}]}"; R2=$DOC
postdoc $R2 $VER; expect "та же накладная — предупреждение" DUPLICATE_INVOICE $(echo $BODY | jq -r .code)
post /documents/$R2/post "{\"version\":$VER,\"confirmDuplicateInvoice\":true}"; expect "с подтверждением — проведена" posted $(echo $BODY | jq -r .status)
expect "средняя: 20 шт на 3000" 3000.00 $(cost $W1 $A)
newdoc "{\"type\":\"writeoff\",\"warehouseId\":\"$W1\",\"docDate\":\"2026-10-22T10:00:00+06:00\",\"extra\":{\"reason\":\"defect\"},\"lines\":[{\"productId\":\"$A\",\"qty\":\"4\"}],\"post\":true}"; WO=$DOC
expect "списание по средней 150 × 4" 600 $(echo $BODY | jq -r '.lines[0].costAmount|tonumber|floor')
get /documents/$R1; RV=$(echo $BODY | jq .version)
patch /documents/$R1 "{\"version\":$RV,\"lines\":[{\"productId\":\"$A\",\"qty\":\"10\",\"price\":\"160\"},{\"productId\":\"$B\",\"qty\":\"5\",\"price\":\"200\"}]}"
expect "исправили проведённую приёмку (перепроведение)" posted $(echo $BODY | jq -r .status); [ "$CODE" != 200 ] && echo "$BODY"
wait_recalc && ok "пересчёт себестоимости отработал" || bad "пересчёт не завершился"
get /documents/$WO; expect "списание пересчитано: средняя 180 × 4 = 720" 720 $(echo $BODY | jq -r '.lines[0].costAmount|tonumber|floor')
expect "остаток в деньгах: 16 × 180 = 2880" 2880.00 $(cost $W1 $A)
newdoc "{\"type\":\"writeoff\",\"warehouseId\":\"$W1\",\"extra\":{\"reason\":\"defect\"},\"lines\":[{\"productId\":\"$A\",\"qty\":\"100\"}]}"; postdoc $DOC $VER
expect "минус запрещён — ошибка по строке" STOCK_NOT_ENOUGH $(echo $BODY | jq -r .code)
echo "     $(echo $BODY | jq -r '.details[0].message')"
expect "в ошибке номер строки" 1 $(echo $BODY | jq '.details[0].line')
req DELETE "/documents/$DOC?version=$VER" "$T"; expect "черновик удалён" 204 $CODE
req DELETE "/documents/$R1?version=$RV" "$T"; expect "проведённый не удалить" 409 $CODE
newdoc "{\"type\":\"writeoff\",\"warehouseId\":\"$W1\",\"extra\":{\"reason\":\"defect\"},\"lines\":[{\"productId\":\"$A\",\"qty\":\"8\"}],\"post\":true}"
expect "A = 16 − 8" 8 $(stock "" $W1 $A)
get /documents/$R2; post /documents/$R2/unpost "{\"version\":$(echo $BODY | jq .version)}"
expect "отмена приёмки, товар которой списан — запрет" UNPOST_NEGATIVE $(echo $BODY | jq -r .code)
expect "показаны мешающие документы" true $(echo $BODY | jq '.details.blockingDocuments|length >= 1')
# Продажа в минус с предупреждением и покрытие
get /settings; patch /settings "{\"version\":$(echo $BODY | jq .version),\"negativeStock\":\"warn\"}"
newdoc "{\"type\":\"writeoff\",\"warehouseId\":\"$W1\",\"extra\":{\"reason\":\"other\"},\"lines\":[{\"productId\":\"$N\",\"qty\":\"2\"}],\"post\":true}"
expect "минус разрешён с предупреждением" true $(echo $BODY | jq .hasNegative)
newdoc "{\"type\":\"receiving\",\"warehouseId\":\"$W1\",\"counterpartyId\":\"$SUP\",\"lines\":[{\"productId\":\"$N\",\"qty\":\"5\",\"price\":\"120\"}],\"post\":true}"; RN=$DOC
expect "приход покрыл минус → корректировка себестоимости" 1 $(echo $BODY | jq '[.links[]|select(.kind=="cost_adjustment")]|length')
expect "остаток N в деньгах = 3 × 120" 360.00 $(cost $W1 $N)
get /settings; patch /settings "{\"version\":$(echo $BODY | jq .version),\"negativeStock\":\"forbid\"}"
get /stock/reconcile; expect "кэш остатков = сумма движений" true $(echo $BODY | jq .ok)

echo "2.1 Параллельные проведения"
newdoc "{\"type\":\"initial_stock\",\"warehouseId\":\"$W1\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"5\",\"price\":\"200\"}],\"post\":true}"
expect "остаток B = 10" 10 $(stock "" $W1 $B)
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/documents -H "$J" -H "Authorization: Bearer $T" -d "{\"type\":\"writeoff\",\"warehouseId\":\"$W1\",\"extra\":{\"reason\":\"other\"},\"lines\":[{\"productId\":\"$B\",\"qty\":\"1\"}],\"post\":true}" & done > $TMP/par.txt; wait
expect "из 20 одновременных списаний прошло ровно 10" 10 $(grep -c 201 $TMP/par.txt)
expect "остаток B = 0, не в минусе" 0 $(stock "" $W1 $B)

echo "2.2 Складские операции"
newdoc "{\"type\":\"initial_stock\",\"warehouseId\":\"$W1\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"6\",\"price\":\"210\",\"place\":\"a-3\"}],\"post\":true}"
get "/stock?warehouseId=$W1"; expect "место из строки запомнено" A-3 "$(echo $BODY | jq -r "[.items[]|select(.productId==\"$B\")][0].warehouses[0].place")"
get "/stock/places/suggest?warehouseId=$W1&q=a"; expect "подсказка мест" A-3 "$(echo $BODY | jq -r '.[0].place')"
newdoc "{\"type\":\"surplus\",\"warehouseId\":\"$W1\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"1\"}],\"post\":true}"
expect "оприходование без цены — по средней 210" 210 $(echo $BODY | jq -r '.lines[0].costAmount|tonumber|round')
BEFORE=$(python3 -c "print($(cost $W1 $A)+$(cost $W1 $B))")
newdoc "{\"type\":\"resort\",\"warehouseId\":\"$W1\",\"lines\":[{\"productId\":\"$A\",\"productToId\":\"$B\",\"qty\":\"2\"}],\"post\":true}"
expect "пересортица проведена" posted $(echo $BODY | jq -r .status)
AFTER=$(python3 -c "print($(cost $W1 $A)+$(cost $W1 $B))"); expect "пересортица не меняет денег" $BEFORE $AFTER
expect "A: 8 − 2 = 6" 6 $(stock "" $W1 $A)
newdoc "{\"type\":\"transfer\",\"warehouseId\":\"$W1\",\"warehouseToId\":\"$W2\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"3\"}],\"post\":true}"; TR=$DOC; TRV=$(echo $BODY | jq .version)
expect "в пути" in_transit "$(echo $BODY | jq -r .extra.transferState)"
expect "ушло со склада 1" 3 $(stock "" $W1 $A)
get "/stock?warehouseId=$W1"; expect "видно «в пути»" 3 $(echo $BODY | jq -r "[.items[]|select(.productId==\"$A\")][0].inTransit")
post /documents/$TR/accept "{\"version\":$TRV,\"lines\":[{\"lineId\":\"$(echo $BODY | jq -r .lines[0].id 2>/dev/null)\",\"qty\":\"2\"}]}" >/dev/null
get /documents/$TR; LID=$(echo $BODY | jq -r .lines[0].id); TRV=$(echo $BODY | jq .version)
post /documents/$TR/accept "{\"version\":$TRV,\"lines\":[{\"lineId\":\"$LID\",\"qty\":\"2\"}]}"
expect "принято с расхождением" received "$(echo $BODY | jq -r .extra.transferState)"
expect "акт расхождения создан" 1 $(echo $BODY | jq '[.links[]|select(.kind=="discrepancy")]|length')
expect "на склад 2 пришло 2" 2 $(stock "" $W2 $A)
post /documents/$TR/unpost "{\"version\":$(echo $BODY | jq .version)}"; expect "принятое перемещение не отменить" TRANSFER_RECEIVED $(echo $BODY | jq -r .code)
post /products/$D/merge '{"duplicateIds":[]}' >/dev/null
newdoc "{\"type\":\"initial_stock\",\"warehouseId\":\"$W1\",\"lines\":[{\"productId\":\"$D\",\"qty\":\"5\",\"price\":\"90\"}],\"post\":true}"
post /products/$A/merge "{\"duplicateIds\":[\"$D\"]}"; expect "дубль с остатком объединён" 200 $CODE
expect "остаток дубля перешёл: 3 + 5" 8 $(stock "" $W1 $A)
post /products/$NC/stock-control "{\"items\":[{\"warehouseId\":\"$W1\",\"qty\":\"7\",\"unitCost\":\"50\"}]}"; expect "учёт остатка включён вводом факта" 200 $CODE
expect "остаток появился" 7 $(stock "" $W1 $NC)
# Согласование списания
get /settings; patch /settings "{\"version\":$(echo $BODY | jq .version),\"writeoffApprovalAmount\":100}"
get /roles; KEEPER=$(echo $BODY | jq -r '.[]|select(.code=="storekeeper").id')
post /staff/invitations "{\"roleIds\":[\"$KEEPER\"],\"allStores\":true}"; IC=$(echo $BODY | jq -r .code)
req POST /auth/accept-invite "" "{\"code\":\"$IC\",\"login\":\"keeper${R}@x.kg\",\"password\":\"secret123\",\"name\":\"Кладовщик\"}"; TK=$(echo $BODY | jq -r .accessToken)
post /documents "{\"type\":\"writeoff\",\"warehouseId\":\"$W1\",\"extra\":{\"reason\":\"damage\"},\"lines\":[{\"productId\":\"$A\",\"qty\":\"2\"}],\"post\":true}" "$TK"
expect "кладовщик: дорогое списание — на согласование" awaiting_approval $(echo $BODY | jq -r .status); WA=$(echo $BODY | jq -r .id); WAV=$(echo $BODY | jq .version)
post /documents/$WA/approve "{\"version\":$WAV}" "$TK"; expect "кладовщик сам не согласует" 403 $CODE
post /documents/$WA/approve "{\"version\":$WAV}"; expect "владелец согласовал — проведено" posted $(echo $BODY | jq -r .status)
post /documents "{\"type\":\"resort\",\"warehouseId\":\"$W1\",\"lines\":[{\"productId\":\"$A\",\"productToId\":\"$B\",\"qty\":\"1\"}]}" "$TK"; expect "кладовщик: пересортица" 201 $CODE
get /settings; patch /settings "{\"version\":$(echo $BODY | jq .version),\"writeoffApprovalAmount\":0}"

echo "2.3 Приёмка: валюта, доп. расходы, серийные, «ожидает цен», этикетки"
newdoc "{\"type\":\"receiving\",\"warehouseId\":\"$W1\",\"counterpartyId\":\"$SUP\",\"currency\":\"USD\",\"rate\":\"87.5\",\"extra\":{\"extraCosts\":[{\"name\":\"Доставка\",\"amount\":\"100\"}]},\"lines\":[{\"productId\":\"$N\",\"qty\":\"2\",\"price\":\"1\"},{\"productId\":\"$B\",\"qty\":\"1\",\"price\":\"2\"}],\"post\":true}"
expect "себестоимость в сомах с курсом и долей доставки: N = (87.5 + 25)" 112.5 $(echo $BODY | jq -r "[.lines[]|select(.productId==\"$N\")][0].unitCost|tonumber+0")
post /files '{}' >/dev/null
printf '\xff\xd8\xff\xe00000000000000000' > $TMP/ph.jpg
FID=$(curl -s -X POST $API/files -H "Authorization: Bearer $T" -F "file=@$TMP/ph.jpg;type=image/jpeg" -F purpose=product_photo | jq -r .id)
newdoc "{\"type\":\"receiving\",\"warehouseId\":\"$W1\",\"counterpartyId\":\"$SUP\",\"lines\":[{\"productId\":\"$S\",\"qty\":\"2\",\"price\":\"5000\",\"serials\":[{\"serialNumber\":\"AKB-1\",\"condition\":\"новый\",\"photoFileIds\":[\"$FID\"]},{\"serialNumber\":\"AKB-2\"}]}],\"post\":true}"
expect "серийная приёмка" posted $(echo $BODY | jq -r .status)
get "/products/$S/serials?status=in_stock"; expect "2 экземпляра на складе" 2 $(echo $BODY | jq length); SER1=$(echo $BODY | jq -r '[.[]|select(.serialNumber=="AKB-1")][0].id')
post /documents "{\"type\":\"writeoff\",\"warehouseId\":\"$W1\",\"extra\":{\"reason\":\"defect\"},\"lines\":[{\"productId\":\"$S\",\"qty\":\"1\"}],\"post\":true}"
expect "серийный расход без экземпляра — запрет" SERIAL_NOT_AVAILABLE $(echo $BODY | jq -r .code)
post /documents "{\"type\":\"writeoff\",\"warehouseId\":\"$W1\",\"extra\":{\"reason\":\"defect\"},\"lines\":[{\"productId\":\"$S\",\"qty\":\"1\",\"serialItemIds\":[\"$SER1\"]}],\"post\":true}"
expect "списан выбранный экземпляр" posted $(echo $BODY | jq -r .status)
post /documents "{\"type\":\"writeoff\",\"warehouseId\":\"$W1\",\"extra\":{\"reason\":\"defect\"},\"lines\":[{\"productId\":\"$S\",\"qty\":\"1\",\"serialItemIds\":[\"$SER1\"]}],\"post\":true}"
expect "тот же экземпляр второй раз — запрет" SERIAL_NOT_AVAILABLE $(echo $BODY | jq -r .code)
newdoc "{\"type\":\"receiving\",\"warehouseId\":\"$W1\",\"counterpartyId\":\"$SUP\",\"lines\":[{\"productId\":\"$N\",\"qty\":\"10\"}],\"post\":true}"; RP=$DOC
expect "приёмка без цен («ожидает цен») проведена" true $(echo $BODY | jq .extra.pricesPending)
patch /documents/$RP "{\"version\":$(echo $BODY | jq .version),\"lines\":[{\"productId\":\"$N\",\"qty\":\"10\",\"price\":\"130\"}]}"
expect "цены введены — себестоимость досчитана" 130 $(echo $BODY | jq -r '.lines[0].unitCost|tonumber+0')
expect "флаг «ожидает цен» снят" false $(echo $BODY | jq .extra.pricesPending)
C=$(curl -s -o $TMP/l.pdf -w "%{http_code}" "$API/documents/$R1/labels.pdf?mode=all" -H "Authorization: Bearer $T"); expect "этикетки PDF" 200 $C
expect "это PDF" "%PDF" "$(head -c 4 $TMP/l.pdf)"
get /products/$A; expect "товару без штрихкода выдан внутренний EAN-13" 25 "$(echo $BODY | jq -r '.units[0].barcodes[0].barcode' | cut -c1-2)"
C=$(curl -s -o $TMP/l2.pdf -w "%{http_code}" -X POST "$API/products/labels.pdf" -H "$J" -H "Authorization: Bearer $T" -d "{\"items\":[{\"productId\":\"$B\",\"copies\":3}]}"); expect "этикетки на выбранные товары" 200 $C

echo "2.4 Инвентаризация"
BC=$(echo $BODY | jq -r '.units[0].barcodes[0].barcode' 2>/dev/null); get /products/$A; BC=$(echo $BODY | jq -r '.units[0].barcodes[0].barcode')
BOOK=$(stock "" $W1 $A)
post /inventories "{\"warehouseId\":\"$W1\",\"productIds\":[\"$A\",\"$B\"]}"; INV=$(echo $BODY | jq -r .id); SH=$(echo $BODY | jq -r .sheets[0].id); expect "инвентаризация начата" 201 $CODE
for i in 1 2 3; do post /inventories/$INV/counts "{\"sheetId\":\"$SH\",\"barcode\":\"$BC\",\"qty\":\"1\"}" >/dev/null; done
post /inventories/$INV/sheets '{"name":"Подсобка"}'; SH2=$(echo $BODY | jq -r .id)
post /inventories/$INV/counts "{\"sheetId\":\"$SH2\",\"productId\":\"$A\",\"qty\":\"2\",\"mode\":\"set\"}"; expect "листы суммируются: 3 + 2" 5 $(echo $BODY | jq -r .counted)
# продажа (списание) после скана — не должна исказить расхождение
newdoc "{\"type\":\"writeoff\",\"warehouseId\":\"$W1\",\"extra\":{\"reason\":\"other\"},\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"}],\"post\":true}"
get /inventories/$INV; expect "учётное — на время скана" $BOOK $(echo $BODY | jq -r "[.rows[]|select(.productId==\"$A\")][0].book")
EXPECTED_SHORT=$((BOOK-5))
INVV=$(echo $BODY | jq .version)
post /inventories/$INV/finish "{\"version\":$INVV}"; expect "инвентаризация завершена" posted $(echo $BODY | jq -r .status)
WID=$(echo $BODY | jq -r .result.writeoffDocumentId); get /documents/$WID
expect "недостача A = учёт − факт" $EXPECTED_SHORT $(echo $BODY | jq -r "[.lines[]|select(.productId==\"$A\")][0].qty|tonumber+0")
expect "после продажи и недостачи остаток = 5 − 1" 4 $(stock "" $W1 $A)

echo "2.5 Остатки на дату, обороты, закрытие периода"
newdoc "{\"type\":\"initial_stock\",\"warehouseId\":\"$W1\",\"docDate\":\"2026-09-10T10:00:00+06:00\",\"lines\":[{\"productId\":\"$N\",\"qty\":\"3\",\"price\":\"100\"}],\"post\":true}"
expect "документ сентябрём" posted $(echo $BODY | jq -r .status)
wait_recalc >/dev/null
get "/stock/at-date?date=2026-09-30T23:00:00%2B06:00&warehouseId=$W1"; expect "остаток на 30.09: только сентябрьский приход" 3 $(echo $BODY | jq -r "[.items[]|select(.productId==\"$N\")][0].qty")
get "/stock/turnover?from=2026-10-01T00:00:00%2B06:00&to=2026-11-01T00:00:00%2B06:00&warehouseId=$W1"; expect "обороты: начало октября N = 3" 3 $(echo $BODY | jq -r "[.items[]|select(.productId==\"$N\")][0].openQty")
get "/products/$A/movements"; expect "движения товара с остатком" true $(echo $BODY | jq 'length >= 5')
get /periods; expect "к закрытию предложен сентябрь" 2026-09 $(echo $BODY | jq -r .nextToClose)
post /periods/close '{"month":"2026-10"}'; expect "текущий месяц не закрыть" MONTH_NOT_OVER $(echo $BODY | jq -r .code)
post /periods/close '{"month":"2026-09"}'; expect "сентябрь закрыт" 2026-09 $(echo $BODY | jq -r .month)
post /documents "{\"type\":\"initial_stock\",\"warehouseId\":\"$W1\",\"docDate\":\"2026-09-20T10:00:00+06:00\",\"lines\":[{\"productId\":\"$N\",\"qty\":\"1\",\"price\":\"1\"}]}"
expect "документ в закрытом периоде — запрет" PERIOD_CLOSED $(echo $BODY | jq -r .code)
get "/stock/at-date?date=2026-10-31T23:00:00%2B06:00&warehouseId=$W1"; expect "остаток на дату — от снимка" true "$(echo $BODY | jq '.fromSnapshot != null')"
post /periods/reopen '{"month":"2026-09","reason":"проверка"}' "$TK"; expect "кладовщик не открывает период" 403 $CODE
post /periods/reopen '{"month":"2026-09","reason":"Нашли накладную"}'; expect "владелец открыл с причиной" reopened $(echo $BODY | jq -r .status)
get "/audit?action=period.reopen"; expect "открытие — в журнале" 1 $(echo $BODY | jq .total)
psql "$OWNER_DB" -q >/dev/null <<SQL
BEGIN;
SELECT set_config('app.tenant_id','$TENANT',true);
UPDATE stock_balances SET qty = qty + 7 WHERE product_id = '$A' AND warehouse_id = '$W1';
COMMIT;
SQL
get /stock/reconcile; expect "ночная сверка находит расхождение" false $(echo $BODY | jq .ok)
post /stock/rebuild '{}'; expect "«Пересчитать остатки»" true $(echo $BODY | jq '.fixed >= 1')
get /stock/reconcile; expect "после пересчёта — сходится" true $(echo $BODY | jq .ok)

echo "Права и изоляция"
req POST /auth/register "" "{\"name\":\"Чужой\",\"login\":\"oth${R}@x.kg\",\"password\":\"secret123\",\"shopName\":\"Чужой\"}"; T2=$(echo $BODY | jq -r .accessToken)
get /documents/$R1 "$T2"; expect "чужой документ — 404" 404 $CODE
get "/stock" "$T2"; expect "чужие остатки не видны" 0 $(echo $BODY | jq .total)
get "/stock/reconcile"; expect "итоговая сверка магазина" true $(echo $BODY | jq .ok)

echo; echo "Итог: ✔ $pass  ✘ $fail"
