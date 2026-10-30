#!/usr/bin/env bash
# Смоук-проверка этапа 7 (деньги полностью, отчёты и дашборд, Telegram для сотрудников).
#   bash scripts/smoke/stage7.sh   (из папки backend; API запущен с NBKR_URL/TELEGRAM_* на заглушку :8098; только dev-база)
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
put(){ req PUT "$1" "${3:-$T}" "$2"; }
j(){ echo "$BODY" | jq -r "$1"; }
n(){ python3 -c "import sys;print(f'{float(sys.argv[1]):.2f}')" "$1"; }
KEY(){ python3 -c "import uuid;print(uuid.uuid4())"; }
tglast(){ tail -1 $TMP/tg.log 2>/dev/null | jq -r .text; }
R=$(printf "%05d" $((RANDOM)))
TODAY=$(TZ=Asia/Bishkek date +%F); DAY=$(TZ=Asia/Bishkek date +%-d); MONTH=${TODAY:0:7}
MEND=$(python3 -c "import calendar,sys;y,m=map(int,sys.argv[1].split('-'));print(f'{y}-{m:02d}-{calendar.monthrange(y,m)[1]:02d}')" $MONTH)
nbkr(){ local d=$1 usd=$2; echo "<?xml version=\"1.0\" encoding=\"windows-1251\"?><CurrencyRates Name=\"Daily Exchange Rates\" Date=\"${d:8:2}.${d:5:2}.${d:0:4}\"><Currency ISOCode=\"USD\"><Nominal>1</Nominal><Value>${usd}</Value></Currency><Currency ISOCode=\"KZT\"><Nominal>100</Nominal><Value>17,1200</Value></Currency></CurrencyRates>" > $TMP/nbkr.xml; }

[ -f /tmp/ext_stub.pid ] && kill $(cat /tmp/ext_stub.pid) 2>/dev/null
nbkr $TODAY "87,4500"; : > $TMP/tg.log
python3 scripts/smoke/lib/ext_stub.py $TMP/nbkr.xml $TMP/tg.log 8098 & echo $! > /tmp/ext_stub.pid; sleep 0.7

echo "0. Подготовка"
req POST /auth/register "" "{\"name\":\"Деньги\",\"login\":\"0556${R}1\",\"password\":\"secret123\",\"shopName\":\"Деньги ${R}\"}"; T=$(j .accessToken)
post /onboarding/complete '{"shopType":"city","shopRateUsd":"87.50","wallets":[{"provider":"MBank","holderName":"Азамат","phone":"0555111222"}]}' >/dev/null
get /auth/me; ME=$(j '.memberships[0].membershipId // .currentMembershipId // .membership.id // empty')
get /staff; ME=${ME:-$(j '.items[0].id')}
get /registers; REG=$(j '.[0].id'); STORE=$(j '.[0].storeId')
get /warehouses; WH=$(j '[.[]|select(.type=="sales_floor")][0].id')
get /price-types; RETAIL=$(j '.[]|select(.code=="retail").id')
get /money/accounts; WALLET=$(j '[.[]|select(.type=="wallet")][0].id'); CASH=$(j '[.[]|select(.type=="cash" and .currency=="KGS")][0].id'); CASH_USD=$(j '[.[]|select(.type=="cash" and .currency=="USD")][0].id'); SAFE=$(j '[.[]|select(.type=="safe")][0].id')
post /products '{"name":"Фильтр масляный","brand":"Bosch","number":"F-7001"}'; A=$(j .id)
put /products/$A/prices "{\"items\":[{\"priceTypeId\":\"$RETAIL\",\"price\":\"1000\"}]}" >/dev/null
post /documents "{\"type\":\"initial_stock\",\"warehouseId\":\"$WH\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"10\",\"price\":\"400\"}]}"; DOC=$(j .id); V=$(j .version)
post /documents/$DOC/post "{\"version\":$V}" >/dev/null
post /counterparties "{\"name\":\"Клиент $R\",\"roles\":[\"customer\"],\"phone\":\"0700${R}2\"}"; CUST=$(j .id)
post /shifts/open "{\"registerId\":\"$REG\",\"cash\":{\"KGS\":\"5000\"}}"; SHIFT=$(j .id); expect "смена открыта" open "$(j .status)"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"2\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"2000\"}]}"; expect "продажа 1 (наличные)" completed "$(j .status)"
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$A\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"transfer\",\"accountId\":\"$WALLET\",\"amount\":\"1000\"}]}"; expect "продажа 2 (перевод)" completed "$(j .status)"

echo "7.1 Расходы, изъятие, регулярные расходы"
get /money/expense-articles; expect "статьи по умолчанию (8)" 8 "$(j length)"; expect "изъятие собственника — отдельная статья" owner "$(j '.[]|select(.code=="owner").kind')"
post /money/expenses "{\"articleCode\":\"rent\",\"accountId\":\"$CASH\",\"amount\":\"3000\",\"comment\":\"октябрь\"}"; EXP1=$(j .id); expect "аренда 3000 из кассы" 201 $CODE
post /money/expenses "{\"articleCode\":\"ads\",\"accountId\":\"$CASH\",\"amount\":\"99000\"}"; expect "больше, чем в кассе, — нельзя" NOT_ENOUGH_CASH "$(j .code)"
post /money/expenses "{\"articleCode\":\"ads\",\"accountId\":\"$CASH\",\"amount\":\"200\"}"; EXP2=$(j .id)
post /money/expenses/$EXP2/cancel '{"reason":"ошибся"}'; expect "расход отменён" cancelled "$(j .status)"
post /money/expenses/$EXP2/cancel '{}'; expect "повторно не отменить" ALREADY_CANCELLED "$(j .code)"
post /money/expenses "{\"articleCode\":\"salary\",\"accountId\":\"$CASH\",\"amount\":\"100\"}"; expect "зарплата без сотрудника — нельзя" MEMBER_REQUIRED "$(j .code)"
post /money/expenses "{\"articleCode\":\"salary\",\"accountId\":\"$CASH\",\"amount\":\"100\",\"membershipId\":\"$ME\"}"; expect "выплата зарплаты" 201 $CODE
post /money/expenses "{\"articleCode\":\"owner\",\"accountId\":\"$CASH\",\"amount\":\"1000\"}"; expect "изъятие собственника" 201 $CODE
get /money/accounts; expect "касса: 5000 + 2000 − 3000 − 100 − 1000" 2900.00 "$(n $(j ".[]|select(.id==\"$CASH\").balance"))"
get "/shifts/$SHIFT/x-report"; expect "расходы — в отчёте смены" true "$(echo $BODY | grep -c 3000 | awk '{print ($1>0)?"true":"false"}')"
get "/money/expenses?from=$TODAY&to=$TODAY"; expect "журнал расходов: 4 записи" 4 "$(j .total)"; expect "итого без отменённого: 4100" 4100.00 "$(n $(j .totalKgs))"
post /money/recurring-expenses "{\"articleCode\":\"utilities\",\"accountId\":\"$CASH\",\"amount\":\"500\",\"dayOfMonth\":$DAY}"; RE=$(j .id); expect "регулярный расход: ближайший — сегодня" $TODAY "$(j .nextDate)"
post /money/recurring-expenses "{\"articleCode\":\"owner\",\"accountId\":\"$CASH\",\"amount\":\"500\",\"dayOfMonth\":1}"; expect "изъятие по расписанию — нельзя" OWNER_RECURRING "$(j .code)"
post /money/recurring-expenses "{\"articleCode\":\"delivery\",\"accountId\":\"$SAFE\",\"amount\":\"700\",\"dayOfMonth\":$DAY}"; expect "второй — из пустого сейфа" 201 $CODE
put /notifications/channels '{"channels":{"money.recurring_failed":{"inApp":true,"telegram":true}}}' >/dev/null
post /money/recurring-expenses/run '{}'; expect "проведён 1 (из сейфа — не хватило)" 1 "$(j .created)"
post /money/recurring-expenses/run '{}'; expect "повторный запуск ничего не дублирует" 0 "$(j .created)"
get /money/recurring-expenses; expect "следующая дата — через месяц" true "$(j "[.[]|select(.id==\"$RE\").nextDate > \"$TODAY\"]|all")"
get "/notifications?limit=20"; expect "уведомление «регулярный расход не проведён»" true "$(j '[.items[]?|select(.type=="money.recurring_failed")]|length >= 1')"

echo "7.1 Курсы НБКР, обмен, переоценка"
post /money/nbkr-rates/refresh '{}'; expect "курсы НБКР загружены" 87.450000 "$(j .rates.USD)"; expect "номинал 100 → за 1 тенге" 0.171200 "$(j .rates.KZT)"
get "/money/nbkr-rates?date=$TODAY"; expect "курс на дату" 87.45 "$(n $(j '.rates[]|select(.currency=="USD").rate'))"
TOMORROW=$(date -d "$TODAY +1 day" +%F); get "/money/nbkr-rates?date=$TOMORROW"; expect "на выходные — последний опубликованный" $TODAY "$(j '.rates[]|select(.currency=="USD").rateDate' | cut -c1-10)"
post /money/operations "{\"type\":\"cash_in\",\"toAccountId\":\"$CASH_USD\",\"amount\":\"200\"}" >/dev/null
post /money/operations "{\"type\":\"exchange\",\"fromAccountId\":\"$CASH_USD\",\"toAccountId\":\"$CASH\",\"amount\":\"50\",\"toAmount\":\"4400\"}"; expect "обмен 50 $ → 4400 сом" 201 $CODE
post /debts/payments "{\"counterpartyId\":\"$CUST\",\"direction\":\"in\",\"currency\":\"USD\",\"amount\":\"100\",\"accountId\":\"$CASH_USD\",\"shiftId\":\"$SHIFT\"}"; expect "аванс клиента 100 $" 201 $CODE
nbkr $MEND "88,0000"; post /money/nbkr-rates/refresh '{}' >/dev/null
post /money/revaluation "{\"month\":\"$MONTH\"}"; expect "переоценка: аванс 100 $ × (88 − 87.45), мы должны → −55" -55.00 "$(j .totalKgs)"
post /money/revaluation "{\"month\":\"$MONTH\"}"; expect "повторная переоценка месяца не удваивает" -55.00 "$(j .totalKgs)"
sleep 2
get "/reports/money.fx?from=${MONTH}-01&to=$MEND"; expect "курсовые разницы: обмен +25, переоценка −55" "-30.00" "$(n $(j .totals.amount))"

echo "7.1 Сверка переводов загрузкой выписки"
NOW=$(TZ=Asia/Bishkek date +%d.%m.%Y\ %H:%M)
printf 'Дата;Описание;Сумма\n%s;Перевод;1000,00\n' "$NOW" > $TMP/st.csv
FID=$(curl -s -X POST $API/files -H "Authorization: Bearer $T" -F "file=@$TMP/st.csv;type=text/csv" -F purpose=import | jq -r .id)
post /money/transfers/match "{\"accountId\":\"$WALLET\",\"fileId\":\"$FID\"}"; MV=$(j '.matches[0].movementId'); expect "перевод сопоставлен с выпиской" true "$(j '.matches|length == 1')"
get "/reports/money.unverified?groupBy=account"; expect "отчёт «несверенные» до подтверждения" 1 "$(j '.totals.transfers')"
post /money/transfers/verify "{\"ids\":[\"$MV\"]}"; expect "сверено" 1 "$(j .verified)"

echo "7.2 Отчёты"
get /reports; expect "каталог: все 8 групп" 8 "$(j length)"; CODES=$(j '[.[].reports[]|select(.path==null).code]|join(" ")')
errs=0; for c in $CODES; do get "/reports/$c?from=${MONTH}-01&to=$TODAY&productId=$A"; [ "$CODE" == 200 ] || { errs=$((errs+1)); echo "      $c: $CODE $(echo $BODY | head -c 200)"; }; done
expect "все отчёты считаются ($(echo $CODES | wc -w) шт.)" 0 $errs
get "/reports/sales.by?from=$TODAY&to=$TODAY"; expect "продажи: 3 шт на 3000" "3 3000.00" "$(j '.totals.qty') $(n $(j .totals.revenue))"; expect "маржа 60%" 60 "$(j '.totals.margin')"
get "/reports/sales.by?from=$TODAY&to=$TODAY&groupBy=customer"; expect "по клиентам: клиент и розничный" 2 "$(j '.rows|length')"
get "/reports/money.pnl?from=$TODAY&to=$TODAY"; PNL=$BODY
expect "прибыль: выручка 3000" 3000 "$(j .totals.revenue)"; expect "себестоимость 3 × 400" 1200 "$(j .totals.cost)"
expect "расходы: аренда 3000 + зарплата 100 + коммунальные 500 (отменённый и изъятие не входят)" 3600 "$(j .totals.expenses)"
expect "чистая прибыль = 3000 − 1200 − 3600 − 30" -1830 "$(j .totals.net)"; expect "изъятие — отдельной строкой" 1000 "$(j .totals.ownerWithdrawals)"
get "/reports/sales.by?from=$TODAY&to=$TODAY&groupBy=day"; expect "прибыль за день сходится с продажами" "$(echo $PNL | jq -r '.totals.gross')" "$(j '.totals.profit')"
get "/reports/money.cash_flow?from=$TODAY&to=$TODAY&groupBy=article"; expect "движение денег по статьям: аренда" 3000 "$(j '.rows[]|select(.name=="Аренда").outcome')"
put /money/salary-rules/$ME '{"baseMonthly":"10000","percent":"5","basis":"sales","planMonthly":"100000"}'; expect "мотивация задана" 201 "$( [ "$CODE" == 200 ] && echo 201 || echo $CODE)"
get "/reports/staff.motivation?from=$TODAY&to=$TODAY"; expect "мотивация: 5% от 3000 = 150, выплачено 100" "150 100" "$(j ".rows[]|select(.key==\"$ME\")|\"\(.bonus) \(.paid)\"")"
get "/reports/money.who_has"; expect "у кого сколько денег: кошелёк Азамата" true "$(j '[.rows[]|select(.holder != null or .typeLabel=="Кошелёк")]|length >= 1')"
get "/reports/stock.on_date?date=$TODAY"; expect "остаток на дату: 7 шт" 7 "$(j ".rows[]|select(.key==\"$A\").qty")"
get "/reports/stock.turnover?from=$TODAY&to=$TODAY"; expect "оборотная: приход 10, расход 3" "10 3" "$(j ".rows[]|select(.key==\"$A\")|\"\(.inQty) \(.outQty)\"")"
curl -s -o $TMP/x.xlsx "$API/reports/sales.by/xlsx?from=$TODAY&to=$TODAY" -H "Authorization: Bearer $T"; expect "выгрузка в Excel" PK "$(head -c 2 $TMP/x.xlsx)"
curl -s -o $TMP/x.pdf "$API/reports/money.pnl/pdf?from=$TODAY&to=$TODAY" -H "Authorization: Bearer $T"; expect "выгрузка в PDF" %PDF "$(head -c 4 $TMP/x.pdf)"
post /reports/views '{"report":"sales.by","name":"По брендам","params":{"groupBy":"brand"}}'; VID=$(j .id); get "/reports/views?report=sales.by"; expect "сохранённый вид" "По брендам" "$(j '.[0].name')"
req DELETE /reports/views/$VID "$T"; get /reports/views; expect "вид удалён" 0 "$(j length)"
post /reports/rebuild "{\"from\":\"$TODAY\",\"to\":\"$TODAY\"}"; get "/reports/sales.by?from=$TODAY&to=$TODAY"; expect "пересчёт таблицы не меняет итог" 3000.00 "$(n $(j .totals.revenue))"

echo "7.2 Дашборд"
get /dashboard; expect "плитки: выручка сегодня 3000" 3000 "$(j '.tiles[]|select(.key=="revenue").today')"; expect "чеков 2, средний 1500" "2 1500" "$(j '"\(.tiles[]|select(.key=="receipts").today) \(.tiles[]|select(.key=="avg").today)"')"
expect "сравнение со вчера и неделей назад" true "$(j '.tiles[0]|has("yesterday") and has("weekAgo")')"
expect "график по часам" true "$(j '.chart|length >= 1')"; expect "топ товаров" $A "$(j '.topProducts[0].id')"
expect "продажи по точкам" 3000 "$(j '.byStore[0].revenue')"; expect "деньги владельца" true "$(j '.money.totalKgs > 0')"
get "/dashboard?period=week"; expect "график за неделю — 7 дней" 7 "$(j '.chart|length')"

echo "7.3 Telegram"
get /me/telegram; expect "бот включён, не привязан" "true false" "$(j '"\(.botEnabled) \(.linked)"')"
post /me/telegram/link '{}'; LC=$(j .code); expect "ссылка на бота с кодом" "https://t.me/autoparts_test_bot?start=$LC" "$(j .deepLink)"
hook(){ curl -s -o $TMP/h.json -w "%{http_code}" -X POST $API/telegram/webhook -H "$J" -H "X-Telegram-Bot-Api-Secret-Token: $1" -d "$2"; }
expect "вебхук без секрета — 403" 403 "$(hook wrong '{}')"
hook hooksecret "{\"message\":{\"chat\":{\"id\":7001$R,\"type\":\"private\"},\"text\":\"/start BADCODE1\"}}" >/dev/null; expect "чужой код — бот отвечает «не подошёл»" true "$(tglast | grep -q 'не подошёл' && echo true || echo false)"
hook hooksecret "{\"message\":{\"chat\":{\"id\":7001$R,\"type\":\"private\"},\"text\":\"/start $LC\"}}" >/dev/null; expect "привязка: бот подтвердил" true "$(tglast | grep -q 'привязан' && echo true || echo false)"
get /me/telegram; expect "Telegram привязан" true "$(j .linked)"
post /money/recurring-expenses/run '{"today":"'$MEND'"}' >/dev/null; sleep 2
expect "уведомление пришло в Telegram (канал включён)" true "$(grep -q 'Регулярный расход' $TMP/tg.log && echo true || echo false)"
get /reports/summary/preview; expect "сводка: выручка, чеки" true "$(j '.text|test("Выручка: 3 000") and test("Чеков: 2")')"
post /reports/summary/send '{}'; expect "сводка отправлена в Telegram" 1 "$(j .telegram)"
expect "в сводке прибыль и долги" true "$(tglast | grep -q 'Прибыль' && tglast | grep -q 'Долги клиентов' && echo true || echo false)"
get /reports/summary/history; expect "история сводок" $TODAY "$(j '.[0].day')"
post /staff/transfer-ownership "{\"membershipId\":\"$(KEY)\",\"password\":\"secret123\"}"; expect "передача владения: нужен код из Telegram" TELEGRAM_CODE_REQUIRED "$(j .code)"
post /staff/transfer-ownership/code '{}'; expect "код передачи владения отправлен" true "$(tglast | grep -q 'передачи владения' && echo true || echo false)"
post /staff/transfer-ownership "{\"membershipId\":\"$(KEY)\",\"password\":\"secret123\",\"telegramCode\":\"000000\"}"; expect "неверный код — отказ" CODE_INVALID "$(j .code)"
req POST /auth/telegram-reset/request "" "{\"login\":\"0556${R}1\"}"; expect "сброс пароля: код в Telegram" true "$(tglast | grep -q 'сброса пароля' && echo true || echo false)"
RC=$(tglast | grep -o '[0-9]\{6\}' | head -1)
req POST /auth/telegram-reset/confirm "" "{\"login\":\"0556${R}1\",\"code\":\"000000\",\"password\":\"newpass123\"}"; expect "неверный код сброса" CODE_INVALID "$(j .code)"
req POST /auth/telegram-reset/confirm "" "{\"login\":\"0556${R}1\",\"code\":\"$RC\",\"password\":\"newpass123\"}"; expect "пароль сброшен" true "$(j .ok)"
req GET /auth/me "$T"; expect "старые сессии закрыты" SESSION_REVOKED "$(j .code)"
req POST /auth/login "" "{\"login\":\"0556${R}1\",\"password\":\"newpass123\"}"; expect "вход с новым паролем" true "$(j '.accessToken != null')"; T=$(j .accessToken)
req POST /auth/telegram-reset/request "" '{"login":"0999999999"}'; expect "неизвестный логин — тот же ответ" true "$(j .sent)"
hook hooksecret "{\"message\":{\"chat\":{\"id\":7001$R,\"type\":\"private\"},\"text\":\"/stop\"}}" >/dev/null; get /me/telegram; expect "/stop — отвязано" false "$(j .linked)"

kill $(cat /tmp/ext_stub.pid) 2>/dev/null
echo
echo "Итого: ✔ $pass  ✘ $fail"
rm -rf $TMP
[ $fail -eq 0 ]
