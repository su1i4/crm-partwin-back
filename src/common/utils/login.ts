/** Логин пользователя — телефон или email. Нормализуем, чтобы «+996 555 12-34-56» и «0555123456» совпадали. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 9) return null;
  // Кыргызстан: 0555123456 → 996555123456; 555123456 → 996555123456
  if (digits.length === 10 && digits.startsWith('0')) return '996' + digits.slice(1);
  if (digits.length === 9) return '996' + digits;
  return digits;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export type LoginKind = { phone: string } | { email: string };

export function parseLogin(raw: string): LoginKind | null {
  const s = raw.trim();
  if (s.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? { email: normalizeEmail(s) } : null;
  const phone = normalizePhone(s);
  return phone ? { phone } : null;
}
