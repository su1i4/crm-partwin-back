/** Настройки магазина. Хранятся в tenant_settings.data (jsonb), недостающие ключи — из DEFAULT_SETTINGS. */
export interface TenantSettingsData {
  // Склад и остатки (ТЗ 7.4, 7.5, 7.6)
  negativeStock: 'forbid' | 'warn';
  editOldDocumentsDays: number;
  reserveDays: number;
  periodCloseReminder: boolean;
  /** Списание дороже этой суммы (сом) — на согласование; 0 — без согласования (ТЗ 9.3) */
  writeoffApprovalAmount: number;
  /** Перемещение «в пути» дольше N дней — в отчёт «зависшие» */
  transferStaleDays: number;

  // Продажи (ТЗ 3.4, 13, 15)
  belowCostSale: 'forbid' | 'confirm' | 'allow';
  allowFreeItems: boolean;
  allowQuickCreateAtPos: boolean;
  allowOcr: boolean;
  deleteLineRequiresPin: boolean;
  cashHandover: boolean;
  shiftAutoCloseTime: string | null;
  returnInOtherStore: boolean;
  repeatScanIncrements: boolean;
  selectionIssueDays: number;
  /** Долг просрочен больше N дней — в долг нельзя без PIN (ТЗ 18.2); null — не проверять */
  creditBlockOverdueDays: number | null;
  /** Окно сопоставления перевода с выпиской банка, минут (ТЗ 19.3) */
  transferMatchWindowMinutes: number;
  /** Быстрые купюры в окне оплаты */
  quickBanknotes: number[];

  // Закупки (ТЗ 10.4)
  /** Месяцы «лета» для сезонных мин./макс. остатков (1–12); остальные — зима */
  summerMonths: number[];
  /** Автозаказ: продажи за N дней */
  autoOrderSalesDays: number;
  /** Автозаказ: на сколько дней сверх срока поставки заказывать */
  autoOrderCoverDays: number;

  // Цены (ТЗ 17)
  priceRounding: 1 | 5 | 10;
  priceTagCurrency: 'KGS' | 'USD' | 'both';
  /** Шифр минимальной цены: 10 разных букв, i-я буква = цифра i (ТЗ 17.5) */
  minPriceCipher: string | null;

  // Каталог по маркам (ТЗ 6.3)
  catalogDefaultView: 'groups' | 'makes';
  ourMakes: string[];
  makeTreeDepth: 'make' | 'model' | 'generation' | 'modification';
  makeGroups: { name: string; makes: string[] }[];

  // Хранение по умолчанию для новых складов (ТЗ 8)
  defaultStorageLevel: 1 | 2 | 3;

  // Касса без интернета (ТЗ 16.3)
  offlineProductLimit: number;

  // Сводка владельцу (ТЗ 20.3)
  eveningSummaryTime: string;

  // Бонусы и карты (ТЗ 17.7)
  loyaltyEnabled: boolean;
  /** Начисление, % от оплаченного деньгами (если нет уровней) */
  bonusAccrualPercent: number;
  /** Оплата бонусами — не больше N% чека */
  bonusMaxPayPercent: number;
  /** Срок сгорания бонусов, дней (0 — не сгорают) */
  bonusExpireDays: number;
  /** Уровни по сумме покупок: { name, threshold, percent } */
  loyaltyLevels: { name: string; threshold: string; percent: string }[];
  /** Срок выдачи на подбор по умолчанию, дней (ТЗ 14.5) */
  selectionDays: number;
}

export const DEFAULT_SETTINGS: TenantSettingsData = {
  negativeStock: 'warn',
  editOldDocumentsDays: 60,
  reserveDays: 3,
  periodCloseReminder: true,
  writeoffApprovalAmount: 0,
  transferStaleDays: 3,

  belowCostSale: 'confirm',
  allowFreeItems: true,
  allowQuickCreateAtPos: true,
  allowOcr: true,
  deleteLineRequiresPin: false,
  cashHandover: false,
  shiftAutoCloseTime: null,
  returnInOtherStore: true,
  repeatScanIncrements: true,
  selectionIssueDays: 3,
  creditBlockOverdueDays: 0,
  transferMatchWindowMinutes: 120,
  quickBanknotes: [500, 1000, 5000],

  summerMonths: [4, 5, 6, 7, 8, 9],
  autoOrderSalesDays: 30,
  autoOrderCoverDays: 14,

  priceRounding: 1,
  priceTagCurrency: 'KGS',
  minPriceCipher: null,

  catalogDefaultView: 'groups',
  ourMakes: [],
  makeTreeDepth: 'generation',
  makeGroups: [],

  defaultStorageLevel: 1,

  offlineProductLimit: 50000,

  eveningSummaryTime: '21:00',

  loyaltyEnabled: false,
  bonusAccrualPercent: 2,
  bonusMaxPayPercent: 30,
  bonusExpireDays: 365,
  loyaltyLevels: [],
  selectionDays: 3,
};

export function withDefaults(data: Partial<TenantSettingsData> | null | undefined): TenantSettingsData {
  return { ...DEFAULT_SETTINGS, ...(data ?? {}) };
}
