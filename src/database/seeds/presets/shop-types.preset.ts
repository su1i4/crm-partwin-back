import type { ShopType } from '../../../modules/tenants/entities/tenant.entity';
import type { TenantSettingsData } from '../../../modules/settings/settings.types';

export interface ShopTypePreset {
  type: ShopType;
  name: string;
  description: string;
  settings: Partial<TenantSettingsData>;
  /** Какие системные роли обычно нужны — подсказка мастеру на шаге «Пригласить сотрудников» */
  suggestedRoles: string[];
}

/** Готовые настройки по типу магазина (ТЗ 1.1, 23.7, шаг 3). */
export const SHOP_TYPE_PRESETS: ShopTypePreset[] = [
  {
    type: 'container',
    name: 'Контейнер на рынке',
    description: 'Павильон или контейнер, 1 продавец, касса на телефоне, интернет нестабильный',
    settings: {
      negativeStock: 'warn',
      catalogDefaultView: 'makes',
      makeTreeDepth: 'model',
      defaultStorageLevel: 1,
      allowQuickCreateAtPos: true,
      allowFreeItems: true,
      belowCostSale: 'confirm',
      repeatScanIncrements: true,
      offlineProductLimit: 20000,
    },
    suggestedRoles: ['seller'],
  },
  {
    type: 'city',
    name: 'Городской магазин',
    description: '60–150 м², 2–5 сотрудников, ПК, сканер, принтер чеков и этикеток',
    settings: {
      negativeStock: 'warn',
      catalogDefaultView: 'groups',
      makeTreeDepth: 'generation',
      defaultStorageLevel: 1,
      allowQuickCreateAtPos: true,
      belowCostSale: 'confirm',
      cashHandover: false,
    },
    suggestedRoles: ['seller', 'storekeeper', 'store_manager'],
  },
  {
    type: 'wholesale',
    name: 'Оптовик и склад',
    description: 'Оптовик, дистрибьютор, разборка или сеть точек; склад, несколько касс',
    settings: {
      negativeStock: 'forbid',
      catalogDefaultView: 'groups',
      makeTreeDepth: 'modification',
      defaultStorageLevel: 2,
      allowQuickCreateAtPos: false,
      allowFreeItems: false,
      belowCostSale: 'forbid',
      cashHandover: true,
      deleteLineRequiresPin: true,
    },
    suggestedRoles: ['admin', 'store_manager', 'seller', 'storekeeper', 'buyer', 'accountant', 'driver'],
  },
];
