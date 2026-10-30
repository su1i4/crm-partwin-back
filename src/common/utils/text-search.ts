/**
 * Подготовка текста для поиска (ТЗ 5.1): нижний регистр, ё→е, кыргызские ң/ө/ү → н/о/у,
 * транслит латиницы в кириллицу, исправление раскладки, размеры «35 52 7» → «35x52x7».
 */
const KY: Record<string, string> = { ң: 'н', ө: 'о', ү: 'у', ё: 'е', һ: 'х' };

export function baseNormalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ңөүёһ]/g, (c) => KY[c] ?? c)
    .replace(/[×хx*]/g, (c, i, str) => {
      // «35х52х7» / «35x52x7» → разделитель размеров, только между цифрами
      const prev = str[i - 1];
      const next = str[i + 1];
      return prev && next && /\d/.test(prev) && /\d/.test(next) ? 'x' : c;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const EN_TO_RU_LAYOUT: Record<string, string> = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з', '[': 'х', ']': 'ъ',
  a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д', ';': 'ж', "'": 'э',
  z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь', ',': 'б', '.': 'ю', '`': 'ё',
};

/** «rjkjlrb» → «колодки» */
export function fixLayout(s: string): string {
  return [...s.toLowerCase()].map((c) => EN_TO_RU_LAYOUT[c] ?? c).join('');
}

const TRANSLIT: [string, string][] = [
  ['shch', 'щ'], ['sch', 'щ'], ['yo', 'ё'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['ch', 'ч'], ['sh', 'ш'],
  ['yu', 'ю'], ['ya', 'я'], ['ye', 'е'], ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'],
  ['z', 'з'], ['i', 'и'], ['j', 'й'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'],
  ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'к'], ['y', 'ы'], ['w', 'в'],
  ['x', 'кс'], ['q', 'к'],
];

/** «kolodki» → «колодки» */
export function translitToRu(s: string): string {
  let out = '';
  let i = 0;
  const low = s.toLowerCase();
  while (i < low.length) {
    let matched = false;
    for (const [lat, cyr] of TRANSLIT) {
      if (low.startsWith(lat, i)) {
        out += cyr;
        i += lat.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += low[i];
      i++;
    }
  }
  return out;
}

/** Грубая основа слова для русского: «колодки» → «колодк», «передние» → «передн». */
export function stem(word: string): string {
  if (!/^[а-я]+$/.test(word) || word.length <= 4) return word;
  const endings = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ой', 'ей', 'ий', 'ый', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ки', 'ка', 'ку', 'ок', 'а', 'я', 'ы', 'и', 'о', 'е', 'у', 'ю'];
  for (const e of endings) {
    if (word.endsWith(e) && word.length - e.length >= 4) {
      // «колодки» — оставляем «колодк», «ки»-окончание сводим к «к»
      if (e === 'ки' || e === 'ка' || e === 'ку') return word.slice(0, -1);
      return word.slice(0, -e.length);
    }
  }
  return word;
}

/** Похоже ли на номер детали: есть цифры, длина ≥ 4 без разделителей. */
export function looksLikeNumber(token: string): boolean {
  const compact = token.replace(/[\s\-./_]/g, '');
  return compact.length >= 4 && /\d/.test(compact) && /^[\p{L}\p{N}]+$/u.test(compact);
}

/** Размеры: «35 52 7» / «35x52x7» / «205/55 R16» → «35x52x7», «205x55x16». */
export function sizeVariant(q: string): string | null {
  const nums = q.replace(/r(?=\d)/gi, ' ').match(/\d+(?:[.,]\d+)?/g);
  if (!nums || nums.length < 2 || nums.length > 4) return null;
  // только если запрос состоит из чисел и разделителей
  if (!/^[\d\s.,x×х*/rR-]+$/.test(q.trim())) return null;
  return nums.map((n) => n.replace(',', '.')).join('x');
}
