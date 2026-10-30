#!/usr/bin/env bash
# Смоук-проверка этапа 6 (умный подбор: VIN, код кузова, уточняющие вопросы, сторона/ось, фото номера, применимость).
#   bash scripts/smoke/stage6.sh      (из папки backend, API запущен с OCR_URL=http://127.0.0.1:8099/ocr; только dev-база)
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
q(){ python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
KEY(){ python3 -c "import uuid;print(uuid.uuid4())"; }
has(){ echo "$BODY" | jq -r --arg id "$1" '[.groups.here[],.groups.elsewhere[],.groups.noStock[]]|map(.id)|index($id) != null'; }
R=$(printf "%05d" $((RANDOM)))
R1=$(printf "%01d" $((RANDOM%10)))

echo "0. Подготовка"
req POST /auth/register "" "{\"name\":\"Подбор\",\"login\":\"sel${R}@x.kg\",\"password\":\"secret123\",\"shopName\":\"Подбор ${R}\"}"; T=$(j .accessToken)
post /onboarding/complete '{"shopType":"container","shopRateUsd":"87.50"}' >/dev/null
get /registers; REG=$(j '.[0].id')
get /price-types; RETAIL=$(j '.[]|select(.code=="retail").id')
get "/vehicles/resolve?q=$(q 'камри 40')"; GEN=$(j '.[0].generationId'); expect "камри 40 → поколение" true "$(j '.[0].generationId != null')"
get /vehicles/generations/$GEN/modifications; M2AZ=$(j '[.[]|select(.engineCode=="2AZ-FE")][0].id'); M2GR=$(j '[.[]|select(.engineCode=="2GR-FE")][0].id')
expect "модификации XV40 из справочника (2AZ, 2GR)" true "$([ "$M2AZ" != null ] && [ "$M2GR" != null ] && echo true || echo false)"
mk(){ post /products "$1"; [ "$CODE" == 201 ] || echo "      mk: $(echo $BODY | head -c 300)" >&2; local id=$(j .id); put /products/$id/prices "{\"items\":[{\"priceTypeId\":\"$RETAIL\",\"price\":\"${2:-1000}\"}]}" >/dev/null; echo $id; }
AP(){ echo "[{\"generationId\":\"$GEN\"$1}]"; }
P1=$(mk "{\"name\":\"Стойка амортизатора $R\",\"brand\":\"KYB\",\"number\":\"339001$R\",\"attributes\":{\"side\":\"Левая\",\"axle\":\"Передняя\"},\"applicability\":$(AP ',"yearFrom":2006,"yearTo":2009')}")
P2=$(mk "{\"name\":\"Стойка амортизатора $R\",\"brand\":\"KYB\",\"number\":\"339002$R\",\"attributes\":{\"side\":\"Левая\",\"axle\":\"Передняя\"},\"applicability\":$(AP ',"yearFrom":2009,"yearTo":2011')}")
P3=$(mk "{\"name\":\"Стойка амортизатора $R\",\"brand\":\"KYB\",\"number\":\"339003$R\",\"attributes\":{\"side\":\"Правая\",\"axle\":\"Передняя\"},\"applicability\":$(AP '')}")
P4=$(mk "{\"name\":\"Стойка амортизатора $R\",\"brand\":\"KYB\",\"number\":\"339004$R\",\"attributes\":{\"side\":\"Левая\",\"axle\":\"Задняя\"},\"applicability\":$(AP '')}")
P5=$(mk "{\"name\":\"Рейка рулевая $R\",\"brand\":\"JTEKT\",\"number\":\"RR1$R\",\"applicability\":$(AP ',"steering":"right"')}")
P6=$(mk "{\"name\":\"Рейка рулевая $R\",\"brand\":\"JTEKT\",\"number\":\"RR2$R\",\"applicability\":$(AP ',"steering":"left"')}")
P7=$(mk "{\"name\":\"Фильтр масляный $R\",\"brand\":\"Toyota\",\"number\":\"90915-YZZE1\",\"barcodes\":[\"4600000000015\"],\"applicability\":[{\"modificationId\":\"$M2AZ\"}]}")
P8=$(mk "{\"name\":\"Фильтр масляный $R\",\"brand\":\"Toyota\",\"number\":\"04152-31090\",\"applicability\":[{\"modificationId\":\"$M2GR\"}]}")
expect "товары созданы" true "$([ "$P1" != null ] && [ "$P8" != null ] && echo true || echo false)"

echo "6.1 VIN и код кузова"
get "/vehicles/decode-vin?vin=JTNBE46K673012345"
expect "VIN: марка Toyota" Toyota "$(j .makeName)"; expect "VIN: год по 10-му символу" 2007 "$(j .year)"
expect "VIN: модель Camry" true "$(j '.modelName|test("Camry";"i")')"; expect "VIN: поколение XV40" $GEN "$(j '.generations[0].id')"
get "/vehicles/decode-vin?vin=JTNBE46K67301234O"; expect "VIN с буквой O — ошибка" BAD_VIN "$(j .code)"
get "/vehicles/decode-vin?vin=YYY21099012345678"; expect "VIN неизвестной марки — ручной выбор" true "$(j .manual)"
get "/vehicles/body-code?code=ACV40-1234567"; expect "код кузова → XV40" $GEN "$(j .generation.id)"
expect "модификации с кузовом ACV40" true "$(j '[.modifications[]|select(.bodyCode=="ACV40")]|length >= 1')"
expect "чужие кузова (GSV40) отсеяны" 0 "$(j '[.modifications[]|select(.bodyCode=="GSV40")]|length')"
get "/vehicles/body-code?code=ZZZ99-1"; expect "неизвестный кузов — не найден" false "$(j .found)"

echo "6.1 Уточняющие вопросы и сторона/ось"
get "/search?q=$(q "стойка перед лев камри 40")&log=false"
expect "«стойка перед лев камри 40»: левая передняя до рестайлинга" true "$(has $P1)"; expect "…и после рестайлинга" true "$(has $P2)"
expect "правая отсеяна" false "$(has $P3)"; expect "задняя отсеяна" false "$(has $P4)"
expect "сторона и ось распознаны" "Левая Передняя" "$(j '.selection.side + " " + .selection.axle')"
expect "вопрос «До или после рестайлинга?»" "До или после рестайлинга?" "$(j '.clarify[]|select(.key=="year").question')"
Y1=$(j '.clarify[]|select(.key=="year").options[0].value'); Y2=$(j '.clarify[]|select(.key=="year").options[1].value')
get "/search?q=$(q "стойка перед лев камри 40")&year=$Y1&log=false"; expect "ответ «до» ($Y1) → только дорестайлинг" "true false" "$(has $P1) $(has $P2)"
expect "после ответа вопрос не повторяется" 0 "$(j '[.clarify[]|select(.key=="year")]|length')"
get "/search?q=$(q "стойка перед лев камри 40")&year=$Y2&log=false"; expect "ответ «после» ($Y2) → только рестайлинг" "false true" "$(has $P1) $(has $P2)"
get "/search?q=$(q "стойка камри 40")&log=false"; expect "без стороны: вопросы «Левая или правая?» и «Передняя или задняя?»" "side axle" "$(j '[.clarify[]|select(.key=="side" or .key=="axle").key]|join(" ")')"
get "/search?q=$(q "стойка камри 40")&side=$(q Правая)&log=false"; expect "сторона параметром" "true false" "$(has $P3) $(has $P1)"
get "/search?q=$(q "рейка камри 40")&log=false"; expect "рейки: вопрос про руль" true "$(j '[.clarify[]|select(.key=="steering")]|length == 1')"
get "/search?q=$(q "рейка камри 40 правый руль")&log=false"; expect "«правый руль» в запросе → только правая рейка" "true false" "$(has $P5) $(has $P6)"
expect "руль в selection" right "$(j .selection.steering)"
get "/search?q=$(q "фильтр масляный камри 40")&log=false"; expect "фильтры: «Какой двигатель?»" "Какой двигатель?" "$(j '.clarify[]|select(.key=="modificationId").question')"
expect "варианты — коды двигателей" true "$(j '[.clarify[]|select(.key=="modificationId").options[].label]|any(test("2GR"))')"
get "/search?q=$(q "фильтр масляный")&modificationId=$M2GR&log=false"; expect "по модификации 2GR — только свой фильтр" "true false" "$(has $P8) $(has $P7)"
get "/search?q=$(q "лев")&log=false"; expect "одно «лев» ищется как текст (не пусто по ошибке)" 200 $CODE

echo "6.1 Машина клиента и VIN в поиске"
post /counterparties "{\"name\":\"Азамат $R\",\"roles\":[\"customer\"],\"phone\":\"0555${R}1\"}"; CP=$(j .id)
post /counterparties/$CP/vehicles "{\"title\":\"Камри Азамата\",\"bodyCode\":\"ACV40\",\"year\":2007}"; CV=$(j .id); expect "машина в гараже" 201 $CODE
get "/search?q=$(q "стойка перед лев")&customerVehicleId=$CV&log=false"
expect "подбор под машину клиента (кузов ACV40, 2007)" "true false" "$(has $P1) $(has $P2)"; expect "источник — машина клиента" customer_vehicle "$(j .selection.source)"
get "/search?q=$(q "стойка перед лев")&vin=JTNBE46K673012345&log=false"; expect "подбор по VIN (2007)" "true false" "$(has $P1) $(has $P2)"; expect "источник — VIN" vin "$(j .selection.source)"
get "/search?q=$(q "стойка перед лев")&bodyCode=ACV40-1234567&log=false"; expect "подбор по коду кузова" true "$(has $P1)"
get "/search?q=&customerVehicleId=$CV&log=false"; expect "пустой запрос + машина → всё для неё" true "$(j '.total >= 3')"

echo "6.2 Фото номера"
python3 - $TMP/p.png <<'PY'
import sys,zlib,struct
def ch(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
raw=b''.join(b'\x00'+b'\xff'*30 for _ in range(10))
open(sys.argv[1],'wb').write(b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',10,10,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw))+ch(b'IEND',b''))
PY
up(){ CODE=$(curl -s -o $TMP/r.json -w "%{http_code}" -X POST "$API/ocr/recognize" -H "Authorization: Bearer $T" -F "file=@$TMP/p.png;type=image/png" -F "context=pos"); BODY=$(cat $TMP/r.json); }
[ -f /tmp/ocr_stub.pid ] && kill $(cat /tmp/ocr_stub.pid) 2>/dev/null; sleep 0.3
up; expect "сервис OCR недоступен → 503" 503 $CODE; expect "…код OCR_UNAVAILABLE (касса предложит ввод)" OCR_UNAVAILABLE "$(j .code)"
echo '[{"text":"MADE IN JAPAN","score":0.99},{"text":"90915-YZZE1","score":0.93},{"text":"12.05.2023","score":0.9},{"text":"1500 сом","score":0.9},{"text":"4600000000015","score":0.95}]' > $TMP/lines.json
python3 scripts/smoke/lib/ocr_stub.py $TMP/lines.json 8099 & STUB=$!; echo $STUB > /tmp/ocr_stub.pid; sleep 0.7
get /ocr/status; expect "OCR включён" true "$(j .enabled)"
up; expect "фото распознано" 201 $CODE; OCR1=$(j .id)
expect "номер найден по фото" true "$(j "[.candidates[]|select(.value==\"90915YZZE1\").products[].id]|index(\"$P7\") != null")"
expect "штрихкод с этикетки — как штрихкод" barcode "$(j '.candidates[]|select(.value=="4600000000015").kind')"
expect "дата и цена отброшены" 0 "$(j '[.candidates[]|select(.value=="12052023" or .value=="1500")]|length')"
expect "лучший кандидат найден" true "$(j .best.found)"; expect "кнопок «создать» нет" 0 "$(j '.actions|length')"
FID=$(j .fileId)
echo '[{"text":"Part No: ZX-77Q1'$R'","score":0.88}]' > $TMP/lines.json
curl -s -o $TMP/r.json -w "%{http_code}" -X POST "$API/ocr/recognize" -H "Authorization: Bearer $T" -H "$J" -d "{\"fileId\":\"$FID\"}" >/dev/null; BODY=$(cat $TMP/r.json)
expect "по fileId: номер не найден" false "$(j .best.found)"
expect "кнопки: создать товар с номером + заявка с фото" "create_product customer_request" "$(j '[.actions[].type|select(.=="create_product" or .=="customer_request")]|join(" ")')"
expect "номер подставлен" "ZX77Q1$R" "$(j '.actions[]|select(.type=="create_product").number')"
post /ocr/$OCR1/correction "{\"correctedText\":\"90915-YZZE1\",\"chosenProductId\":\"$P7\"}"; expect "исправление сохранено" 90915-YZZE1 "$(j .correctedText)"
get /ocr/stats; expect "статистика: 2 распознавания, 1 найдено, 1 исправлено" "2 1 1" "$(j '"\(.total) \(.found) \(.corrected)"')"
kill $STUB 2>/dev/null

echo "6.3 Проверить применимость"
post /shifts/open "{\"registerId\":\"$REG\",\"cash\":{\"KGS\":\"5000\"}}" >/dev/null
post /pos/sales "{\"registerId\":\"$REG\",\"idempotencyKey\":\"$(KEY)\",\"lines\":[{\"productId\":\"$P1\",\"qty\":\"1\"}],\"payments\":[{\"method\":\"cash\",\"amount\":\"1000\"}]}"; RS=$(j .id); LS=$(j '.lines[0].id')
expect "продажа стойки" 201 $CODE
post /pos/returns "{\"registerId\":\"$REG\",\"saleReceiptId\":\"$RS\",\"lines\":[{\"saleLineId\":\"$LS\",\"qty\":\"1\",\"reason\":\"not_fit\",\"noInstallMarks\":true,\"triedVehicleTitle\":\"Toyota Ipsum 2003\"}]}"
expect "возврат «не подошло»" 201 $CODE
get /catalog/fit-issues; expect "в списке «Проверить применимость»" true "$(j "[.[]|select(.productId==\"$P1\" and (.vehicles|index(\"Toyota Ipsum 2003\") != null))]|length == 1")"
FI=$(j "[.[]|select(.productId==\"$P1\")][0].issues[0].id")
get /products/$P1; expect "в карточке пометка «есть возвраты на Ipsum 2003»" true "$(j '.fitWarning|test("Ipsum 2003")')"
post /catalog/fit-issues/$FI/resolve '{"note":"на Ipsum не ставится, применимость верна"}'; expect "разобрано" true "$(j .resolved)"
get /catalog/fit-issues; expect "список пуст" 0 "$(j "[.[]|select(.productId==\"$P1\")]|length")"
get /products/$P1; expect "пометка снята" null "$(j .fitWarning)"
get "/search?q=$(q "бампер камри 40")"; get /search/unfound
expect "«Что спрашивают, но нет» — с машиной" true "$(j '[.[]|select(.example=="бампер камри 40")][0].vehicles|length >= 1')"

echo
echo "Итого: ✔ $pass  ✘ $fail"
rm -rf $TMP
[ $fail -eq 0 ]
