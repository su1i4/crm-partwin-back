import { Injectable } from '@nestjs/common';
import { createHmac, pbkdf2Sync, randomInt } from 'crypto';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app.config';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Membership } from '../users/entities/membership.entity';
import { User } from '../users/entities/user.entity';
import { ReceiptApproval } from './entities/receipt.entity';

const PIN_LENGTH = 5;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
/** PIN без сети: PBKDF2 — касса проверяет PIN тем же алгоритмом (ТЗ 3.5) */
export const PIN_OFFLINE = { iterations: 20000, keyLength: 32, digest: 'sha256' as const };
export const pinOfflineSalt = (tenantId: string, membershipId: string) => `pin:${tenantId}:${membershipId}`;

export interface PinApprover {
  membershipId: string;
  userId: string;
  name: string;
  isOwner: boolean;
  permissions: string[];
  maxDiscountPercent: number;
}

/**
 * PIN старшего (ТЗ 13.3, 13.8): подтверждение скидки сверх лимита, долга сверх лимита, продажи ниже себестоимости,
 * удаления строки. PIN выдаёт система (5 цифр, уникален в магазине) — чтобы при выборе своего нельзя было
 * узнать чужой. Хранится HMAC. 5 неверных попыток с кассы — блокировка на 15 минут.
 */
@Injectable()
export class PinService {
  private readonly fails = new Map<string, { n: number; until: number }>();

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly config: AppConfig,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private lookup(tenantId: string, pin: string) {
    return createHmac('sha256', this.config.encryptionKey).update(`pin:${tenantId}:${pin}`).digest('hex');
  }

  /** Выдать новый PIN себе или (с правом staff.manage) сотруднику. Показывается один раз. */
  issue(membershipId?: string) {
    return this.tenantTx.run(async (tx) => {
      const target = membershipId ?? this.ctx.membershipId;
      if (!target) throw Errors.forbidden();
      if (target !== this.ctx.membershipId && !this.ctx.can('staff.manage')) throw Errors.forbidden('Выдавать PIN сотрудникам может только тот, кто управляет сотрудниками');
      const m = await tx.repo(Membership, 'Сотрудник').getById(target);
      for (let attempt = 0; attempt < 20; attempt++) {
        const pin = String(randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
        if (/^(\d)\1+$/.test(pin)) continue;
        const key = this.lookup(tx.tenantId, pin);
        const taken = await tx.repo(Membership).count({ where: { pinLookup: key } });
        if (taken) continue;
        const offline = pbkdf2Sync(pin, pinOfflineSalt(tx.tenantId, m.id), PIN_OFFLINE.iterations, PIN_OFFLINE.keyLength, PIN_OFFLINE.digest).toString('base64');
        await tx.query(`UPDATE memberships SET pin_lookup = $3, pin_offline_hash = $4, pin_set_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, m.id, key, offline]);
        await this.audit.log(tx, { action: 'pin.issue', entityType: 'membership', entityId: m.id, summary: 'Выдан новый PIN', important: true });
        return { pin, length: PIN_LENGTH };
      }
      throw Errors.conflict('PIN_EXHAUSTED', 'Не удалось подобрать PIN, попробуйте ещё раз');
    });
  }

  revoke(membershipId: string) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Membership, 'Сотрудник').getById(membershipId);
      await tx.query(`UPDATE memberships SET pin_lookup = NULL, pin_offline_hash = NULL, pin_set_at = NULL WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, membershipId]);
      await this.audit.log(tx, { action: 'pin.revoke', entityType: 'membership', entityId: membershipId, important: true });
    });
  }

  /** Кто ввёл PIN. Ошибка, если PIN неверный или касса заблокирована после попыток. */
  async verify(tx: TenantTx, pin: string, failKey?: string): Promise<PinApprover> {
    const key = `${tx.tenantId}:${failKey ?? this.ctx.membershipId ?? tx.userId}`;
    const f = this.fails.get(key);
    if (f && f.until > Date.now()) throw Errors.tooMany('Слишком много неверных PIN — подождите 15 минут', { retryAfterSec: Math.ceil((f.until - Date.now()) / 1000) });
    const clean = String(pin ?? '').replace(/\D/g, '');
    const m = clean.length === PIN_LENGTH ? await tx.repo(Membership).findOne({ where: { pinLookup: this.lookup(tx.tenantId, clean) } }) : null;
    if (!m || m.status !== 'active') {
      const n = (f && f.until <= Date.now() && f.n >= MAX_FAILS ? 0 : (f?.n ?? 0)) + 1;
      this.fails.set(key, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      if (n >= MAX_FAILS) {
        await this.notifications.notify(tx, { type: 'pin.blocked', title: 'Касса заблокирована: 5 неверных PIN подряд', permission: 'staff.manage' });
      }
      throw Errors.bad('PIN_INVALID', 'Неверный PIN');
    }
    this.fails.delete(key);
    const access = await this.access.load(tx.tenantId, m.id, m.userId);
    const user = await tx.manager.findOne(User, { where: { id: m.userId } });
    return {
      membershipId: m.id,
      userId: m.userId,
      name: user?.name ?? 'Сотрудник',
      isOwner: m.isOwner,
      permissions: access?.permissions ?? [],
      maxDiscountPercent: access?.maxDiscountPercent ?? 0,
    };
  }

  can(a: PinApprover, permission: string) {
    return a.isOwner || a.permissions.includes(permission);
  }

  /**
   * Нужно ли подтверждение и подходит ли PIN: если у текущего пользователя есть право — PIN не нужен.
   * Иначе — PIN сотрудника с этим правом (или проверка check для лимитов).
   */
  async approve(
    tx: TenantTx,
    opts: { action: ReceiptApproval['action']; permission: string; pin?: string | null; code: string; message: string; check?: (a: PinApprover) => boolean; selfOk?: boolean },
  ): Promise<ReceiptApproval | null> {
    if (opts.selfOk ?? this.ctx.can(opts.permission)) return null;
    if (!opts.pin) throw Errors.conflict(opts.code, opts.message, { requiresPin: true, action: opts.action });
    const a = await this.verify(tx, opts.pin);
    const ok = opts.check ? opts.check(a) : this.can(a, opts.permission);
    if (!ok) throw Errors.forbidden(`У сотрудника ${a.name} нет права подтвердить это`);
    return { action: opts.action, membershipId: a.membershipId, name: a.name, at: new Date().toISOString() };
  }
}
