import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { sha256 } from '../../common/utils/crypto';
import { SecretBox } from '../../common/utils/secret-box';
import { AppConfig } from '../../config/app.config';
import { CountersService } from '../../database/tenant/counters.service';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { ScopeService } from '../auth/scope.service';
import { ClientMeta, SessionsService } from '../auth/sessions.service';
import { Device } from '../devices/entities/device.entity';
import { DevicesService, deviceToken } from '../devices/devices.service';
import { PinService } from '../pos/pin.service';
import { Register } from '../stores/entities/register.entity';
import { Membership } from '../users/entities/membership.entity';

/** Серии номеров офлайн-чеков: К1А, К1Б, … (ТЗ 16.4). Без похожих на цифры и латиницу букв. */
const SERIES = 'АБВГДЕЖИКЛМНПРСТУФХЦЧШЭЮЯ';
export function seriesFor(n: number): string {
  let s = '';
  let x = n;
  do {
    s = SERIES[x % SERIES.length] + s;
    x = Math.floor(x / SERIES.length) - 1;
  } while (x >= 0);
  return s;
}

export interface DeviceContext {
  tenantId: string;
  device: Device;
}

/**
 * Кассовое устройство (ТЗ 3.5): администратор привязывает браузер или телефон к кассе — устройство получает
 * долгоживущий токен (по нему уходят офлайн-чеки, даже если токен продавца истёк), серию номеров и секрет
 * для проверки PIN без сети.
 */
@Injectable()
export class PosDevicesService {
  private readonly box: SecretBox;

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly devices: DevicesService,
    private readonly access: AccessService,
    private readonly sessions: SessionsService,
    private readonly pins: PinService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    config: AppConfig,
  ) {
    this.box = new SecretBox(config.encryptionKey);
  }

  /** Привязать этот браузер / телефон к кассе. Токен и секрет показываются один раз. */
  register(dto: { registerId: string; name?: string; info?: Record<string, any> }) {
    return this.tenantTx.run(async (tx) => {
      const reg = await tx.repo(Register, 'Касса').getById(dto.registerId);
      this.scope.assertStore(reg.storeId);
      if (!reg.isActive) throw Errors.bad('REGISTER_INACTIVE', 'Касса отключена');
      const token = deviceToken(tx.tenantId);
      const secret = randomBytes(32).toString('base64url');
      // Каждая новая привязка (переустановка, очистка данных) — новая серия: номера не повторяются
      const n = await this.counters.next(tx, `pos_series:${reg.id}`);
      const series = seriesFor(n - 1);
      const d = await tx.repo(Device).insert({
        kind: 'pos',
        registerId: reg.id,
        storeId: reg.storeId,
        name: (dto.name ?? `Касса ${reg.name}`).slice(0, 100),
        tokenHash: sha256(token),
        info: dto.info ?? {},
        series,
        secretEnc: this.box.encrypt(secret),
        lastOpSeq: '0',
      });
      await this.audit.log(tx, { action: 'pos_device.register', entityType: 'device', entityId: d.id, storeId: reg.storeId, summary: `Устройство «${d.name}» привязано к «${reg.name}», серия ${series}`, important: true });
      return {
        deviceId: d.id,
        token,
        secret,
        series,
        numberPrefix: `${reg.code}${series}`,
        register: { id: reg.id, code: reg.code, name: reg.name, storeId: reg.storeId, warehouseId: reg.warehouseId },
      };
    });
  }

  list(registerId?: string) {
    return this.tenantTx.run(async (tx) => {
      const rows = await tx.repo(Device).find({ where: registerId ? { registerId, kind: 'pos' } : { kind: 'pos' }, order: { createdAt: 'DESC' } });
      return rows
        .filter((d) => this.scope.canStore(d.storeId))
        .map((d) => ({ id: d.id, name: d.name, registerId: d.registerId, series: d.series, lastSeenAt: d.lastSeenAt, lastSyncAt: d.lastSyncAt, lastOpSeq: d.lastOpSeq, revokedAt: d.revokedAt }));
    });
  }

  revoke(id: string) {
    return this.devices.revoke(id);
  }

  /** Аутентификация кассы по токену устройства (заголовок X-Device-Token). */
  async authenticate(token: string | undefined): Promise<DeviceContext> {
    return this.devices.authenticate(token ?? '', 'pos');
  }

  secretOf(device: Device): string {
    if (!device.secretEnc) throw Errors.bad('NO_DEVICE_SECRET', 'У устройства нет секрета');
    return this.box.decrypt(device.secretEnc);
  }

  /** Хэш PIN для кассы: HMAC(секрет устройства, PBKDF2(PIN)) — на другом устройстве бесполезен. */
  wrapPinHash(device: Device, offlineHash: string | null): string | null {
    if (!offlineHash) return null;
    return createHmac('sha256', this.secretOf(device)).update(offlineHash).digest('base64');
  }

  /**
   * Выполнить fn от имени устройства: магазин, точка кассы; если указан участник — его права (продавец чека).
   * Права и точки берутся из базы, а не из токена продавца (он мог истечь, пока касса была без сети).
   */
  async runAs<R>(dc: DeviceContext, membershipId: string | null, fn: () => Promise<R>): Promise<R> {
    return this.ctx.cls.run({ ifNested: 'inherit' }, async () => {
      this.ctx.set('tenantId', dc.tenantId);
      this.ctx.set('deviceId', dc.device.id);
      this.ctx.set('currentStoreId', dc.device.storeId);
      if (membershipId) {
        const m = await this.tenantTx.run((tx) => tx.repo(Membership).findById(membershipId), { tenantId: dc.tenantId, userId: null });
        if (!m) throw Errors.bad('UNKNOWN_SELLER', 'Продавец чека не найден');
        const a = await this.access.load(dc.tenantId, m.id, m.userId);
        if (!a) throw Errors.bad('UNKNOWN_SELLER', 'Продавец чека не найден');
        this.ctx.set('userId', m.userId);
        this.ctx.set('membershipId', m.id);
        this.ctx.set('isOwner', a.isOwner);
        this.ctx.set('permissions', a.permissions);
        // Точка кассы — всегда: чек уже пробит на этой кассе (доступ продавца могли изменить, пока не было сети)
        this.ctx.set('storeIds', a.allStores || a.isOwner ? null : [...new Set([...a.storeIds, dc.device.storeId])]);
        this.ctx.set('warehouseIds', a.warehouseIds.length ? a.warehouseIds : null);
        this.ctx.set('maxDiscountPercent', a.maxDiscountPercent);
      } else {
        this.ctx.set('userId', undefined as any);
        this.ctx.set('membershipId', undefined as any);
        this.ctx.set('permissions', []);
        this.ctx.set('storeIds', [dc.device.storeId]);
      }
      return fn();
    });
  }

  /**
   * Вход продавца на кассе по PIN (только на зарегистрированном устройстве): сессия этого продавца.
   * 5 ошибок — блокировка на 15 минут и уведомление.
   */
  async pinLogin(token: string | undefined, pin: string, meta: ClientMeta) {
    const dc = await this.authenticate(token);
    const approver = await this.tenantTx.run((tx) => this.pins.verify(tx, pin, `dev:${dc.device.id}`), { tenantId: dc.tenantId, userId: null });
    const a = await this.access.load(dc.tenantId, approver.membershipId, approver.userId);
    if (!a || a.status !== 'active') throw Errors.forbidden('Сотрудник отключён');
    if (!a.isOwner && !a.allStores && !a.storeIds.includes(dc.device.storeId)) throw Errors.forbidden('Нет доступа к этой точке');
    if (!a.isOwner && !a.permissions.includes('pos.use')) throw Errors.forbidden('Нет права работать на кассе');
    const tokens = await this.sessions.create(approver.userId, { tenantId: dc.tenantId, membershipId: approver.membershipId }, { ...meta, userAgent: `pos-device:${dc.device.id} ${meta.userAgent ?? ''}`.slice(0, 400) });
    await this.tenantTx.run(
      (tx) => this.audit.log(tx, { action: 'pos_device.pin_login', entityType: 'device', entityId: dc.device.id, storeId: dc.device.storeId, summary: `Вход по PIN: ${approver.name}` }),
      { tenantId: dc.tenantId, userId: approver.userId },
    );
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, membershipId: approver.membershipId, name: approver.name };
  }
}
