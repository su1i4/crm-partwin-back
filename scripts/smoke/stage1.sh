#!/usr/bin/env bash
# Смоук-проверка этапа 1 (каталог, номера, аналоги, применимость, поиск, импорт).
#   bash scripts/smoke/stage1.sh      (из папки backend, API запущен; только dev-база)
set -u
set -a; [ -f .env ] && . ./.env; set +a
API=${API:-http://localhost:${PORT:-3000}/api}
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
get(){ req GET "$1" "$T"; }
post(){ req POST "$1" "$T" "$2"; }
urlq(){ python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
R=$(printf "%05d" $((RANDOM)))

echo "0. Магазин"
req POST /auth/register "" "{\"name\":\"Каталог\",\"login\":\"cat${R}@x.kg\",\"password\":\"secret123\",\"shopName\":\"Каталог\"}"; T=$(echo $BODY | jq -r .accessToken)
post /onboarding/complete '{"shopType":"city","ourMakes":["toyota","lexus"]}'; expect "мастер" 201 $CODE
get /categories; CAT_FILTERS=$(echo $BODY | jq -r '.[]|select(.presetCode=="filters_oil").id'); CAT_CV=$(echo $BODY | jq -r '.[]|select(.presetCode=="cv_joints").id'); CAT_SEALS=$(echo $BODY | jq -r '.[]|select(.presetCode=="seals").id'); CAT_PADS=$(echo $BODY | jq -r '.[]|select(.presetCode=="brake_pads").id'); CAT_OILS=$(echo $BODY | jq -r '.[]|select(.presetCode=="engine_oils").id'); CAT_MAINT=$(echo $BODY | jq -r '.[]|select(.presetCode=="maintenance").id')
get /part-types; PT_FILTER=$(echo $BODY | jq -r '.types[]|select(.code=="filter").id'); PT_SEAL=$(echo $BODY | jq -r '.types[]|select(.code=="seal").id'); PT_BELT=$(echo $BODY | jq -r '.types[]|select(.code=="belt").id'); PT_BEAR=$(echo $BODY | jq -r '.types[]|select(.code=="bearing").id')

echo "1.1 Справочники"
get "/brands?q=bos"; expect "Bosch в общем справочнике" Bosch "$(echo $BODY | jq -r '.[0].name')"
post /brands '{"name":"Lemförder"}'; expect "Lemförder = Lemforder (глобальный)" Lemforder "$(echo $BODY | jq -r .name)"
post /brands '{"name":"АвтоМир","aliases":["AvtoMir"]}'; expect "свой бренд" 201 $CODE; OWN_BRAND=$(echo $BODY | jq -r .id)
post /brands '{"name":"avtomir"}'; expect "дубль по синониму — 409" BRAND_EXISTS $(echo $BODY | jq -r .code)
post /categories "{\"name\":\"Моя группа\",\"parentId\":\"$CAT_MAINT\"}"; MYCAT=$(echo $BODY | jq -r .id); MYVER=$(echo $BODY | jq -r .version); expect "подкатегория" 201 $CODE
req PATCH /categories/$MYCAT "$T" "{\"version\":$MYVER,\"parentId\":null}"; expect "перенос в корень" 0 $(echo $BODY | jq .level)
post /part-types '{"name":"Ремень ГРМ особый","attributes":[{"name":"Зубья","code":"teeth","valueType":"number","searchable":true}]}'; expect "свой тип детали" 201 $CODE

echo "1.2 Товары"
post /products "{\"name\":\"Фильтр масляный\",\"brand\":\"BOSCH\",\"number\":\"0 986-452.041\",\"oemNumbers\":[\"90915-YZZE1\"],\"categoryId\":\"$CAT_FILTERS\",\"partTypeId\":\"$PT_FILTER\",\"attributes\":{\"filter_kind\":\"Масляный\",\"height\":\"86\"},\"generateBarcode\":true,\"retailPrice\":\"650\",\"applicability\":[{\"text\":\"камри 40\"}],\"units\":[{\"name\":\"коробка\",\"factor\":\"20\",\"barcode\":\"4047024000001\"}]}"
expect "создан фильтр Bosch" 201 $CODE; P_BOSCH=$(echo $BODY | jq -r .id); VER=$(echo $BODY | jq .version)
expect "номер как ввели" "0 986-452.041" "$(echo $BODY | jq -r .mainNumber)"
expect "нормализован" 0986452041 "$(echo $BODY | jq -r '.numbers[]|select(.type=="manufacturer").normalized')"
BC=$(echo $BODY | jq -r '.units[]|select(.isBase).barcodes[0].barcode'); expect "внутренний EAN-13 с 25" 25 ${BC:0:2}
expect "класс по бренду — аналог" aftermarket $(echo $BODY | jq -r .qualityClass)
expect "розничная цена" 650.00 $(echo $BODY | jq -r '.prices[0].price')
expect "применимость Camry XV40" "Toyota Camry XV40" "$(echo $BODY | jq -r '.applicability[0].label')"
expect "гарантия из категории не задана" null $(echo $BODY | jq .effective.warrantyDays)
post /products '{"name":"Дубль","brand":"Robert Bosch","number":"0986452041"}'; expect "дубль Bosch+номер — 409" DUPLICATE_PART_NUMBER $(echo $BODY | jq -r .code)
post /products '{"name":"Другой","brand":"Mann","number":"0986452041"}'; expect "тот же номер другого бренда — можно" 201 $CODE
post /products "{\"name\":\"Ч\",\"barcodes\":[\"$BC\"]}"; expect "чужой штрихкод — предупреждение" BARCODE_DUPLICATE $(echo $BODY | jq -r .code)
post /products "{\"name\":\"Ч\",\"barcodes\":[\"$BC\"],\"confirmDuplicateBarcode\":true}"; expect "с подтверждением — сохраняется" 201 $CODE
get "/products/by-barcode/$BC"; expect "скан общего штрихкода — выбор" true $(echo $BODY | jq .ambiguous)
post /products "{\"name\":\"Х\",\"partTypeId\":\"$PT_SEAL\",\"attributes\":{\"dimensions\":\"35x52\"}}"; expect "неверный размер — ошибка атрибута" ATTRIBUTES_INVALID $(echo $BODY | jq -r .code)
T0=$(date +%s%3N); post /products/quick '{"name":"Колодки передние","number":"04465-33450","brand":"Toyota","price":"3200","vehicles":["камри 40"]}'; T1=$(date +%s%3N)
expect "быстрое создание" 201 $CODE; P_PADS_TOY=$(echo $BODY | jq -r .id); expect "оригинал Toyota" original $(echo $BODY | jq -r .qualityClass)
[ $((T1-T0)) -lt 1500 ] && ok "быстрое создание за $((T1-T0)) мс" || bad "быстрое создание медленно: $((T1-T0)) мс"
post /products/quick '{"name":"Колодки передние (Китай)","number":"04465-33450","price":"900","qualityClass":"copy"}'; expect "no-name с OEM-номером" 201 $CODE; P_PADS_CN=$(echo $BODY | jq -r .id)
post /products/quick '{"name":"Колодки передние (Китай 2)","number":"04465-33450","price":"850"}'; expect "вторая копия того же OEM не конфликтует" 201 $CODE
req PATCH /products/$P_BOSCH "$T" "{\"version\":$VER,\"name\":\"Фильтр масляный Bosch\"}"; expect "изменили" 200 $CODE
req PATCH /products/$P_BOSCH "$T" "{\"version\":$VER,\"name\":\"x\"}"; expect "старая версия — 409" VERSION_CONFLICT $(echo $BODY | jq -r .code)
get "/audit?entityId=$P_BOSCH"; expect "история карточки" true $(echo $BODY | jq '.total >= 2')
post /products "{\"name\":\"Комплект ТО Camry\",\"kind\":\"kit\",\"kitComponents\":[{\"productId\":\"$P_BOSCH\",\"qty\":\"1\"}]}"; expect "комплект" 201 $CODE
post /products '{"name":"Замена масла","kind":"service"}'; expect "услуга без контроля остатка" true $(echo $BODY | jq .noStockControl)

echo "1.3 Аналоги"
post /crosses '{"aBrand":"Bosch","aNumber":"0986452041","bBrand":"Mann","bNumber":"W 68/3"}'; expect "кросс Bosch ↔ Mann" true $(echo $BODY | jq .created)
post /crosses '{"aBrand":"Mann","aNumber":"W68/3","bBrand":"Bosch","bNumber":"0 986 452 041"}'; expect "обратный кросс — не дубль" false $(echo $BODY | jq .created)
post /crosses '{"aBrand":"Mann","aNumber":"W68/3","bBrand":"Sakura","bNumber":"C-1139"}'; expect "кросс Mann ↔ Sakura" true $(echo $BODY | jq .created)
post /crosses '{"aBrand":"Sakura","aNumber":"C1139","bBrand":"Bosch","bNumber":"0986452041"}'; expect "цикл A→B→C→A" true $(echo $BODY | jq .created)
post /products '{"name":"Фильтр Mann","brand":"Mann","number":"W 68/3"}'; P_MANN=$(echo $BODY | jq -r .id)
post /products '{"name":"Фильтр Sakura","brand":"Sakura","number":"C-1139"}'; P_SAK=$(echo $BODY | jq -r .id)
post /products '{"name":"Фильтр Toyota","brand":"Toyota Genuine","number":"90915-YZZE1"}'; P_TOY=$(echo $BODY | jq -r .id)
get /products/$P_BOSCH/analogs; expect "аналоги найдены без зацикливания" 3 $(echo $BODY | jq "[.[]|select(.id==\"$P_MANN\" or .id==\"$P_SAK\" or .id==\"$P_TOY\")]|length")
expect "оригинал Toyota — через общий OEM" oem "$(echo $BODY | jq -r ".[]|select(.id==\"$P_TOY\").via")"
get /products/$P_TOY/analogs; expect "у оригинала Toyota через OEM — Bosch" 1 $(echo $BODY | jq "[.[]|select(.id==\"$P_BOSCH\")]|length")
expect "Mann у оригинала — через аналог (уровень 2)" true "$(echo $BODY | jq -r "[.[]|select(.id==\"$P_MANN\")][0].throughAnalog")"

echo "1.4 Применимость и дерево по маркам"
get "/vehicles/resolve?q=$(urlq 'камри 40')"; expect "«камри 40» → XV40" XV40 "$(echo $BODY | jq -r '.[0].generationName')"
get "/vehicles/resolve?q=ACV40"; expect "код кузова ACV40 → XV40" XV40 "$(echo $BODY | jq -r '.[0].generationName')"
get "/vehicles/resolve?q=$(urlq 'фит')"; expect "«фит» → Honda Fit" Fit "$(echo $BODY | jq -r '.[0].modelName')"
get "/vehicles/resolve?q=$(urlq 'крузак 200')"; expect "«крузак 200»" 200 "$(echo $BODY | jq -r '.[0].generationName')"
get "/vehicles/resolve?q=$(urlq 'lexus es 350 2008')"; LEX_ES=$(echo $BODY | jq -r '.[0].generationId')
req PUT /products/$P_BOSCH/applicability "$T" "{\"items\":[{\"text\":\"камри 40\"},{\"generationId\":\"$LEX_ES\"}]}"; expect "применимость Toyota + Lexus" 2 $(echo $BODY | jq length)
get "/catalog/tree/makes?depth=generation"
expect "в ветке Toyota" true $(echo $BODY | jq '[.ourMakes[]|select(.name=="Toyota")][0].count >= 1')
expect "и в ветке Lexus" true $(echo $BODY | jq '[.ourMakes[]|select(.name=="Lexus")][0].count >= 1')
expect "наши марки первыми" 2 $(echo $BODY | jq '.ourMakes|length')
CAMRY40=$(echo $BODY | jq -r '[.ourMakes[]|select(.name=="Toyota")][0].models[]|select(.name=="Camry").generations[]|select(.name=="XV40").id')
get "/products?generationId=$CAMRY40"; expect "товары Camry XV40" true $(echo $BODY | jq '.total >= 2')
post /products "{\"name\":\"Масло моторное 5W-30 4л\",\"brand\":\"ZIC\",\"categoryId\":\"$CAT_OILS\"}"
get "/products?vehicleBranch=universal"; expect "масло — в «Универсальное»" 1 $(echo $BODY | jq '[.items[]|select(.name|test("Масло"))]|length')
post /products/$P_BOSCH/applicability/copy "{\"toProductIds\":[\"$P_MANN\"]}"; expect "скопировать применимость" 2 $(echo $BODY | jq .added)

echo "1.5 Поиск"
srch(){ get "/search?q=$(urlq "$1")&log=${2:-true}"; }
post /products "{\"name\":\"ШРУС наружный\",\"brand\":\"GSP\",\"number\":\"817001\",\"categoryId\":\"$CAT_CV\",\"applicability\":[{\"text\":\"камри 40\"}]}"
post /products "{\"name\":\"Сальник коленвала\",\"brand\":\"NOK\",\"number\":\"AH2885\",\"categoryId\":\"$CAT_SEALS\",\"partTypeId\":\"$PT_SEAL\",\"attributes\":{\"dimensions\":\"35x52x7\"}}"
post /products "{\"name\":\"Ремень поликлиновой\",\"brand\":\"Gates\",\"partTypeId\":\"$PT_BELT\",\"attributes\":{\"profile_length\":\"6PK1200\"}}"
post /products "{\"name\":\"Подшипник\",\"brand\":\"SKF\",\"partTypeId\":\"$PT_BEAR\",\"attributes\":{\"bearing_number\":\"6203\",\"dimensions\":\"17x40x12\"}}"
post /products "{\"name\":\"Колодки тормозные передние\",\"brand\":\"Akebono\",\"number\":\"AN-685WK\",\"categoryId\":\"$CAT_PADS\",\"applicability\":[{\"text\":\"камри 40\"}]}"
post /products "{\"name\":\"Колодки тормозные передние\",\"brand\":\"Akebono\",\"number\":\"AN-111\",\"categoryId\":\"$CAT_PADS\",\"applicability\":[{\"text\":\"фит ge\"}]}"
all(){ echo $BODY | jq -r '[.groups.here[],.groups.elsewhere[],.groups.noStock[]]|map(.name)|join("|")'; }
srch "0986-452 041"; expect "номер с дефисами" number "$(echo $BODY | jq -r '[.groups.here[],.groups.noStock[]][0].matchKind')"
srch "О986452О41"; expect "кириллица О вместо нуля" true $(echo $BODY | jq '.total >= 1')
srch "0986452O4l"; expect "путаница O/0, l/1" true $(echo $BODY | jq '[.groups.here[],.groups.noStock[]]|map(.matchKind)|index("number_confusable") != null')
srch "0986452014"; expect "опечатка в номере (нечётко)" true $(echo $BODY | jq '.total >= 1')
srch "граната"; expect "«граната» → ШРУС" true "$(all | grep -q ШРУС && echo true || echo false)"
srch "kolodki"; expect "транслит kolodki" true "$(all | grep -q Колодки && echo true || echo false)"
srch "rjkjlrb"; expect "раскладка rjkjlrb" true "$(all | grep -q Колодки && echo true || echo false)"
srch "35 52 7"; expect "размер сальника «35 52 7»" true "$(all | grep -q Сальник && echo true || echo false)"
srch "6PK1200"; expect "ремень 6PK1200" true "$(all | grep -q Ремень && echo true || echo false)"
srch "6203"; expect "подшипник 6203" true "$(all | grep -q Подшипник && echo true || echo false)"
srch "колодки камри 40"; expect "машина распознана" XV40 "$(echo $BODY | jq -r .vehicle.generationName)"
expect "только колодки на Camry (не на Fit)" false "$(echo $BODY | jq -r '[.groups.here[],.groups.noStock[]]|map(.mainNumber)|index("AN-111") != null')"
expect "колодки на Camry найдены" true "$(echo $BODY | jq -r '[.groups.here[],.groups.noStock[]]|map(.mainNumber)|index("AN-685WK") != null')"
srch "колодка перед"; expect "«колодка перед» → колодки передние" true "$(all | grep -q 'Колодки тормозные передние' && echo true || echo false)"
srch "04465-33450"; expect "лестница: оригинал первым" original "$(echo $BODY | jq -r '[.groups.here[],.groups.noStock[]][0].qualityClass')"
expect "в лестнице оригинал и копия" true $(echo $BODY | jq '[.ladder[].qualityClass]|(index("original") != null and index("copy") != null)')
srch "0986452041"; expect "у номера Bosch — аналоги" true $(echo $BODY | jq '.groups.analogs|length >= 2')
srch "бочонок глушителя"; expect "ничего не нашли → кнопки" create_product $(echo $BODY | jq -r '.actions[0]')
get /search/unfound; expect "запрос записан в «Что спрашивают, но нет»" true "$(echo $BODY | jq '[.[]|select(.example=="бочонок глушителя")]|length == 1')"
post /search/synonyms '{"word":"бочонок","target":"глушитель"}'; expect "свой синоним" 201 $CODE
post /products '{"name":"Глушитель задний","brand":"Bosal"}'
srch "бочонок" false; expect "свой синоним работает" true "$(all | grep -q Глушитель && echo true || echo false)"
for q in "0986452041" "граната" "колодки камри 40" "35 52 7"; do srch "$q" false; echo "     $(echo $BODY | jq .tookMs) мс — $q"; done

echo "1.6 Импорт и массовые операции"
node -e '
const ExcelJS = require("exceljs");
(async () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Товары");
  ws.addRow(["Наименование", "Артикул", "Производитель", "Цена", "Группа", "Применимость", "Штрихкод"]);
  for (let i = 1; i <= 5000; i++) {
    const bad = i % 500 === 0;
    ws.addRow([bad ? "" : "Деталь тест " + i, bad ? "" : "TST-" + String(i).padStart(5, "0"), i % 2 ? "Febi" : "Swag",
               i % 997 === 0 ? "дорого" : String(100 + i), i % 3 ? "Фильтры" : "Моя новая группа/Подгруппа", i % 10 === 0 ? "камри 40" : "", ""]);
  }
  await wb.xlsx.writeFile(process.argv[1]);
})();' $TMP/import.xlsx
C=$(curl -s -o $TMP/f.json -w "%{http_code}" -X POST $API/files -H "Authorization: Bearer $T" -F "file=@$TMP/import.xlsx;type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" -F purpose=import); FID=$(jq -r .id $TMP/f.json)
post /imports "{\"type\":\"products\",\"fileId\":\"$FID\"}"; expect "файл распознан, 5000 строк" 5000 $(echo $BODY | jq .job.totalRows); JOB=$(echo $BODY | jq -r .job.id)
MAP=$(echo $BODY | jq -c .suggestedMapping); expect "колонки угаданы (название, номер, бренд, цена)" true $(echo $MAP | jq 'has("name") and has("number") and has("brand") and has("price")')
post /imports/$JOB/preview "{\"mapping\":$MAP,\"options\":{\"createCategories\":true}}"; expect "предпросмотр" 200 $CODE
expect "ошибки по строкам найдены" true $(echo $BODY | jq '.errorRows >= 10')
expect "у ошибки есть номер строки" true $(echo $BODY | jq '.errors[0].row > 1')
post /imports/$JOB/run '{}'; expect "запуск в фоне" 202 $CODE
for i in $(seq 1 120); do get /imports/$JOB; S=$(echo $BODY | jq -r .status); [ "$S" == "done" ] || [ "$S" == "failed" ] && break; sleep 1; done
expect "импорт завершён" done $S
expect "загружены только корректные строки" true $(echo $BODY | jq '.createdCount >= 4980 and .errorCount >= 10')
echo "     создано $(echo $BODY | jq .createdCount), ошибок $(echo $BODY | jq .errorCount), за $(( $(date -d "$(echo $BODY | jq -r .finishedAt)" +%s) - $(date -d "$(echo $BODY | jq -r .startedAt)" +%s) )) с"
srch "TST-00010"; expect "загруженный товар ищется" true $(echo $BODY | jq '.total >= 1')
get "/categories"; expect "создан путь категорий из файла" 1 $(echo $BODY | jq '[.[]|select(.name=="Подгруппа")]|length')
# повторная загрузка того же файла — обновляет, а не дублирует
post /imports "{\"type\":\"products\",\"fileId\":\"$FID\"}"; JOB2=$(echo $BODY | jq -r .job.id)
post /imports/$JOB2/preview "{\"mapping\":$MAP,\"options\":{\"createCategories\":true}}"; expect "предпросмотр: найдёт существующие" true $(echo $BODY | jq '.wouldUpdate >= 4980')
post /imports/$JOB2/run '{}'
for i in $(seq 1 120); do get /imports/$JOB2; S=$(echo $BODY | jq -r .status); [ "$S" == "done" ] || [ "$S" == "failed" ] && break; sleep 1; done
expect "повтор: обновлено, не создано" true $(echo $BODY | jq '.createdCount == 0 and .updatedCount >= 4980')
post /imports/$JOB/rollback '{}'; expect "откат первой загрузки" true $(echo $BODY | jq '.removedProducts >= 4980')
srch "TST-00010" false; expect "после отката товара нет" 0 $(echo $BODY | jq '[.groups.here[],.groups.noStock[]]|length')
# кроссы из CSV в кодировке 1С (Windows-1251, разделитель ;)
printf 'Бренд;Номер;Бренд аналога;Номер аналога\nBosch;0 986 452 041;Filtron;OP 641\nMann;W 68/3;Hengst;H14W30\n' | iconv -f utf-8 -t cp1251 > $TMP/cross.csv
C=$(curl -s -o $TMP/f.json -w "%{http_code}" -X POST $API/files -H "Authorization: Bearer $T" -F "file=@$TMP/cross.csv;type=text/csv" -F purpose=import); FID2=$(jq -r .id $TMP/f.json)
post /imports "{\"type\":\"crosses\",\"fileId\":\"$FID2\"}"; JOB3=$(echo $BODY | jq -r .job.id); expect "CSV в cp1251 прочитан" "Бренд аналога" "$(echo $BODY | jq -r '.columns[2]')"
MAP3=$(echo $BODY | jq -c .suggestedMapping)
post /imports/$JOB3/preview "{\"mapping\":$MAP3}"; post /imports/$JOB3/run '{}'
for i in $(seq 1 30); do get /imports/$JOB3; S=$(echo $BODY | jq -r .status); [ "$S" == "done" ] && break; sleep 1; done
expect "кроссы загружены" 2 $(echo $BODY | jq .createdCount)
get /products/$P_BOSCH/crosses; expect "кросс Bosch ↔ Filtron виден" true $(echo $BODY | jq '[.[]|select(.bNumber=="OP 641" or .aNumber=="OP 641")]|length == 1')
# массовые операции
get "/products?q=$(urlq 'Колодки')"; IDS=$(echo $BODY | jq -c '[.items[].id]')
post /products/bulk "{\"ids\":$IDS,\"set\":{\"addTags\":[\"тормоза\"],\"categoryId\":\"$CAT_PADS\"}}"; expect "массовое изменение" true $(echo $BODY | jq '.updated >= 3')
get "/products?tag=$(urlq 'тормоза')"; expect "тег у всех выбранных" $(echo $IDS | jq length) $(echo $BODY | jq .total)
post /products "{\"name\":\"Фильтр Bosch дубль\",\"brand\":\"Без бренда\",\"number\":\"0986452041\",\"barcodes\":[\"2000000000017\"]}"; DUP=$(echo $BODY | jq -r .id)
post /products/$P_BOSCH/merge "{\"duplicateIds\":[\"$DUP\"]}"; expect "дубль объединён" 200 $CODE
expect "штрихкод дубля перенесён" true $(echo $BODY | jq '[.units[].barcodes[].barcode]|index("2000000000017") != null')
get /products/$DUP; expect "дубль в архиве со ссылкой" "$P_BOSCH" $(echo $BODY | jq -r .mergedIntoId)
get "/products/to-fill"; expect "«Дозаполнить» считает пробелы" true $(echo $BODY | jq '.total >= 1 and (.summary|length) == 6')

echo "Изоляция"
req POST /auth/register "" "{\"name\":\"Чужой\",\"login\":\"oth${R}@x.kg\",\"password\":\"secret123\",\"shopName\":\"Чужой\"}"; T2=$(echo $BODY | jq -r .accessToken)
req GET "/search?q=0986452041" "$T2"; expect "чужой магазин ничего не находит" 0 $(echo $BODY | jq .total)
req GET "/products/$P_BOSCH" "$T2"; expect "чужая карточка — 404" 404 $CODE
req GET "/products/$P_BOSCH/analogs" "$T2"; expect "чужие аналоги — 404" 404 $CODE

echo; echo "Итог: ✔ $pass  ✘ $fail"
