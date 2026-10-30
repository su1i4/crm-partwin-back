/** Контрольная цифра EAN-13 для 12 цифр. */
export function ean13CheckDigit(body12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/**
 * Внутренний EAN-13 (ТЗ 4.4): префиксы 25–29 зарезервированы под внутреннее использование.
 * Используем 25 + 10 цифр счётчика магазина.
 */
export function internalEan13(counter: number, prefix = '25'): string {
  const body = prefix + String(counter).padStart(10, '0');
  if (body.length !== 12) throw new Error('Счётчик штрихкодов переполнен');
  return body + ean13CheckDigit(body);
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** Штрихкод: убрать пробелы, оставить печатные символы. */
export function normalizeBarcode(raw: string): string {
  return raw.replace(/\s+/g, '').trim();
}
