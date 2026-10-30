/**
 * Почему не входит в админку:
 *   npx ts-node -r tsconfig-paths/register src/scripts/admin-check.ts email пароль
 * Печатает: найден ли админ, подходит ли пароль, блокировка и какой код 2FA сервер ждёт сейчас.
 */
import 'reflect-metadata';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import { SecretBox } from '../common/utils/secret-box';
import AppDataSource from '../database/data-source';

async function main() {
  const [email, password] = process.argv.slice(2);
  const ds = await AppDataSource.initialize();
  const [a] = await ds.query(`SELECT * FROM platform_admins WHERE email = lower($1)`, [email ?? '']);
  if (!a) {
    console.log('Админ с таким email не найден. Есть:', (await ds.query(`SELECT email FROM platform_admins`)).map((r: any) => r.email).join(', ') || 'никого');
  } else {
    const secret = new SecretBox(process.env.ENCRYPTION_KEY!).decrypt(a.totp_secret_enc);
    console.log('Активен:', a.is_active, '| роль:', a.role);
    console.log('Пароль подходит:', password ? await bcrypt.compare(password, a.password_hash) : 'не передан');
    console.log('Заблокирован до:', a.locked_until ?? 'нет', '| ошибок подряд:', a.failed_logins);
    console.log('Ключ 2FA (сверь с Authenticator):', secret);
    console.log('Код, который сервер ждёт сейчас:', authenticator.generate(secret), '| время сервера:', new Date().toLocaleTimeString('ru-RU'));
  }
  await ds.destroy();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});