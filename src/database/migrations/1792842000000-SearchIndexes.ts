import { MigrationInterface, QueryRunner } from 'typeorm';

/** Индекс поиска по началу номера: COLLATE "C" + диапазон (работает с индексом при RLS, в отличие от LIKE). */
export class SearchIndexes1792842000000 implements MigrationInterface {
  name = 'SearchIndexes1792842000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_part_numbers_prefix" ON "part_numbers" ("tenant_id", "normalized" COLLATE "C")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_part_numbers_prefix"`);
  }
}
