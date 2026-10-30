#!/usr/bin/env bash
# Смоук-проверка этапа 4 (прайсы поставщиков, заказы и автозаказ, полная приёмка, заявки клиентов, лист ожидания).
#   bash scripts/smoke/stage4.sh      (из папки backend, API запущен; только dev-база; в .env PRICELIST_ALLOW_PRIVATE_URLS=true)
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
get(){ req GET "$1" "${2:-$T}"; }
post(){ req POST "$1" "${3:-$T}" "$2"; }
patch(){ req PATCH "$1" "${3:-$T}" "$2"; }
put(){ req PUT "$1" "${3:-$T}" "$2"; }
j(){ echo "$BODY" | jq -r "$1"; }
jc(){ echo "$BODY" | jq -c "$1"; }
n(){ python3 -c "import sys;print(f'{float(sys.argv[1]):.2f}')" "$1"; }
R=$(printf "%05d" $((RANDOM)))
KEY(){ echo "k$(date +%s%N)$RANDOM"; }
upload(){ curl -s -X POST $API/files -H "Authorization: Bearer $T" -F "file=@$1;type=text/csv" -F purpose=import | jq -r .id; }
wait_list(){ for i in $(seq 1 40); do get /price-lists/$1; [ "$(j .status)" != "loading" ] && return 0; sleep 0.5; done; return 1; }

echo "0. Подготовка"
req POST /auth/register "" "{\"name\":\"Закупщик\",\"login\":\"buy${R}@x.kg\",\"password\":\"secret123\",\"shopName\":\"Закупки ${R}\"}"; T=$(j .accessToken)
post /onboarding/complete '{"shopType":"city","shopRateUsd":"87.40"}' >/dev/null
get /registers; REG=$(j '.[0].id'); STORE=$(j '.[0].storeId')
get /warehouses; WH=$(j '[.[]|select(.type=="sales_floor")][0].id'); DEFECT=$(j '[.[]|select(.type=="defect")][0].id')
get /price-types; RETAIL=$(j '.[]|select(.code=="retail").id')
post /counterparties '{"name":"Автомир опт","roles":["supplier"],"phone":"0700111222","supplierTerms":{"leadTimeDays":5,"paymentDelayDays":14}}'; S1=$(j .id)
post /counterparties '{"name":"Карго Экспресс","roles":["supplier"]}'; CARGO=$(j .id)
post /counterparties '{"name":"Сосед Бакыт","roles":["neighbor"]}'; NB=$(j .id)
mk(){ post /products "$1"; echo $BODY | jq -r .id; }
price(){ put /products/$1/prices "{\"items\":[{\"priceTypeId\":\"$RETAIL\",\"price\":\"$2\"}]}" >/dev/null; }
A=$(mk '{"name":"Колодки передние","brand":"Toyota","number":"04465-33450"}'); price $A 3500
B=$(mk '{"name":"Фильтр воздушный","brand":"Mann","number":"C 30 005"}'); price $B 900
C=$(mk '{"name":"Лампа H4","brand":"Osram","number":"64193"}'); price $C 300
post /documents "{\"type\":\"initial_stock\",\"warehouseId\":\"$WH\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"2\",\"price\":\"2500\"},{\"productId\":\"$C\",\"qty\":\"10\",\"price\":\"150\"}],\"post\":true}" >/dev/null
post /shifts/open "{\"registerId\":\"$REG\",\"cash\":{\"KGS\":\"20000\"}}"; SHIFT=$(j .id)
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"3500\"}]}"; expect "продали 1 колодки" completed "$(j .status)"

echo "4.1 Прайсы поставщиков"
cat > $TMP/p1.csv <<CSV
Бренд;Номер;Наименование;Цена;Остаток;Срок;Кратность;OEM;Применимость
Toyota;04465-33450;Колодки передние оригинал;2800;>10;3;1;;Camry 40
Akebono;AN-761WK;Колодки передние Akebono;1500;5;2;2;04465-33450, 04465-06090;Camry 40; Camry 50
Mann;C 30 005;Фильтр воздушный;600;есть;1;;;
Bosch;0 986 452 041;Фильтр масляный;450;0;7;;;
CSV
post /price-lists "{\"supplierId\":\"$S1\",\"name\":\"Автомир основной\"}"; PL=$(j .id); expect "прайс создан" empty "$(j .status)"
F1=$(upload $TMP/p1.csv)
post /price-lists/$PL/preview "{\"fileId\":\"$F1\"}"; expect "колонки угаданы: номер" 1 "$(j .mapping.number)"; expect "цена" 3 "$(j .mapping.price)"; expect "OEM" 7 "$(j .mapping.oem)"
post /price-lists/$PL/load "{\"fileId\":\"$F1\",\"mapping\":$(jc .mapping)}"; expect "загрузка в фоне" queued "$(j .status)"
wait_list $PL; expect "прайс загружен" ready "$(j .status)"; expect "4 строки" 4 "$(j .rowsCount)"
expect "история загрузок" 4 "$(j '.loads[0].rows')"; expect "кроссы из OEM добавлены" true "$(j '.loads[0].crossesAdded >= 2')"
get "/price-lists/search?q=an761wk"; expect "номер, которого нет в каталоге, — в прайсе" "Автомир опт" "$(j '.[0].supplierName')"
expect "с ценой" 1500.00 "$(n $(j '.[0].price'))"; expect "и сроком" 2 "$(j '.[0].leadDays')"
get "/search?q=AN-761WK"; expect "единый поиск: группа «У поставщиков»" true "$(j '.groups.suppliers|length >= 1')"; expect "кнопка «создать из прайса»" true "$(j '.actions|index("create_from_pricelist") != null')"
get "/search?q=04465-33450"; expect "по номеру из каталога — и аналог из прайса" true "$(j '[.groups.suppliers[]|select(.number=="AN-761WK")]|length == 1')"
expect "строка прайса связана с товаром каталога" $A "$(j '[.groups.suppliers[]|select(.number=="04465-33450")][0].productId')"
cat > $TMP/p2.csv <<CSV
Бренд;Номер;Наименование;Цена;Остаток;Срок;Кратность;OEM;Применимость
Toyota;04465-33450;Колодки передние оригинал;2950;>10;3;1;;Camry 40
Akebono;AN-761WK;Колодки передние Akebono;1500;5;2;2;04465-33450;Camry 40
Mann;C 30 005;Фильтр воздушный;600;есть;1;;;
CSV
F2=$(upload $TMP/p2.csv); post /price-lists/$PL/load "{\"fileId\":\"$F2\"}" >/dev/null; wait_list $PL
expect "повторная загрузка: изменение цены записано" 1 "$(j '.loads[0].priceChanges')"; expect "пропавшая строка удалена" 1 "$(j '.loads[0].removed')"
get "/price-lists/$PL/rows?q=04465"; ROWA=$(j '.items[0].id'); get /price-list-rows/$ROWA/history; expect "история цены: 2800 → 2950" 2950.000000 "$(j '.[0].newPrice')"
mkdir -p $TMP/www && cp $TMP/p1.csv $TMP/www/price.csv && (cd $TMP/www && python3 -m http.server 8765 >/dev/null 2>&1 & echo $! > $TMP/http.pid); sleep 1
get /price-lists/$PL; patch /price-lists/$PL "{\"version\":$(j .version),\"url\":\"http://127.0.0.1:8765/price.csv\",\"schedule\":\"daily\"}"; expect "ссылка и расписание" daily "$(j .schedule)"
post /price-lists/$PL/load '{}'; wait_list $PL; expect "загрузка по ссылке" url "$(j '.loads[0].source')"; expect "по ссылке — 4 строки" 4 "$(j .rowsCount)"; [ "$(j .rowsCount)" != 4 ] && echo "$(jc '.loads[0]') $(j .lastError)"
kill $(cat $TMP/http.pid) 2>/dev/null
get "/price-lists/$PL/rows?q=AN761"; ROWB=$(j '.items[0].id')
post /price-list-rows/$ROWB/create-product '{"retailPrice":"2500"}'; AK=$(j .id); expect "товар из строки прайса" true "$(j '.id|length == 36')"
get /products/$AK; expect "с OEM-номерами из строки" true "$(j '[.numbers[]?|select(.type=="oem")]|length >= 1')"
get "/price-lists/search?q=AN761WK"; expect "строка теперь связана с товаром" $AK "$(j '.[0].productId')"
get /roles; SELLER_ROLE=$(j '.[]|select(.code=="seller").id')
post /staff/invitations "{\"name\":\"Айбек\",\"roleIds\":[\"$SELLER_ROLE\"],\"allStores\":true}"; IC=$(j .code)
req POST /auth/accept-invite "" "{\"code\":\"$IC\",\"login\":\"sel${R}@x.kg\",\"password\":\"secret123\",\"name\":\"Айбек\"}"; TS=$(j .accessToken)
get "/price-lists/search?q=AN761WK" "$TS"; expect "продавец видит наличие и срок" 2 "$(j '.[0].leadDays')"; expect "но не закупочную цену" null "$(j '.[0].price')"

echo "4.2 Заказы и автозаказ"
put /products/$A/suppliers "{\"items\":[{\"supplierId\":\"$S1\",\"supplierCode\":\"AM-0446\",\"multiplicity\":\"4\",\"leadDays\":5,\"preferred\":true}]}"; expect "поставщик товара" AM-0446 "$(j '.[0].supplierCode')"
get "/search?q=AM-0446"; expect "товар ищется по коду поставщика" $A "$(j '.groups.here[0].id // .groups.elsewhere[0].id // .groups.noStock[0].id')"
put /products/$A/stock-rules "{\"rules\":[{\"storeId\":\"$STORE\",\"minQty\":\"5\",\"maxQty\":\"20\"}]}"; expect "мин./макс." 5 "$(j '.[0].minQty|tonumber')"
put /products/$B/stock-rules "{\"rules\":[{\"summerMin\":\"2\",\"summerMax\":\"6\",\"winterMin\":\"10\",\"winterMax\":\"30\",\"supplierId\":\"$S1\"}]}" >/dev/null
post /auto-order/preview "{\"storeId\":\"$STORE\"}"; expect "автозаказ: 2 товара" 2 "$(j '.lines|length')"
expect "колодки: до макс. 20 − (1 на складе) = 19 → кратность 4 → 20" 20 "$(j ".lines[]|select(.productId==\"$A\").qty")"
expect "сезонность: октябрь — зимние мин./макс. (30 − 0)" 30 "$(j ".lines[]|select(.productId==\"$B\").qty")"
expect "сгруппировано по поставщикам" 1 "$(j '.groups|length')"
post /auto-order/create "{\"storeId\":\"$STORE\",\"lines\":$(jc '[.lines[]|{productId,supplierId,qty,price,unitId,explain}]')}"; PO=$(j '.[0].id')
expect "черновик заказа из автозаказа" draft "$(j '.[0].status')"; expect "источник — автозаказ" auto "$(j '.[0].source')"
[[ "$(j '.[0].number')" =~ ^ЗП-Т1-2026-[0-9]{6}$ ]] && ok "номер $(j '.[0].number')" || bad "номер"
get /purchase-orders/$PO; LA=$(j ".lines[]|select(.productId==\"$A\").id"); LB=$(j ".lines[]|select(.productId==\"$B\").id")
patch /purchase-orders/$PO "{\"version\":$(j .version),\"lines\":[{\"productId\":\"$A\",\"qty\":\"20\",\"price\":\"2800\"},{\"productId\":\"$B\",\"qty\":\"30\",\"price\":\"600\"}]}"
expect "цены в заказе" 74000.00 "$(n $(j .totalAmount))"
post /purchase-orders/$PO/status "{\"version\":$(j .version),\"status\":\"sent\"}"; expect "отправлен" sent "$(j .status)"
get /purchase-orders/$PO/message; expect "текст для WhatsApp с кодом поставщика" true "$(j '.text|test("AM-0446")')"; expect "ссылка wa.me" true "$(j '.whatsappUrl|startswith("https://wa.me/996700111222")')"
C1=$(curl -s -o $TMP/o.pdf -w "%{http_code}" "$API/purchase-orders/$PO/pdf" -H "Authorization: Bearer $T"); expect "PDF заказа" "%PDF" "$(head -c 4 $TMP/o.pdf)"
C2=$(curl -s -o $TMP/o.xlsx -w "%{http_code}" "$API/purchase-orders/$PO/xlsx" -H "Authorization: Bearer $T"); expect "Excel заказа" "PK" "$(head -c 2 $TMP/o.xlsx)"
get "/purchase-orders/expected?productIds=$A"; expect "ожидается 20" 20 "$(j ".\"$A\"|tonumber")"
post /auto-order/preview "{\"storeId\":\"$STORE\"}"; expect "ожидаемое учтено — повторно не предлагается" 0 "$(j "[.lines[]|select(.productId==\"$A\")]|length")"

echo "4.3 Приёмка — полная"
post /purchase-orders/$PO/receiving '{}'; RC1=$(j .id); expect "черновик приёмки по заказу" draft "$(j .status)"
expect "ожидалось 20" 20 "$(j ".lines[]|select(.productId==\"$A\").extra.expectedQty")"
LINES=$(jc "[.lines[]|{productId,unitId,qty:(if .productId==\"$A\" then \"12\" else .qty end),price,orderLineId:.extra.orderLineId,expectedQty:.extra.expectedQty,orderPrice:.extra.orderPrice}]")
LINES=$(echo $LINES | jq -c "map(if .productId==\"$A\" then .price=\"2900\" else . end)")
patch /documents/$RC1 "{\"version\":$(j .version),\"lines\":$LINES,\"extra\":{\"supplierInvoiceNumber\":\"АМ-777\"}}"
post /documents/$RC1/post "{\"version\":$(j .version)}"; expect "пришло меньше — приёмка на факт" posted "$(j .status)"
get /purchase-orders/$PO; expect "заказ «частично принят»" partially_received "$(j .status)"; expect "принято 12 из 20" 12.00 "$(n $(j ".lines[]|select(.productId==\"$A\").receivedQty"))"
expect "цена в накладной другая — подсветка" true "$(j '.receivings[0].priceDiffs|length == 1')"
get /products/$A/purchase-history; expect "история закупочных цен: 2900 при заказе 2800" 2800 "$(j '.[0].orderPrice|tonumber')"
get "/counterparties/$S1/debts?direction=payable"; expect "долг поставщику по приёмке: 12×2900 + 30×600" 52800.00 "$(n $(j '.[0].remaining'))"
expect "срок оплаты — отсрочка поставщика" true "$(j '.[0].dueDate != null')"
post /purchase-orders/$PO/receiving '{}'; RC2=$(j .id)
LINES=$(jc "[.lines[]|{productId,unitId,qty:\"10\",price,orderLineId:.extra.orderLineId,expectedQty:.extra.expectedQty}]")
patch /documents/$RC2 "{\"version\":$(j .version),\"lines\":$LINES}"; V=$(j .version)
post /documents/$RC2/post "{\"version\":$V}"; expect "пришло больше — предупреждение" OVER_RECEIVED "$(j .code)"; expect "излишек 2" 2 "$(j '.details[0].excess')"
get /documents/$RC2; patch /documents/$RC2 "{\"version\":$(j .version),\"extra\":{\"overMode\":\"by_order\"}}"; post /documents/$RC2/post "{\"version\":$(j .version)}"
expect "по заказу — принято 8" 8.00 "$(n $(j '.lines[0].qty'))"; expect "излишек — в акт расхождения" 2.00 "$(n $(j '.extra.discrepancies[0].excess'))"
get /purchase-orders/$PO; expect "заказ «принят»" received "$(j .status)"
post /purchase-orders "{\"supplierId\":\"$S1\",\"lines\":[{\"productId\":\"$C\",\"qty\":\"5\",\"price\":\"100\"}]}"; PO2=$(j .id)
post /purchase-orders/$PO2/status "{\"version\":$(j .version),\"status\":\"confirmed\"}" >/dev/null
post /purchase-orders/$PO2/receiving '{}'; RC3=$(j .id)
LINES=$(jc "[.lines[]|{productId,unitId,qty:\"4\",price,orderLineId:.extra.orderLineId,expectedQty:.extra.expectedQty}] + [{productId:\"$C\",qty:\"1\",price:\"100\",orderLineId:.lines[0].extra.orderLineId,defect:true,defectAction:\"return\"},{productId:\"$B\",qty:\"2\",price:\"600\"}]")
patch /documents/$RC3 "{\"version\":$(j .version),\"lines\":$LINES}"; post /documents/$RC3/post "{\"version\":$(j .version)}"
expect "пришло не то — строка «не заказана»" NOT_ORDERED "$(j .code)"
get /documents/$RC3; LINES=$(jc "[.lines[]|{productId,unitId,qty,price,orderLineId:.extra.orderLineId,expectedQty:.extra.expectedQty,defect:.extra.defect,defectAction:.extra.defectAction,notOrderedAction:(if .productId==\"$B\" then \"accept_return\" else null end)}|with_entries(select(.value != null))]")
patch /documents/$RC3 "{\"version\":$(j .version),\"lines\":$LINES}"; post /documents/$RC3/post "{\"version\":$(j .version)}"
expect "принять и вернуть: приёмка проведена" posted "$(j .status)"; RET=$(j .extra.autoReturnId); expect "черновик возврата поставщику создан" true "$(j '.extra.autoReturnId != null')"
get "/stock?warehouseId=$DEFECT"; expect "брак — на склад «Брак»" 1 "$(j ".items[]|select(.productId==\"$C\").qty")"
get /documents/$RET; expect "в возврате: брак со склада «Брак» и незаказанное" 2 "$(j '.lines|length')"
get "/counterparties/$S1/debts?direction=payable"; DEBT0=$(j '[.[].remaining|tonumber]|add')
post /documents/$RET/post "{\"version\":$(get /documents/$RET; j .version)}"; expect "возврат поставщику проведён" posted "$(j .status)"
get "/counterparties/$S1/debts?direction=payable"; expect "возврат уменьшил долг поставщику на 1×100 + 2×600" "$(python3 -c "print(f'{$DEBT0-1300:.2f}')")" "$(n $(j '[.[].remaining|tonumber]|add'))"
get "/stock?warehouseId=$WH"; QB=$(j ".items[]|select(.productId==\"$B\").qty"); expect "незаказанное вернули — B: 30 + 8×0" 30 "$QB"
post /documents "{\"type\":\"receiving\",\"warehouseId\":\"$WH\",\"counterpartyId\":\"$S1\",\"currency\":\"USD\",\"rate\":\"87.50\",\"lines\":[{\"productId\":\"$C\",\"qty\":\"10\",\"price\":\"2\"}],\"post\":true}"; RCU=$(j .id)
get "/counterparties/$S1/debts"; expect "долг поставщику в валюте документа" 20.00 "$(n $(j "[.[]|select(.currency==\"USD\")][0].remaining"))"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$C\",\"qty\":\"5\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"1500\"}]}" >/dev/null
get "/stock?warehouseId=$WH"; AMT0=$(j ".items[]|select(.productId==\"$C\").amount")
post /receivings/$RCU/extra-costs "{\"amount\":\"350\",\"method\":\"qty\",\"counterpartyId\":\"$CARGO\",\"name\":\"Доставка\"}"
expect "доп. расходы через неделю — документ на основании приёмки" extra_costs "$(j .type)"; expect "распределено на строку" 350.00 "$(n $(j '.lines[0].amount'))"
for i in $(seq 1 30); do get /stock; [ "$(j .costRecalcPending)" == "false" ] && break; sleep 1; done
get "/stock?warehouseId=$WH"; AMT1=$(j ".items[]|select(.productId==\"$C\").amount")
expect "себестоимость остатка выросла (часть расходов — на проданное)" true "$(python3 -c "print(str($AMT1 > $AMT0).lower())")"
get "/counterparties/$CARGO/debts?direction=payable"; expect "долг перевозчику" 350.00 "$(n $(j '.[0].remaining'))"
post /debts/payments "{\"counterpartyId\":\"$S1\",\"direction\":\"out\",\"amount\":\"20\",\"currency\":\"USD\",\"accountId\":\"$(get /money/accounts; j '[.[]|select(.type=="cash" and .currency=="KGS")][0].id')\",\"shiftId\":\"$SHIFT\"}"
expect "оплата долга в $ сомами по курсу" 1748.00 "$(n $(j .payment.accountAmount))"
get /stock/reconcile; expect "остатки сходятся" true "$(j .ok)"

echo "4.4 Заявки клиентов"
post /requests "{\"kind\":\"order\",\"customerName\":\"Нурлан\",\"customerPhone\":\"0555404040\",\"vehicleText\":\"Camry 40\",\"items\":[{\"number\":\"AN-761WK\",\"name\":\"Колодки передние\"}]}"; RQ=$(j .id); RQV=$(j .version); IT=$(j '.items[0].id')
expect "заявка создана" new "$(j .status)"; expect "клиент создан по телефону" true "$(j '.customerId != null')"
[[ "$(j .number)" =~ ^ЗК-Т1-[0-9]{5}$ ]] && ok "номер $(j .number)" || bad "номер $(j .number)"
get /requests/$RQ/suggest; expect "подбор: найдено в прайсе" true "$(j '.[0].suppliers|length >= 1')"
post /requests/$RQ/offer "{\"version\":$RQV,\"itemId\":\"$IT\",\"offers\":[{\"productId\":\"$AK\",\"name\":\"Akebono\",\"qualityClass\":\"aftermarket\",\"price\":\"2500\",\"supplierId\":\"$S1\",\"purchasePrice\":\"1500\",\"leadDays\":2},{\"productId\":\"$A\",\"name\":\"Toyota оригинал\",\"qualityClass\":\"original\",\"price\":\"3500\"}]}"
expect "предложено клиенту" offered "$(j .status)"; OF=$(j '.items[0].offers[0].id')
post /requests/$RQ/choose "{\"version\":$(j .version),\"itemId\":\"$IT\",\"offerId\":\"$OF\"}"; expect "выбран вариант Akebono" $AK "$(j '.items[0].productId')"
post /requests/$RQ/prepay "{\"version\":$(j .version),\"amount\":\"1000\",\"method\":\"cash\",\"registerId\":\"$REG\"}"; expect "предоплата 1000" 1000.00 "$(n $(j .prepaid))"
post /requests/$RQ/order "{\"version\":$(j .version),\"sourceKind\":\"supplier\",\"sourceId\":\"$S1\",\"purchasePrice\":\"1500\"}"; expect "заказано у поставщика" ordered "$(j .status)"
PO3=$(get /purchase-orders?status=draft; j "[.items[]|select(.source==\"request\")][0].id"); expect "черновик заказа поставщику из заявки" true "$(echo $PO3 | grep -q - && echo true || echo false)"
get /purchase-orders/$PO3; post /purchase-orders/$PO3/status "{\"version\":$(j .version),\"status\":\"sent\"}" >/dev/null
post /purchase-orders/$PO3/receiving '{}'; post /documents/$(j .id)/post "{\"version\":$(j .version)}"; expect "приёмка по заказу из заявки" posted "$(j .status)"
get /requests/$RQ; expect "заявка — «привезли» сама" arrived "$(j .status)"
get "/notifications?limit=50"; expect "уведомление «деталь пришла»" true "$(j '[.items[]?|select(.type=="request.arrived")]|length >= 1')"
get /requests/$RQ/message; expect "текст «ваша деталь пришла»" true "$(j '.text|test("пришла")')"; expect "к оплате 1500" true "$(j '.text|test("1500")')"
post /requests/$RQ/issue "{\"version\":$(get /requests/$RQ; j .version),\"registerId\":\"$REG\",\"payments\":[{\"method\":\"cash\",\"amount\":\"1500\"}]}"
expect "выдано" issued "$(j .request.status)"; expect "предоплата засчитана в чеке" 1000.00 "$(n $(j '.receipt.payments[]|select(.method=="advance").amountKgs'))"
expect "чек оплачен" completed "$(j .receipt.status)"
CUSTN=$(get /requests/$RQ; j .customerId); get /counterparties/$CUSTN/card; expect "у клиента не осталось предоплаты" 0 "$(j '[.debts[]|select(.direction=="payable")]|length')"
post /requests "{\"kind\":\"select\",\"customerId\":\"$CUSTN\",\"dueAt\":\"2026-10-01T10:00:00Z\",\"items\":[{\"name\":\"Фара левая Ipsum 2003\"}]}"; RQ2=$(j .id)
post /requests/$RQ2/prepay "{\"version\":$(j .version),\"amount\":\"500\",\"method\":\"cash\",\"registerId\":\"$REG\"}" >/dev/null
get "/requests?view=kanban"; expect "канбан: колонки статусов" 7 "$(j '.columns|length')"; expect "просроченная подсвечена" true "$(j "[.columns[].items[]|select(.id==\"$RQ2\")][0].overdue")"
post /requests/$RQ2/refuse "{\"version\":$(get /requests/$RQ2; j .version),\"reason\":\"Не нашли\"}"; expect "отказ с предоплатой — спросить, куда деньги" REFUND_REQUIRED "$(j .code)"
get /shifts/current?registerId=$REG; CASH0=$(j .cashBalance.KGS)
post /requests/$RQ2/refuse "{\"version\":$(get /requests/$RQ2; j .version),\"reason\":\"Не нашли\",\"refund\":\"money\",\"registerId\":\"$REG\"}"; expect "отказ" refused "$(j .status)"
get /shifts/current?registerId=$REG; expect "предоплата возвращена из кассы" "$(python3 -c "print(f'{$CASH0-500:.2f}')")" "$(j .cashBalance.KGS)"
get /search/unfound; expect "заявка без результата — в «Что спрашивают, но нет»" true "$(j '[.[]|select(.example=="Фара левая Ipsum 2003")]|length == 1')"
post /requests "{\"customerId\":\"$CUSTN\",\"items\":[{\"name\":\"Шрус наружный\",\"number\":\"GI-123\"}]}"; RQ3=$(j .id); IT3=$(j '.items[0].id')
post /requests/$RQ3/order "{\"version\":$(j .version),\"sourceKind\":\"neighbor\",\"sourceId\":\"$NB\",\"purchasePrice\":\"2200\"}"
patch /requests/$RQ3 "{\"version\":$(j .version),\"items\":[{\"id\":\"$IT3\",\"name\":\"Шрус наружный\",\"number\":\"GI-123\",\"salePrice\":\"3000\"}]}"
post /requests/$RQ3/issue "{\"version\":$(j .version),\"registerId\":\"$REG\",\"payments\":[{\"method\":\"cash\",\"amount\":\"3000\"}]}"
expect "от соседа: выдача — «взял у соседа» + продажа" issued "$(j .request.status)"
get "/counterparties/$NB/debts?direction=payable"; expect "долг перед соседом" 2200.00 "$(n $(j '.[0].remaining'))"

echo "18.4 Лист ожидания"
post /waitlist "{\"productId\":\"$B\",\"customerId\":\"$CUSTN\"}"; WL=$(j .id); expect "в листе ожидания" waiting "$(j .status)"
post /documents "{\"type\":\"receiving\",\"warehouseId\":\"$WH\",\"counterpartyId\":\"$S1\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"5\",\"price\":\"600\"}],\"post\":true}" >/dev/null
for i in $(seq 1 20); do get "/waitlist?productId=$B"; [ "$(j '.[0].status')" == "notified" ] && break; sleep 0.5; done
expect "товар пришёл — уведомили" notified "$(j '.[0].status')"
get "/notifications?limit=50"; expect "уведомление продавцу с текстом для клиента" true "$(j '[.items[]?|select(.type=="waitlist.arrived")][0].data.whatsappUrl|startswith("https://wa.me/")')"

echo "Права и изоляция"
post /purchase-orders "{\"supplierId\":\"$S1\"}" "$TS"; expect "продавцу заказы поставщикам нельзя" 403 $CODE
req POST /auth/register "" "{\"name\":\"Чужой\",\"login\":\"oth${R}@x.kg\",\"password\":\"secret123\",\"shopName\":\"Чужой\"}"; T2=$(j .accessToken)
get /purchase-orders/$PO "$T2"; expect "чужой заказ — 404" 404 $CODE
get "/price-lists/search?q=AN761WK" "$T2"; expect "чужие прайсы не видны" 0 "$(j length)"
get /requests/$RQ "$T2"; expect "чужая заявка — 404" 404 $CODE

echo; echo "Итог: ✔ $pass  ✘ $fail"
