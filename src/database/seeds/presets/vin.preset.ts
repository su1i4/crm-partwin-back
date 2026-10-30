/**
 * Расшифровка VIN (ТЗ 5.2): WMI — первые 3 (или 2) символа → марка и страна.
 * Модификации популярных поколений — стартовое наполнение; полный справочник — импорт CSV (npm run vehicles:import).
 */
export const WMI_PRESET: [string, string, string][] = [
  ['JT', 'toyota', 'Япония'], ['JTE', 'toyota', 'Япония'], ['JTD', 'toyota', 'Япония'], ['JTM', 'toyota', 'Япония'], ['4T1', 'toyota', 'США'],
  ['4T3', 'toyota', 'США'], ['5TD', 'toyota', 'США'], ['2T1', 'toyota', 'Канада'], ['SB1', 'toyota', 'Великобритания'], ['XW7', 'toyota', 'Россия'],
  ['JTH', 'lexus', 'Япония'], ['JTJ', 'lexus', 'Япония'], ['2T2', 'lexus', 'Канада'],
  ['JH', 'honda', 'Япония'], ['JHM', 'honda', 'Япония'], ['1HG', 'honda', 'США'], ['2HG', 'honda', 'Канада'], ['5J6', 'honda', 'США'], ['JHL', 'honda', 'Япония'],
  ['JN', 'nissan', 'Япония'], ['JN1', 'nissan', 'Япония'], ['JN8', 'nissan', 'Япония'], ['1N4', 'nissan', 'США'], ['5N1', 'nissan', 'США'], ['Z8N', 'nissan', 'Россия'],
  ['JMB', 'mitsubishi', 'Япония'], ['JA3', 'mitsubishi', 'Япония'], ['JA4', 'mitsubishi', 'Япония'], ['JMY', 'mitsubishi', 'Япония'],
  ['JM1', 'mazda', 'Япония'], ['JMZ', 'mazda', 'Япония'], ['JF1', 'subaru', 'Япония'], ['JF2', 'subaru', 'Япония'], ['4S3', 'subaru', 'США'],
  ['KMH', 'hyundai', 'Корея'], ['KM8', 'hyundai', 'Корея'], ['5NP', 'hyundai', 'США'], ['Z94', 'hyundai', 'Россия'],
  ['KNA', 'kia', 'Корея'], ['KND', 'kia', 'Корея'], ['KNE', 'kia', 'Корея'], ['XWE', 'kia', 'Россия'],
  ['KLA', 'daewoo', 'Корея'], ['XWB', 'daewoo', 'Узбекистан'], ['KL1', 'chevrolet', 'Корея'], ['1G1', 'chevrolet', 'США'],
  ['WDB', 'mercedes-benz', 'Германия'], ['WDD', 'mercedes-benz', 'Германия'], ['WDC', 'mercedes-benz', 'Германия'], ['WDF', 'mercedes-benz', 'Германия'],
  ['WBA', 'bmw', 'Германия'], ['WBS', 'bmw', 'Германия'], ['WBX', 'bmw', 'Германия'], ['5UX', 'bmw', 'США'],
  ['WVW', 'volkswagen', 'Германия'], ['WVG', 'volkswagen', 'Германия'], ['WV1', 'volkswagen', 'Германия'], ['WV2', 'volkswagen', 'Германия'],
  ['WAU', 'audi', 'Германия'], ['WA1', 'audi', 'Германия'], ['XTA', 'lada', 'Россия'], ['JS', 'suzuki', 'Япония'], ['JDA', 'daihatsu', 'Япония'],
  ['KPT', 'ssangyong', 'Корея'], ['JNK', 'infiniti', 'Япония'], ['WF0', 'ford', 'Германия'], ['1FA', 'ford', 'США'], ['W0L', 'opel', 'Германия'],
  ['LVV', 'chery', 'Китай'], ['L6T', 'geely', 'Китай'], ['LGW', 'haval', 'Китай'], ['LGX', 'byd', 'Китай'],
];

/** [марка, модель, поколение, название, двигатель, объём, топливо, КПП, привод, руль, рынок, код кузова] */
export const MODIFICATIONS_PRESET: [string, string, string, string, string, string, string, string, string, string, string, string][] = [
  ['toyota', 'camry', 'xv40', '2.4 2AZ-FE АКПП', '2AZ-FE', '2.4', 'petrol', 'at', 'fwd', 'left', 'usa', 'ACV40'],
  ['toyota', 'camry', 'xv40', '2.4 2AZ-FE АКПП', '2AZ-FE', '2.4', 'petrol', 'at', 'fwd', 'right', 'japan', 'ACV40'],
  ['toyota', 'camry', 'xv40', '3.5 2GR-FE АКПП', '2GR-FE', '3.5', 'petrol', 'at', 'fwd', 'left', 'usa', 'GSV40'],
  ['toyota', 'camry', 'xv40', '2.4 Hybrid 2AZ-FXE', '2AZ-FXE', '2.4', 'hybrid', 'cvt', 'fwd', 'left', 'usa', 'AHV40'],
  ['toyota', 'camry', 'xv50', '2.5 2AR-FE АКПП', '2AR-FE', '2.5', 'petrol', 'at', 'fwd', 'left', 'usa', 'ASV50'],
  ['toyota', 'camry', 'xv50', '3.5 2GR-FE АКПП', '2GR-FE', '3.5', 'petrol', 'at', 'fwd', 'left', 'usa', 'GSV50'],
  ['toyota', 'corolla', 'e150', '1.6 1ZR-FE', '1ZR-FE', '1.6', 'petrol', 'at', 'fwd', 'left', 'europe', 'ZRE151'],
  ['toyota', 'corolla', 'e150', '1.5 1NZ-FE', '1NZ-FE', '1.5', 'petrol', 'at', 'fwd', 'right', 'japan', 'NZE151'],
  ['toyota', 'prius', 'xw20', '1.5 Hybrid 1NZ-FXE', '1NZ-FXE', '1.5', 'hybrid', 'cvt', 'fwd', 'right', 'japan', 'NHW20'],
  ['toyota', 'prius', 'xw30', '1.8 Hybrid 2ZR-FXE', '2ZR-FXE', '1.8', 'hybrid', 'cvt', 'fwd', 'right', 'japan', 'ZVW30'],
];
