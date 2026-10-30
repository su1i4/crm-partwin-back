import type { CategorySettings } from '../../../modules/catalog/entities/category.entity';

export interface CategoryPreset {
  code: string;
  name: string;
  settings?: CategorySettings;
  children?: CategoryPreset[];
}

const pair: CategorySettings = { pairHint: true };
const universal: CategorySettings = { universal: true };
const electric: CategorySettings = { returnConditions: 'Электрика после установки не принимается', requireNoInstallMarks: true };

/** Пресет категорий (ТЗ 4.6). */
export const CATEGORY_PRESET: CategoryPreset[] = [
  {
    code: 'maintenance',
    name: 'Техобслуживание',
    children: [
      {
        code: 'filters',
        name: 'Фильтры',
        children: [
          { code: 'filters_oil', name: 'Масляные фильтры' },
          { code: 'filters_air', name: 'Воздушные фильтры' },
          { code: 'filters_cabin', name: 'Салонные фильтры' },
          { code: 'filters_fuel', name: 'Топливные фильтры' },
        ],
      },
      { code: 'spark_plugs', name: 'Свечи' },
      { code: 'belts_rollers', name: 'Ремни и ролики' },
      { code: 'wipers', name: 'Щётки стеклоочистителя', settings: pair },
    ],
  },
  {
    code: 'engine',
    name: 'Двигатель',
    children: [
      { code: 'gaskets', name: 'Прокладки' },
      { code: 'seals', name: 'Сальники' },
      { code: 'pistons', name: 'Поршневая группа' },
      { code: 'timing', name: 'ГРМ' },
      { code: 'water_pumps', name: 'Помпы' },
      { code: 'thermostats', name: 'Термостаты' },
      { code: 'engine_mounts', name: 'Опоры двигателя' },
    ],
  },
  {
    code: 'suspension',
    name: 'Подвеска и рулевое',
    children: [
      { code: 'shock_absorbers', name: 'Амортизаторы', settings: pair },
      { code: 'struts', name: 'Стойки', settings: pair },
      { code: 'control_arms', name: 'Рычаги' },
      { code: 'ball_joints', name: 'Шаровые' },
      { code: 'bushings', name: 'Сайлентблоки' },
      { code: 'tie_rods', name: 'Рулевые наконечники и тяги' },
      { code: 'hubs_bearings', name: 'Ступицы и подшипники' },
    ],
  },
  {
    code: 'brakes',
    name: 'Тормозная система',
    children: [
      { code: 'brake_pads', name: 'Колодки', settings: pair },
      { code: 'brake_discs', name: 'Диски', settings: pair },
      { code: 'brake_drums', name: 'Барабаны', settings: pair },
      { code: 'calipers', name: 'Суппорты' },
      { code: 'brake_hoses', name: 'Шланги' },
      { code: 'brake_fluid', name: 'Тормозная жидкость', settings: universal },
    ],
  },
  {
    code: 'transmission',
    name: 'Трансмиссия',
    children: [
      { code: 'clutch', name: 'Сцепление' },
      { code: 'cv_joints', name: 'ШРУСы и пыльники' },
      { code: 'gear_oils', name: 'Масла трансмиссионные', settings: universal },
    ],
  },
  {
    code: 'electrical',
    name: 'Электрика',
    settings: electric,
    children: [
      { code: 'batteries', name: 'Аккумуляторы', settings: { warrantyDays: 365 } },
      { code: 'lamps', name: 'Лампы', settings: { ...pair, universal: true } },
      { code: 'fuses', name: 'Предохранители', settings: universal },
      { code: 'alternators_starters', name: 'Генераторы и стартеры', settings: electric },
      { code: 'sensors', name: 'Датчики', settings: electric },
    ],
  },
  {
    code: 'cooling',
    name: 'Охлаждение и кондиционер',
    children: [
      { code: 'radiators', name: 'Радиаторы' },
      { code: 'fans', name: 'Вентиляторы' },
      { code: 'ac_compressors', name: 'Компрессоры' },
      { code: 'antifreeze', name: 'Антифриз', settings: universal },
    ],
  },
  {
    code: 'body',
    name: 'Кузов и оптика',
    children: [
      { code: 'headlights', name: 'Фары' },
      { code: 'taillights', name: 'Фонари' },
      { code: 'mirrors', name: 'Зеркала' },
      { code: 'bumpers', name: 'Бамперы' },
      { code: 'hoods', name: 'Капоты' },
      { code: 'fenders', name: 'Крылья' },
    ],
  },
  {
    code: 'oils_chemicals',
    name: 'Масла и автохимия',
    settings: universal,
    children: [
      { code: 'engine_oils', name: 'Моторные масла' },
      { code: 'greases', name: 'Смазки' },
      { code: 'cleaners', name: 'Очистители' },
      { code: 'additives', name: 'Присадки' },
    ],
  },
  {
    code: 'tires_wheels',
    name: 'Шины и диски',
    settings: universal,
    children: [
      { code: 'tires_summer', name: 'Шины летние' },
      { code: 'tires_winter', name: 'Шины зимние' },
      { code: 'tires_all_season', name: 'Шины всесезонные' },
      { code: 'wheels', name: 'Диски' },
    ],
  },
  {
    code: 'accessories',
    name: 'Аксессуары и инструмент',
    settings: universal,
    children: [
      { code: 'mats', name: 'Коврики' },
      { code: 'covers', name: 'Чехлы' },
      { code: 'tools', name: 'Инструмент' },
    ],
  },
  {
    code: 'used_units',
    name: 'Агрегаты б/у',
    settings: { warrantyDays: 14, returnConditions: 'Гарантия на запуск 14 дней' },
    children: [
      { code: 'used_engines', name: 'Двигатели' },
      { code: 'used_gearboxes', name: 'КПП' },
      { code: 'used_axles', name: 'Мосты' },
      { code: 'used_transfer_cases', name: 'Раздатки' },
    ],
  },
];
