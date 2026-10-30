import { Injectable } from '@nestjs/common';
import { Not } from 'typeorm';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { isValidTimezone } from '../../common/utils/dates';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { OutboxService } from '../../jobs/outbox.service';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { ScopeService } from '../auth/scope.service';
import { MoneyAccount } from '../finance/entities/money-account.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { Tenant } from '../tenants/entities/tenant.entity';
import { MembershipStoreAccess } from '../users/entities/membership-access.entity';
import {
  CreateRegisterDto,
  CreateStoreDto,
  CreateWarehouseDto,
  UpdateRegisterDto,
  UpdateStoreDto,
  UpdateWarehouseDto,
} from './dto/stores.dto';
import { Register } from './entities/register.entity';
import { Store } from './entities/store.entity';
import { Warehouse } from './entities/warehouse.entity';

/** Точки, склады, кассы (ТЗ 3.1, 16.1). */
@Injectable()
export class StoresService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly scope: ScopeService,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly access: AccessService,
    private readonly platform: PlatformDb,
  ) {}

  // ── Точки ───────────────────────────────────────────────

  async listStores(includeInactive = false) {
    return this.tenantTx.run(async (tx) => {
      const stores = await tx.repo(Store).find({
        where: includeInactive ? {} : { isActive: true },
        order: { createdAt: 'ASC' },
      });
      return stores.filter((s) => this.scope.canStore(s.id));
    });
  }

  async getStore(tx: TenantTx, id: string) {
    const store = await tx.repo(Store, 'Точка').getById(id);
    this.scope.assertStore(store.id);
    return store;
  }

  async createStore(dto: CreateStoreDto) {
    if (dto.timezone && !isValidTimezone(dto.timezone)) throw Errors.bad('BAD_TIMEZONE', 'Неизвестный часовой пояс');
    return this.tenantTx.run(async (tx) => {
      await this.assertLimit(tx, 'stores', await tx.repo(Store).count());
      const code = dto.code ?? (await this.nextCode(tx, Store, 'Т'));
      if (dto.code && (await tx.repo(Store).count({ where: { code: dto.code } }))) {
        throw Errors.conflict('CODE_TAKEN', 'Точка с таким кодом уже есть');
      }
      const store = await tx.repo(Store).insert({
        name: dto.name,
        code,
        address: dto.address ?? null,
        phone: dto.phone ?? null,
        timezone: dto.timezone ?? 'Asia/Bishkek',
        registerMode: 'single',
      });
      // Создатель с ограниченным доступом должен видеть созданную точку
      if (!this.scope.hasAllStores() && this.ctx.membershipId) {
        await tx.repo(MembershipStoreAccess).insert({ membershipId: this.ctx.membershipId, storeId: store.id });
        tx.onCommit(() => this.access.invalidateMembership(this.ctx.membershipId!));
      }
      if (dto.createDefaults !== false) {
        const s = await this.settings.get(tx);
        const wh = await tx.repo(Warehouse).insert({
          storeId: store.id,
          name: 'Торговый зал',
          code: await this.freeCode(tx, Warehouse, `${code}-ЗАЛ`),
          type: 'sales_floor',
          storageLevel: s.defaultStorageLevel,
        });
        await this.createRegisterInternal(tx, store, { name: 'Касса 1', warehouseId: wh.id });
      }
      await this.audit.log(tx, {
        action: 'store.create',
        entityType: 'store',
        entityId: store.id,
        storeId: store.id,
        summary: `Создана точка «${store.name}»`,
        after: store,
      });
      return store;
    });
  }

  async updateStore(id: string, dto: UpdateStoreDto) {
    if (dto.timezone && !isValidTimezone(dto.timezone)) throw Errors.bad('BAD_TIMEZONE', 'Неизвестный часовой пояс');
    return this.tenantTx.run(async (tx) => {
      const store = await this.getStore(tx, id);
      const before = { ...store };
      if (dto.isActive === false && store.isActive) {
        const active = await tx.repo(Store).count({ where: { isActive: true } });
        if (active <= 1) throw Errors.conflict('LAST_STORE', 'Нельзя отключить последнюю точку');
      }
      const saved = await tx.repo(Store).update(id, { ...dto }, dto.version);
      await this.audit.log(tx, {
        action: 'store.update',
        entityType: 'store',
        entityId: id,
        storeId: id,
        summary: `Изменена точка «${saved.name}»`,
        before,
        after: saved,
      });
      return saved;
    });
  }

  async removeStore(id: string, version: number) {
    await this.tenantTx.run(async (tx) => {
      const store = await this.getStore(tx, id);
      if (store.version !== version) throw Errors.versionConflict();
      const total = await tx.repo(Store).count();
      if (total <= 1) throw Errors.conflict('LAST_STORE', 'Нельзя удалить последнюю точку');
      const regs = await tx.repo(Register).count({ where: { storeId: id } });
      const whs = await tx.repo(Warehouse).count({ where: { storeId: id } });
      if (regs || whs) {
        throw Errors.conflict('STORE_NOT_EMPTY', 'У точки есть кассы или склады. Отключите точку вместо удаления', {
          registers: regs,
          warehouses: whs,
        });
      }
      await tx.repo(Store).softDelete(id);
      await this.audit.log(tx, { action: 'store.delete', entityType: 'store', entityId: id, before: store, important: true });
    });
  }

  // ── Склады ──────────────────────────────────────────────

  async listWarehouses(storeId?: string, includeInactive = false) {
    return this.tenantTx.run(async (tx) => {
      if (storeId) this.scope.assertStore(storeId);
      const rows = await tx.repo(Warehouse).find({
        where: { ...(storeId ? { storeId } : {}), ...(includeInactive ? {} : { isActive: true }) },
        order: { createdAt: 'ASC' },
      });
      const allowed = await this.scope.warehouseIds(tx);
      return allowed === null ? rows : rows.filter((w) => allowed.includes(w.id));
    });
  }

  async createWarehouse(dto: CreateWarehouseDto) {
    return this.tenantTx.run(async (tx) => {
      let prefix = 'Ц';
      if (dto.storeId) {
        const store = await this.getStore(tx, dto.storeId);
        prefix = store.code;
      } else if (!this.scope.hasAllStores()) {
        throw Errors.forbidden('Центральный склад может создать только сотрудник с доступом ко всем точкам');
      }
      const s = await this.settings.get(tx);
      const code = dto.code ?? (await this.nextCode(tx, Warehouse, `${prefix}-`));
    if (dto.code && (await this.freeCode(tx, Warehouse, dto.code)) !== dto.code) {
      throw Errors.conflict('CODE_TAKEN', 'Склад с таким кодом уже есть');
    }
      const wh = await tx.repo(Warehouse).insert({
        storeId: dto.storeId ?? null,
        name: dto.name,
        code,
        type: dto.type,
        storageLevel: dto.storageLevel ?? s.defaultStorageLevel,
      });
      await this.audit.log(tx, {
        action: 'warehouse.create',
        entityType: 'warehouse',
        entityId: wh.id,
        storeId: wh.storeId,
        summary: `Создан склад «${wh.name}»`,
        after: wh,
      });
      return wh;
    });
  }

  async updateWarehouse(id: string, dto: UpdateWarehouseDto) {
    return this.tenantTx.run(async (tx) => {
      const wh = await tx.repo(Warehouse, 'Склад').getById(id);
      await this.scope.assertWarehouse(tx, id);
      const before = { ...wh };
      if (dto.isActive === false) {
        const used = await tx.repo(Register).count({ where: { warehouseId: id, isActive: true } });
        if (used) throw Errors.conflict('WAREHOUSE_IN_USE', 'С этого склада продают кассы. Сначала смените склад у касс');
      }
      // Смена уровня хранения — отдельной операцией (ТЗ 8.4), здесь не меняется
      const saved = await tx.repo(Warehouse).update(id, { name: dto.name, code: dto.code, isActive: dto.isActive }, dto.version);
      await this.audit.log(tx, {
        action: 'warehouse.update',
        entityType: 'warehouse',
        entityId: id,
        storeId: wh.storeId,
        before,
        after: saved,
      });
      return saved;
    });
  }

  async removeWarehouse(id: string, version: number) {
    await this.tenantTx.run(async (tx) => {
      const wh = await tx.repo(Warehouse, 'Склад').getById(id);
      await this.scope.assertWarehouse(tx, id);
      if (wh.version !== version) throw Errors.versionConflict();
      const used = await tx.repo(Register).count({ where: { warehouseId: id } });
      if (used) throw Errors.conflict('WAREHOUSE_IN_USE', 'Склад привязан к кассам');
      // Этап 2: запрет удаления склада с движениями
      await tx.repo(Warehouse).softDelete(id);
      await this.audit.log(tx, { action: 'warehouse.delete', entityType: 'warehouse', entityId: id, before: wh });
    });
  }

  // ── Кассы ───────────────────────────────────────────────

  async listRegisters(storeId?: string, includeInactive = false) {
    return this.tenantTx.run(async (tx) => {
      if (storeId) this.scope.assertStore(storeId);
      const rows = await tx.repo(Register).find({
        where: { ...(storeId ? { storeId } : {}), ...(includeInactive ? {} : { isActive: true }) },
        order: { code: 'ASC' },
      });
      return rows.filter((r) => this.scope.canStore(r.storeId));
    });
  }

  async createRegister(dto: CreateRegisterDto) {
    return this.tenantTx.run(async (tx) => {
      const store = await this.getStore(tx, dto.storeId);
      const reg = await this.createRegisterInternal(tx, store, dto);
      await this.audit.log(tx, {
        action: 'register.create',
        entityType: 'register',
        entityId: reg.id,
        storeId: store.id,
        summary: `Создана касса ${reg.code} «${reg.name}»`,
        after: reg,
      });
      return reg;
    });
  }

  private async createRegisterInternal(
    tx: TenantTx,
    store: Store,
    dto: { name?: string; code?: string; warehouseId?: string },
  ) {
    await this.assertLimit(tx, 'registers', await tx.repo(Register).count({ where: { isActive: true } }));
    const warehouseId = dto.warehouseId ?? (await this.defaultWarehouse(tx, store.id)).id;
    await this.assertWarehouseOfStore(tx, warehouseId, store.id);
    const code = dto.code ?? (await this.nextCode(tx, Register, 'К'));
    const count = await tx.repo(Register).count({ where: { storeId: store.id } });
    const reg = await tx.repo(Register).insert({
      storeId: store.id,
      warehouseId,
      code,
      name: dto.name ?? `Касса ${count + 1}`,
    });
    await tx.repo(MoneyAccount).insertMany([
      { type: 'cash', name: `${reg.name} — сомы`, currency: 'KGS', storeId: store.id, registerId: reg.id },
      { type: 'cash', name: `${reg.name} — доллары`, currency: 'USD', storeId: store.id, registerId: reg.id },
    ]);
    await this.recomputeRegisterMode(tx, store.id);
    return reg;
  }

  async updateRegister(id: string, dto: UpdateRegisterDto) {
    return this.tenantTx.run(async (tx) => {
      const reg = await tx.repo(Register, 'Касса').getById(id);
      this.scope.assertStore(reg.storeId);
      if (dto.warehouseId) await this.assertWarehouseOfStore(tx, dto.warehouseId, reg.storeId);
      if (dto.isActive === true && !reg.isActive) {
        await this.assertLimit(tx, 'registers', await tx.repo(Register).count({ where: { isActive: true } }));
      }
      // Этап 3: нельзя отключить кассу с открытой сменой
      const before = { ...reg };
      const saved = await tx.repo(Register).update(
        id,
        { name: dto.name, warehouseId: dto.warehouseId, isActive: dto.isActive },
        dto.version,
      );
      if (dto.isActive !== undefined && dto.isActive !== before.isActive) {
        await tx.manager.update(MoneyAccount, { tenantId: tx.tenantId, registerId: id }, { isActive: dto.isActive });
        await this.recomputeRegisterMode(tx, reg.storeId);
      }
      await this.audit.log(tx, {
        action: 'register.update',
        entityType: 'register',
        entityId: id,
        storeId: reg.storeId,
        before,
        after: saved,
      });
      return saved;
    });
  }

  async removeRegister(id: string, version: number) {
    await this.tenantTx.run(async (tx) => {
      const reg = await tx.repo(Register, 'Касса').getById(id);
      this.scope.assertStore(reg.storeId);
      if (reg.version !== version) throw Errors.versionConflict();
      // Этап 3: касса с чеками не удаляется — только отключается
      await tx.repo(Register).softDelete(id);
      await tx.manager.update(MoneyAccount, { tenantId: tx.tenantId, registerId: id }, { isActive: false });
      await this.recomputeRegisterMode(tx, reg.storeId);
      await this.audit.log(tx, { action: 'register.delete', entityType: 'register', entityId: id, before: reg });
    });
  }

  /**
   * Режим точки «одна касса» / «несколько касс» переключается сам по числу активных касс (ТЗ 16.1).
   * При переключении — уведомление владельцу.
   */
  async recomputeRegisterMode(tx: TenantTx, storeId: string) {
    const store = await tx.repo(Store).getById(storeId);
    const active = await tx.repo(Register).count({ where: { storeId, isActive: true } });
    const mode = active > 1 ? 'multi' : 'single';
    if (store.registerMode === mode) return;
    store.registerMode = mode;
    await tx.repo(Store).save(store);
    await this.outbox.emit(tx, 'register.mode_changed', { storeId, mode });
    await this.notifications.notify(tx, {
      type: 'register.mode_changed',
      title:
        mode === 'multi'
          ? `Точка «${store.name}»: несколько касс — без интернета часть операций будет недоступна`
          : `Точка «${store.name}»: режим «одна касса»`,
      entityType: 'store',
      entityId: storeId,
      storeId,
      ownersOnly: true,
    });
  }

  // ── Вспомогательное ────────────────────────────────────

  private async defaultWarehouse(tx: TenantTx, storeId: string) {
    const wh =
      (await tx.repo(Warehouse).findOne({ where: { storeId, type: 'sales_floor', isActive: true }, order: { createdAt: 'ASC' } })) ??
      (await tx.repo(Warehouse).findOne({ where: { storeId, isActive: true, type: Not('customer') }, order: { createdAt: 'ASC' } }));
    if (!wh) throw Errors.bad('NO_WAREHOUSE', 'У точки нет склада для кассы');
    return wh;
  }

  private async assertWarehouseOfStore(tx: TenantTx, warehouseId: string, storeId: string) {
    const wh = await tx.repo(Warehouse, 'Склад').getById(warehouseId);
    if (wh.storeId !== storeId) throw Errors.bad('WAREHOUSE_OTHER_STORE', 'Склад принадлежит другой точке');
    if (wh.type === 'customer' || wh.type === 'transit') {
      throw Errors.bad('WAREHOUSE_VIRTUAL', 'Касса не может продавать с виртуального склада');
    }
  }

  private async nextCode(tx: TenantTx, entity: typeof Store | typeof Register | typeof Warehouse, prefix: string) {
    const table = tx.manager.connection.getMetadata(entity).tableName;
    const rows = await tx.query<{ code: string }>(
      `SELECT code FROM "${table}" WHERE tenant_id = $1 AND code LIKE $2`,
      [tx.tenantId, `${prefix}%`],
    );
    const used = new Set(rows.map((r) => r.code));
    let n = 1;
    while (used.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  /** Код свободен — вернуть как есть, иначе добавить номер: ДОР-ЗАЛ → ДОР-ЗАЛ2. */
  async freeCode(tx: TenantTx, entity: typeof Store | typeof Register | typeof Warehouse, base: string) {
    const table = tx.manager.connection.getMetadata(entity).tableName;
    const rows = await tx.query<{ code: string }>(
      `SELECT code FROM "${table}" WHERE tenant_id = $1 AND deleted_at IS NULL AND code LIKE $2`,
      [tx.tenantId, `${base}%`],
    );
    const used = new Set(rows.map((r) => r.code));
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(`${base}${n}`)) n++;
    return `${base}${n}`;
  }

  /** Лимиты тарифа (ТЗ 24): задаёт администратор платформы. */
  private async assertLimit(tx: TenantTx, key: 'stores' | 'registers' | 'staff', current: number) {
    const tenant = await this.platform.repo(Tenant).findOne({ where: { id: tx.tenantId } });
    const limit = tenant?.limits?.[key];
    if (limit !== undefined && limit !== null && current >= limit) {
      const names = { stores: 'точек', registers: 'касс', staff: 'сотрудников' };
      throw Errors.conflict('PLAN_LIMIT', `Достигнут лимит тарифа: ${limit} ${names[key]}`);
    }
  }
}
