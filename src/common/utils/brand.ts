/** Нормализация названия бренда для сопоставления: «Lemförder» = «LEMFORDER», «TRW Automotive» ≠ «TRW» (это синоним). */
export function normalizeBrand(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .replace(/[^\p{L}\p{N}]/gu, '');
}
