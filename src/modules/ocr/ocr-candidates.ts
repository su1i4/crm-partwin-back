import { isValidEan13 } from '../../common/utils/barcode';
import { normalizePartNumber } from '../../common/utils/part-number';
import type { OcrLine } from './ocr.provider';

export interface OcrCandidate {
  /** Как прочитано */
  raw: string;
  /** Нормализованный номер / штрихкод */
  value: string;
  kind: 'number' | 'barcode';
  score: number;
}

const DATE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;
const PRICE = /^\d{1,7}([.,]\d{1,2})?(сом|руб|р|c|kgs|\$|₽)?$/i;
const MONEY_WORD = /(сом|руб|цена|price|итого|сумма|kgs)/i;
/** Слова с этикеток, которые не номера */
const NOISE = /^(MADE|IN|JAPAN|CHINA|KOREA|GERMANY|GENUINE|PARTS?|OEM|QTY|LOT|DATE|NO|PART|NUMBER|TOYOTA|NISSAN|HONDA|BOSCH)$/i;

function isEan(v: string) {
  if (/^\d{13}$/.test(v)) return isValidEan13(v);
  if (/^\d{8}$/.test(v)) {
    const d = v.split('').map(Number);
    const sum = d.slice(0, 7).reduce((a, x, i) => a + x * (i % 2 ? 1 : 3), 0);
    return (10 - (sum % 10)) % 10 === d[7];
  }
  return false;
}

/**
 * Из строк OCR — кандидаты в номера (ТЗ 11.3): 5–20 букв/цифр, хотя бы одна цифра;
 * даты, цены и служебные слова отбрасываются; EAN-8/13 — как штрихкоды.
 * Номер часто разорван пробелом («90915 YZZE1») — пробуем и склейку соседних кусков.
 */
export function extractCandidates(lines: OcrLine[], max = 6): OcrCandidate[] {
  const out = new Map<string, OcrCandidate>();
  const push = (raw: string, conf: number, bonus = 0) => {
    const r = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!r || DATE.test(r) || PRICE.test(r) && !/^\d{6,}$/.test(r)) return;
    const value = normalizePartNumber(r);
    if (value.length < 5 || value.length > 20 || !/\d/.test(value) || !/^[A-Z0-9]+$/.test(value)) return;
    if (/^(19|20)\d{2}$/.test(value)) return;
    const kind = isEan(value) ? 'barcode' : 'number';
    // Длинные номера с буквами и цифрами — вероятнее всего номер детали; разделители в оригинале — тоже признак
    let score = conf * 100 + Math.min(value.length, 12) * 2 + bonus;
    if (/[A-Z]/.test(value) && /\d/.test(value)) score += 10;
    if (/[-.\s]/.test(r)) score += 5;
    if (kind === 'barcode') score += 15;
    const cur = out.get(value);
    if (!cur || cur.score < score) out.set(value, { raw: r, value, kind, score: Math.round(score) });
  };
  for (const l of lines) {
    const text = (l.text ?? '').trim();
    if (!text || MONEY_WORD.test(text)) continue;
    const conf = l.score ?? 0.8;
    const parts = text.split(/\s+/).filter((p) => p && !NOISE.test(p));
    for (const p of parts) push(p, conf);
    for (let i = 0; i + 1 < parts.length; i++) push(`${parts[i]} ${parts[i + 1]}`, conf, -3);
    if (parts.length > 2 && text.length <= 24) push(parts.join(' '), conf, -4);
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, max);
}
