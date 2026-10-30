import { Injectable, OnModuleInit } from '@nestjs/common';
import { In, IsNull } from 'typeorm';
import { Page } from '../../common/dto/pagination.dto';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { OutboxService } from '../../jobs/outbox.service';
import { RealtimeService } from '../realtime/realtime.service';
import { Permission } from '../roles/permissions';
import { Notification, NotificationChannels, NotificationSettings } from './entities/notification.entity';
import { DEFAULT_CHANNELS, NOTIFICATION_TYPES, NotificationType } from './notification-types';

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  storeId?: string | null;
  link?: string;
  data?: Record<string, unknown>;
  /** Кому: конкретным пользователям и/или всем, у кого есть разрешение (владельцы — всегда) */
  userIds?: string[];
  permission?: Permission;
  /** Только владельцам */
  ownersOnly?: boolean;
  /** Не уведомлять автора действия */
  excludeUserId?: string | null;
}

/**
 * Уведомления (ТЗ 22.1). Создаются в транзакции действия; в WebSocket уходят после COMMIT через outbox.
 * Получатели фильтруются по доступу к точке (ТЗ 3.4): уведомление по точке не придёт тем, у кого её нет.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly outbox: OutboxService,
    private readonly registry: OutboxRegistry,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit() {
    this.registry.on('notification.created', async (e) => {
      const ids: string[] = e.payload.ids ?? [];
      if (!ids.length) return;
      const rows = await this.tenantTx.run((tx) => tx.repo(Notification).findByIds(ids), {
        tenantId: e.tenantId,
        userId: null,
      });
      for (const n of rows) this.realtime.toUser(e.tenantId, n.userId, 'notification', n);
      // Telegram — этап 7: здесь же отправка в бот по каналам пользователя
    });
  }

  async notify(tx: TenantTx, input: NotifyInput): Promise<string[]> {
    const recipients = await this.resolveRecipients(tx, input);
    if (!recipients.length) return [];
    const settings = await tx.repo(NotificationSettings).find({ where: { userId: In(recipients) } });
    const byUser = new Map(settings.map((s) => [s.userId, s.channels]));
    const inApp = recipients.filter((u) => (byUser.get(u)?.[input.type] ?? DEFAULT_CHANNELS).inApp);
    if (!inApp.length) return [];
    const rows = await tx.repo(Notification).insertMany(
      inApp.map((userId) => ({
        userId,
        type: input.type,
        title: input.title.slice(0, 300),
        body: input.body ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        storeId: input.storeId ?? null,
        link: input.link ?? null,
        data: input.data ?? {},
      })),
    );
    await this.outbox.emit(tx, 'notification.created', { ids: rows.map((r) => r.id) });
    return rows.map((r) => r.id);
  }

  private async resolveRecipients(tx: TenantTx, input: NotifyInput): Promise<string[]> {
    const rows = await tx.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id
         FROM memberships m
        WHERE m.tenant_id = $1 AND m.status = 'active'
          AND (
                ($2::uuid[] IS NOT NULL AND m.user_id = ANY($2::uuid[]))
             OR ($3::boolean AND m.is_owner)
             OR ($4::text IS NOT NULL AND (m.is_owner OR EXISTS (
                   SELECT 1 FROM membership_roles mr
                     JOIN role_permissions rp ON rp.role_id = mr.role_id
                     JOIN roles r ON r.id = mr.role_id AND r.deleted_at IS NULL
                    WHERE mr.membership_id = m.id AND rp.permission = $4)))
          )
          AND ($5::uuid IS NULL OR m.is_owner OR m.all_stores OR EXISTS (
                SELECT 1 FROM membership_store_access a WHERE a.membership_id = m.id AND a.store_id = $5))`,
      [tx.tenantId, input.userIds?.length ? input.userIds : null, !!input.ownersOnly, input.permission ?? null, input.storeId ?? null],
    );
    return rows.map((r) => r.user_id).filter((u) => u !== input.excludeUserId);
  }

  // ── Колокольчик ─────────────────────────────────────────

  async list(userId: string, opts: { unreadOnly?: boolean; page: number; limit: number }): Promise<Page<Notification> & { unread: number }> {
    return this.tenantTx.run(async (tx) => {
      const repo = tx.repo(Notification);
      const where = opts.unreadOnly ? { userId, readAt: IsNull() } : { userId };
      const [items, total] = await repo.findAndCount({
        where,
        order: { createdAt: 'DESC' },
        skip: (opts.page - 1) * opts.limit,
        take: opts.limit,
      });
      const unread = await repo.count({ where: { userId, readAt: IsNull() } });
      return { items, total, unread };
    });
  }

  async markRead(userId: string, ids: string[] | 'all') {
    await this.tenantTx.run(async (tx) => {
      const qb = tx.manager
        .createQueryBuilder()
        .update(Notification)
        .set({ readAt: () => 'now()' })
        .where('tenant_id = :t AND user_id = :u AND read_at IS NULL', { t: tx.tenantId, u: userId });
      if (ids !== 'all') {
        if (!ids.length) return;
        qb.andWhere('id = ANY(:ids)', { ids });
      }
      await qb.execute();
    });
  }

  async getChannels(userId: string) {
    const s = await this.tenantTx.repo(NotificationSettings).findOne({ where: { userId } });
    return Object.entries(NOTIFICATION_TYPES).map(([type, label]) => ({
      type,
      label,
      channels: s?.channels?.[type] ?? DEFAULT_CHANNELS,
    }));
  }

  async setChannels(userId: string, patch: Record<string, NotificationChannels>) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in NOTIFICATION_TYPES)) throw Errors.bad('UNKNOWN_EVENT', `Неизвестное событие: ${k}`);
      if (typeof v?.inApp !== 'boolean' || typeof v?.telegram !== 'boolean') throw Errors.bad('BAD_CHANNELS', `Каналы «${k}»: inApp и telegram — да/нет`);
      patch[k] = { inApp: v.inApp, telegram: v.telegram };
    }
    await this.tenantTx.run(async (tx) => {
      const repo = tx.repo(NotificationSettings);
      const s = await repo.findOne({ where: { userId } });
      if (s) {
        s.channels = { ...s.channels, ...patch };
        await repo.save(s);
      } else {
        await repo.insert({ userId, channels: patch });
      }
    });
    return this.getChannels(userId);
  }
}
