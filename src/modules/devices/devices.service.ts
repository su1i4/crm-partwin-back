import { Injectable, OnModuleInit } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { randomDigits, randomToken, sha256 } from '../../common/utils/crypto';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { OutboxService } from '../../jobs/outbox.service';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { Register } from '../stores/entities/register.entity';
import { Store } from '../stores/entities/store.entity';
import { Device, DevicePairingCode, PrintJob, PrintJobKind, PrintJobStatus } from './entities/device.entity';

const CODE_TTL_MS = 10 * 60_000;

/** Как агент передаёт статусы: печатный текст для пользователя. */
export const PRINT_STATUS_LABELS: Record<string, string> = {
  printed: 'Напечатано',
  no_paper: 'Нет бумаги',
  not_found: 'Принтер не найден',
  offline: 'Принтер выключен',
  error: 'Ошибка печати',
};

/** Токен устройства: магазин (base64url) + секрет; в базе — только sha256. */
export const deviceToken = (tenantId: string) => `dev_${Buffer.from(tenantId.replace(/-/g, ''), 'hex').toString('base64url')}${randomToken(32)}`;

export function tenantOfDeviceToken(token: string): string | null {
  if (!/^dev_[A-Za-z0-9_-]{60,80}$/.test(token)) return null;
  const hex = Buffer.from(token.slice(4, 26), 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const deviceRoom = (tenantId: string, deviceId: string) => `t:${tenantId}:dev:${deviceId}`;

/**
 * DeviceHub (ТЗ 12): привязка локального агента к кассе 6-значным кодом, задания печати,
 * доставка агенту по WebSocket (или опросом REST), статусы «Напечатано / Нет бумаги».
 */
@Injectable()
export class DevicesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly platform: PlatformDb,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly registry: OutboxRegistry,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    // Задание → агенту доставляет AgentGateway (namespace /agent); статус — пользователю
    this.registry.on('print.job_status', (e) => {
      if (e.payload.userId) this.realtime.toUser(e.tenantId, e.payload.userId, 'print.status', e.payload);
    });
  }

  // ── Привязка ─────────────────────────────────────────────

  /** «Подключить агент» в настройках кассы → код на 10 минут. */
  async pairingCode(registerId: string) {
    const { tenantId, reg } = await this.tenantTx.run(async (tx) => {
      const reg = await tx.repo(Register, 'Касса').getById(registerId);
      this.scope.assertStore(reg.storeId);
      return { tenantId: tx.tenantId, reg };
    });
    for (let i = 0; i < 10; i++) {
      const code = randomDigits(6);
      const hash = sha256(`pair:${code}`);
      const busy = await this.platform.repo(DevicePairingCode).findOne({ where: { codeHash: hash } });
      if (busy && !busy.usedAt && busy.expiresAt > new Date()) continue;
      if (busy) await this.platform.repo(DevicePairingCode).delete({ id: busy.id });
      await this.platform.repo(DevicePairingCode).insert({ tenantId, registerId: reg.id, codeHash: hash, expiresAt: new Date(Date.now() + CODE_TTL_MS), createdBy: this.ctx.userId ?? null });
      return { code, expiresInSec: CODE_TTL_MS / 1000, register: { id: reg.id, name: reg.name } };
    }
    throw Errors.conflict('CODE_EXHAUSTED', 'Попробуйте ещё раз');
  }

  /** Агент вводит код → получает токен устройства (показывается один раз). */
  async pair(dto: { code: string; name?: string; agentVersion?: string; info?: Record<string, any> }) {
    const hash = sha256(`pair:${String(dto.code).replace(/\D/g, '')}`);
    const pc = await this.platform.repo(DevicePairingCode).findOne({ where: { codeHash: hash } });
    if (!pc || pc.usedAt || pc.expiresAt < new Date()) throw Errors.bad('PAIRING_CODE_INVALID', 'Код неверный или устарел — получите новый в настройках кассы');
    await this.platform.repo(DevicePairingCode).update({ id: pc.id }, { usedAt: new Date() });
    const token = deviceToken(pc.tenantId);
    const device = await this.tenantTx.run(
      async (tx) => {
        const reg = await tx.repo(Register, 'Касса').getById(pc.registerId);
        const store = await tx.repo(Store).findById(reg.storeId);
        const d = await tx.repo(Device).insert({
          kind: 'agent',
          registerId: reg.id,
          storeId: reg.storeId,
          name: (dto.name ?? `Агент ${reg.name}`).slice(0, 100),
          tokenHash: sha256(token),
          agentVersion: dto.agentVersion ?? null,
          info: dto.info ?? {},
          lastSeenAt: new Date(),
        });
        await this.audit.log(tx, { action: 'device.pair', entityType: 'device', entityId: d.id, storeId: reg.storeId, summary: `Агент привязан к «${reg.name}»`, important: true });
        return { id: d.id, register: { id: reg.id, name: reg.name }, store: { id: store?.id, name: store?.name } };
      },
      { tenantId: pc.tenantId, userId: pc.createdBy },
    );
    return { token, device };
  }

  list(registerId?: string) {
    return this.tenantTx.run(async (tx) => {
      const rows = await tx.repo(Device).find({ where: registerId ? { registerId } : {}, order: { createdAt: 'DESC' } });
      return rows.filter((d) => this.scope.canStore(d.storeId)).map(({ tokenHash: _t, ...d }) => ({ ...d, online: !!d.lastSeenAt && Date.now() - +d.lastSeenAt < 90_000 && !d.revokedAt }));
    });
  }

  revoke(id: string) {
    return this.tenantTx.run(async (tx) => {
      const d = await tx.repo(Device, 'Устройство').getById(id);
      this.scope.assertStore(d.storeId);
      await tx.query(`UPDATE devices SET revoked_at = now(), version = version + 1 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id]);
      await tx.query(`UPDATE print_jobs SET status = 'cancelled' WHERE tenant_id = $1 AND device_id = $2 AND status IN ('queued', 'sent')`, [tx.tenantId, id]);
      await this.audit.log(tx, { action: 'device.revoke', entityType: 'device', entityId: id, storeId: d.storeId, summary: `Токен агента «${d.name}» отозван`, important: true });
      await this.outbox.emit(tx, 'device.revoked', { deviceId: id });
    });
  }

  // ── Агент: аутентификация по токену ──────────────────────

  async authenticate(token: string, kind: 'agent' | 'pos' = 'agent'): Promise<{ tenantId: string; device: Device }> {
    const tenantId = tenantOfDeviceToken(token ?? '');
    if (!tenantId) throw Errors.unauthorized('Неверный токен устройства', 'DEVICE_UNAUTHORIZED');
    const device = await this.tenantTx.run(
      async (tx) => {
        const d = await tx.repo(Device).findOne({ where: { tokenHash: sha256(token), kind } });
        if (d && !d.revokedAt) await tx.query(`UPDATE devices SET last_seen_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, d.id]);
        return d;
      },
      { tenantId, userId: null },
    ).catch(() => null);
    if (!device || device.revokedAt) throw Errors.unauthorized('Устройство отключено', 'DEVICE_REVOKED');
    return { tenantId, device };
  }

  /** Агент забирает задания (опрос, если WebSocket недоступен). */
  async pull(token: string, limit = 10) {
    const { tenantId, device } = await this.authenticate(token);
    return this.tenantTx.run(
      async (tx) => {
        const res = await tx.query(
          `UPDATE print_jobs SET status = 'sent', sent_at = now(), attempts = attempts + 1
            WHERE id IN (SELECT id FROM print_jobs WHERE tenant_id = $1 AND device_id = $2 AND status IN ('queued', 'sent')
                          AND (status = 'queued' OR sent_at < now() - interval '60 seconds') ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED)
            RETURNING id, kind, payload, created_at AS "createdAt"`,
          [tenantId, device.id, limit],
        );
        // UPDATE … RETURNING в драйвере pg возвращает [строки, количество]
        const jobs = Array.isArray(res[0]) ? res[0] : res;
        return { deviceId: device.id, jobs };
      },
      { tenantId, userId: null },
    );
  }

  async heartbeat(token: string, dto: { agentVersion?: string; info?: Record<string, any> }) {
    const { tenantId, device } = await this.authenticate(token);
    await this.tenantTx.run(
      (tx) =>
        tx.query(`UPDATE devices SET agent_version = coalesce($3, agent_version), info = coalesce($4::jsonb, info), last_seen_at = now() WHERE tenant_id = $1 AND id = $2`, [
          tenantId,
          device.id,
          dto.agentVersion ?? null,
          dto.info ? JSON.stringify(dto.info) : null,
        ]),
      { tenantId, userId: null },
    );
    return { ok: true, deviceId: device.id, registerId: device.registerId };
  }

  /** Статус задания от агента: printed | no_paper | not_found | offline | error. */
  async reportStatus(token: string, jobId: string, dto: { status: string; error?: string }) {
    const { tenantId, device } = await this.authenticate(token);
    return this.tenantTx.run(
      async (tx) => {
        const job = await tx.repo(PrintJob, 'Задание').getById(jobId);
        if (job.deviceId !== device.id) throw Errors.notFound('Задание');
        const ok = dto.status === 'printed';
        const status: PrintJobStatus = ok ? 'printed' : 'error';
        const message = ok ? null : (dto.error ?? PRINT_STATUS_LABELS[dto.status] ?? 'Ошибка печати').slice(0, 300);
        // «Нет бумаги» / «выключен» — задание ждёт и печатается после исправления
        const retry = !ok && ['no_paper', 'offline'].includes(dto.status);
        await tx.query(`UPDATE print_jobs SET status = $3::varchar, error = $4::varchar, done_at = CASE WHEN $3::varchar IN ('printed', 'error') THEN now() END WHERE tenant_id = $1 AND id = $2`, [
          tenantId,
          job.id,
          retry ? 'queued' : status,
          message,
        ]);
        await this.outbox.emit(tx, 'print.job_status', { jobId: job.id, status: retry ? 'waiting' : status, label: PRINT_STATUS_LABELS[dto.status] ?? message, userId: job.createdBy, kind: job.kind });
        if (!ok && !retry && job.createdBy) {
          await this.notifications.notify(tx, { type: 'print.failed', title: `Печать не удалась: ${message}`, userIds: [job.createdBy], storeId: device.storeId });
        }
        return { ok: true };
      },
      { tenantId, userId: null },
    );
  }

  // ── Задания ──────────────────────────────────────────────

  /** Поставить задание агенту кассы. Нет агента — ошибка: фронт предложит PDF через системный диалог. */
  async enqueue(tx: TenantTx, registerId: string, kind: PrintJobKind, payload: Record<string, any>): Promise<PrintJob> {
    const devices = await tx.repo(Device).find({ where: { registerId, kind: 'agent' }, order: { lastSeenAt: 'DESC' } });
    const device = devices.find((d) => !d.revokedAt);
    if (!device) throw Errors.conflict('NO_AGENT', 'К кассе не подключён агент печати — напечатайте PDF', { fallback: 'pdf' });
    const job = await tx.repo(PrintJob).insert({ deviceId: device.id, registerId, kind, payload, status: 'queued' });
    await this.outbox.emit(tx, 'print.job_created', { deviceId: device.id, job: { id: job.id, kind, payload, createdAt: job.createdAt } });
    return job;
  }

  job(id: string) {
    return this.tenantTx.run(async (tx) => {
      const j = await tx.repo(PrintJob, 'Задание').getById(id);
      return { id: j.id, kind: j.kind, status: j.status, error: j.error, createdAt: j.createdAt, doneAt: j.doneAt };
    });
  }

  /** Агент подключился по WebSocket — отдать ждущие задания. */
  async pending(tenantId: string, deviceId: string) {
    return this.tenantTx.run(
      (tx) =>
        tx.query(`SELECT id, kind, payload, created_at AS "createdAt" FROM print_jobs WHERE tenant_id = $1 AND device_id = $2 AND status IN ('queued', 'sent') ORDER BY created_at LIMIT 50`, [
          tenantId,
          deviceId,
        ]),
      { tenantId, userId: null },
    );
  }

  async markSent(tenantId: string, deviceId: string, ids: string[]) {
    if (!ids.length) return;
    await this.tenantTx.run(
      (tx) => tx.query(`UPDATE print_jobs SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE tenant_id = $1 AND device_id = $2 AND id = ANY($3::uuid[]) AND status = 'queued'`, [tenantId, deviceId, ids]),
      { tenantId, userId: null },
    );
  }
}
