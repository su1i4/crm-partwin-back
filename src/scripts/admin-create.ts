/**
 * Создать сотрудника платформы (админка, ТЗ 24):
 *   npm run admin:create -- email@example.com "Имя" 'пароль-от-10-символов' [admin|support]
 * Печатает otpauth-ссылку — добавить в Google Authenticator / Aegis (двухфакторная обязательна).
 */
import 'reflect-metadata';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import { SecretBox } from '../common/utils/secret-box';
import AppDataSource from '../database/data-source';

async function main() {
  const [email, name, password, role = 'support'] = process.argv.slice(2);
  if (!email || !name || !password) throw new Error('npm run admin:create -- email "Имя" пароль [admin|support]');
  if (password.length < 10) throw new Error('Пароль — от 10 символов');
  if (!['admin', 'support'].includes(role)) throw new Error('Роль: admin или support');
  const box = new SecretBox(process.env.ENCRYPTION_KEY!);
  const secret = authenticator.generateSecret();
  const ds = await AppDataSource.initialize();
  await ds.query(
    `INSERT INTO platform_admins (email, name, password_hash, totp_secret_enc, role) VALUES (lower($1), $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, totp_secret_enc = EXCLUDED.totp_secret_enc, role = EXCLUDED.role, is_active = true`,
    [email, name, await bcrypt.hash(password, 12), box.encrypt(secret), role],
  );
  console.log(`Готово. Добавьте в приложение-аутентификатор:\n${authenticator.keyuri(email, 'Autoparts Admin', secret)}`);
  await ds.destroy();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
