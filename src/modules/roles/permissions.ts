/**
 * Каталог разрешений (ТЗ 3.3): строки вида «модуль.объект.действие».
 * Права проверяются только на backend (ТЗ 2.4.11). Магазин собирает свои роли из этого набора.
 */
export const PERMISSIONS = {
  // ── Магазин и доступ
  'settings.manage': 'Настройки магазина',
  'stores.manage': 'Точки, склады, кассы',
  'staff.read': 'Просмотр сотрудников',
  'staff.manage': 'Приглашение и изменение сотрудников',
  'roles.manage': 'Роли и разрешения',
  'audit.read': 'Журнал действий',
  'devices.manage': 'Кассовые устройства и агенты',

  // ── Каталог
  'products.read': 'Просмотр товаров',
  'products.write': 'Создание и изменение товаров',
  'products.quick_create': 'Быстрое создание товара при продаже/приёмке',
  'products.view_cost': 'Видеть закупочные цены, себестоимость и маржу',
  'products.import': 'Импорт и массовые операции с каталогом',
  'catalog.manage': 'Категории, бренды, типы деталей, синонимы',

  // ── Цены
  'prices.read': 'Просмотр цен',
  'prices.write': 'Установка цен, наценки',
  'prices.shop_rate': 'Курс магазина',
  'promotions.manage': 'Акции, промокоды, бонусы',

  // ── Склад и документы
  'stock.read': 'Остатки и движения',
  'documents.read': 'Просмотр документов',
  'documents.write': 'Создание и изменение документов',
  'documents.post': 'Проведение документов',
  'documents.unpost': 'Отмена проведения',
  'documents.edit_old': 'Изменение документов старше N дней',
  'stock.receive': 'Приёмка',
  'stock.transfer': 'Перемещения',
  'stock.writeoff': 'Списания',
  'stock.writeoff_approve': 'Согласование списаний сверх порога',
  'stock.inventory': 'Инвентаризация',
  'stock.labels': 'Печать этикеток и ценников',
  'stock.locations': 'Места хранения и ячейки',
  'stock.tasks': 'Задания склада',

  // ── Закупки
  'purchasing.suppliers': 'Поставщики и соседи',
  'purchasing.pricelists': 'Прайсы поставщиков',
  'purchasing.orders': 'Заказы поставщикам и автозаказ',
  'purchasing.containers': 'Контейнеры',
  'purchasing.buy_from_customer': 'Покупка у клиента, доноры',

  // ── Касса и продажи
  'pos.use': 'Работа на кассе',
  'pos.shift': 'Открытие и закрытие смены',
  'pos.cash_in_out': 'Внесение и изъятие наличных',
  'sales.discount': 'Ручная скидка в пределах лимита роли',
  'sales.discount_unlimited': 'Скидка без лимита',
  'sales.below_cost': 'Продажа ниже себестоимости',
  'sales.custom_price': 'Свободная цена',
  'sales.free_item': 'Свободная позиция в чеке',
  'sales.credit': 'Продажа в долг в пределах лимита',
  'sales.credit_over_limit': 'Продажа в долг сверх лимита',
  'sales.return': 'Возврат в пределах смены',
  'sales.return_any': 'Возврат из любой смены, без чека',
  'sales.delete_line': 'Удаление строки чека без PIN',
  'sales.sell_reserved': 'Продажа зарезервированного товара',
  'sales.orders': 'Заказы покупателей, опт',
  'sales.selection': 'Выдача на подбор, реализация',
  'sales.warranty': 'Гарантийные обращения',
  'requests.read': 'Заявки клиентов — просмотр',
  'requests.write': 'Заявки клиентов — работа',

  // ── Клиенты
  'customers.read': 'Клиенты и СТО — просмотр',
  'customers.write': 'Клиенты и СТО — изменение',
  'customers.debts': 'Долги и взаиморасчёты',
  'customers.bonuses': 'Бонусы мастерам',

  // ── Деньги
  'money.read': 'Деньги — просмотр',
  'money.write': 'Платежи, расходы, перемещения денег',
  'money.verify_transfers': 'Сверка переводов',

  // ── Доставка
  'deliveries.own': 'Свои доставки и подотчёт (водитель)',
  'deliveries.manage': 'Все доставки',

  // ── Отчёты
  'reports.sales': 'Отчёты по продажам',
  'reports.profit': 'Отчёты по прибыли',
  'reports.stock': 'Складские отчёты',
  'reports.money': 'Финансовые отчёты',
  'reports.staff': 'Отчёты по сотрудникам',
  'reports.export': 'Выгрузка отчётов в Excel и PDF',
  'dashboard.owner': 'Дашборд владельца',

  // ── Период
  'period.close': 'Закрытие периода',
  'period.reopen': 'Открытие закрытого периода',

  // ── Данные
  'data.export_all': 'Полная выгрузка данных магазина',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
export const isPermission = (p: string): p is Permission => p in PERMISSIONS;

/** Разрешения, которые есть только у владельца (не выдаются ролям). */
export const OWNER_ONLY: Permission[] = ['period.reopen'];

/** Системные роли по умолчанию (ТЗ 3.3). */
export interface RolePreset {
  code: string;
  name: string;
  description: string;
  permissions: Permission[] | '*';
  maxDiscountPercent: number;
}

const sellerBase: Permission[] = [
  'products.read',
  'products.quick_create',
  'prices.read',
  'stock.read',
  'pos.use',
  'pos.shift',
  'sales.discount',
  'sales.credit',
  'sales.return',
  'requests.read',
  'requests.write',
  'customers.read',
  'customers.write',
  'stock.labels',
  'documents.read',
];

export const ROLE_PRESETS: RolePreset[] = [
  {
    code: 'owner',
    name: 'Владелец',
    description: 'Всё, включая сотрудников, настройки и открытие закрытого периода',
    permissions: '*',
    maxDiscountPercent: 100,
  },
  {
    code: 'admin',
    name: 'Администратор',
    description: 'Всё, кроме передачи владения и открытия закрытого периода',
    permissions: ALL_PERMISSIONS.filter((p) => !OWNER_ONLY.includes(p)),
    maxDiscountPercent: 100,
  },
  {
    code: 'store_manager',
    name: 'Управляющий точкой',
    description: 'Продажи, склад, отчёты и сотрудники своей точки',
    permissions: [
      ...sellerBase,
      'products.write',
      'products.view_cost',
      'prices.write',
      'prices.shop_rate',
      'documents.write',
      'documents.post',
      'documents.unpost',
      'stock.receive',
      'stock.transfer',
      'stock.writeoff',
      'stock.writeoff_approve',
      'stock.inventory',
      'stock.locations',
      'stock.tasks',
      'pos.cash_in_out',
      'sales.discount_unlimited',
      'sales.below_cost',
      'sales.custom_price',
      'sales.free_item',
      'sales.credit_over_limit',
      'sales.return_any',
      'sales.delete_line',
      'sales.sell_reserved',
      'sales.orders',
      'sales.selection',
      'sales.warranty',
      'customers.debts',
      'customers.bonuses',
      'money.read',
      'money.verify_transfers',
      'deliveries.manage',
      'reports.sales',
      'reports.profit',
      'reports.stock',
      'reports.staff',
      'reports.export',
      'staff.read',
      'staff.manage',
      'purchasing.suppliers',
      'purchasing.orders',
    ],
    maxDiscountPercent: 30,
  },
  {
    code: 'seller',
    name: 'Продавец',
    description: 'Касса, поиск и подбор, заявки клиентов, продажа в долг в пределах лимита, возврат в пределах смены',
    permissions: sellerBase,
    maxDiscountPercent: 5,
  },
  {
    code: 'storekeeper',
    name: 'Кладовщик',
    description: 'Приёмка, перемещения, инвентаризация, списания, этикетки',
    permissions: [
      'products.read',
      'products.write',
      'products.quick_create',
      'prices.read',
      'stock.read',
      'documents.read',
      'documents.write',
      'documents.post',
      'stock.receive',
      'stock.transfer',
      'stock.writeoff',
      'stock.inventory',
      'stock.labels',
      'stock.locations',
      'stock.tasks',
    ],
    maxDiscountPercent: 0,
  },
  {
    code: 'buyer',
    name: 'Закупщик',
    description: 'Поставщики, прайсы, заказы поставщикам, приёмка, контейнеры',
    permissions: [
      'products.read',
      'products.write',
      'products.quick_create',
      'products.view_cost',
      'products.import',
      'prices.read',
      'stock.read',
      'documents.read',
      'documents.write',
      'documents.post',
      'stock.receive',
      'stock.labels',
      'purchasing.suppliers',
      'purchasing.pricelists',
      'purchasing.orders',
      'purchasing.containers',
      'purchasing.buy_from_customer',
      'reports.stock',
    ],
    maxDiscountPercent: 0,
  },
  {
    code: 'accountant',
    name: 'Бухгалтер',
    description: 'Деньги, долги, отчёты, экспорт; склад — только чтение',
    permissions: [
      'products.read',
      'products.view_cost',
      'prices.read',
      'stock.read',
      'documents.read',
      'customers.read',
      'customers.debts',
      'customers.bonuses',
      'money.read',
      'money.write',
      'money.verify_transfers',
      'reports.sales',
      'reports.profit',
      'reports.stock',
      'reports.money',
      'reports.staff',
      'reports.export',
      'period.close',
    ],
    maxDiscountPercent: 0,
  },
  {
    code: 'driver',
    name: 'Водитель',
    description: 'Свои доставки, отметка «доставлено и оплачено», свой подотчёт',
    permissions: ['deliveries.own', 'products.read'],
    maxDiscountPercent: 0,
  },
];
