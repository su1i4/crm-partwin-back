import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { normalizePhone } from '../../common/utils/login';
import { D } from '../../common/utils/decimal';
import { AppConfig } from '../../config/app.config';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { TelegramService } from '../telegram/telegram.service';
import { CustomerTelegram, LoyaltyCard } from './entities/loyalty.entity';
import { LoyaltyService } from './loyalty.service';

const fmt = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString('ru-RU').replace(/ /g, ' ');

/**
 * Клиентская часть Telegram-бота (ТЗ 22.2, 18.5): клиент открывает бота по QR магазина, делится номером —
 * привязывается к своей карточке (или создаётся новый клиент). Получает карту и баланс бонусов, электронные
 * чеки, «деталь пришла». Один чат — несколько магазинов.
 */
@Injectable()
export class CustomerBotService implements OnModuleInit {
  private readonly log = new Logger('CustomerBot');
  /** Чат → магазин, к которому подключается (ждём номер телефона). В памяти процесса, 30 минут */
  private readonly pending = new Map<string, { tenantId: string; at: number }>();

  constructor(
    private readonly tg: TelegramService,
    private readonly platform: PlatformDb,
    private readonly tenantTx: TenantTransaction,
    private readonly loyalty: LoyaltyService,
    private readonly registry: OutboxRegistry,
    private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.tg.customerHandler = (u) => this.handle(u);
    // Электронный чек и бонусы — клиенту в бот
    this.registry.on('receipt.completed', async (e) => {
      if (!this.tg.enabled) return;
      const [r] = await this.tenantTx.run(
        (tx) =>
          tx.query(
            `SELECT r.customer_id, r.number, r.kind, r.total, r.public_token, s.name AS store FROM receipts r JOIN stores s ON s.id = r.store_id WHERE r.tenant_id = $1 AND r.id = $2`,
            [tx.tenantId, e.payload.receiptId],
          ),
        { tenantId: e.tenantId, userId: null },
      );
      if (!r?.customer_id) return;
      const bal = await this.tenantTx.run((tx) => this.loyalty.balance(tx, r.customer_id), { tenantId: e.tenantId, userId: null });
      const url = r.public_token ? `${this.config.publicUrl}/r/${r.public_token}` : null;
      await this.notify(e.tenantId, r.customer_id, `🧾 ${r.store}: ${r.kind === 'return' ? 'возврат' : 'чек'} ${r.number} на ${fmt(r.total)} сом.${D(bal).gt(0) ? `\nБонусов на карте: ${fmt(bal)}` : ''}`, url ? [[{ text: 'Чек', url }]] : undefined);
    });
    // «Деталь пришла» — клиенту заявки
    this.registry.on('notification.created', async (e) => {
      if (!this.tg.enabled) return;
      const rows = await this.tenantTx.run(
        (tx) =>
          tx.query(
            `SELECT DISTINCT r.customer_id, r.number, s.name AS store FROM notifications n JOIN customer_requests r ON r.id = n.entity_id JOIN stores s ON s.id = r.store_id
              WHERE n.tenant_id = $1 AND n.id = ANY($2::uuid[]) AND n.type = 'request.arrived' AND r.customer_id IS NOT NULL`,
            [tx.tenantId, e.payload.ids ?? []],
          ),
        { tenantId: e.tenantId, userId: null },
      );
      for (const r of rows) await this.notify(e.tenantId, r.customer_id, `📦 ${r.store}: ваша деталь по заявке ${r.number} пришла. Ждём вас!`);
    });
  }

  /** Ссылка для QR магазина (на чеке, на кассе). */
  shopLink(tenantId: string) {
    const u = this.config.telegram.username;
    return { link: u ? `https://t.me/${u}?start=s_${tenantId.replace(/-/g, '')}` : null, botEnabled: this.tg.enabled };
  }

  /** Сообщение клиенту магазина во все его чаты. */
  async notify(tenantId: string, counterpartyId: string, text: string, buttons?: { text: string; url: string }[][]) {
    const chats = await this.platform.repo(CustomerTelegram).find({ where: { tenantId, counterpartyId } as any });
    let sent = 0;
    for (const c of chats) if (await this.tg.send(c.chatId, text, buttons)) sent++;
    return sent;
  }

  private async handle(update: any): Promise<boolean> {
    const msg = update?.message;
    const chatId = msg?.chat?.id ? String(msg.chat.id) : null;
    if (!chatId || (msg.chat.type && msg.chat.type !== 'private')) return false;
    const text = String(msg.text ?? '').trim();
    const start = /^\/start\s+s_([0-9a-f]{32})$/i.exec(text);
    if (start) {
      const h = start[1].toLowerCase();
      const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      const [t] = await this.platform.ds.query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
      if (!t) {
        await this.tg.send(chatId, 'Магазин не найден. Отсканируйте QR-код ещё раз.');
        return true;
      }
      this.pending.set(chatId, { tenantId, at: Date.now() });
      await this.tg.send(chatId, `Здравствуйте! Это бот магазина «${t.name}». Нажмите кнопку ниже, чтобы поделиться номером — подключим вашу карту клиента.`, undefined, {
        keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      });
      return true;
    }
    if (msg.contact) {
      const p = this.pending.get(chatId);
      if (!p || Date.now() - p.at > 30 * 60_000) {
        await this.tg.send(chatId, 'Сначала отсканируйте QR-код магазина.');
        return true;
      }
      if (msg.contact.user_id && String(msg.contact.user_id) !== String(msg.from?.id)) {
        await this.tg.send(chatId, 'Поделитесь своим номером (кнопкой), а не чужим контактом.');
        return true;
      }
      this.pending.delete(chatId);
      await this.link(p.tenantId, chatId, msg.contact.phone_number, [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' '));
      return true;
    }
    const linked = await this.platform.repo(CustomerTelegram).find({ where: { chatId } });
    if (!linked.length) return false;
    if (/^\/(card|start)\b/i.test(text) || /карт|бонус/i.test(text)) {
      for (const l of linked) await this.sendCard(l.tenantId, l.counterpartyId, chatId);
      return true;
    }
    if (/^\/requests\b/i.test(text) || /заявк/i.test(text)) {
      for (const l of linked) {
        const rows = await this.tenantTx.run(
          (tx) => tx.query(`SELECT number, status FROM customer_requests WHERE tenant_id = $1 AND customer_id = $2 AND deleted_at IS NULL AND status NOT IN ('issued', 'refused') ORDER BY created_at DESC LIMIT 10`, [tx.tenantId, l.counterpartyId]),
          { tenantId: l.tenantId, userId: null },
        );
        const ST: Record<string, string> = { new: 'принята', selecting: 'подбираем', offered: 'есть предложение', ordered: 'заказано', arrived: 'пришло — ждём вас' };
        await this.tg.send(chatId, rows.length ? rows.map((r: any) => `Заявка ${r.number}: ${ST[r.status] ?? r.status}`).join('\n') : 'Открытых заявок нет.');
      }
      return true;
    }
    if (/^\/stop\b/i.test(text)) {
      await this.platform.ds.query(`DELETE FROM customer_telegram WHERE chat_id = $1`, [chatId]);
      await this.tg.send(chatId, 'Готово, вы отключены от магазинов.');
      return true;
    }
    await this.tg.send(chatId, 'Команды: /card — карта и бонусы, /requests — мои заявки, /stop — отключиться.');
    return true;
  }

  private async link(tenantId: string, chatId: string, rawPhone: string, name: string) {
    const phone = normalizePhone(rawPhone) ?? rawPhone.replace(/\D/g, '');
    const cpId = await this.tenantTx.run(
      async (tx) => {
        const [c] = await tx.query(
          `SELECT id FROM counterparties WHERE tenant_id = $1 AND deleted_at IS NULL AND merged_into_id IS NULL AND (phone = $2 OR $2 = ANY(phones)) ORDER BY created_at LIMIT 1`,
          [tx.tenantId, phone],
        );
        if (c) return c.id as string;
        const [n] = await tx.query(
          `INSERT INTO counterparties (tenant_id, name, kind, phone, phones, roles) VALUES ($1, $2, 'person', $3, '{}', '{customer}') RETURNING id`,
          [tx.tenantId, (name || `Клиент ${phone}`).slice(0, 200), phone],
        );
        return n.id as string;
      },
      { tenantId, userId: null },
    );
    await this.platform.ds.query(
      `INSERT INTO customer_telegram (tenant_id, counterparty_id, chat_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, chat_id) DO UPDATE SET counterparty_id = EXCLUDED.counterparty_id, updated_at = now()`,
      [tenantId, cpId, chatId],
    );
    const settings = await this.tenantTx.run((tx) => tx.query(`SELECT data FROM tenant_settings WHERE tenant_id = $1`, [tx.tenantId]), { tenantId, userId: null });
    if (settings[0]?.data?.loyaltyEnabled) await this.tenantTx.run(() => this.loyalty.issueCard(cpId), { tenantId, userId: null });
    await this.tg.send(chatId, 'Готово, вы подключены! Сюда будут приходить чеки, статусы заявок и бонусы.', undefined, { remove_keyboard: true });
    await this.sendCard(tenantId, cpId, chatId);
  }

  private async sendCard(tenantId: string, counterpartyId: string, chatId: string) {
    const c = await this.tenantTx.run((tx) => this.loyalty.cardInTx(tx, counterpartyId), { tenantId, userId: null });
    const [t] = await this.platform.ds.query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
    if (!c.card) {
      await this.tg.send(chatId, `${t?.name ?? 'Магазин'}: карты клиента пока нет.`);
      return;
    }
    const qr = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${c.card.number}`;
    await this.tg.send(
      chatId,
      `💳 ${t?.name ?? 'Магазин'}\nКарта ${c.card.number}${c.level ? ` · ${c.level}` : ''}\nБонусов: ${fmt(c.balance)}\nНачисление: ${c.accrualPercent}%${D(c.expiringSoon.amount).gt(0) ? `\nСгорят в течение 30 дней: ${fmt(c.expiringSoon.amount)}` : ''}\nПокажите карту на кассе.`,
      [[{ text: 'QR-код карты', url: qr }]],
    );
  }
}
