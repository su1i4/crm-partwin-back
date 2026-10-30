import type { AttributeValueType } from '../../../modules/catalog/entities/part-type.entity';

export interface AttributePreset {
  code: string;
  name: string;
  valueType: AttributeValueType;
  unit?: string;
  options?: string[];
  filterable?: boolean;
  searchable?: boolean;
  required?: boolean;
}

export interface PartTypePreset {
  code: string;
  name: string;
  attributes: AttributePreset[];
}

/** Атрибуты для всех деталей (ТЗ 4.5, строка «Все детали»). */
export const COMMON_ATTRIBUTES: AttributePreset[] = [
  { code: 'side', name: 'Сторона', valueType: 'list', options: ['Левая', 'Правая'], filterable: true },
  { code: 'axle', name: 'Ось', valueType: 'list', options: ['Передняя', 'Задняя'], filterable: true },
  { code: 'country', name: 'Страна', valueType: 'string', filterable: true },
  { code: 'condition', name: 'Состояние', valueType: 'list', options: ['Новая', 'Б/у', 'Восстановленная'], filterable: true },
];

/** Пресет типов деталей (ТЗ 4.5). */
export const PART_TYPE_PRESET: PartTypePreset[] = [
  {
    code: 'engine_oil',
    name: 'Масло моторное',
    attributes: [
      { code: 'sae', name: 'Вязкость SAE', valueType: 'string', filterable: true, searchable: true },
      { code: 'base', name: 'Основа', valueType: 'list', options: ['Синтетика', 'Полусинтетика', 'Минеральное'], filterable: true },
      { code: 'volume', name: 'Объём', valueType: 'number', unit: 'л', filterable: true },
      { code: 'approvals', name: 'Допуски (API, ACEA, OEM)', valueType: 'string', searchable: true },
    ],
  },
  {
    code: 'fluid',
    name: 'Масло трансмиссионное, жидкости',
    attributes: [
      { code: 'standard', name: 'Стандарт (ATF, DOT 4, G12…)', valueType: 'string', filterable: true, searchable: true },
      { code: 'volume', name: 'Объём', valueType: 'number', unit: 'л', filterable: true },
    ],
  },
  {
    code: 'battery',
    name: 'Аккумулятор',
    attributes: [
      { code: 'capacity', name: 'Ёмкость', valueType: 'number', unit: 'Ач', filterable: true, searchable: true },
      { code: 'cca', name: 'Пусковой ток', valueType: 'number', unit: 'А', filterable: true },
      { code: 'polarity', name: 'Полярность', valueType: 'list', options: ['Прямая', 'Обратная'], filterable: true },
      { code: 'terminals', name: 'Тип клемм', valueType: 'string', filterable: true },
      { code: 'dimensions', name: 'Габариты Д×Ш×В', valueType: 'size', unit: 'мм', options: ['Д', 'Ш', 'В'], searchable: true },
    ],
  },
  {
    code: 'tire',
    name: 'Шины',
    attributes: [
      { code: 'width', name: 'Ширина', valueType: 'number', unit: 'мм', filterable: true, searchable: true },
      { code: 'profile', name: 'Профиль', valueType: 'number', filterable: true, searchable: true },
      { code: 'diameter', name: 'Диаметр', valueType: 'number', unit: '″', filterable: true, searchable: true },
      { code: 'season', name: 'Сезон', valueType: 'list', options: ['Летние', 'Зимние', 'Всесезонные'], filterable: true },
      { code: 'load_index', name: 'Индекс нагрузки', valueType: 'string', filterable: true },
      { code: 'speed_index', name: 'Индекс скорости', valueType: 'string', filterable: true },
      { code: 'studs', name: 'Шипы', valueType: 'boolean', filterable: true },
      { code: 'dot_year', name: 'Год выпуска (DOT)', valueType: 'number', filterable: true },
    ],
  },
  {
    code: 'wheel',
    name: 'Диски',
    attributes: [
      { code: 'diameter', name: 'Диаметр', valueType: 'number', unit: '″', filterable: true, searchable: true },
      { code: 'width', name: 'Ширина', valueType: 'number', unit: '″', filterable: true },
      { code: 'pcd', name: 'Сверловка (PCD)', valueType: 'string', filterable: true, searchable: true },
      { code: 'et', name: 'Вылет (ET)', valueType: 'number', unit: 'мм', filterable: true },
      { code: 'dia', name: 'Центральное отверстие', valueType: 'number', unit: 'мм', filterable: true },
    ],
  },
  {
    code: 'spark_plug',
    name: 'Свечи',
    attributes: [
      { code: 'electrode', name: 'Тип электрода', valueType: 'string', filterable: true },
      { code: 'heat_range', name: 'Калильное число', valueType: 'string', filterable: true },
      { code: 'thread', name: 'Резьба', valueType: 'string', filterable: true },
    ],
  },
  {
    code: 'lamp',
    name: 'Лампы',
    attributes: [
      { code: 'base', name: 'Цоколь (H4, H7…)', valueType: 'string', filterable: true, searchable: true },
      { code: 'power', name: 'Мощность', valueType: 'number', unit: 'Вт', filterable: true },
      { code: 'lamp_type', name: 'Тип', valueType: 'list', options: ['Галоген', 'Ксенон', 'LED'], filterable: true },
    ],
  },
  {
    code: 'belt',
    name: 'Ремни',
    attributes: [
      { code: 'profile_length', name: 'Профиль и длина (6PK1200)', valueType: 'string', filterable: true, searchable: true },
      { code: 'teeth', name: 'Число зубьев (ГРМ)', valueType: 'number', filterable: true, searchable: true },
    ],
  },
  {
    code: 'bearing',
    name: 'Подшипники',
    attributes: [
      { code: 'bearing_number', name: 'Номер (6203)', valueType: 'string', filterable: true, searchable: true },
      { code: 'dimensions', name: 'Внутр. × наруж. × ширина', valueType: 'size', unit: 'мм', options: ['внутр.', 'наруж.', 'ширина'], filterable: true, searchable: true },
    ],
  },
  {
    code: 'seal',
    name: 'Сальники',
    attributes: [
      { code: 'dimensions', name: 'Внутр. × наруж. × высота', valueType: 'size', unit: 'мм', options: ['внутр.', 'наруж.', 'высота'], filterable: true, searchable: true },
    ],
  },
  {
    code: 'filter',
    name: 'Фильтры',
    attributes: [
      { code: 'filter_kind', name: 'Вид', valueType: 'list', options: ['Масляный', 'Воздушный', 'Салонный', 'Топливный'], filterable: true },
      { code: 'thread', name: 'Резьба', valueType: 'string', filterable: true },
      { code: 'height', name: 'Высота', valueType: 'number', unit: 'мм', filterable: true },
      { code: 'diameter', name: 'Диаметр', valueType: 'number', unit: 'мм', filterable: true },
    ],
  },
  {
    code: 'brake_pad',
    name: 'Колодки',
    attributes: [
      { code: 'length', name: 'Длина', valueType: 'number', unit: 'мм', filterable: true },
      { code: 'height', name: 'Высота', valueType: 'number', unit: 'мм', filterable: true },
      { code: 'thickness', name: 'Толщина', valueType: 'number', unit: 'мм', filterable: true },
      { code: 'wear_sensor', name: 'Датчик износа', valueType: 'boolean', filterable: true },
    ],
  },
];
