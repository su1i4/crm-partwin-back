import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { GlobalVehicleModification } from './entities/vehicle.entity';
import { DirGeneration, VehicleDirectoryService } from './vehicle-directory.service';

/** 10-й символ VIN → год (цикл 30 лет; берём последний год, не позже следующего). */
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

/**
 * Подсказка модели по символам 4–8 VIN для известных марок (ТЗ 5.2). Неполная — дальше ручной выбор.
 * Ключ — код марки справочника; значение — [регулярка по VDS, код модели].
 */
const MODEL_HINTS: Record<string, [RegExp, string][]> = {
  toyota: [
    [/^(BE|BF|BK|B1|B2|BB|BZ|SK|SV)/, 'camry'],
    [/^(BR|BU|BY|KU|ZE)/, 'corolla'],
    [/^(KU|BU)..\d/, 'corolla'],
    [/^(BD|DH|JB)/, 'land-cruiser-prado'],
    [/^(HT|HY|UY)/, 'land-cruiser'],
    [/^(KD|KW|DW|BW)/, 'prius'],
    [/^(BF|BD)3/, 'rav4'],
  ],
  lexus: [[/^(GS|BA|BD|BF)/, 'rx'], [/^(HT|HY)/, 'lx']],
  honda: [[/^(CM|CP|CR|CS|CT)/, 'accord'], [/^(RD|RE|RM|RW)/, 'cr-v'], [/^(GD|GE|GK)/, 'fit']],
  hyundai: [[/^(DH|DM)/, 'sonata'], [/^(PT|PU)/, 'tucson']],
  kia: [[/^(GA|GB|GC)/, 'k5']],
};

export interface VinDecode {
  vin: string;
  valid: boolean;
  wmi: string;
  makeId: string | null;
  makeName: string | null;
  country: string | null;
  year: number | null;
  modelId: string | null;
  modelName: string | null;
  /** Поколения модели (или марки), подходящие по году */
  generations: { id: string; name: string; modelName: string; yearFrom: number | null; yearTo: number | null }[];
  /** Не расшифровалось — выбрать вручную */
  manual: boolean;
}

/** Расшифровка VIN и кода кузова японских машин (ТЗ 5.2). */
@Injectable()
export class VinService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly dir: VehicleDirectoryService,
  ) {}

  /** Контрольная цифра (9-й символ) — обязательна для Северной Америки, у остальных — справочно. */
  static checkDigit(vin: string): boolean {
    const map: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
    const w = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += (/\d/.test(vin[i]) ? Number(vin[i]) : (map[vin[i]] ?? 0)) * w[i];
    const r = sum % 11;
    return vin[8] === (r === 10 ? 'X' : String(r));
  }

  static year(code: string, now = new Date().getFullYear()): number | null {
    const i = YEAR_CODES.indexOf(code);
    if (i < 0) return null;
    let y = 1980 + i;
    while (y + 30 <= now + 1) y += 30;
    return y;
  }

  async decode(tx: TenantTx, raw: string): Promise<VinDecode> {
    const vin = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (vin.length !== 17 || /[IOQ]/.test(vin)) throw Errors.bad('BAD_VIN', 'VIN — 17 символов, без букв I, O, Q');
    const wmi = vin.slice(0, 3);
    const rows = await this.platform.ds.query(
      `SELECT w.wmi, w.country, m.id, m.code, m.name FROM global_vin_wmi w JOIN global_vehicle_makes m ON m.id = w.make_id
        WHERE w.wmi IN ($1, $2) ORDER BY length(w.wmi) DESC LIMIT 1`,
      [wmi, wmi.slice(0, 2)],
    );
    const make = rows[0] ?? null;
    const year = VinService.year(vin[9]);
    const full = await this.dir.full(tx);
    let model: { id: string; name: string } | null = null;
    if (make) {
      const vds = vin.slice(3, 8);
      const hint = (MODEL_HINTS[make.code] ?? []).find(([re]) => re.test(vds));
      if (hint) {
        const m = full.models.find((x: any) => x.makeId === make.id && (x.code === hint[1] || x.name.toLowerCase().replace(/\s+/g, '-') === hint[1]));
        if (m) model = { id: m.id, name: m.name };
      }
    }
    const models = full.models.filter((m: any) => make && m.makeId === make.id && (!model || m.id === model.id));
    const gens = full.generations
      .filter((g: DirGeneration) => models.some((m: any) => m.id === g.modelId))
      .filter((g: DirGeneration) => !year || ((g.yearFrom ?? 0) <= year && (g.yearTo ?? 9999) >= year))
      .map((g: DirGeneration) => ({ id: g.id, name: g.name, modelName: models.find((m: any) => m.id === g.modelId)!.name, yearFrom: g.yearFrom, yearTo: g.yearTo }));
    return {
      vin,
      valid: VinService.checkDigit(vin),
      wmi,
      makeId: make?.id ?? null,
      makeName: make?.name ?? null,
      country: make?.country ?? null,
      year,
      modelId: model?.id ?? null,
      modelName: model?.name ?? null,
      generations: model ? gens : gens.slice(0, 30),
      manual: !make || (!model && gens.length !== 1),
    };
  }

  /**
   * Код кузова / номер рамы японской машины: «ACV40-1234567», «GE6-1000001» → поколение по префиксу,
   * модификации с этим кодом кузова. Для японских машин без VIN — основной способ.
   */
  async bodyCode(tx: TenantTx, raw: string) {
    const code = String(raw ?? '').toUpperCase().replace(/\s/g, '').split(/[-–]/)[0].replace(/[^A-Z0-9]/g, '');
    if (code.length < 2) throw Errors.bad('BAD_BODY_CODE', 'Введите код кузова, например ACV40-1234567');
    const full = await this.dir.full(tx);
    // Самый длинный совпавший код кузова: ACV40 точнее, чем ACV4
    let best: { g: DirGeneration; len: number } | null = null;
    for (const g of full.generations as DirGeneration[]) {
      for (const b of g.bodyCodes ?? []) {
        const bc = b.toUpperCase();
        if ((code === bc || code.startsWith(bc)) && (!best || bc.length > best.len)) best = { g, len: bc.length };
      }
    }
    if (!best) return { code, found: false, generation: null, modifications: [] };
    const model = full.models.find((m: any) => m.id === best!.g.modelId);
    const make = full.makes.find((m: any) => m.id === model?.makeId);
    const mods = await this.platform.repo(GlobalVehicleModification).find({ where: { generationId: best.g.id }, order: { name: 'ASC' } });
    return {
      code,
      found: true,
      makeId: make?.id ?? null,
      makeName: make?.name ?? null,
      modelId: model?.id ?? null,
      modelName: model?.name ?? null,
      generation: { id: best.g.id, name: best.g.name, yearFrom: best.g.yearFrom, yearTo: best.g.yearTo },
      modifications: mods.filter((m) => !m.bodyCode || code.startsWith(m.bodyCode.toUpperCase())),
    };
  }
}
