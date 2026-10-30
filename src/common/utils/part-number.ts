/**
 * Нормализация номера детали (ТЗ 4.2):
 *  - верхний регистр;
 *  - убрать пробелы, дефисы, точки, слэши, подчёркивания (и прочие разделители);
 *  - кириллицу, похожую на латиницу, заменить латиницей.
 *  "0 986-452.041" → "0986452041"
 */
const CYR_TO_LAT: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X',
  // часто встречающиеся «двойники» в прописном виде после toUpperCase
  Ё: 'E', У: 'Y',
};

export function normalizePartNumber(input: string | null | undefined): string {
  if (!input) return '';
  const upper = input.toUpperCase();
  let out = '';
  for (const ch of upper) {
    const mapped = CYR_TO_LAT[ch] ?? ch;
    if (/[A-Z0-9]/.test(mapped)) out += mapped;
    else if (/[\p{L}\p{N}]/u.test(mapped)) out += mapped; // прочие буквы оставляем (редкие случаи)
  }
  return out;
}

/** Похожие символы, которые путают при вводе и OCR (ТЗ 5.1, 11.3). */
export const CONFUSABLE_GROUPS = [
  ['0', 'O', 'Q', 'D'],
  ['1', 'I', 'L'],
  ['5', 'S'],
  ['8', 'B'],
  ['2', 'Z'],
  ['6', 'G'],
];

/** «Скелет» номера: путаемые символы сводятся к одному представителю — для нечёткого поиска. */
export function partNumberSkeleton(normalized: string): string {
  let out = '';
  for (const ch of normalized) {
    const group = CONFUSABLE_GROUPS.find((g) => g.includes(ch));
    out += group ? group[0] : ch;
  }
  return out;
}
