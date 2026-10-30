/**
 * Зарегистрировать вебхук бота у Telegram:
 *   npm run telegram:webhook -- https://crm.example.kg/api
 * Берёт TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_API_URL из .env.
 */
import 'dotenv/config';

async function main() {
  const base = (process.argv[2] ?? '').replace(/\/$/, '');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const api = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('Укажите публичный https-адрес API, например https://crm.example.kg/api');
  if (!token || !secret) throw new Error('Заполните TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET в .env');
  const res = await fetch(`${api}/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${base}/telegram/webhook`, secret_token: secret, allowed_updates: ['message'] }),
  });
  console.log(res.status, await res.text());
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
