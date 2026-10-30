/**
 * Импорт общего справочника автомобилей командой платформы (ТЗ 6.1).
 *   npm run vehicles:import -- путь/к/файлу.csv
 * Формат — src/modules/vehicles/vehicles-import.ts. Тот же импорт — в админке платформы.
 */
import 'reflect-metadata';
import AppDataSource from '../database/data-source';
import { importVehicles } from '../modules/vehicles/vehicles-import';

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Укажите CSV: npm run vehicles:import -- file.csv');
  const ds = await AppDataSource.initialize();
  console.log(JSON.stringify(await importVehicles(ds, file)));
  await ds.destroy();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
