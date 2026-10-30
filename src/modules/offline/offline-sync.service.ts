import { Injectable, Logger } from '@nestjs/common';
import { AppException, Errors } from '../../common/errors/app.exception';
import { normalizePartNumber } from '../../common/utils/part-number';
import { normalizePhone } from '../../common/utils/login';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { ProductsService } from '../catalog/products.service';
import { CounterpartiesService } from '../counterparties/counterparties.service';
import { Counterparty } from '../counterparties/entities/counterparty.entity';
import { Device, OfflineIdMap, OfflineOp } from '../devices/entities/device.entity';
import { Shift } from '../finance/entities/money.entity';
import { ShiftsService } from '../finance/shifts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReturnsService } from '../pos/returns.service';
import { Store } from '../stores/entities/store.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { OfflineSale, OfflineSalesService } from './offline-sales.service';
import { DeviceContext, PosDevicesService } from './pos-devices.service';

export const OP_TYPES = ['shift_open', 'sale', 'return', 'cash_op', 'shift_close', 'customer', 'product_draft'] as const;
export type OpType = (typeof OP_TYPES)[number];

export interface OfflineOpInput {
  /** UUID операции (у чека — UUID чека) */
  id: string;
  /** Порядковый номер в очереди устройства: 1, 2, 3 … */
  seq: number;
  type: OpType;
  /** Время на устройстве */
  at: string;
  /** Кто выполнил на кассе (продавец) */
  membershipId: string;
  payload: Record<string, any>;
}

export interface SyncResult {
  seq: number;
  id: string;
  status: 'accepted' | 'rejected' | 'retry';
  duplicate?: boolean;
  result?: Record<string, any>;
  code?: string;
  message?: string;
}

/**
 * Приём очереди офлайн-кассы (ТЗ 16.4): строго по порядку (открытие смены → чеки → внесения → закрытие),
 * каждая операция — один раз (UUID), отдельной транзакцией. Ошибка в данных — операция «отклонена», очередь идёт
 * дальше; сбой сервера — «повторить», очередь останавливается и придёт снова.
 */
@Injectable()
export class OfflineSyncService {
  private readonly logger = new Logger(OfflineSyncService.name);

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly platform: PlatformDb,
    private readonly devices: PosDevicesService,
    private readonly sales: OfflineSalesService,
    private readonly shifts: ShiftsService,
    private readonly returns: ReturnsService,
    private readonly counterparties: CounterpartiesService,
    private readonly products: ProductsService,
    private readonly notifications: NotificationsService,
  ) {}

  async sync(token: string | undefined, dto: { deviceTime?: string; ops: OfflineOpInput[] }) {
    const dc = await this.devices.authenticate(token);
    const skewMs = dto.deviceTime && !isNaN(Date.parse(dto.deviceTime)) ? Date.now() - Date.parse(dto.deviceTime) : 0;
    const tenant = await this.platform.repo(Tenant).findOne({ where: { id: dc.tenantId } });
    const ops = [...(dto.ops ?? [])].sort((a, b) => a.seq - b.seq);
    const results: SyncResult[] = [];
    let last = Number((await this.reloadDevice(dc)).lastOpSeq);
    for (const op of ops) {
      const done = await this.tenantTx.run((tx) => tx.repo(OfflineOp).findOne({ where: { deviceId: dc.device.id, opId: op.id } }), { tenantId: dc.tenantId, userId: null });
      if (done) {
        results.push({ seq: op.seq, id: op.id, status: done.status, duplicate: true, result: done.result, ...(done.error ? { message: done.error } : {}) });
        continue;
      }
      // Строгий порядок: пропущенную операцию касса должна прислать раньше следующих
      if (op.seq !== last + 1) {
        results.push({ seq: op.seq, id: op.id, status: 'retry', code: 'OUT_OF_ORDER', message: `Ожидается операция №${last + 1}` });
        break;
      }
      if (!(OP_TYPES as readonly string[]).includes(op.type)) {
        await this.record(dc, op, 'rejected', {}, 'Неизвестный тип операции');
        results.push({ seq: op.seq, id: op.id, status: 'rejected', code: 'UNKNOWN_OP', message: 'Неизвестный тип операции' });
        last = op.seq;
        continue;
      }
      // Подписка приостановлена: принимаем то, что создано на кассе до приостановки (ТЗ 16.4)
      if (tenant?.status === 'suspended' && new Date(op.at) > tenant.updatedAt) {
        await this.record(dc, op, 'rejected', {}, 'Подписка приостановлена');
        results.push({ seq: op.seq, id: op.id, status: 'rejected', code: 'TENANT_SUSPENDED', message: 'Подписка приостановлена' });
        last = op.seq;
        continue;
      }
      try {
        const result = await this.devices.runAs(dc, op.membershipId, () =>
          this.tenantTx.run(async (tx) => {
            const r = await this.apply(tx, dc, op, skewMs);
            await this.insertOp(tx, dc, op, 'accepted', r, null);
            return r;
          }),
        );
        results.push({ seq: op.seq, id: op.id, status: 'accepted', result });
        last = op.seq;
      } catch (e) {
        if (e instanceof AppException) {
          const body = e.getResponse() as any;
          await this.record(dc, op, 'rejected', { code: body.code, details: body.details ?? null }, body.message);
          results.push({ seq: op.seq, id: op.id, status: 'rejected', code: body.code, message: body.message });
          last = op.seq;
          await this.notifyRejected(dc, op, body.message);
          continue;
        }
        this.logger.error(`offline op ${op.type} #${op.seq}: ${(e as Error).message}`);
        results.push({ seq: op.seq, id: op.id, status: 'retry', code: 'SERVER_ERROR', message: 'Сбой сервера — операция придёт снова' });
        break;
      }
    }
    const fresh = await this.reloadDevice(dc);
    return {
      results,
      lastOpSeq: Number(fresh.lastOpSeq),
      serverTime: new Date(),
      clockSkewSec: Math.round(skewMs / 1000),
      warnings: Math.abs(skewMs) > 5 * 60_000 ? [{ code: 'CLOCK_SKEW', message: `Часы устройства сбиты на ${Math.round(Math.abs(skewMs) / 60_000)} мин.` }] : [],
    };
  }

  /** Состояние очереди: что сервер уже принял (касса сверяет при запуске). */
  async state(token: string | undefined) {
    const dc = await this.devices.authenticate(token);
    return this.tenantTx.run(
      async (tx) => {
        const d = await tx.repo(Device).getById(dc.device.id);
        const rejected = await tx.query(
          `SELECT op_id AS id, seq, type, error, result, created_at AS "at" FROM offline_ops WHERE tenant_id = $1 AND device_id = $2 AND status = 'rejected' ORDER BY seq DESC LIMIT 50`,
          [tx.tenantId, d.id],
        );
        return { lastOpSeq: Number(d.lastOpSeq), lastSyncAt: d.lastSyncAt, rejected };
      },
      { tenantId: dc.tenantId, userId: null },
    );
  }

  private async apply(tx: TenantTx, dc: DeviceContext, op: OfflineOpInput, skewMs: number): Promise<Record<string, any>> {
    const p = op.payload ?? {};
    const resolveId = (entity: string, id: string | null | undefined) => this.resolve(tx, entity, id);
    switch (op.type) {
      case 'shift_open': {
        const existing = await tx.repo(Shift).findOne({ where: { registerId: dc.device.registerId, status: 'open' } });
        if (existing) {
          // Смену уже открыли (онлайн или с другой вкладки) — операции этой офлайн-смены пойдут в неё
          await this.map(tx, dc, 'shift', op.id, existing.id);
          return { shiftId: existing.id, joined: true };
        }
        const s = await this.shifts.open(dc.device.registerId, p.cash ?? {});
        const at = new Date(Math.min(Date.now(), Date.parse(op.at) + skewMs));
        await tx.query(`UPDATE shifts SET client_id = $3, opened_at = $4 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, s.id, op.id, at]);
        await this.map(tx, dc, 'shift', op.id, s.id);
        return { shiftId: s.id, number: s.number };
      }
      case 'sale':
        return this.sales.accept(tx, dc, { ...(p as OfflineSale), id: op.id, membershipId: op.membershipId, createdAt: p.createdAt ?? op.at }, { skewMs, resolveId });
      case 'return': {
        const store = await tx.repo(Store, 'Точка').getById(dc.device.storeId);
        const sale = p.saleReceiptId ? await tx.query(`SELECT register_id FROM receipts WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, p.saleReceiptId]) : [];
        // «Несколько касс»: без сети — только возврат по чеку этой кассы (ТЗ 16.2)
        if (store.registerMode !== 'single' && (!p.saleReceiptId || sale[0]?.register_id !== dc.device.registerId)) {
          throw Errors.bad('OFFLINE_NOT_ALLOWED', 'Без интернета в режиме «несколько касс» — только возврат по чеку этой кассы');
        }
        const r = await this.returns.createInTx(
          tx,
          {
            id: op.id,
            registerId: dc.device.registerId,
            saleReceiptId: p.saleReceiptId ?? null,
            customerId: await resolveId('customer', p.customerId),
            lines: p.lines ?? [],
            refundMode: p.refundMode ?? (p.refunds?.length ? 'custom' : 'same'),
            refunds: p.refunds,
            idempotencyKey: `offline:${op.id}`,
            comment: p.comment ?? 'Офлайн-возврат',
          },
          { system: true, skipPeriodCheck: true },
        );
        await tx.query(`UPDATE receipts SET offline = true, device_id = $3, device_created_at = $4, received_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, r.id, dc.device.id, op.at]);
        return { receiptId: r.id, number: r.number, total: r.total.toFixed(2) };
      }
      case 'cash_op': {
        const shiftId = await resolveId('shift', p.shiftId);
        if (!shiftId) throw Errors.bad('UNKNOWN_SHIFT', 'Смена не найдена');
        const o = await this.shifts.cashOperation(shiftId, { type: p.type, currency: p.currency, amount: String(p.amount), toAccountId: p.toAccountId, purpose: p.purpose, rate: p.rate, toAmount: p.toAmount, comment: p.comment });
        return { operationId: o.id };
      }
      case 'shift_close': {
        const shiftId = await resolveId('shift', p.shiftId);
        if (!shiftId) throw Errors.bad('UNKNOWN_SHIFT', 'Смена не найдена');
        const s = await tx.repo(Shift, 'Смена').getById(shiftId);
        if (s.status === 'closed') return { shiftId, alreadyClosed: true };
        const closed = await this.shifts.close(shiftId, undefined as any, p.counted ?? {});
        return { shiftId, diff: closed.diff };
      }
      case 'customer': {
        // Новый клиент с кассы: при синхронизации — объединение по телефону (ТЗ 16.2)
        const phone = p.phone ? normalizePhone(p.phone) : null;
        if (phone) {
          const dup = await tx.repo(Counterparty).findOne({ where: { phone } });
          if (dup) {
            await this.map(tx, dc, 'customer', op.id, dup.id);
            return { customerId: dup.id, merged: true };
          }
        }
        const c = await this.counterparties.createInTx(tx, { name: p.name, phone: p.phone, roles: p.roles ?? ['customer'], confirmDuplicatePhone: true });
        await this.map(tx, dc, 'customer', op.id, c.id);
        return { customerId: c.id };
      }
      case 'product_draft': {
        const store = await tx.repo(Store, 'Точка').getById(dc.device.storeId);
        if (store.registerMode !== 'single') throw Errors.bad('OFFLINE_NOT_ALLOWED', 'Без интернета в режиме «несколько касс» товар не создаётся — только свободная позиция');
        // Проверка дубля по номеру и бренду
        if (p.number) {
          const [dup] = await tx.query(
            `SELECT n.product_id FROM part_numbers n JOIN products pr ON pr.id = n.product_id AND pr.deleted_at IS NULL LEFT JOIN brands b ON b.id = n.brand_id
              WHERE n.tenant_id = $1 AND n.normalized = $2 AND ($3::text IS NULL OR b.name ILIKE $3) LIMIT 1`,
            [tx.tenantId, normalizePartNumber(p.number), p.brand ?? null],
          );
          if (dup) {
            await this.map(tx, dc, 'product', op.id, dup.product_id);
            return { productId: dup.product_id, merged: true };
          }
        }
        const prod: any = await this.products.createInTx(tx, { name: p.name, number: p.number, brand: p.brand, ...(p.price ? { price: String(p.price) } : {}) } as any, { quick: true });
        await this.map(tx, dc, 'product', op.id, prod.id);
        return { productId: prod.id };
      }
    }
  }

  private async resolve(tx: TenantTx, entity: string, id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    const m = await tx.repo(OfflineIdMap).findOne({ where: { entity: entity as any, clientId: id } });
    return m?.serverId ?? id;
  }

  private async map(tx: TenantTx, dc: DeviceContext, entity: 'customer' | 'product' | 'shift', clientId: string, serverId: string) {
    await tx.query(
      `INSERT INTO offline_id_map (tenant_id, device_id, entity, client_id, server_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, entity, client_id) DO NOTHING`,
      [tx.tenantId, dc.device.id, entity, clientId, serverId],
    );
  }

  private async insertOp(tx: TenantTx, dc: DeviceContext, op: OfflineOpInput, status: 'accepted' | 'rejected', result: Record<string, any>, error: string | null) {
    await tx.repo(OfflineOp).insert({ deviceId: dc.device.id, opId: op.id, seq: String(op.seq), type: op.type, status, result, error: error?.slice(0, 300) ?? null, deviceAt: isNaN(Date.parse(op.at)) ? null : new Date(op.at) });
    await tx.query(`UPDATE devices SET last_op_seq = GREATEST(last_op_seq, $3), last_sync_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, dc.device.id, op.seq]);
  }

  private record(dc: DeviceContext, op: OfflineOpInput, status: 'accepted' | 'rejected', result: Record<string, any>, error: string | null) {
    return this.tenantTx.run((tx) => this.insertOp(tx, dc, op, status, result, error), { tenantId: dc.tenantId, userId: null });
  }

  private reloadDevice(dc: DeviceContext) {
    return this.tenantTx.run((tx) => tx.repo(Device).getById(dc.device.id), { tenantId: dc.tenantId, userId: null });
  }

  private notifyRejected(dc: DeviceContext, op: OfflineOpInput, message: string) {
    return this.tenantTx
      .run(
        (tx) =>
          this.notifications.notify(tx, {
            type: 'pos.unsent_receipts',
            title: `Касса: офлайн-операция «${OP_LABELS[op.type] ?? op.type}» №${op.seq} не принята — ${message}`.slice(0, 300),
            storeId: dc.device.storeId,
            permission: 'reports.sales',
          }),
        { tenantId: dc.tenantId, userId: null },
      )
      .catch(() => undefined);
  }
}

const OP_LABELS: Record<string, string> = {
  shift_open: 'открытие смены',
  sale: 'чек',
  return: 'возврат',
  cash_op: 'внесение / изъятие',
  shift_close: 'закрытие смены',
  customer: 'новый клиент',
  product_draft: 'новый товар',
};
