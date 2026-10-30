/**
 * Стартовое наполнение моделей и поколений (ТЗ 6.1): популярные в КР.
 * Полный справочник платформа загружает через CSV (scripts/vehicles-import.ts).
 * Формат поколения: [код, название, годС, годПо, рестайлинг, народные названия, коды кузова]
 */
type Gen = [string, string, number, number | null, 'pre' | 'post' | null, string[], string[]];
interface ModelSeed {
  code: string;
  name: string;
  aliases: string[];
  gens: Gen[];
}

export const VEHICLES_PRESET: Record<string, ModelSeed[]> = {
  toyota: [
    { code: 'camry', name: 'Camry', aliases: ['камри', 'кемри', 'кэмри'], gens: [
      ['xv30', 'XV30', 2001, 2006, null, ['камри 30', 'кемри 30', '30'], ['ACV30', 'ACV31', 'MCV30']],
      ['xv40', 'XV40', 2006, 2011, null, ['камри 40', 'кемри 40', '40'], ['ACV40', 'ACV45', 'GSV40', 'AHV40']],
      ['xv50', 'XV50', 2011, 2014, 'pre', ['камри 50', 'кемри 50', '50'], ['ASV50', 'AVV50', 'GSV50']],
      ['xv55', 'XV55', 2014, 2017, 'post', ['камри 55', 'кемри 55', '55'], ['ASV51', 'AVV50', 'GSV50']],
      ['xv70', 'XV70', 2017, null, null, ['камри 70', 'кемри 70', '70'], ['AXVA70', 'ASV70', 'GSV70']],
    ] },
    { code: 'corolla', name: 'Corolla', aliases: ['королла', 'карола'], gens: [
      ['e120', 'E120', 2000, 2007, null, ['королла 120'], ['NZE121', 'ZZE122', 'NZE120']],
      ['e150', 'E150', 2006, 2013, null, ['королла 150'], ['NZE151', 'ZRE151', 'ZRE152']],
      ['e170', 'E170', 2013, 2019, null, ['королла 170'], ['ZRE172', 'NRE180']],
    ] },
    { code: 'prius', name: 'Prius', aliases: ['приус'], gens: [
      ['xw20', 'XW20', 2003, 2009, null, ['приус 20'], ['NHW20']],
      ['xw30', 'XW30', 2009, 2015, null, ['приус 30'], ['ZVW30']],
      ['xw50', 'XW50', 2015, 2022, null, ['приус 50'], ['ZVW50', 'ZVW51', 'ZVW55']],
    ] },
    { code: 'rav4', name: 'RAV4', aliases: ['рав4', 'рав 4', 'рафик'], gens: [
      ['xa20', 'XA20', 2000, 2005, null, ['рав4 20'], ['ACA21', 'ACA20', 'ZCA26']],
      ['xa30', 'XA30', 2005, 2012, null, ['рав4 30'], ['ACA30', 'ACA31', 'ACA36', 'GSA33']],
      ['xa40', 'XA40', 2012, 2018, null, ['рав4 40'], ['ASA44', 'ZSA44', 'ALA49']],
      ['xa50', 'XA50', 2018, null, null, ['рав4 50'], ['AXAA54', 'AXAH54', 'MXAA54']],
    ] },
    { code: 'land-cruiser', name: 'Land Cruiser', aliases: ['ленд крузер', 'крузак', 'кукурузер', 'лк'], gens: [
      ['j100', '100', 1998, 2007, null, ['крузак 100', 'сотка', 'лк 100'], ['UZJ100', 'HDJ100', 'FZJ100']],
      ['j200', '200', 2007, 2021, null, ['крузак 200', 'двухсотый', 'лк 200'], ['URJ200', 'UZJ200', 'VDJ200']],
    ] },
    { code: 'land-cruiser-prado', name: 'Land Cruiser Prado', aliases: ['прадо', 'прада'], gens: [
      ['j120', '120', 2002, 2009, null, ['прадо 120'], ['GRJ120', 'KDJ120', 'TRJ120', 'RZJ120']],
      ['j150', '150', 2009, null, null, ['прадо 150'], ['GRJ150', 'TRJ150', 'KDJ150', 'GDJ150']],
    ] },
    { code: 'ipsum', name: 'Ipsum', aliases: ['ипсум'], gens: [
      ['xm20', 'XM20', 2001, 2009, null, ['ипсум 20'], ['ACM21', 'ACM26']],
    ] },
    { code: 'estima', name: 'Estima', aliases: ['эстима'], gens: [
      ['xr30', 'XR30/40', 2000, 2006, null, ['эстима 30', 'эстима 40'], ['ACR30', 'ACR40', 'MCR30', 'MCR40', 'AHR10']],
      ['xr50', 'XR50', 2006, 2019, null, ['эстима 50'], ['ACR50', 'ACR55', 'GSR50', 'GSR55', 'AHR20']],
    ] },
    { code: 'alphard', name: 'Alphard', aliases: ['альфард'], gens: [
      ['h10', 'H10', 2002, 2008, null, ['альфард 10'], ['ANH10', 'ANH15', 'MNH10', 'MNH15', 'ATH10']],
      ['h20', 'H20', 2008, 2015, null, ['альфард 20'], ['ANH20', 'ANH25', 'GGH20', 'GGH25', 'ATH20']],
      ['h30', 'H30', 2015, 2023, null, ['альфард 30'], ['AGH30', 'GGH30', 'AYH30']],
    ] },
    { code: 'highlander', name: 'Highlander', aliases: ['хайлендер', 'хайландер'], gens: [
      ['xu20', 'XU20', 2000, 2007, null, ['хайлендер 20'], ['ACU20', 'MCU20', 'MCU25']],
      ['xu40', 'XU40', 2007, 2013, null, ['хайлендер 40'], ['GSU40', 'GSU45', 'ASU40']],
    ] },
    { code: 'harrier', name: 'Harrier', aliases: ['харриер', 'харьер'], gens: [
      ['xu30', 'XU30', 2003, 2013, null, ['харриер 30'], ['ACU30', 'MCU30', 'GSU30', 'MHU38']],
    ] },
    { code: 'hiace', name: 'Hiace', aliases: ['хайс', 'хайейс'], gens: [
      ['h200', 'H200', 2004, null, null, ['хайс 200'], ['KDH200', 'TRH200', 'KDH220', 'TRH223']],
    ] },
  ],
  lexus: [
    { code: 'rx', name: 'RX', aliases: ['рх', 'rx300', 'rx330', 'rx350'], gens: [
      ['xu10', 'XU10 (RX300)', 1997, 2003, null, ['rx300', 'рх 300'], ['MCU10', 'MCU15']],
      ['xu30', 'XU30 (RX330/350)', 2003, 2009, null, ['rx330', 'rx350', 'рх 330', 'рх 350'], ['MCU38', 'GSU35', 'MHU38']],
      ['al10', 'AL10', 2008, 2015, null, ['rx 2009', 'rx350 al10'], ['GGL15', 'GYL15', 'AGL10']],
    ] },
    { code: 'es', name: 'ES', aliases: ['ес', 'es350'], gens: [
      ['xv40', 'XV40 (ES350)', 2006, 2012, null, ['es 350 2008'], ['GSV40']],
      ['xv60', 'XV60', 2012, 2018, null, ['es 2013'], ['GSV60', 'AVV60', 'ASV60']],
    ] },
    { code: 'gx', name: 'GX', aliases: ['гх', 'gx470', 'gx460'], gens: [
      ['j120', 'J120 (GX470)', 2002, 2009, null, ['gx470', 'гх 470'], ['UZJ120']],
      ['j150', 'J150 (GX460)', 2009, null, null, ['gx460', 'гх 460'], ['URJ150', 'GRJ150']],
    ] },
    { code: 'lx', name: 'LX', aliases: ['лх', 'lx470', 'lx570'], gens: [
      ['j100', 'J100 (LX470)', 1998, 2007, null, ['lx470', 'лх 470'], ['UZJ100']],
      ['j200', 'J200 (LX570)', 2007, 2021, null, ['lx570', 'лх 570'], ['URJ201']],
    ] },
  ],
  honda: [
    { code: 'fit', name: 'Fit', aliases: ['фит'], gens: [
      ['gd', 'GD', 2001, 2007, null, ['фит gd', 'фит 1'], ['GD1', 'GD2', 'GD3', 'GD4']],
      ['ge', 'GE', 2007, 2013, null, ['фит ge', 'фит 2'], ['GE6', 'GE7', 'GE8', 'GE9', 'GP1']],
      ['gk', 'GK', 2013, 2020, null, ['фит gk', 'фит 3'], ['GK3', 'GK4', 'GK5', 'GK6', 'GP5']],
    ] },
    { code: 'cr-v', name: 'CR-V', aliases: ['срв', 'црв', 'crv'], gens: [
      ['rd', 'RD (2 пок.)', 2001, 2006, null, ['срв 2'], ['RD4', 'RD5', 'RD7']],
      ['re', 'RE (3 пок.)', 2006, 2012, null, ['срв 3'], ['RE3', 'RE4', 'RE5', 'RE7']],
    ] },
    { code: 'odyssey', name: 'Odyssey', aliases: ['одиссей'], gens: [
      ['ra6', 'RA6-RA9', 1999, 2003, null, ['одиссей 2'], ['RA6', 'RA7', 'RA8', 'RA9']],
      ['rb1', 'RB1-RB2', 2003, 2008, null, ['одиссей 3'], ['RB1', 'RB2']],
    ] },
    { code: 'stream', name: 'Stream', aliases: ['стрим'], gens: [
      ['rn1', 'RN1-RN5', 2000, 2006, null, ['стрим 1'], ['RN1', 'RN2', 'RN3', 'RN4', 'RN5']],
    ] },
  ],
  nissan: [
    { code: 'x-trail', name: 'X-Trail', aliases: ['икстрейл', 'х трейл', 'хтрейл'], gens: [
      ['t30', 'T30', 2000, 2007, null, ['икстрейл 30', 't30'], ['NT30', 'T30', 'PNT30']],
      ['t31', 'T31', 2007, 2015, null, ['икстрейл 31', 't31'], ['NT31', 'T31', 'TNT31']],
    ] },
    { code: 'tiida', name: 'Tiida', aliases: ['тиида'], gens: [['c11', 'C11', 2004, 2012, null, ['тиида 11'], ['C11', 'NC11', 'JC11']]] },
  ],
  'mercedes-benz': [
    { code: 'sprinter', name: 'Sprinter', aliases: ['спринтер'], gens: [
      ['w901', '901-905', 1995, 2006, null, ['спринтер 110', 'спринтер 311', 'спринтер старый'], ['W901', 'W902', 'W903', 'W904', 'W905']],
      ['w906', '906', 2006, 2018, null, ['спринтер 906', 'спринтер новый'], ['W906']],
    ] },
    { code: 'e-class', name: 'E-Class', aliases: ['ешка', 'е класс', 'е-класс'], gens: [
      ['w210', 'W210', 1995, 2002, null, ['очкарик', 'w210', '210'], ['W210', 'S210']],
      ['w211', 'W211', 2002, 2009, null, ['w211', '211'], ['W211', 'S211']],
      ['w212', 'W212', 2009, 2016, null, ['w212', '212'], ['W212', 'S212']],
    ] },
    { code: 's-class', name: 'S-Class', aliases: ['эска', 's класс', 'кабан'], gens: [
      ['w220', 'W220', 1998, 2005, null, ['w220', '220'], ['W220']],
      ['w221', 'W221', 2005, 2013, null, ['w221', '221'], ['W221']],
    ] },
  ],
  hyundai: [
    { code: 'sonata', name: 'Sonata', aliases: ['соната'], gens: [
      ['yf', 'YF', 2009, 2014, null, ['соната yf'], ['YF']],
      ['lf', 'LF', 2014, 2019, null, ['соната lf'], ['LF']],
    ] },
    { code: 'starex', name: 'Starex / H-1', aliases: ['старекс', 'h1', 'аш1'], gens: [
      ['a1', 'A1', 1997, 2007, null, ['старекс старый'], ['A1']],
      ['tq', 'TQ', 2007, 2021, null, ['старекс tq', 'h1 tq'], ['TQ']],
    ] },
  ],
  kia: [{ code: 'sportage', name: 'Sportage', aliases: ['спортейдж', 'спортаж'], gens: [['sl', 'SL (3 пок.)', 2010, 2015, null, ['спортейдж 3'], ['SL']]] }],
  daewoo: [
    { code: 'matiz', name: 'Matiz', aliases: ['матиз'], gens: [['m100', 'M100/M150', 1998, 2015, null, ['матиз'], ['M100', 'M150']]] },
    { code: 'nexia', name: 'Nexia', aliases: ['нексия'], gens: [['n100', 'N100/N150', 1995, 2016, null, ['нексия'], ['N100', 'N150']]] },
  ],
  lada: [
    { code: '2107', name: '2107', aliases: ['семерка', 'семёрка', 'ваз 2107'], gens: [['2107', '2107', 1982, 2012, null, ['семерка'], ['2107']]] },
    { code: 'priora', name: 'Priora', aliases: ['приора'], gens: [['2170', '2170', 2007, 2018, null, ['приора'], ['2170', '2171', '2172']]] },
  ],
};
