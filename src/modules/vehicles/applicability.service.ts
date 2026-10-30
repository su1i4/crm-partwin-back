import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { ApplicabilityPrecision, ProductApplicability } from './entities/vehicle.entity';
import { VehicleDirectoryService } from './vehicle-directory.service';

export interface ApplicabilityInput {
  text?: string;
  makeId?: string;
  modelId?: string;
  generationId?: string;
  modificationId?: string;
  yearFrom?: number;
  yearTo?: number;
  steering?: string;
  market?: string;
  note?: string;
}

export interface ApplicabilityRow {
  makeId: string;
  modelId: string | null;
  generationId: string | null;
  modificationId: string | null;
  precision: ApplicabilityPrecision;
  yearFrom: number | null;
  yearTo: number | null;
  steering: string | null;
  market: string | null;
  note: string | null;
}

/** Применимость товара: быстрая метка → поколение → модификация (ТЗ 6.2). */
@Injectable()
export class ApplicabilityService {
  constructor(private readonly dir: VehicleDirectoryService) {}

  /** Привести ввод к строке применимости: текст разбирается справочником, id проверяются на согласованность. */
  async normalize(tx: TenantTx, item: ApplicabilityInput): Promise<ApplicabilityRow> {
    let { makeId, modelId, generationId } = item;
    const modificationId = item.modificationId;
    if (item.text && !makeId && !modelId && !generationId) {
      const [best] = await this.dir.resolve(tx, item.text, 1);
      if (!best) throw Errors.bad('VEHICLE_NOT_FOUND', `Не нашли машину «${item.text}». Выберите из списка`);
      makeId = best.makeId;
      modelId = best.modelId ?? undefined;
      generationId = best.generationId ?? undefined;
    }
    if (modificationId && !generationId) {
      // Модификация из справочника — поколение, модель и марка по ней
      const [m] = await tx.query(`SELECT generation_id FROM global_vehicle_modifications WHERE id = $1`, [modificationId]);
      if (!m) throw Errors.notFound('Модификация');
      generationId = m.generation_id;
    }
    const names = await this.dir.names(tx);
    if (generationId) {
      const g = names.generation.get(generationId);
      if (!g) throw Errors.notFound('Поколение');
      if (modelId && modelId !== g.modelId) throw Errors.bad('VEHICLE_MISMATCH', 'Поколение не относится к модели');
      modelId = g.modelId;
    }
    if (modelId) {
      const m = names.model.get(modelId);
      if (!m) throw Errors.notFound('Модель');
      if (makeId && makeId !== m.makeId) throw Errors.bad('VEHICLE_MISMATCH', 'Модель не относится к марке');
      makeId = m.makeId;
    }
    if (!makeId || !names.make.get(makeId)) throw Errors.bad('MAKE_REQUIRED', 'Укажите марку');
    if (modificationId) {
      if (!generationId) throw Errors.bad('VEHICLE_MISMATCH', 'Модификация указывается вместе с поколением');
      const mods = await this.dir.modifications(generationId);
      if (!mods.some((m) => m.id === modificationId)) throw Errors.notFound('Модификация');
    }
    const precision: ApplicabilityPrecision = modificationId
      ? 'modification'
      : generationId
        ? 'generation'
        : modelId
          ? 'model'
          : 'make';
    return {
      makeId,
      modelId: modelId ?? null,
      generationId: generationId ?? null,
      modificationId: modificationId ?? null,
      precision,
      yearFrom: item.yearFrom ?? null,
      yearTo: item.yearTo ?? null,
      steering: item.steering ?? null,
      market: item.market ?? null,
      note: item.note ?? null,
    };
  }

  async replace(tx: TenantTx, productId: string, items: ApplicabilityInput[]) {
    const rows: ApplicabilityRow[] = [];
    for (const i of items) rows.push(await this.normalize(tx, i));
    const unique = dedupe(rows);
    await tx.repo(ProductApplicability).hardDelete({ productId });
    await tx.repo(ProductApplicability).insertMany(unique.map((r) => ({ ...r, productId })));
    return unique.length;
  }

  async add(tx: TenantTx, productIds: string[], items: ApplicabilityInput[]) {
    const rows: ApplicabilityRow[] = [];
    for (const i of items) rows.push(await this.normalize(tx, i));
    let added = 0;
    for (const productId of productIds) {
      const existing = await tx.repo(ProductApplicability).find({ where: { productId } });
      const keys = new Set(existing.map(key));
      const fresh = dedupe(rows).filter((r) => !keys.has(key(r)));
      await tx.repo(ProductApplicability).insertMany(fresh.map((r) => ({ ...r, productId })));
      added += fresh.length;
    }
    return added;
  }

  async list(tx: TenantTx, productId: string) {
    const rows = await tx.repo(ProductApplicability).find({ where: { productId } });
    const n = await this.dir.names(tx);
    return rows.map((r) => {
      const mk = n.make.get(r.makeId);
      const md = r.modelId ? n.model.get(r.modelId) : undefined;
      const g = r.generationId ? n.generation.get(r.generationId) : undefined;
      return {
        id: r.id,
        makeId: r.makeId,
        modelId: r.modelId,
        generationId: r.generationId,
        modificationId: r.modificationId,
        precision: r.precision,
        yearFrom: r.yearFrom,
        yearTo: r.yearTo,
        steering: r.steering,
        market: r.market,
        note: r.note,
        label: [mk?.name, md?.name, g?.name].filter(Boolean).join(' '),
        /** Быстрая метка без поколения — «применимость не уточнена» (ТЗ 5.2) */
        unverified: r.precision === 'make' || r.precision === 'model',
      };
    });
  }

  async copy(tx: TenantTx, fromProductId: string, toProductIds: string[]) {
    const src = await tx.repo(ProductApplicability).find({ where: { productId: fromProductId } });
    const items = src.map((r) => ({
      makeId: r.makeId,
      modelId: r.modelId ?? undefined,
      generationId: r.generationId ?? undefined,
      modificationId: r.modificationId ?? undefined,
      yearFrom: r.yearFrom ?? undefined,
      yearTo: r.yearTo ?? undefined,
      steering: r.steering ?? undefined,
      market: r.market ?? undefined,
      note: r.note ?? undefined,
    }));
    return this.add(tx, toProductIds, items);
  }
}

const key = (r: { makeId: string; modelId: string | null; generationId: string | null; modificationId: string | null }) =>
  [r.makeId, r.modelId, r.generationId, r.modificationId].join('|');

function dedupe<T extends { makeId: string; modelId: string | null; generationId: string | null; modificationId: string | null }>(rows: T[]) {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(key(r)) ? false : (seen.add(key(r)), true)));
}
