import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Код из цифр (для привязки агента, подтверждений). */
export const randomDigits = (len: number) =>
  Array.from({ length: len }, () => randomInt(0, 10).toString()).join('');

/** Человекочитаемый код без похожих символов (для приглашений). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const randomCode = (len: number) =>
  Array.from({ length: len }, () => ALPHABET[randomInt(0, ALPHABET.length)]).join('');

export const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};
