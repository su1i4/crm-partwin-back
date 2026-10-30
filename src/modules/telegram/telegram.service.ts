import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomInt } from 'crypto';
import { In, IsNull } from 'typeorm';
import { Errors } from '../../common/errors/app.exception';
import { sha256 } from '../../common/utils/crypto';
import { AppConfig } from '../../config/app.config';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { Notification, NotificationSettings } from '../notifications/entities/notification.entity';
import { DEFAULT_CHANNELS } from '../notifications/notification-types';
import { User } from '../users/entities/user.entity';
import { TelegramCode } from './entities/telegram.entity';

const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MIN = { link: 15, reset: 10, ownership: 10 } as const;
const MAX_ATTEMPTS = 5;

export interface TgButton {
  text: string;
  url: string;
}

/**
 * Telegram-бот платформы (ТЗ 22.2), часть для сотрудников: привязка кодом из профиля, уведомления
 * по выбранным каналам, коды сброса пароля и подтверждения передачи владения, вечерняя сводка.
 * Без TELEGRAM_BOT_TOKEN бот выключен: отправка молча пропускается.
 */
@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly log = new Logger('Telegram');

  constructor(
    private readonly config: AppConfig,
    private readonly platform: PlatformDb,
    private readonly tenantTx: TenantTransaction,
    private readonly registry: OutboxRegistry,
  ) {}

  get enabled() {
    return !!this.config.telegram.token;
  }

  onModuleInit() {
    // Уведомления → в Telegram тем, у кого включён канал для этого типа (ТЗ 22.1)
    this.registry.on('notification.created', async (e) => {
      if (!this.enabled) return;
      const ids: string[] = e.payload.ids ?? [];
      if (!ids.length) return;
      const rows = await this.tenantTx.run(
        async (tx) => {
          const ns = await tx.repo(Notification).findByIds(ids);
          const settings = await tx.repo(NotificationSettings).find({ where: { userId: In([...new Set(ns.map((n) => n.userId))]) } });
          return ns.filter((n) => (settings.find((s) => s.userId === n.userId)?.channels?.[n.type] ?? DEFAULT_CHANNELS).telegram);
        },
        { tenantId: e.tenantId, userId: null },
      );
      if (!rows.length) return;
      const users = await this.platform.repo(User).find({ where: { id: In(rows.map((n) => n.userId)) } });
      for (const n of rows) {
        const chat = users.find((u) => u.id === n.userId)?.telegramChatId;
        if (!chat) continue;
        const url = n.link ? `${this.config.publicUrl}${n.link}` : null;
        await this.send(chat, `🔔 ${n.title}${n.body ? `\n${n.body}` : ''}`, url ? [[{ text: 'Открыть', url }]] : undefined);
      }
    });
  }

  /** Отправить сообщение. Ошибки Telegram не ломают действие — только лог. */
  async send(chatId: string, text: string, buttons?: TgButton[][], replyMarkup?: Record<string, unknown>): Promise<boolean> {
    const { token, apiUrl } = this.config.telegram;
    if (!token) return false;
    try {
      const res = await fetch(`${apiUrl}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : replyMarkup ? { reply_markup: replyMarkup } : {}) }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) this.log.warn(`sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.ok;
    } catch (e) {
      this.log.warn(`sendMessage: ${(e as Error).message}`);
      return false;
    }
  }

  // ── Привязка ─────────────────────────────────────────────

  /** Код привязки для профиля: открыть бота по ссылке или отправить ему код. */
  async linkCode(userId: string) {
    let code = '';
    for (let i = 0; i < 8; i++) code += LINK_ALPHABET[randomInt(LINK_ALPHABET.length)];
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN.link * 60_000);
    await this.platform.repo(TelegramCode).update({ userId, purpose: 'link', usedAt: IsNull() }, { usedAt: new Date() });
    await this.platform.repo(TelegramCode).insert({ userId, purpose: 'link', codeHash: sha256(code), expiresAt });
    const username = this.config.telegram.username;
    return { code, expiresAt, deepLink: username ? `https://t.me/${username}?start=${code}` : null, botEnabled: this.enabled };
  }

  async unlink(userId: string) {
    const u = await this.platform.repo(User).findOne({ where: { id: userId } });
    if (u?.telegramChatId) await this.send(u.telegramChatId, 'Telegram отвязан от учётной записи. Уведомления больше не придут.');
    await this.platform.repo(User).update({ id: userId }, { telegramChatId: null });
    return { linked: false };
  }

  /** Входящее обновление от Telegram (вебхук). */
  /** Клиентская часть бота (модуль лояльности): вернёт true, если сообщение — её */
  customerHandler?: (update: any) => Promise<boolean>;

  async handleUpdate(update: any) {
    if (this.customerHandler && (await this.customerHandler(update))) return { ok: true, customer: true };
    const msg = update?.message;
    const chatId = msg?.chat?.id ? String(msg.chat.id) : null;
    const text = String(msg?.text ?? '').trim();
    if (!chatId || !text) return { ok: true };
    if (msg.chat.type && msg.chat.type !== 'private') return { ok: true };
    if (/^\/stop\b/.test(text)) {
      const users = await this.platform.repo(User).find({ where: { telegramChatId: chatId } });
      for (const u of users) await this.platform.repo(User).update({ id: u.id }, { telegramChatId: null });
      await this.send(chatId, users.length ? 'Готово, Telegram отвязан.' : 'Этот Telegram не привязан.');
      return { ok: true, unlinked: users.length };
    }
    const m = /^(?:\/start\s+)?([A-Z0-9]{8})$/i.exec(text);
    if (!m) {
      await this.send(chatId, 'Здравствуйте! Чтобы получать уведомления магазина, откройте профиль в CRM → «Привязать Telegram» и отправьте сюда код.');
      return { ok: true };
    }
    const row = await this.platform.repo(TelegramCode).findOne({ where: { codeHash: sha256(m[1].toUpperCase()), purpose: 'link', usedAt: IsNull() } });
    if (!row || row.expiresAt < new Date()) {
      await this.send(chatId, 'Код не подошёл или устарел. Получите новый в профиле.');
      return { ok: true, linked: false };
    }
    await this.platform.repo(TelegramCode).update({ id: row.id }, { usedAt: new Date() });
    // Один Telegram — одна учётная запись
    await this.platform.ds.query(`UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = $1 AND id <> $2`, [chatId, row.userId]);
    await this.platform.repo(User).update({ id: row.userId }, { telegramChatId: chatId });
    const u = await this.platform.repo(User).findOne({ where: { id: row.userId } });
    await this.send(chatId, `Готово, ${u?.name ?? ''}! Telegram привязан. Какие уведомления присылать — выберите в профиле. Отвязать — /stop`);
    return { ok: true, linked: true, userId: row.userId };
  }

  // ── Одноразовые коды ─────────────────────────────────────

  /** Код подтверждения в Telegram (сброс пароля, передача владения). */
  async sendCode(userId: string, purpose: 'reset' | 'ownership', text: (code: string) => string) {
    const u = await this.platform.repo(User).findOne({ where: { id: userId } });
    if (!u?.telegramChatId) throw Errors.bad('TELEGRAM_NOT_LINKED', 'Telegram не привязан');
    if (!this.enabled) throw Errors.bad('TELEGRAM_DISABLED', 'Telegram-бот не настроен');
    const code = String(randomInt(100000, 1000000));
    await this.platform.repo(TelegramCode).update({ userId, purpose, usedAt: IsNull() }, { usedAt: new Date() });
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN[purpose] * 60_000);
    await this.platform.repo(TelegramCode).insert({ userId, purpose, codeHash: sha256(`${userId}:${code}`), expiresAt });
    await this.send(u.telegramChatId, text(code));
    return { expiresAt };
  }

  /** Проверить код; 5 неверных попыток — код сгорает. */
  async verifyCode(userId: string, purpose: 'reset' | 'ownership', code: string) {
    const repo = this.platform.repo(TelegramCode);
    const row = await repo.findOne({ where: { userId, purpose, usedAt: IsNull() }, order: { createdAt: 'DESC' } });
    if (!row || row.expiresAt < new Date()) throw Errors.bad('CODE_EXPIRED', 'Код устарел — запросите новый');
    if (row.codeHash !== sha256(`${userId}:${String(code).trim()}`)) {
      const attempts = row.attempts + 1;
      await repo.update({ id: row.id }, { attempts, ...(attempts >= MAX_ATTEMPTS ? { usedAt: new Date() } : {}) });
      throw Errors.bad('CODE_INVALID', attempts >= MAX_ATTEMPTS ? 'Неверный код. Попытки закончились — запросите новый' : 'Неверный код');
    }
    await repo.update({ id: row.id }, { usedAt: new Date() });
  }

  async isLinked(userId: string) {
    const u = await this.platform.repo(User).findOne({ where: { id: userId } });
    return !!u?.telegramChatId;
  }
}
