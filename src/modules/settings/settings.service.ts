import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { OutboxService } from '../../jobs/outbox.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UpdateSettingsDto } from './dto/settings.dto';
import { TenantSettings } from './entities/tenant-settings.entity';
import { TenantSettingsData, withDefaults } from './settings.types';

@Injectable()
export class SettingsService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
  ) {}

  private async row(tx: TenantTx): Promise<TenantSettings> {
    const repo = tx.repo(TenantSettings);
    const existing = await repo.findOne({ where: {} });
    return existing ?? repo.insert({ data: {} });
  }

  /** Настройки с подставленными значениями по умолчанию. */
  async get(tx: TenantTx): Promise<TenantSettingsData> {
    return withDefaults((await this.row(tx)).data);
  }

  async getWithVersion() {
    return this.tenantTx.run(async (tx) => {
      const r = await this.row(tx);
      return { version: r.version, settings: withDefaults(r.data) };
    });
  }

  async update(dto: UpdateSettingsDto) {
    const { version, ...patch } = dto;
    if (patch.minPriceCipher) validateCipher(patch.minPriceCipher);
    return this.tenantTx.run(async (tx) => {
      const row = await this.row(tx);
      if (row.version !== version) throw Errors.versionConflict();
      const before = withDefaults(row.data);
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      row.data = { ...row.data, ...clean };
      const saved = await tx.repo(TenantSettings).save(row);
      const after = withDefaults(saved.data);
      await this.applyPatch(tx, before, after);
      return { version: saved.version, settings: after };
    });
  }

  /** Применить изменения настроек внутри уже открытой транзакции (мастер первого запуска). */
  async patchInTx(tx: TenantTx, patch: Partial<TenantSettingsData>) {
    const row = await this.row(tx);
    const before = withDefaults(row.data);
    row.data = { ...row.data, ...patch };
    const saved = await tx.repo(TenantSettings).save(row);
    await this.applyPatch(tx, before, withDefaults(saved.data), false);
    return withDefaults(saved.data);
  }

  private async applyPatch(tx: TenantTx, before: TenantSettingsData, after: TenantSettingsData, notify = true) {
    await this.audit.log(tx, {
      action: 'settings.update',
      entityType: 'settings',
      summary: 'Изменены настройки магазина',
      before: before as any,
      after: after as any,
      important: true,
    });
    await this.outbox.emit(tx, 'settings.updated', {});
    if (notify) {
      await this.notifications.notify(tx, {
        type: 'settings.changed',
        title: 'Изменены настройки магазина',
        link: '/settings',
        permission: 'settings.manage',
        excludeUserId: tx.userId,
      });
    }
  }
}

function validateCipher(c: string) {
  const letters = [...c.toUpperCase()];
  if (letters.length !== 10 || new Set(letters).size !== 10 || !letters.every((l) => /\p{L}/u.test(l))) {
    throw Errors.bad('BAD_CIPHER', 'Шифр — слово из 10 разных букв');
  }
}
