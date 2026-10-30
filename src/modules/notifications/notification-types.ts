/** События уведомлений (ТЗ 22.1). Пользователь выбирает каналы для каждого. */
export const NOTIFICATION_TYPES = {
  'settings.changed': 'Изменены настройки магазина',
  'staff.changed': 'Изменения в сотрудниках и ролях',
  'register.mode_changed': 'Режим касс точки изменился',
  'stock.below_min': 'Товар ниже минимума',
  'request.new': 'Новая заявка',
  'request.overdue': 'Заявка просрочена',
  'request.arrived': 'Деталь пришла',
  'debt.overdue': 'Просроченный долг',
  'transfer.unverified': 'Несверенный перевод',
  'shift.discrepancy': 'Расхождение смены',
  'sale.discount_over_limit': 'Скидка сверх лимита',
  'document.unposted': 'Отмена проведения',
  'sale.negative_stock': 'Продажа в минус',
  'pin.blocked': 'Заблокирован PIN',
  'pos.unsent_receipts': 'Неотправленные офлайн-чеки',
  'print.failed': 'Ошибка печати',
  'import.finished': 'Импорт завершён',
  'period.close_reminder': 'Напоминание о закрытии периода',
  'stock.reconcile_mismatch': 'Расхождение остатков после ночной сверки',
  'shift.not_closed': 'Смена не закрыта',
  'rate.changed': 'Изменён курс магазина',
  'return.not_fit': 'Возврат «не подошло» — проверить применимость',
  'warranty.new': 'Новое гарантийное обращение',
  'sale.below_cost': 'Продажа ниже себестоимости',
  'waitlist.arrived': 'Пришёл товар из листа ожидания',
  'money.recurring_failed': 'Регулярный расход не проведён',
  'money.nbkr_failed': 'Не загрузились курсы НБКР',
  'summary.evening': 'Вечерняя сводка владельцу',
} as const;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const DEFAULT_CHANNELS = { inApp: true, telegram: false };
