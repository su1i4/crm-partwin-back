import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/** AES-256-GCM для секретов в БД (TOTP). Ключ — ENCRYPTION_KEY. */
export class SecretBox {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHash('sha256').update(secret).digest();
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, enc].map((b) => b.toString('base64url')).join('.');
  }
  decrypt(payload: string): string {
    const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }
}
