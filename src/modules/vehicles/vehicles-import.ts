/**
 * Импорт общего справочника автомобилей командой платформы (ТЗ 6.1).
 *   npm run vehicles:import -- путь/к/файлу.csv
 * CSV (разделитель ; или ,), первая строка — заголовки:
 *   make;model;model_aliases;generation;generation_name;year_from;year_to;restyle;generation_aliases;body_codes;
 *   modification;engine_code;engine_volume;fuel;transmission;drive;steering;market;modification_body_code
 * Списки внутри ячейки — через «|». make — код марки справочника (toyota, honda …). Повторный импорт обновляет.
 * Кэш справочника в API обновится сам за 10 минут.
 */
import { readTable } from '../../common/utils/table-reader';

const list = (s?: string) => (s ?? '').split('|').map((x) => x.trim()).filter(Boolean);
const num = (s?: string) => (s && s.trim() ? Number(s.replace(',', '.')) : null);

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<any>;
}

/** Импорт CSV/Excel общего справочника (скрипт и админка платформы). */
export async function importVehicles(ds: Queryable, file: string, kind: 'csv' | 'xlsx' = file.endsWith('.xlsx') ? 'xlsx' : 'csv') {
  let header: string[] = [];
  const stats = { rows: 0, models: 0, generations: 0, modifications: 0, skipped: 0 };
  await readTable(file, kind, async (no, cells) => {
    if (no === 1) {
      header = cells.map((c) => c.trim().toLowerCase());
      return;
    }
    const r = Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
    stats.rows++;
    const [make] = await ds.query(`SELECT id FROM global_vehicle_makes WHERE code = $1`, [r.make?.toLowerCase()]);
    if (!make || !r.model) {
      stats.skipped++;
      return;
    }
    const modelCode = r.model.toLowerCase().replace(/\s+/g, '-');
    const [model] = await ds.query(
      `INSERT INTO global_vehicle_models (make_id, code, name, aliases) VALUES ($1, $2, $3, $4)
       ON CONFLICT (make_id, code) DO UPDATE SET aliases = (SELECT array(SELECT DISTINCT unnest(global_vehicle_models.aliases || EXCLUDED.aliases))), updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [make.id, modelCode, r.model, list(r.model_aliases)],
    );
    if (model.inserted) stats.models++;
    if (!r.generation) return;
    const [gen] = await ds.query(
      `INSERT INTO global_vehicle_generations (model_id, code, name, year_from, year_to, restyle, aliases, body_codes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (model_id, code) DO UPDATE SET name = EXCLUDED.name, year_from = coalesce(EXCLUDED.year_from, global_vehicle_generations.year_from),
          year_to = coalesce(EXCLUDED.year_to, global_vehicle_generations.year_to), restyle = coalesce(EXCLUDED.restyle, global_vehicle_generations.restyle),
          aliases = (SELECT array(SELECT DISTINCT unnest(global_vehicle_generations.aliases || EXCLUDED.aliases))),
          body_codes = (SELECT array(SELECT DISTINCT unnest(global_vehicle_generations.body_codes || EXCLUDED.body_codes))), updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [model.id, r.generation.toLowerCase(), r.generation_name || r.generation, num(r.year_from), num(r.year_to), r.restyle || null, list(r.generation_aliases), list(r.body_codes).map((b) => b.toUpperCase())],
    );
    if (gen.inserted) stats.generations++;
    if (!r.modification) return;
    const [exists] = await ds.query(`SELECT id FROM global_vehicle_modifications WHERE generation_id = $1 AND name = $2 AND coalesce(steering, '') = $3 AND coalesce(market, '') = $4`, [
      gen.id,
      r.modification,
      r.steering ?? '',
      r.market ?? '',
    ]);
    const vals = [r.engine_code || null, num(r.engine_volume), r.fuel || null, r.transmission || null, r.drive || null, r.steering || null, r.market || null, r.modification_body_code?.toUpperCase() || null];
    if (exists) {
      await ds.query(
        `UPDATE global_vehicle_modifications SET engine_code = $2, engine_volume = $3, fuel = $4, transmission = $5, drive = $6, steering = $7, market = $8, body_code = $9, updated_at = now() WHERE id = $1`,
        [exists.id, ...vals],
      );
    } else {
      await ds.query(
        `INSERT INTO global_vehicle_modifications (generation_id, name, engine_code, engine_volume, fuel, transmission, drive, steering, market, body_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [gen.id, r.modification, ...vals],
      );
      stats.modifications++;
    }
  });
  return stats;
}
