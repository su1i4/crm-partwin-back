import type { ImportType } from './entities/import-job.entity';

export interface ImportField {
  key: string;
  label: string;
  required?: boolean;
  /** Заголовки колонок, по которым поле угадывается само */
  guess: string[];
}

export const IMPORT_FIELDS: Record<ImportType, ImportField[]> = {
  products: [
    { key: 'name', label: 'Название', guess: ['наименование', 'название', 'name', 'товар', 'номенклатура', 'наименование товара', 'полное наименование', 'номенклатура.наименование'] },
    { key: 'number', label: 'Номер производителя', guess: ['номер', 'артикул', 'каталожный номер', 'part number', 'номер детали', 'partnumber', 'код производителя'] },
    { key: 'brand', label: 'Бренд', guess: ['бренд', 'производитель', 'brand', 'manufacturer', 'марка производителя', 'фирма'] },
    { key: 'sku', label: 'Артикул магазина', guess: ['код', 'sku', 'внутренний код', 'код товара', 'артикул магазина', 'код 1с', 'внешний код'] },
    { key: 'oem', label: 'OEM-номера (через , или ;)', guess: ['oem', 'оем', 'оригинальный номер', 'oem номер', 'оригинал'] },
    { key: 'category', label: 'Категория (или путь «Группа/Подгруппа»)', guess: ['категория', 'группа', 'category', 'группа товаров', 'раздел', 'группы', 'родитель', 'папка'] },
    { key: 'partType', label: 'Тип детали', guess: ['тип детали', 'тип'] },
    { key: 'qualityClass', label: 'Класс качества', guess: ['класс', 'качество', 'класс качества'] },
    { key: 'barcode', label: 'Штрихкод (через , для нескольких)', guess: ['штрихкод', 'штрих-код', 'штрих код', 'ean', 'barcode', 'шк', 'штрихкод ean13', 'штрихкоды'] },
    { key: 'baseUnit', label: 'Единица', guess: ['ед', 'ед.', 'единица', 'ед. изм.', 'ед изм', 'единица измерения'] },
    { key: 'price', label: 'Розничная цена', guess: ['цена', 'розница', 'розничная цена', 'цена продажи', 'price', 'цена розн', 'цена: цена продажи', 'розничная'] },
    { key: 'minPrice', label: 'Минимальная цена', guess: ['минимальная цена', 'мин цена', 'мин. цена'] },
    { key: 'vehicles', label: 'Применимость (через ;)', guess: ['применимость', 'для машин', 'машина', 'авто', 'модель авто', 'для каких машин'] },
    { key: 'description', label: 'Описание', guess: ['описание', 'комментарий', 'примечание'] },
    { key: 'tags', label: 'Теги (через ,)', guess: ['теги', 'метки'] },
  ],
  crosses: [
    { key: 'aBrand', label: 'Бренд 1', guess: ['бренд 1', 'бренд', 'производитель', 'brand'] },
    { key: 'aNumber', label: 'Номер 1', required: true, guess: ['номер 1', 'номер', 'артикул', 'number'] },
    { key: 'bBrand', label: 'Бренд 2 (аналог)', guess: ['бренд 2', 'бренд аналога', 'производитель аналога', 'cross brand'] },
    { key: 'bNumber', label: 'Номер 2 (аналог)', required: true, guess: ['номер 2', 'аналог', 'номер аналога', 'кросс', 'cross number'] },
    { key: 'crossType', label: 'Тип (полный / частичный / оригинал-замена)', guess: ['тип', 'тип аналога'] },
  ],
  applicability: [
    { key: 'sku', label: 'Артикул магазина', guess: ['код', 'sku', 'артикул магазина'] },
    { key: 'brand', label: 'Бренд', guess: ['бренд', 'производитель', 'brand'] },
    { key: 'number', label: 'Номер', guess: ['номер', 'артикул', 'number'] },
    { key: 'vehicles', label: 'Машина («Toyota Camry XV40», «камри 40»; через ;)', required: true, guess: ['применимость', 'машина', 'авто', 'модель'] },
    { key: 'yearFrom', label: 'Год с', guess: ['год с', 'с года', 'year from'] },
    { key: 'yearTo', label: 'Год по', guess: ['год по', 'по год', 'year to'] },
  ],
};

export function guessMapping(type: ImportType, header: string[]): Record<string, number> {
  const norm = header.map((h) => h.toLowerCase().replace(/\s+/g, ' ').trim());
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const f of IMPORT_FIELDS[type]) {
    const idx = norm.findIndex((h, i) => !used.has(i) && f.guess.includes(h));
    if (idx >= 0) {
      out[f.key] = idx;
      used.add(idx);
    }
  }
  // Вторая попытка: заголовок содержит подсказку
  for (const f of IMPORT_FIELDS[type]) {
    if (out[f.key] !== undefined) continue;
    const idx = norm.findIndex((h, i) => !used.has(i) && f.guess.some((g) => g.length > 3 && h.includes(g)));
    if (idx >= 0) {
      out[f.key] = idx;
      used.add(idx);
    }
  }
  return out;
}

export function qualityFromText(s: string): string | null {
  const v = s.toLowerCase().trim();
  if (!v) return null;
  if (/(ориг|original|genuine|^oe$)/.test(v)) return 'original';
  if (/(oem|оем|без лого)/.test(v)) return 'oem';
  if (/(копия|китай|copy|china|реплика)/.test(v)) return 'copy';
  if (/(б\/у|бу|used|контракт)/.test(v)) return 'used';
  if (/(аналог|aftermarket|неориг)/.test(v)) return 'aftermarket';
  return null;
}

/**
 * Шаблоны перехода с 1С и МойСклад (ТЗ 21.2): какую выгрузку сделать и какие колонки распознаются сами
 * (заголовки добавлены в guess выше). Выбор шаблона в интерфейсе подставляет тип импорта и подсказку.
 */
export const IMPORT_TEMPLATES = [
  { code: '1c_nomenclature', title: '1С: Номенклатура', type: 'products', howTo: '1С → Номенклатура → «Ещё» → «Вывести список» → сохранить в Excel', columns: ['Наименование', 'Артикул', 'Код', 'Производитель', 'Группа', 'Штрихкод', 'Единица'] },
  { code: '1c_stock', title: '1С: Остатки товаров', type: 'stock', howTo: 'Отчёт «Остатки и доступность товаров» / «Ведомость по товарам на складах» → Excel', columns: ['Номенклатура', 'Артикул', 'Количество', 'Себестоимость / Сумма'] },
  { code: '1c_counterparties', title: '1С: Контрагенты и долги', type: 'counterparties', howTo: 'Справочник «Контрагенты» → Excel; долги — «Ведомость расчётов с контрагентами»', columns: ['Наименование', 'Телефон', 'ИНН', 'Долг'] },
  { code: 'moysklad_products', title: 'МойСклад: Товары', type: 'products', howTo: 'Товары и услуги → «Экспорт» → Excel', columns: ['Наименование', 'Артикул', 'Код', 'Группы', 'Штрихкод EAN13', 'Цена: Цена продажи', 'Единица измерения'] },
  { code: 'moysklad_stock', title: 'МойСклад: Остатки', type: 'stock', howTo: 'Склад → Остатки → «Экспорт» → Excel', columns: ['Наименование', 'Артикул', 'Остаток', 'Себестоимость'] },
  { code: 'moysklad_counterparties', title: 'МойСклад: Контрагенты', type: 'counterparties', howTo: 'Контрагенты → «Экспорт»', columns: ['Наименование', 'Телефон', 'ИНН', 'Баланс'] },
];
