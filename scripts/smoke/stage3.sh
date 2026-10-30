#!/usr/bin/env bash
# Смоук-проверка этапа 3 (цены и курс, клиенты и гараж, смены и деньги, касса, агент печати, возвраты, долги, соседи).
#   bash scripts/smoke/stage3.sh      (из папки backend, API запущен; только dev-база)
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
n(){ python3 -c "import sys;print(f'{float(sys.argv[1]):.2f}')" "$1"; }
R=$(printf "%05d" $((RANDOM)))
KEY(){ echo "k$(date +%s%N)$RANDOM"; }

echo "0. Подготовка"
req POST /auth/register "" "{\"name\":\"Бакыт Касса\",\"login\":\"pos${R}@x.kg\",\"password\":\"secret123\",\"shopName\":\"Касса ${R}\"}"; T=$(j .accessToken); TENANT=$(j .currentTenantId)
post /onboarding/complete '{"shopType":"city","shopRateUsd":"87.40","wallets":[{"provider":"MBank","holderName":"Бакыт","phone":"0555111222"}]}' >/dev/null
get /registers; REG=$(j '.[0].id'); STORE=$(j '.[0].storeId')
get /warehouses; WH=$(j '[.[]|select(.type=="sales_floor")][0].id'); DEFECT=$(j '[.[]|select(.type=="defect")][0].id')
get /price-types; RETAIL=$(j '.[]|select(.code=="retail").id'); STO_T=$(j '.[]|select(.code=="sto").id')
post /money/accounts '{"type":"acquiring","name":"Эквайринг Optima","details":{"commissionPercent":"2"}}' >/dev/null
get "/money/accounts"; ACQ=$(j '[.[]|select(.type=="acquiring")][0].id'); WALLET=$(j '[.[]|select(.type=="wallet")][0].id'); CASH_KGS=$(j "[.[]|select(.type==\"cash\" and .currency==\"KGS\")][0].id"); CASH_USD=$(j "[.[]|select(.type==\"cash\" and .currency==\"USD\")][0].id"); SAFE=$(j '[.[]|select(.type=="safe")][0].id')
mk(){ post /products "$1"; echo $BODY | jq -r .id; }
price(){ put /products/$1/prices "{\"items\":[{\"priceTypeId\":\"${3:-$RETAIL}\",\"price\":\"$2\"${4:+,\"currency\":\"$4\"}}]}" >/dev/null; }
A=$(mk '{"name":"Фильтр масляный","brand":"Bosch","number":"0986452041","minPrice":"500"}'); price $A 650
B=$(mk '{"name":"Свеча NGK","brand":"NGK","number":"BKR6E","units":[{"name":"упаковка","factor":"4"}]}'); price $B 180
C=$(mk '{"name":"Ступица","brand":"GMB","number":"GH-1"}')
S=$(mk '{"name":"АКБ 60","brand":"Varta","number":"S60","isSerial":true,"warrantyDays":365}'); price $S 6500
NP=$(mk '{"name":"Без цены","brand":"Febi","number":"NP-1"}')
K1=$(mk '{"name":"Масло 4л","brand":"Mobil","number":"M4"}'); price $K1 2400
K2=$(mk '{"name":"Прокладка пробки","brand":"Toyota","number":"90430"}'); price $K2 100
KIT=$(mk "{\"name\":\"Комплект ТО\",\"kind\":\"kit\",\"kitComponents\":[{\"productId\":\"$A\",\"qty\":\"1\"},{\"productId\":\"$K1\",\"qty\":\"1\"},{\"productId\":\"$K2\",\"qty\":\"1\"}]}"); price $KIT 3000
expect "комплект создан" kit "$(get /products/$KIT; j .kind)"
post /documents "{\"type\":\"initial_stock\",\"warehouseId\":\"$WH\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"50\",\"price\":\"400\"},{\"productId\":\"$B\",\"qty\":\"100\",\"price\":\"90\"},{\"productId\":\"$C\",\"qty\":\"10\",\"price\":\"1500\"},{\"productId\":\"$K1\",\"qty\":\"10\",\"price\":\"1800\"},{\"productId\":\"$K2\",\"qty\":\"10\",\"price\":\"30\"},{\"productId\":\"$NP\",\"qty\":\"5\",\"price\":\"100\"},{\"productId\":\"$S\",\"qty\":\"2\",\"price\":\"5000\",\"serials\":[{\"serialNumber\":\"V-001\"},{\"serialNumber\":\"V-002\"}]}],\"post\":true}"
expect "остатки введены" posted "$(j .status)"

echo "3.1 Цены и курс"
get /rates; expect "курс из мастера" 87.40 "$(n $(j '.current[0].rate'))"
post /price-types '{"name":"Опт в долларах","currency":"USD"}'; USD_T=$(j .id); expect "тип цены в USD" USD "$(j .currency)"
price $C 20 $USD_T USD
post /prices/quote "{\"storeId\":\"$STORE\",\"priceTypeId\":\"$USD_T\",\"items\":[{\"productId\":\"$C\"}]}"
expect "20 $ × 87.40 = 1748 сом" 1748.00 "$(j '.[0].price')"
post /rates/shop '{"rate":"88.10"}'; expect "новый курс" 88.10 "$(n $(j .rate))"
post /prices/quote "{\"storeId\":\"$STORE\",\"priceTypeId\":\"$USD_T\",\"items\":[{\"productId\":\"$C\"}]}"
expect "после смены курса — сразу по новому: 1762" 1762.00 "$(j '.[0].price')"
get /settings; patch /settings "{\"version\":$(j .version),\"priceRounding\":10,\"minPriceCipher\":\"ПРОДАВЕЦКУ\"}" >/dev/null
post /prices/quote "{\"storeId\":\"$STORE\",\"priceTypeId\":\"$USD_T\",\"items\":[{\"productId\":\"$C\"},{\"productId\":\"$B\",\"unitId\":\"$(get /products/$B; j '.units[]|select(.isBase==false).id')\"}]}"
expect "округление до 10 сом: 1760" 1760.00 "$(j '.[0].price')"
expect "упаковка 4 шт без своей цены = 180 × 4" 720.00 "$(j '.[1].price')"
expect "у упаковки мин. цена ×4 видна продавцу" null "$(j '.[1].minPrice')"
post /prices/quote "{\"items\":[{\"productId\":\"$A\"}]}"; expect "мин. цена товара (долгое нажатие)" 500.00 "$(j '.[0].minPrice')"
post /prices/cipher '{"value":"1250"}'; expect "шифр 1250 → РОВП" РОВП "$(j .cipher)"
post /markup-rules "{\"priceTypeId\":\"$STO_T\",\"percent\":\"40\",\"costTo\":\"500\"}" >/dev/null
post /markup-rules "{\"priceTypeId\":\"$STO_T\",\"percent\":\"30\",\"costFrom\":\"500\",\"costTo\":\"2000\"}"; expect "правило наценки" 201 $CODE
post /prices/suggest "{\"productIds\":[\"$A\",\"$C\"],\"priceTypeId\":\"$STO_T\"}"
expect "закупка 400 → +40% = 560" 560.00 "$(j ".[]|select(.productId==\"$A\").price")"
expect "закупка 1500 → +30% = 1950" 1950.00 "$(j ".[]|select(.productId==\"$C\").price")"
TOMORROW=$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)
post /price-settings "{\"validFrom\":\"$TOMORROW\",\"generate\":{\"method\":\"markup\",\"priceTypeId\":\"$STO_T\",\"productIds\":[\"$A\",\"$C\"]}}"; PS=$(j .id)
expect "предпросмотр: 2 строки" 2 "$(j '.lines|length')"
post /price-settings/$PS/post "{\"version\":$(j .version)}"; expect "установка цен с будущей датой" posted "$(j .status)"
expect "список для перепечатки ценников" 2 "$(j '.relabel|length')"
post /prices/quote "{\"priceTypeId\":\"$STO_T\",\"items\":[{\"productId\":\"$A\"}]}"; expect "до даты действует старая (розница 650)" retail_all "$(j '.[0].source')"
post /price-settings "{\"lines\":[{\"productId\":\"$A\",\"priceTypeId\":\"$STO_T\",\"newPrice\":\"600\"}]}"; PS2=$(j .id)
post /price-settings/$PS2/post "{\"version\":$(j .version)}"
post /prices/quote "{\"priceTypeId\":\"$STO_T\",\"items\":[{\"productId\":\"$A\"}]}"; expect "цена СТО с сегодня" 600.00 "$(j '.[0].price')"
get /settings; patch /settings "{\"version\":$(j .version),\"priceRounding\":1}" >/dev/null

echo "3.2 Клиенты и гараж"
get /counterparty-groups; expect "группы по умолчанию" 5 "$(j length)"; G_STO=$(j '.[]|select(.name=="СТО").id'); G_RETAIL=$(j '.[]|select(.name=="Розница").id')
patch /counterparty-groups/$G_STO "{\"version\":$(j ".[]|select(.name==\"СТО\").version"),\"debtLimit\":\"5000\",\"discountPercent\":\"0\"}" >/dev/null
post /counterparties "{\"name\":\"СТО Мотор\",\"roles\":[\"customer\",\"sto\"],\"phone\":\"0700123456\"}"; STO=$(j .id)
expect "СТО попал в группу СТО" $G_STO "$(j .groupId)"
post /counterparties/$STO/vehicles '{"title":"Camry 40 белая","plate":"01 KG 123 ABC","year":2009}'; V1=$(j .id); expect "машина 1 в гараже" 01KG123ABC "$(j .plate)"
get "/vehicles/makes?q=toyota" ; MAKE=$(j '.[0].id // .items[0].id // empty')
post /counterparties/$STO/vehicles "{\"makeId\":\"$MAKE\",\"year\":2012,\"plate\":\"B 777 BB\"}"; V2=$(j .id); expect "машина 2: подпись из справочника" true "$(j '.title|test("2012")')"
get /counterparties/$STO/card; expect "карточка: 2 машины" 2 "$(j '.vehicles|length')"
expect "условия из группы: тип цены СТО" $STO_T "$(j .terms.priceTypeId)"
get "/counterparties?q=01kg123"; expect "поиск клиента по госномеру" $STO "$(j '.items[0].id')"
post /counterparties '{"name":"Мотор дубль","phone":"+996 700 123 456"}'; expect "дубль по телефону — предупреждение" DUPLICATE_PHONE "$(j .code)"
post /counterparties '{"name":"Мотор дубль","phone":"+996 700 123 456","confirmDuplicatePhone":true}'; DUP=$(j .id)
get /counterparties/duplicates; expect "отчёт о дублях" true "$(j "[.[]|select(.phone==\"996700123456\")]|length > 0")"
post /counterparties/$STO/merge "{\"duplicateIds\":[\"$DUP\"]}"; expect "дубли объединены" 201 $CODE
get /counterparties/$DUP; expect "дубль скрыт" 404 $CODE
post /counterparties '{"name":"Азамат розница","phone":"0555987654"}'; CUST=$(j .id)
post /counterparties '{"name":"Сосед Эрмек","roles":["neighbor","customer"]}'; NB=$(j .id)
post /counterparties '{"name":"Мастер Улан","roles":["master"]}'; MASTER=$(j .id)

echo "3.3 Деньги и смены"
post /pos/receipts "{\"registerId\":\"$REG\"}"; expect "без смены чек не открыть" SHIFT_CLOSED "$(j .code)"
post /shifts/open "{\"registerId\":\"$REG\",\"cash\":{\"KGS\":\"5000\",\"USD\":\"100\"}}"; SHIFT=$(j .id); expect "смена открыта" open "$(j .status)"
expect "расхождение при открытии записано" 5000.00 "$(j .openingDiff.KGS)"
post /shifts/open "{\"registerId\":\"$REG\",\"cash\":{\"KGS\":\"5000\"}}"; expect "вторую смену не открыть" SHIFT_ALREADY_OPEN "$(j .code)"
post /shifts/$SHIFT/cash '{"type":"cash_in","amount":"2000","comment":"Размен"}'; expect "внесение" 201 $CODE
post /shifts/$SHIFT/cash "{\"type\":\"cash_out\",\"amount\":\"1000\",\"purpose\":\"safe\",\"toAccountId\":\"$SAFE\"}"; expect "изъятие в сейф" 201 $CODE
post /shifts/$SHIFT/cash '{"type":"exchange","currency":"USD","amount":"10","rate":"87.50"}'; expect "обмен 10$ по 87.50 → 875 сом" 875.00 "$(n $(j .toAmount))"
get /shifts/current?registerId=$REG; expect "наличные сомы: 5000+2000−1000+875" 6875.00 "$(j .cashBalance.KGS)"; expect "доллары: 100 − 10" 90.00 "$(j .cashBalance.USD)"
get /money/accounts; expect "сейф: 1000" 1000.00 "$(n $(j ".[]|select(.id==\"$SAFE\").balance"))"

echo "3.4 Касса"
K=$(KEY)
SALE="{\"registerId\":\"$REG\",\"idempotencyKey\":\"$K\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"},{\"productId\":\"$B\",\"qty\":\"4\"}],\"receiptDiscountAmount\":\"70\",\"payments\":[{\"method\":\"cash\",\"currency\":\"USD\",\"amount\":\"5\"},{\"method\":\"transfer\",\"accountId\":\"$WALLET\",\"amount\":\"859.50\"}]}"
post /pos/sales "$SALE"; R1=$(j .id); R1TOKEN=$(j .publicToken)
expect "чек 1370 − 70 = 1300 (пример ТЗ)" 1300.00 "$(n $(j .total))"
expect "скидка на чек распределена: фильтр 33.21" 33.21 "$(n $(j '.lines[0].receiptDiscount'))"
expect "сумма строк = итог чека" 1300.00 "$(n $(j '[.lines[].amount|tonumber]|add'))"
expect "оплата частью долларами и частью переводом прошла до конца" completed "$(j .status)"
expect "5 $ по курсу 88.10 = 440.50" 440.50 "$(n $(j '.payments[]|select(.method=="cash").amountKgs'))"
expect "перевод «не сверено»" unverified "$(j '.payments[]|select(.method=="transfer").verifyStatus')"
[[ "$(j .number)" =~ ^К1-0000[0-9]{2}$ ]] && ok "номер чека $(j .number)" || bad "номер чека $(j .number)"
post /pos/sales "$SALE"; expect "повтор с тем же ключом — тот же чек" $R1 "$(j .id)"; expect "помечен как повтор" true "$(j .duplicate)"
get "/stock?warehouseId=$WH"; expect "товар ушёл со склада кассы: B 100 − 4" 96 "$(j ".items[]|select(.productId==\"$B\").qty")"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$NP\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"100\"}]}"
expect "цена не задана — продажа запрещена" LINES_INVALID "$(j .code)"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"600\"}]}"
expect "не хватает денег" UNDERPAID "$(j .code)"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"1000\"}]}"
expect "сдача 350" 350.00 "$(n $(j .change))"
# Продавец и лимит скидки
get /roles; SELLER_ROLE=$(j '.[]|select(.code=="seller").id')
post /staff/invitations "{\"name\":\"Айбек\",\"roleIds\":[\"$SELLER_ROLE\"],\"allStores\":true}"; IC=$(j .code)
req POST /auth/accept-invite "" "{\"code\":\"$IC\",\"login\":\"sel${R}@x.kg\",\"password\":\"secret123\",\"name\":\"Айбек\"}"; TS=$(j .accessToken)
get /staff; SELLER_M=$(j '.items[]|select(.name=="Айбек").id')
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$C\",\"qty\":\"1\",\"price\":\"1800\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"1800\"}]}" "$TS"
expect "продавцу свободная цена — нельзя" LINES_INVALID "$(j .code)"
K2S=$(KEY)
DISC="{\"registerId\":\"$REG\",\"idempotencyKey\":\"$K2S\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"2\",\"discountPercent\":\"20\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"288\"}]}"
post /pos/sales "$DISC" "$TS"; expect "скидка 20% выше лимита продавца 5% — нужен PIN" DISCOUNT_OVER_LIMIT "$(j .code)"; expect "ответ просит PIN" true "$(j .details.requiresPin)"
post /pos/pin '{}'; OWNER_PIN=$(j .pin); expect "владелец получил PIN" 5 "${#OWNER_PIN}"
post /pos/sales "$(echo $DISC | jq -c ".pin=\"$OWNER_PIN\"")" "$TS"
expect "с PIN владельца — скидка подтверждена" completed "$(j .status)"; expect "в чеке — кто подтвердил" discount "$(j '.approvals[0].action')"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"card\",\"amount\":\"700\"}]}"
expect "карта больше суммы — нельзя (сдача только с наличных)" OVERPAY_NONCASH "$(j .code)"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"card\",\"amount\":\"650\"}]}"
expect "оплата картой → эквайринг" completed "$(j .status)"
get /money/accounts; expect "на эквайринге 650 − 2% комиссии" 637.00 "$(n $(j ".[]|select(.id==\"$ACQ\").balance"))"

echo "3.4 Отложенные, цена в чеке, комплект, серийные, свободная позиция"
post /pos/receipts "{\"registerId\":\"$REG\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"2\"}]}"; RH=$(j .id); LINE_A=$(j '.lines[0].id')
expect "цена при добавлении 650" 650.00 "$(n $(j '.lines[0].price'))"
post /pos/receipts/$RH/defer "{\"version\":$(j .version),\"label\":\"Азамат, ждёт друга\"}"; expect "чек отложен" deferred "$(j .status)"
get "/pos/receipts?status=deferred&storeId=$STORE" "$TS"; expect "отложенный виден другому продавцу" $RH "$(j '.items[0].id')"
price $A 700
post /pos/receipts/$RH/resume "{\"registerId\":\"$REG\"}"; expect "продолжили" open "$(j .status)"
patch /pos/receipts/$RH "{\"version\":$(j .version),\"lines\":[{\"lineId\":\"$LINE_A\",\"productId\":\"$A\",\"qty\":\"3\"},{\"productId\":\"$A\",\"qty\":\"1\"}]}"
expect "старая строка держит цену 650" 650.00 "$(n $(j '.lines[0].price'))"
expect "новая строка — по новой цене 700" 700.00 "$(n $(j '.lines[1].price'))"
post /pos/receipts/$RH/pay "{\"version\":$(j .version),\"payments\":[{\"method\":\"cash\",\"amount\":\"2650\"}]}"; expect "оплачен" completed "$(j .status)"
get "/pos/last-prices?customerId=$CUST&productIds=$A"; expect "«как в прошлый раз»" true "$(j '.[0].price|tonumber > 0')"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$KIT\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"3000\"}]}"; RKIT=$(j .id)
expect "комплект продан" completed "$(j .status)"
get "/stock?warehouseId=$WH"; expect "списались компоненты: масло 10 − 1" 9 "$(j ".items[]|select(.productId==\"$K1\").qty")"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$S\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"6500\"}]}"
expect "серийный без экземпляра — нельзя" SERIAL_NOT_AVAILABLE "$(j .code)"
get "/products/$S/serials?status=in_stock"; SER1=$(j '.[0].id')
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$S\",\"qty\":\"1\",\"serialItemIds\":[\"$SER1\"]}],\"payments\":[{\"method\":\"cash\",\"amount\":\"6500\"}]}"; RSER=$(j .id); RSER_LINE=$(j '.lines[0].id')
expect "АКБ продан с экземпляром" completed "$(j .status)"; expect "гарантия на чеке" 365 "$(j '.lines[0].rules.warrantyDays')"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"free\":{\"name\":\"Хомут 40 мм\"},\"qty\":\"2\",\"price\":\"50\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"100\"}]}"
expect "свободная позиция" completed "$(j .status)"
get /pos/reports/free-items; expect "отчёт «Свободные позиции»" "Хомут 40 мм" "$(j '.[0].name')"
get /settings; patch /settings "{\"version\":$(j .version),\"belowCostSale\":\"confirm\"}" >/dev/null
post /pos/receipts "{\"registerId\":\"$REG\",\"lines\":[{\"productId\":\"$C\",\"qty\":\"1\",\"price\":\"1000\"}]}"; RBC=$(j .id)
post /pos/receipts/$RBC/pay "{\"version\":$(j .version),\"payments\":[{\"method\":\"cash\",\"amount\":\"1000\"}]}" "$TS"
expect "ниже себестоимости — нужно подтверждение" BELOW_COST "$(j .code)"
get /pos/receipts/$RBC; post /pos/receipts/$RBC/pay "{\"version\":$(j .version),\"payments\":[{\"method\":\"cash\",\"amount\":\"1000\"}]}"
expect "владелец продал ниже себестоимости" completed "$(j .status)"
get /pos/reports/below-cost; expect "отчёт «Продажи ниже себестоимости»" true "$(j "[.[]|select(.receiptId==\"$RBC\")]|length == 1")"

echo "3.7 «Взял у соседа», долг"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"neighbor\":{\"neighborId\":\"$NB\",\"name\":\"Колодки Camry 40\",\"partNumber\":\"04465-33450\",\"purchasePrice\":\"1800\"},\"qty\":\"1\",\"price\":\"2500\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"2500\"}]}"
expect "одна операция: продажа от соседа" completed "$(j .status)"; expect "себестоимость = закупка у соседа" 1800.00 "$(n $(j '.lines[0].costAmount'))"
get "/counterparties/$NB/debts?direction=payable"; expect "долг перед соседом 1800" 1800.00 "$(n $(j '.[0].remaining'))"
get /pos/neighbor-purchases; expect "«что брали у соседей»: прибыль 700" 700.00 "$(n $(j '.groups[0].profit'))"
post /pos/neighbor-purchases/$(j '.recent[0].id')/link "{\"productId\":\"$C\"}"; expect "позицию привязали к карточке" $C "$(j .productId)"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"debt\",\"amount\":\"700\"}]}" "$TS"
expect "рознице в долг нельзя (лимит группы 0)" CREDIT_LIMIT "$(j .code)"
CRED="{\"registerId\":\"$REG\",\"customerId\":\"$STO\",\"customerVehicleId\":\"$V1\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"2\"}],\"payments\":[{\"method\":\"debt\",\"amount\":\"1200\"}]}"
post /pos/sales "$(echo $CRED | jq -c ".idempotencyKey=\"$(KEY)\"")"; RD1=$(j .id); expect "СТО: продажа в долг по цене СТО (600 × 2)" 1200.00 "$(n $(j .total))"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"customerId\":\"$STO\",\"customerVehicleId\":\"$V2\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"10\"}],\"payments\":[{\"method\":\"debt\",\"amount\":\"1800\"}]}"; RD2=$(j .id)
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"customerId\":\"$STO\",\"customerVehicleId\":\"$V2\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"10\"}],\"payments\":[{\"method\":\"debt\",\"amount\":\"6000\"}]}" "$TS"
expect "сверх лимита 5000 — нужен PIN" CREDIT_LIMIT "$(j .code)"
get /counterparties/$STO/card; expect "долг СТО виден по машинам" 2 "$(j '.debtsByVehicle|length')"
get /customer-vehicles/$V1/history; expect "у машины 1 своя история (фильтр ×2)" "Фильтр масляный" "$(j '.items[0].productName')"
get /customer-vehicles/$V2/history; expect "у машины 2 своя история (свечи)" "Свеча NGK" "$(j '.items[0].productName')"
get "/counterparties/$STO/debts?vehicleId=$V1"; expect "фильтр «за какую машину»" 1200.00 "$(n $(j '.[0].remaining'))"
get /counterparties/$STO/debts/statement; expect "сверка одним сообщением: машина и итог" true "$(j '.text|test("Camry 40 белая") and test("Итого долг: 3")')"
expect "кнопка WhatsApp" true "$(j '.whatsappUrl|startswith("https://wa.me/996700123456")')"
C=$(curl -s -o $TMP/st.pdf -w "%{http_code}" "$API/counterparties/$STO/debts/statement.pdf" -H "Authorization: Bearer $T"); expect "PDF сверки" 200 $C
post /debts/payments "{\"counterpartyId\":\"$STO\",\"direction\":\"in\",\"amount\":\"1000\",\"accountId\":\"$CASH_KGS\",\"shiftId\":\"$SHIFT\",\"allocation\":{\"mode\":\"vehicles\",\"vehicleIds\":[\"$V2\"]}}"
get "/counterparties/$STO/debts?vehicleId=$V2"; expect "оплата гасит долг выбранной машины: 1800 − 1000" 800.00 "$(n $(j '.[0].remaining'))"
get "/counterparties/$STO/debts?vehicleId=$V1"; expect "долг другой машины не тронут" 1200.00 "$(n $(j '.[0].remaining'))"
post /debts/payments "{\"counterpartyId\":\"$STO\",\"direction\":\"in\",\"amount\":\"3500\",\"accountId\":\"$CASH_KGS\",\"shiftId\":\"$SHIFT\"}"
expect "переплата осталась авансом" 1500.00 "$(n $(j '.balance[]|select(.advance==true).amount'))"
post /pos/sales "$(echo $CRED | jq -c ".idempotencyKey=\"$(KEY)\"")"
get /counterparties/$STO/card; expect "аванс сам погасил новый долг" 0 "$(j '[.debts[]|select(.direction=="receivable")]|length')"
expect "остаток аванса 300" 300.00 "$(n $(j '.debts[]|select(.direction=="payable").amount'))"
get "/debts?direction=payable"; expect "кредиторка: сосед" true "$(j "[.items[]|select(.counterpartyId==\"$NB\")]|length == 1")"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"customerId\":\"$NB\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"debt\",\"amount\":\"700\"}],\"pin\":\"$OWNER_PIN\"}"
expect "сосед купил у нас в долг (PIN — лимит)" completed "$(j .status)"
post /debts/offset "{\"counterpartyId\":\"$NB\"}"; expect "взаимозачёт с соседом: 700" 700.00 "$(n $(j .amount))"
post /debts/payments "{\"counterpartyId\":\"$NB\",\"direction\":\"out\",\"amount\":\"1100\",\"accountId\":\"$CASH_KGS\",\"shiftId\":\"$SHIFT\"}"
expect "расчёт с соседом — долг закрыт" 0 "$(j '.balance|length')"

echo "3.5 Агент печати и электронный чек"
post /pos/receipts/$R1/print '{}'; expect "без агента — PDF" NO_AGENT "$(j .code)"
post /devices/pairing-code "{\"registerId\":\"$REG\"}"; PC=$(j .code); expect "код привязки 6 цифр" 6 "${#PC}"
req POST /agent/pair "" "{\"code\":\"000000\"}"; expect "неверный код" PAIRING_CODE_INVALID "$(j .code)"
req POST /agent/pair "" "{\"code\":\"$PC\",\"name\":\"Касса у входа\",\"agentVersion\":\"1.0.0\"}"; DT=$(j .token); DEV=$(j .device.id); expect "агент привязан" true "$(j '.token|startswith("dev_")')"
req POST /agent/pair "" "{\"code\":\"$PC\"}"; expect "код одноразовый" PAIRING_CODE_INVALID "$(j .code)"
post /pos/receipts/$R1/print '{}'; JOB=$(j .jobId); expect "задание печати в очереди" queued "$(j .status)"
C=$(curl -s -o $TMP/a.json -w "%{http_code}" "$API/agent/jobs" -H "X-Device-Token: $DT"); BODY=$(cat $TMP/a.json)
expect "агент забрал задание" $JOB "$(j '.jobs[0].id')"; expect "в задании — чек с QR" true "$(j '.jobs[0].payload.qr|test("/r/")')"
expect "в чеке нет себестоимости" null "$(j '.jobs[0].payload.lines[0].costAmount')"
curl -s -o /dev/null -X POST "$API/agent/jobs/$JOB/status" -H "$J" -H "X-Device-Token: $DT" -d '{"status":"no_paper"}'
get /print-jobs/$JOB; expect "нет бумаги — задание ждёт" queued "$(j .status)"
curl -s -o /dev/null -X POST "$API/agent/jobs/$JOB/status" -H "$J" -H "X-Device-Token: $DT" -d '{"status":"printed"}'
get /print-jobs/$JOB; expect "«Напечатано»" printed "$(j .status)"
post /print-jobs "{\"registerId\":\"$REG\",\"kind\":\"drawer\"}"; expect "открыть денежный ящик" drawer "$(j .kind)"
C=$(curl -s -o $TMP/c.json -w "%{http_code}" "$API/agent/jobs" -H "X-Device-Token: bad"); expect "чужой токен — 401" 401 $C
req GET /public/receipts/$R1TOKEN ""; expect "электронный чек без входа" 1300.00 "$(n $(j .total))"; expect "магазин на чеке" true "$(j '.store.name|length > 0')"
req GET /public/receipts/${R1TOKEN:0:22}AAAAAAAAAAAAAAAAAAAAAAAA ""; expect "подбор ссылки — 404" 404 $CODE
get /pos/receipts/$R1/share; expect "ссылка для WhatsApp" true "$(j '.whatsappUrl|startswith("https://wa.me/")')"
req DELETE /devices/$DEV "$T"; C=$(curl -s -o /dev/null -w "%{http_code}" "$API/agent/jobs" -H "X-Device-Token: $DT"); expect "отозванный агент не работает" 401 $C

echo "3.6 Возвраты"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"},{\"productId\":\"$B\",\"qty\":\"4\"}],\"receiptDiscountAmount\":\"70\",\"payments\":[{\"method\":\"cash\",\"amount\":\"636.79\"},{\"method\":\"transfer\",\"accountId\":\"$WALLET\",\"amount\":\"733.21\"}]}"
RS=$(j .id); RS_TOKEN=$(j .publicToken); LB=$(j ".lines[]|select(.productId==\"$B\").id"); LA=$(j ".lines[]|select(.productId==\"$A\").id")
LB_AMOUNT=$(n $(j ".lines[]|select(.productId==\"$B\").amount")); expect "чек с акцией: B со скидкой" true "$(python3 -c "print(str($LB_AMOUNT < 720).lower())")"
get "/pos/returns/lookup?code=$(python3 -c "import urllib.parse;print(urllib.parse.quote('https://shop.kg/r/$RS_TOKEN'))")"; expect "найден по QR" $RS "$(j .id)"
expect "можно вернуть 4 свечи" 4.000 "$(j ".lines[]|select(.id==\"$LB\").returnableQty")"
post /pos/returns "{\"registerId\":\"$REG\",\"saleReceiptId\":\"$RS\",\"lines\":[{\"saleLineId\":\"$LB\",\"qty\":\"1\",\"reason\":\"changed_mind\"}]}"; RET1=$(j .id)
EXP1=$(python3 -c "from decimal import Decimal as D,ROUND_HALF_UP;print((D('$LB_AMOUNT')/4).quantize(D('0.01'),ROUND_HALF_UP))")
expect "сумма возврата — по сохранённому распределению скидки" $EXP1 "$(n $(j .total))"
expect "деньги — теми же способами: наличные и перевод" 2 "$(j '.payments|length')"
expect "сумма выплат = сумме возврата" $EXP1 "$(n $(j '[.payments[].amountKgs|tonumber]|add|-.'))"
post /pos/returns "{\"registerId\":\"$REG\",\"saleReceiptId\":\"$RS\",\"lines\":[{\"saleLineId\":\"$LB\",\"qty\":\"3\",\"reason\":\"changed_mind\"}]}"
EXP2=$(python3 -c "from decimal import Decimal as D;print(D('$LB_AMOUNT')-D('$EXP1'))")
expect "последний возврат забирает остаток до тыйына" $EXP2 "$(n $(j .total))"
post /pos/returns "{\"registerId\":\"$REG\",\"saleReceiptId\":\"$RS\",\"lines\":[{\"saleLineId\":\"$LB\",\"qty\":\"1\",\"reason\":\"changed_mind\"}]}"
expect "больше купленного не вернуть" LINES_INVALID "$(j .code)"
post /pos/returns "{\"registerId\":\"$REG\",\"saleReceiptId\":\"$RS\",\"lines\":[{\"saleLineId\":\"$LA\",\"qty\":\"1\",\"reason\":\"not_fit\"}]}"
expect "«не подошло» без отметок — нельзя" LINES_INVALID "$(j .code)"
post /pos/returns "{\"registerId\":\"$REG\",\"saleReceiptId\":\"$RS\",\"lines\":[{\"saleLineId\":\"$LA\",\"qty\":\"1\",\"reason\":\"not_fit\",\"noInstallMarks\":true,\"triedVehicleTitle\":\"Toyota Ipsum 2003\"}]}"
expect "«не подошло» с машиной" completed "$(j .status)"
get "/notifications?limit=50"; expect "задача «проверить применимость»" true "$(j '[.items[]?|select(.type=="return.not_fit")]|length >= 1')"
get "/stock?warehouseId=$WH"; QA=$(j ".items[]|select(.productId==\"$A\").qty")
post /pos/returns "{\"registerId\":\"$REG\",\"saleReceiptId\":\"$RKIT\",\"lines\":[{\"saleLineId\":\"$(get /pos/receipts/$RKIT; j '.lines[0].id')\",\"componentProductId\":\"$K1\",\"qty\":\"1\",\"reason\":\"defect\"}]}"
expect "часть комплекта — по распределению цены комплекта" true "$(j '(.total|tonumber) as $t | $t > 0 and $t < 3000')"
get "/stock?warehouseId=$DEFECT"; expect "брак — на склад «Брак»" 1 "$(j ".items[]|select(.productId==\"$K1\").qty")"
post /pos/returns "{\"registerId\":\"$REG\",\"saleReceiptId\":\"$RD1\",\"lines\":[{\"saleLineId\":\"$(get /pos/receipts/$RD1; j '.lines[0].id')\",\"qty\":\"1\",\"reason\":\"other\"}]}"
expect "возврат проданного в долг уменьшает долг (аванс уже погасил — наличными)" completed "$(j .status)"
post /pos/returns "{\"registerId\":\"$REG\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\",\"price\":\"650\",\"reason\":\"other\"}]}" "$TS"
expect "без чека продавцу — нужен PIN" RETURN_WITHOUT_RECEIPT "$(j .code)"
post /pos/returns "{\"registerId\":\"$REG\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\",\"price\":\"650\",\"reason\":\"other\"}],\"pin\":\"$OWNER_PIN\"}" "$TS"
expect "без чека с PIN старшего" completed "$(j .status)"

echo "3.6 Обмен и гарантия"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"2\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"360\"}]}"; REX=$(j .id); LEX=$(j '.lines[0].id')
post /pos/exchanges "{\"registerId\":\"$REG\",\"saleReceiptId\":\"$REX\",\"returnLines\":[{\"saleLineId\":\"$LEX\",\"qty\":\"2\",\"reason\":\"wrong_item\"}],\"sale\":{\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"340\"}]}}"
expect "обмен: доплата 700 − 360 = 340" 340.00 "$(n $(j .difference))"; expect "новый чек оплачен зачётом и доплатой" completed "$(j .sale.status)"
post /warranty "{\"saleReceiptId\":\"$RSER\",\"saleLineId\":\"$RSER_LINE\",\"serialItemId\":\"$SER1\",\"complaint\":\"Не держит заряд\"}"; WC=$(j .id)
expect "обращение в гарантии" true "$(j .inWarranty)"; [[ "$(j .number)" =~ ^ГО-2026-[0-9]{5}$ ]] && ok "номер $(j .number)" || bad "номер $(j .number)"
post /warranty/$WC/status "{\"version\":$(j .version),\"status\":\"checking\"}"; expect "на проверке" checking "$(j .status)"
get "/products/$S/serials?status=in_stock"; SER2=$(j '.[0].id')
post /warranty/$WC/decide "{\"version\":$(get /warranty/$WC; j .version),\"decision\":\"replace\",\"registerId\":\"$REG\",\"serialItemIds\":[\"$SER2\"]}"
expect "замена по гарантии" replace "$(j .decision)"; expect "выдан новый экземпляр" true "$(j '.replacementReceiptId != null')"
get /pos/receipts/$(j .replacementReceiptId); expect "замена без доплаты" return_credit "$(j '.payments[0].method')"
get /warranty/report; expect "отчёт по брендам" Varta "$(j '.byBrand[0].brand')"

echo "3.7 Сверка переводов"
get "/money/transfers?accountId=$WALLET"; expect "несверенные переводы" true "$(j '.total >= 2')"
TR1=$(j ".items[]|select(.receiptId==\"$R1\").id")
post /money/transfers/verify "{\"ids\":[\"$TR1\"]}"; expect "отметили «пришло»" 1 "$(j .verified)"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"transfer\",\"accountId\":\"$WALLET\",\"amount\":\"700\"}]}"; RT2=$(j .id)
get "/money/transfers?accountId=$WALLET"; TR2=$(j ".items[]|select(.receiptId==\"$RT2\").id")
post /money/transfers/$TR2/not-received '{"action":"debt"}'; expect "без клиента долг не записать" CUSTOMER_REQUIRED "$(j .code)"
post /money/transfers/$TR2/not-received "{\"action\":\"debt\",\"counterpartyId\":\"$CUST\"}"; expect "«не поступило» → долг клиента" true "$(j '.debtItemId != null')"
get "/counterparties/$CUST/debts"; expect "долг клиента 700" 700.00 "$(n $(j '[.[]|select(.kind=="not_received")][0].remaining'))"
get "/stock?warehouseId=$WH"; QA0=$(j ".items[]|select(.productId==\"$A\").qty")
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"2\"}],\"payments\":[{\"method\":\"transfer\",\"accountId\":\"$WALLET\",\"amount\":\"1000\"},{\"method\":\"cash\",\"amount\":\"400\"}]}"; RT3=$(j .id)
get "/money/transfers?accountId=$WALLET"; TR3=$(j ".items[]|select(.receiptId==\"$RT3\").id")
post /money/transfers/$TR3/not-received '{"action":"cancel"}'; expect "«не поступило» → чек отменён возвратом" true "$(j '.returnReceiptId != null')"
get /pos/receipts/$(j .returnReceiptId); expect "наличная часть вернулась, перевод — нет" -400.00 "$(n $(j '.payments[]|select(.method=="cash").amountKgs'))"
get "/stock?warehouseId=$WH"; expect "товар вернулся на склад" $QA0 "$(j ".items[]|select(.productId==\"$A\").qty")"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"transfer\",\"accountId\":\"$WALLET\",\"amount\":\"180\"}]}"
NOW=$(TZ=Asia/Bishkek date +%d.%m.%Y\ %H:%M)
printf 'Дата;Описание;Сумма\n%s;Перевод от клиента;180,00\n%s;Чужой перевод;999,00\n' "$NOW" "$NOW" > $TMP/st.csv
FID=$(curl -s -X POST $API/files -H "Authorization: Bearer $T" -F "file=@$TMP/st.csv;type=text/csv" -F purpose=import | jq -r .id)
post /money/transfers/match "{\"accountId\":\"$WALLET\",\"fileId\":\"$FID\"}"
expect "выписка: перевод 180 сопоставлен" 1 "$(j '[.matches[]|select(.amount=="180.00")]|length')"; expect "чужой перевод — без пары" 1 "$(j '.unmatchedStatementRows|length')"
post /money/transfers/verify "{\"ids\":[\"$(j '.matches[0].movementId')\"]}"; expect "подтвердили сопоставление" 1 "$(j .verified)"
get /money/transfers/summary; expect "отчёт «Несверенные переводы»" true "$(j '.byWallet|length >= 1')"

echo "PIN: блокировка"
for i in 1 2 3 4 5; do post /pos/sales "$(echo $DISC | jq -c ".pin=\"0000$i\" | .idempotencyKey=\"x$i$K2S\"")" "$TS" >/dev/null; done
post /pos/sales "$(echo $DISC | jq -c ".pin=\"$OWNER_PIN\" | .idempotencyKey=\"y$K2S\"")" "$TS"; expect "5 неверных PIN — касса заблокирована" TOO_MANY_ATTEMPTS "$(j .code)"


echo "3.3 Передача кассы и закрытие смены"
post /money/accounts "{\"type\":\"wallet\",\"name\":\"O!Деньги — Айбек\",\"holderMembershipId\":\"$SELLER_M\",\"storeId\":\"$STORE\",\"details\":{\"provider\":\"O!Деньги\",\"phone\":\"0700555666\"}}"; SW=$(j .id)
get /settings; patch /settings "{\"version\":$(j .version),\"cashHandover\":true}" >/dev/null
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"180\"}]}" "$TS"
expect "касса у другого продавца — сначала передача" SHIFT_HANDOVER_REQUIRED "$(j .code)"
get /shifts/current?registerId=$REG; EXPK=$(j .cashBalance.KGS); SV=$(j .shift.version)
post /shifts/$SHIFT/handover "{\"version\":$SV,\"toMembershipId\":\"$SELLER_M\",\"counted\":{\"KGS\":\"$(python3 -c "print(float('$EXPK')-100)")\"}}"
expect "передача кассы с недостачей 100" -100.00 "$(j .handover.diff.KGS)"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"2\"}],\"payments\":[{\"method\":\"transfer\",\"accountId\":\"$SW\",\"amount\":\"360\"}]}" "$TS"
expect "продавец продал переводом на свой номер" completed "$(j .status)"
post /pos/receipts "{\"registerId\":\"$REG\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"1\"}]}" "$TS"; OPEN_R=$(j .id)
get /shifts/$SHIFT/x-report; expect "X-отчёт: продажи" true "$(j '.salesCount > 10')"
expect "X-отчёт: по кошелькам" true "$(j '[.byAccount[]|select(.type=="wallet")]|length >= 2')"
expect "«сдать владельцу» переводы на номер продавца: 360" 360.00 "$(n $(j .toOwner.total))"
expect "обмен валюты — курсовая разница в отчёте" true "$(j '.exchangeDiff != null')"
get /shifts/current?registerId=$REG; SV=$(j .shift.version); EXPK=$(j .cashBalance.KGS); EXPU=$(j .cashBalance.USD)
post /shifts/$SHIFT/close "{\"version\":$SV,\"counted\":{\"KGS\":\"$EXPK\",\"USD\":\"$EXPU\"}}" "$TS"
expect "есть незавершённый чек — закрыть нельзя" OPEN_RECEIPTS "$(j .code)"
get /pos/receipts/$OPEN_R; post /pos/receipts/$OPEN_R/cancel "{\"version\":$(j .version)}" "$TS" >/dev/null
post /shifts/$SHIFT/close "{\"version\":$SV,\"counted\":{\"KGS\":\"$EXPK\",\"USD\":\"$EXPU\"}}" "$TS"
expect "смена закрыта" closed "$(j .status)"; expect "Z-отчёт: без расхождения" 0.00 "$(j .diff.KGS)"
expect "Z: итоги по способам оплаты" true "$(j '[.zReport.byMethod[].method]|index("transfer") != null')"
expect "Z: «сдать владельцу»" 360.00 "$(n $(j .zReport.toOwner.total))"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$B\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"180\"}]}"
expect "после закрытия продаж нет" SHIFT_CLOSED "$(j .code)"
get /settings; patch /settings "{\"version\":$(j .version),\"cashHandover\":false}" >/dev/null

echo "Изоляция и сверка"
req POST /auth/register "" "{\"name\":\"Чужой\",\"login\":\"oth${R}@x.kg\",\"password\":\"secret123\",\"shopName\":\"Чужой\"}"; T2=$(j .accessToken)
get /pos/receipts/$R1 "$T2"; expect "чужой чек — 404" 404 $CODE
get "/counterparties/$STO/debts" "$T2"; expect "чужие долги — 404" 404 $CODE
get "/money/transfers" "$T2"; expect "чужие переводы не видны" 0 "$(j .total)"
get /stock/reconcile; expect "кэш остатков = движения" true "$(j .ok)"
psql "$DATABASE_OWNER_URL" -tAc "SELECT count(*) FROM (SELECT d.id FROM receipts r JOIN documents d ON d.id = r.document_id WHERE r.tenant_id = '$TENANT' AND r.status = 'completed' AND r.kind = 'sale' AND abs((SELECT coalesce(sum(amount),0) FROM document_lines l WHERE l.document_id = d.id) - r.total) > 0.001) x" > $TMP/chk.txt
expect "во всех чеках сумма строк = итог" 0 "$(cat $TMP/chk.txt | tr -d ' ')"
psql "$DATABASE_OWNER_URL" -tAc "SELECT count(*) FROM debt_items WHERE tenant_id = '$TENANT' AND (remaining < 0 OR remaining > amount OR abs(amount - remaining - coalesce((SELECT sum(a.amount) FROM debt_allocations a WHERE a.debt_item_id = debt_items.id), 0)) > 0.001)" > $TMP/chk2.txt
expect "долги: остаток = сумма − распределения" 0 "$(cat $TMP/chk2.txt | tr -d ' ')"

echo; echo "Итог: ✔ $pass  ✘ $fail"
