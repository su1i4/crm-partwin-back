import { Injectable } from '@nestjs/common';
import { baseNormalize } from '../../common/utils/text-search';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { GlobalVehicleMake } from './entities/global-vehicle-make.entity';
import {
  GlobalVehicleGeneration,
  GlobalVehicleModel,
  GlobalVehicleModification,
  TenantVehicleGeneration,
  TenantVehicleModel,
} from './entities/vehicle.entity';

export interface DirMake { id: string; code: string; name: string; aliases: string[]; popular: boolean; sort: number }
export interface DirModel { id: string; makeId: string; name: string; aliases: string[]; own: boolean }
export interface DirGeneration {
  id: string;
  modelId: string;
  name: string;
  code: string;
  yearFrom: number | null;
  yearTo: number | null;
  restyle: string | null;
  aliases: string[];
  bodyCodes: string[];
  own: boolean;
}

export interface VehicleMatch {
  makeId: string;
  makeName: string;
  modelId: string | null;
  modelName: string | null;
  generationId: string | null;
  generationName: string | null;
  precision: 'make' | 'model' | 'generation';
  label: string;
  score: number;
  /** Слова запроса, которые ушли на машину (остальное — что искать) */
  consumed: string[];
}

interface GlobalCache {
  at: number;
  makes: DirMake[];
  models: DirModel[];
  generations: DirGeneration[];
}

const TTL = 10 * 60_000;

/**
 * Справочник автомобилей: общий (кэш в памяти на 10 минут) + свои модели и поколения магазина (ТЗ 6.1).
 * resolve() разбирает «камри 40», «Toyota Camry XV40», «ACV40», «фит», «крузак 200».
 */
@Injectable()
export class VehicleDirectoryService {
  private cache?: GlobalCache;

  constructor(private readonly platform: PlatformDb) {}

  async global(): Promise<GlobalCache> {
    if (this.cache && Date.now() - this.cache.at < TTL) return this.cache;
    const [makes, models, gens] = await Promise.all([
      this.platform.repo(GlobalVehicleMake).find(),
      this.platform.repo(GlobalVehicleModel).find(),
      this.platform.repo(GlobalVehicleGeneration).find(),
    ]);
    this.cache = {
      at: Date.now(),
      makes: makes.map((m) => ({ id: m.id, code: m.code, name: m.name, aliases: m.aliases, popular: m.popularKg, sort: m.sort })),
      models: models.map((m) => ({ id: m.id, makeId: m.makeId, name: m.name, aliases: m.aliases, own: false })),
      generations: gens.map((g) => ({
        id: g.id,
        modelId: g.modelId,
        name: g.name,
        code: g.code,
        yearFrom: g.yearFrom,
        yearTo: g.yearTo,
        restyle: g.restyle,
        aliases: g.aliases,
        bodyCodes: g.bodyCodes,
        own: false,
      })),
    };
    return this.cache;
  }

  invalidate() {
    this.cache = undefined;
  }

  /** Общий + свой справочник магазина. */
  async full(tx: TenantTx) {
    const g = await this.global();
    const [models, gens] = await Promise.all([tx.repo(TenantVehicleModel).find(), tx.repo(TenantVehicleGeneration).find()]);
    return {
      makes: g.makes,
      models: [...g.models, ...models.map((m) => ({ id: m.id, makeId: m.makeId, name: m.name, aliases: m.aliases, own: true }))],
      generations: [
        ...g.generations,
        ...gens.map((x) => ({
          id: x.id,
          modelId: x.modelId,
          name: x.name,
          code: x.name.toLowerCase(),
          yearFrom: x.yearFrom,
          yearTo: x.yearTo,
          restyle: x.restyle,
          aliases: x.aliases,
          bodyCodes: x.bodyCodes,
          own: true,
        })),
      ],
    };
  }

  async modifications(generationId: string) {
    return this.platform.repo(GlobalVehicleModification).find({ where: { generationId }, order: { name: 'ASC' } });
  }

  /** Подсказки для «Для каких машин» и разбор машины в свободном запросе. */
  async resolve(tx: TenantTx, text: string, limit = 8): Promise<VehicleMatch[]> {
    const q = baseNormalize(text);
    if (!q) return [];
    const tokens = q.split(/[\s,;]+/).filter(Boolean);
    const dir = await this.full(tx);
    const has = (phrase: string) => {
      const p = baseNormalize(phrase);
      if (!p) return false;
      return ` ${q} `.includes(` ${p} `);
    };
    const phraseTokens = (phrase: string) => baseNormalize(phrase).split(' ').filter(Boolean);
    const results: VehicleMatch[] = [];

    const makeHit = new Map<string, string[]>();
    for (const mk of dir.makes) {
      for (const n of [mk.name, mk.code, ...mk.aliases]) if (has(n)) { makeHit.set(mk.id, phraseTokens(n)); break; }
    }
    const modelHit = new Map<string, string[]>();
    for (const md of dir.models) {
      for (const n of [md.name, ...md.aliases]) if (n.length >= 2 && has(n)) { modelHit.set(md.id, phraseTokens(n)); break; }
    }

    for (const g of dir.generations) {
      const md = dir.models.find((m) => m.id === g.modelId);
      if (!md) continue;
      const mk = dir.makes.find((m) => m.id === md.makeId);
      if (!mk) continue;
      let score = 0;
      let consumed: string[] = [];
      const aliasHit = g.aliases.find((a) => a.includes(' ') && has(a));
      if (aliasHit) {
        score = 100;
        consumed = phraseTokens(aliasHit);
      } else {
        const body = tokens.find((t) => g.bodyCodes.some((b) => t.toUpperCase().startsWith(b.toUpperCase()) && t.length >= b.length));
        if (body) {
          score = 95;
          consumed = [body];
        } else if (modelHit.has(md.id)) {
          const genTok = tokens.find(
            (t) =>
              t === g.name.toLowerCase() ||
              t === g.code.toLowerCase() ||
              g.aliases.some((a) => !a.includes(' ') && a.toLowerCase() === t) ||
              (/^\d{2,3}$/.test(t) && (g.code.endsWith(t) || g.name.toLowerCase().endsWith(t))),
          );
          if (genTok) {
            score = 90;
            consumed = [...modelHit.get(md.id)!, genTok];
          }
        }
      }
      if (!score) continue;
      if (makeHit.has(mk.id)) {
        score += 3;
        consumed = [...new Set([...consumed, ...makeHit.get(mk.id)!])];
      }
      results.push({
        makeId: mk.id,
        makeName: mk.name,
        modelId: md.id,
        modelName: md.name,
        generationId: g.id,
        generationName: g.name,
        precision: 'generation',
        label: `${mk.name} ${md.name} ${g.name}${g.yearFrom ? ` (${g.yearFrom}–${g.yearTo ?? 'н.в.'})` : ''}`,
        score,
        consumed,
      });
    }

    if (!results.length) {
      for (const [modelId, toks] of modelHit) {
        const md = dir.models.find((m) => m.id === modelId)!;
        const mk = dir.makes.find((m) => m.id === md.makeId);
        if (!mk) continue;
        const consumed = [...new Set([...toks, ...(makeHit.get(mk.id) ?? [])])];
        results.push({
          makeId: mk.id,
          makeName: mk.name,
          modelId: md.id,
          modelName: md.name,
          generationId: null,
          generationName: null,
          precision: 'model',
          label: `${mk.name} ${md.name}`,
          score: 70 + (makeHit.has(mk.id) ? 3 : 0) + toks.join(' ').length,
          consumed,
        });
      }
    }
    if (!results.length) {
      for (const [makeId, toks] of makeHit) {
        const mk = dir.makes.find((m) => m.id === makeId)!;
        results.push({
          makeId,
          makeName: mk.name,
          modelId: null,
          modelName: null,
          generationId: null,
          generationName: null,
          precision: 'make',
          label: mk.name,
          score: 50,
          consumed: toks,
        });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Подписи для набора id (марка, модель, поколение). */
  async names(tx: TenantTx) {
    const dir = await this.full(tx);
    return {
      make: new Map(dir.makes.map((m) => [m.id, m])),
      model: new Map(dir.models.map((m) => [m.id, m])),
      generation: new Map(dir.generations.map((g) => [g.id, g])),
    };
  }
}
