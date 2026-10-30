import { Injectable } from '@nestjs/common';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { MoneyAccount } from '../finance/entities/money-account.entity';
import { PriceType } from '../pricing/entities/price-type.entity';
import { Role, RolePermission } from '../roles/entities/role.entity';
import { ALL_PERMISSIONS, ROLE_PRESETS } from '../roles/permissions';
import { TenantSettings } from '../settings/entities/tenant-settings.entity';
import { Register } from '../stores/entities/register.entity';
import { Store } from '../stores/entities/store.entity';
import { Warehouse } from '../stores/entities/warehouse.entity';
import { Membership } from '../users/entities/membership.entity';
import { MembershipRole } from '../users/entities/membership-access.entity';

export const DEFAULT_PRICE_TYPES = [
  { code: 'retail', name: 'Розничная', isRetail: true, sort: 1 },
  { code: 'sto', name: 'Для СТО', isRetail: false, sort: 2 },
  { code: 'wholesale', name: 'Оптовая', isRetail: false, sort: 3 },
];

/**
 * Начальные данные нового магазина — создаются в транзакции регистрации:
 * системные роли, участие владельца, настройки, точка + склад + касса, типы цен, кассовые счета.
 * Пресеты каталога (категории, типы деталей) — в мастере первого запуска (OnboardingService).
 */
@Injectable()
export class TenantBootstrapService {
  async createDefaults(tx: TenantTx, ownerUserId: string): Promise<{ membership: Membership; store: Store }> {
    // Роли
    const roles = await tx.repo(Role).insertMany(
      ROLE_PRESETS.map((p) => ({
        name: p.name,
        code: p.code,
        description: p.description,
        isSystem: true,
        settings: { maxDiscountPercent: p.maxDiscountPercent },
      })),
    );
    const perms: Partial<RolePermission>[] = [];
    for (const role of roles) {
      const preset = ROLE_PRESETS.find((p) => p.code === role.code)!;
      const list = preset.permissions === '*' ? ALL_PERMISSIONS : preset.permissions;
      for (const permission of list) perms.push({ roleId: role.id, permission });
    }
    await tx.repo(RolePermission).insertMany(perms);

    // Владелец
    const membership = await tx.repo(Membership).insert({
      userId: ownerUserId,
      status: 'active',
      isOwner: true,
      allStores: true,
      position: 'Владелец',
    });
    const ownerRole = roles.find((r) => r.code === 'owner')!;
    await tx.repo(MembershipRole).insert({ membershipId: membership.id, roleId: ownerRole.id });

    // Настройки
    await tx.repo(TenantSettings).insert({ data: {} });

    // Точка, склад, касса
    const store = await tx.repo(Store).insert({
      name: 'Основная точка',
      code: 'Т1',
      timezone: 'Asia/Bishkek',
      registerMode: 'single',
    });
    const warehouse = await tx.repo(Warehouse).insert({
      storeId: store.id,
      name: 'Торговый зал',
      code: 'Т1-ЗАЛ',
      type: 'sales_floor',
      storageLevel: 1,
    });
    const register = await tx.repo(Register).insert({
      storeId: store.id,
      warehouseId: warehouse.id,
      code: 'К1',
      name: 'Касса 1',
    });

    // Типы цен
    await tx.repo(PriceType).insertMany(DEFAULT_PRICE_TYPES.map((p) => ({ ...p, currency: 'KGS', isSystem: true })));

    // Наличные кассы: сомы и доллары (ТЗ 19.1)
    await tx.repo(MoneyAccount).insertMany([
      { type: 'cash', name: 'Касса 1 — сомы', currency: 'KGS', storeId: store.id, registerId: register.id },
      { type: 'cash', name: 'Касса 1 — доллары', currency: 'USD', storeId: store.id, registerId: register.id },
      { type: 'safe', name: 'Сейф', currency: 'KGS', storeId: store.id },
    ]);

    return { membership, store };
  }
}
