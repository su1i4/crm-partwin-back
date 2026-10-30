import { MigrationInterface, QueryRunner } from "typeorm";
import { normalizeBrand } from "../../common/utils/brand";
import { BRANDS_PRESET } from "../seeds/presets/brands.preset";
import { SYNONYMS_PRESET } from "../seeds/presets/synonyms.preset";
import { VEHICLES_PRESET } from "../seeds/presets/vehicles.preset";
import { grantAppRole } from "../tenant/grants";
import { enableRls } from "../tenant/rls";

const TENANT_TABLES = [
  "counters", "tenant_vehicle_models", "tenant_vehicle_generations", "product_applicability", "search_synonyms",
  "unfound_queries", "prices", "part_numbers", "part_crosses", "import_jobs", "products", "product_units",
  "product_barcodes", "product_photos", "kit_components", "brands",
];

export class Catalog1792841509013 implements MigrationInterface {
    name = 'Catalog1792841509013'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "counters" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "key" character varying(100) NOT NULL, "value" bigint NOT NULL DEFAULT '0', CONSTRAINT "PK_910bfcbadea9cde6397e0daf996" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9b2c8f9471ca39759d7b7cd32c" ON "counters" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_counters_key" ON "counters" ("tenant_id", "key") `);
        await queryRunner.query(`CREATE TABLE "global_vehicle_models" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "make_id" uuid NOT NULL, "code" character varying(80) NOT NULL, "name" character varying(100) NOT NULL, "aliases" text array NOT NULL DEFAULT '{}', "sort" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_3195047b95afe8721752309b513" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_global_vehicle_models" ON "global_vehicle_models" ("make_id", "code") `);
        await queryRunner.query(`CREATE TABLE "global_vehicle_generations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "model_id" uuid NOT NULL, "code" character varying(80) NOT NULL, "name" character varying(100) NOT NULL, "year_from" smallint, "year_to" smallint, "restyle" character varying(5), "aliases" text array NOT NULL DEFAULT '{}', "body_codes" text array NOT NULL DEFAULT '{}', "sort" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_652471f18062a7d8c4495716d04" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_global_vehicle_generations" ON "global_vehicle_generations" ("model_id", "code") `);
        await queryRunner.query(`CREATE TABLE "global_vehicle_modifications" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "generation_id" uuid NOT NULL, "name" character varying(150) NOT NULL, "engine_code" character varying(30), "engine_volume" numeric(4,1), "fuel" character varying(15), "transmission" character varying(10), "drive" character varying(10), "steering" character varying(10), "market" character varying(10), "body_code" character varying(30), "year_from" smallint, "year_to" smallint, CONSTRAINT "PK_d537909359a608c485cb1cb8c11" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3c7e505641849c9d5b221e571c" ON "global_vehicle_modifications" ("generation_id") `);
        await queryRunner.query(`CREATE TABLE "global_vin_wmi" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "wmi" character varying(3) NOT NULL, "make_id" uuid NOT NULL, "country" character varying(60), CONSTRAINT "PK_d35117f2ac6f5ef7dcfdb0fab48" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_global_vin_wmi" ON "global_vin_wmi" ("wmi") `);
        await queryRunner.query(`CREATE TABLE "tenant_vehicle_models" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "make_id" uuid NOT NULL, "name" character varying(100) NOT NULL, "aliases" text array NOT NULL DEFAULT '{}', CONSTRAINT "PK_0ac67ec741c23059db2006d3fc6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2fe96077f69feee8458493368c" ON "tenant_vehicle_models" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_2250ad96112e570b2a73eacae0" ON "tenant_vehicle_models" ("tenant_id", "make_id") `);
        await queryRunner.query(`CREATE TABLE "tenant_vehicle_generations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "model_id" uuid NOT NULL, "name" character varying(100) NOT NULL, "year_from" smallint, "year_to" smallint, "restyle" character varying(5), "aliases" text array NOT NULL DEFAULT '{}', "body_codes" text array NOT NULL DEFAULT '{}', CONSTRAINT "PK_ea505a92b81bd30172ab4029c14" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_18b34a0218b261968bff4c3122" ON "tenant_vehicle_generations" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8279bcad1e2a097b0c6095bdc4" ON "tenant_vehicle_generations" ("tenant_id", "model_id") `);
        await queryRunner.query(`CREATE TABLE "product_applicability" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "product_id" uuid NOT NULL, "make_id" uuid NOT NULL, "model_id" uuid, "generation_id" uuid, "modification_id" uuid, "precision" character varying(15) NOT NULL, "year_from" smallint, "year_to" smallint, "steering" character varying(10), "market" character varying(10), "note" character varying(200), CONSTRAINT "PK_5ff1ec3ca0d765f82af18399c46" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7f7dd1c6e0bed2d098d8dbcccf" ON "product_applicability" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_25839d7c4c58b63caa8161b277" ON "product_applicability" ("tenant_id", "make_id", "model_id", "generation_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_863e26ab4779b3de4faf463f0a" ON "product_applicability" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE TABLE "global_search_synonyms" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "word" character varying(100) NOT NULL, "target" character varying(200) NOT NULL, "lang" character varying(5) NOT NULL DEFAULT 'ru', CONSTRAINT "PK_5bd217082856e5aa52a806acf3a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_global_search_synonyms" ON "global_search_synonyms" ("word", "target") `);
        await queryRunner.query(`CREATE TABLE "search_synonyms" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "word" character varying(100) NOT NULL, "target" character varying(200) NOT NULL, CONSTRAINT "PK_ce183cb7609a798751043c85c5f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_ac01b199e21a675e31d01c0dcd" ON "search_synonyms" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_search_synonyms" ON "search_synonyms" ("tenant_id", "word", "target") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "unfound_queries" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "query" character varying(300) NOT NULL, "normalized" character varying(300) NOT NULL, "reason" character varying(10) NOT NULL, "store_id" uuid, "make_id" uuid, "model_id" uuid, "generation_id" uuid, "context" character varying(20), CONSTRAINT "PK_fd78ead476150bcca46233032ce" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6d96f67bcf939af887d28acc58" ON "unfound_queries" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8666331c68d6b0c942879175a8" ON "unfound_queries" ("tenant_id", "normalized") `);
        await queryRunner.query(`CREATE INDEX "IDX_d81dc2d06555a82b283c89cb54" ON "unfound_queries" ("tenant_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "prices" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "price_type_id" uuid NOT NULL, "store_id" uuid, "product_id" uuid NOT NULL, "unit_id" uuid, "price" numeric(18,2) NOT NULL, "currency" character varying(3) NOT NULL DEFAULT 'KGS', "valid_from" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "document_id" uuid, CONSTRAINT "PK_2e40b9e4e631a53cd514d82ccd2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_05a380a8a11ed0df3f87916fca" ON "prices" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_a1ee1537672da0e3777582f5ca" ON "prices" ("tenant_id", "product_id", "price_type_id", "valid_from") `);
        await queryRunner.query(`CREATE TABLE "part_numbers" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "product_id" uuid NOT NULL, "brand_id" uuid, "number" character varying(80) NOT NULL, "normalized" character varying(80) NOT NULL, "skeleton" character varying(80) NOT NULL, "type" character varying(15) NOT NULL, "supplier_id" uuid, CONSTRAINT "PK_32156f8ed266a73c218c60501e0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_0321d294871fc8892cee2afcd0" ON "part_numbers" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_part_numbers_manufacturer" ON "part_numbers" ("tenant_id", "brand_id", "normalized") WHERE type = 'manufacturer'`);
        await queryRunner.query(`CREATE INDEX "IDX_dd9dbfe6e83c5f5d42c807db4d" ON "part_numbers" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_bf1de49af41ffa618bec15bd16" ON "part_numbers" ("tenant_id", "skeleton") `);
        await queryRunner.query(`CREATE INDEX "IDX_7a133cf0147e91410b7b90e024" ON "part_numbers" ("tenant_id", "normalized") `);
        await queryRunner.query(`CREATE TABLE "part_crosses" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "a_brand_id" uuid, "a_number" character varying(80) NOT NULL, "a_normalized" character varying(80) NOT NULL, "a_brand_key" character varying(36) NOT NULL DEFAULT '', "b_brand_id" uuid, "b_number" character varying(80) NOT NULL, "b_normalized" character varying(80) NOT NULL, "b_brand_key" character varying(36) NOT NULL DEFAULT '', "cross_type" character varying(20) NOT NULL DEFAULT 'full', "source" character varying(20) NOT NULL DEFAULT 'manual', "source_ref_id" uuid, CONSTRAINT "PK_2b9c611f56d8a37b3f496236434" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b6e8b2d9b8817b356427023ad7" ON "part_crosses" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_part_crosses_pair" ON "part_crosses" ("tenant_id", "a_normalized", "a_brand_key", "b_normalized", "b_brand_key") `);
        await queryRunner.query(`CREATE INDEX "IDX_c31afd6910bd3d99ee5736148e" ON "part_crosses" ("tenant_id", "b_normalized") `);
        await queryRunner.query(`CREATE INDEX "IDX_d3cc584c48eb3dc6d91e8647f4" ON "part_crosses" ("tenant_id", "a_normalized") `);
        await queryRunner.query(`CREATE TABLE "import_jobs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "type" character varying(20) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'uploaded', "file_id" uuid NOT NULL, "file_name" character varying(300) NOT NULL, "columns" jsonb NOT NULL DEFAULT '[]', "mapping" jsonb NOT NULL DEFAULT '{}', "options" jsonb NOT NULL DEFAULT '{}', "total_rows" integer NOT NULL DEFAULT '0', "processed_rows" integer NOT NULL DEFAULT '0', "created_count" integer NOT NULL DEFAULT '0', "updated_count" integer NOT NULL DEFAULT '0', "error_count" integer NOT NULL DEFAULT '0', "errors" jsonb NOT NULL DEFAULT '[]', "fail_reason" text, "started_at" TIMESTAMP WITH TIME ZONE, "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_4d206c602f173f98e4bb85819a3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_96f340d5dff8bf3a3d2df26a2c" ON "import_jobs" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_4b1d950efd714318231b6ca443" ON "import_jobs" ("tenant_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "products" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "name" character varying(300) NOT NULL, "sku" character varying(50) NOT NULL, "kind" character varying(10) NOT NULL DEFAULT 'goods', "brand_id" uuid, "quality_class" character varying(20) NOT NULL DEFAULT 'aftermarket', "category_id" uuid, "part_type_id" uuid, "attributes" jsonb NOT NULL DEFAULT '{}', "description" text, "seller_note" text, "warranty_days" integer, "return_days" integer, "return_conditions" character varying(500), "base_unit" character varying(10) NOT NULL DEFAULT 'шт', "fractional" boolean NOT NULL DEFAULT false, "qty_step" numeric(18,3) NOT NULL DEFAULT '1', "is_serial" boolean NOT NULL DEFAULT false, "no_stock_control" boolean NOT NULL DEFAULT false, "price_negotiable" boolean NOT NULL DEFAULT false, "min_price" numeric(18,2), "recommended_price" numeric(18,2), "status" character varying(10) NOT NULL DEFAULT 'active', "tags" text array NOT NULL DEFAULT '{}', "search_text" text NOT NULL DEFAULT '', "merged_into_id" uuid, "import_job_id" uuid, "quick_created" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9c365ebf78f0e8a6d9e4827ea7" ON "products" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_65711bca92032bc7211bf92121" ON "products" ("tenant_id", "import_job_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_22ad5445514d484d9a67095b59" ON "products" ("tenant_id", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_86fec4df3ad775c726cd29edf1" ON "products" ("tenant_id", "brand_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_860485c46a817f4b075a7a3265" ON "products" ("tenant_id", "category_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_products_sku" ON "products" ("tenant_id", "sku") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "product_units" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "product_id" uuid NOT NULL, "name" character varying(30) NOT NULL, "factor" numeric(18,3) NOT NULL, "is_base" boolean NOT NULL DEFAULT false, "price_mode" character varying(10) NOT NULL DEFAULT 'computed', CONSTRAINT "PK_d26a9abe8b38cdd765716265977" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8ef48eb413ef1aa30e4b38775d" ON "product_units" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_7f33f70717d1c434cc925afa11" ON "product_units" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE TABLE "product_barcodes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "product_id" uuid NOT NULL, "unit_id" uuid NOT NULL, "barcode" character varying(64) NOT NULL, "is_internal" boolean NOT NULL DEFAULT false, "duplicate_accepted" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_459d7d53aebb732e6c8460247d6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3a84104912ab1e199e7f7cdb1c" ON "product_barcodes" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_product_barcodes" ON "product_barcodes" ("tenant_id", "product_id", "barcode") `);
        await queryRunner.query(`CREATE INDEX "IDX_78ad89c26181b6831b37556d95" ON "product_barcodes" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_00769c0fb75bd2e77eed5c6970" ON "product_barcodes" ("tenant_id", "barcode") `);
        await queryRunner.query(`CREATE TABLE "product_photos" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "product_id" uuid NOT NULL, "file_id" uuid NOT NULL, "sort" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_0586e8a3f1766827efaf0ee3943" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6d682c790cf34aa8a86cd0695e" ON "product_photos" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_7813368bf5cd54c7d539fdc44d" ON "product_photos" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE TABLE "kit_components" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "kit_id" uuid NOT NULL, "component_id" uuid NOT NULL, "qty" numeric(18,3) NOT NULL, CONSTRAINT "PK_34f04573bc149465005a040d299" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a8260acdec96ce8608fcbbcfc8" ON "kit_components" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_kit_components" ON "kit_components" ("tenant_id", "kit_id", "component_id") `);
        await queryRunner.query(`CREATE TABLE "global_brands" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying(100) NOT NULL, "normalized_name" character varying(100) NOT NULL, "aliases" text array NOT NULL DEFAULT '{}', "aliases_norm" text array NOT NULL DEFAULT '{}', "country" character varying(60), "is_car_maker" boolean NOT NULL DEFAULT false, "is_no_brand" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_eb73ee7f4664a6e78ea9fd780df" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_global_brands_norm" ON "global_brands" ("normalized_name") `);
        await queryRunner.query(`CREATE TABLE "brands" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "name" character varying(100) NOT NULL, "normalized_name" character varying(100) NOT NULL, "global_brand_id" uuid, "aliases" text array NOT NULL DEFAULT '{}', "aliases_norm" text array NOT NULL DEFAULT '{}', "country" character varying(60), "is_car_maker" boolean NOT NULL DEFAULT false, "is_no_brand" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_b0c437120b624da1034a81fc561" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_33bb5b1b1a3a7e8b9787cd8778" ON "brands" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_brands_global" ON "brands" ("tenant_id", "global_brand_id") WHERE deleted_at IS NULL AND global_brand_id IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_brands_norm" ON "brands" ("tenant_id", "normalized_name") WHERE deleted_at IS NULL`);

        // ── GIN-индексы для поиска (ТЗ 5.1) ─────────────────────
        await queryRunner.query(`CREATE INDEX "ix_products_search_trgm" ON "products" USING gin ("search_text" gin_trgm_ops)`);
        await queryRunner.query(`CREATE INDEX "ix_products_attributes" ON "products" USING gin ("attributes" jsonb_path_ops)`);
        await queryRunner.query(`CREATE INDEX "ix_part_numbers_trgm" ON "part_numbers" USING gin ("normalized" gin_trgm_ops)`);
        await queryRunner.query(`CREATE INDEX "ix_global_brands_aliases" ON "global_brands" USING gin ("aliases_norm")`);
        await queryRunner.query(`CREATE INDEX "ix_brands_aliases" ON "brands" USING gin ("aliases_norm")`);
        await queryRunner.query(`CREATE INDEX "ix_global_vehicle_models_aliases" ON "global_vehicle_models" USING gin ("aliases")`);
        await queryRunner.query(`CREATE INDEX "ix_global_vehicle_generations_aliases" ON "global_vehicle_generations" USING gin ("aliases")`);
        await queryRunner.query(`CREATE INDEX "ix_global_vehicle_generations_body" ON "global_vehicle_generations" USING gin ("body_codes")`);

        for (const t of TENANT_TABLES) await enableRls(queryRunner, t);
        await grantAppRole(queryRunner);

        // ── Справочники платформы ───────────────────────────────
        for (const b of BRANDS_PRESET) {
            const aliases = b.aliases ?? [];
            await queryRunner.query(
                `INSERT INTO global_brands (name, normalized_name, aliases, aliases_norm, country, is_car_maker, is_no_brand)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (normalized_name) DO NOTHING`,
                [b.name, normalizeBrand(b.name), aliases, aliases.map(normalizeBrand), b.country ?? null, !!b.carMaker, !!b.noBrand],
            );
        }
        for (const syn of SYNONYMS_PRESET) {
            await queryRunner.query(
                `INSERT INTO global_search_synonyms (word, target, lang) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                [syn.word.toLowerCase(), syn.target.toLowerCase(), syn.lang ?? "ru"],
            );
        }
        for (const [makeCode, models] of Object.entries(VEHICLES_PRESET)) {
            const [make] = await queryRunner.query(`SELECT id FROM global_vehicle_makes WHERE code = $1`, [makeCode]);
            if (!make) continue;
            let ms = 0;
            for (const m of models) {
                ms += 10;
                const [model] = await queryRunner.query(
                    `INSERT INTO global_vehicle_models (make_id, code, name, aliases, sort) VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (make_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
                    [make.id, m.code, m.name, m.aliases, ms],
                );
                let gs = 0;
                for (const [code, name, from, to, restyle, aliases, bodies] of m.gens) {
                    gs += 10;
                    await queryRunner.query(
                        `INSERT INTO global_vehicle_generations (model_id, code, name, year_from, year_to, restyle, aliases, body_codes, sort)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (model_id, code) DO NOTHING`,
                        [model.id, code, name, from, to, restyle, aliases, bodies, gs],
                    );
                }
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uq_brands_norm"`);
        await queryRunner.query(`DROP INDEX "public"."uq_brands_global"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_33bb5b1b1a3a7e8b9787cd8778"`);
        await queryRunner.query(`DROP TABLE "brands"`);
        await queryRunner.query(`DROP INDEX "public"."uq_global_brands_norm"`);
        await queryRunner.query(`DROP TABLE "global_brands"`);
        await queryRunner.query(`DROP INDEX "public"."uq_kit_components"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a8260acdec96ce8608fcbbcfc8"`);
        await queryRunner.query(`DROP TABLE "kit_components"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7813368bf5cd54c7d539fdc44d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6d682c790cf34aa8a86cd0695e"`);
        await queryRunner.query(`DROP TABLE "product_photos"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_00769c0fb75bd2e77eed5c6970"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_78ad89c26181b6831b37556d95"`);
        await queryRunner.query(`DROP INDEX "public"."uq_product_barcodes"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3a84104912ab1e199e7f7cdb1c"`);
        await queryRunner.query(`DROP TABLE "product_barcodes"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7f33f70717d1c434cc925afa11"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8ef48eb413ef1aa30e4b38775d"`);
        await queryRunner.query(`DROP TABLE "product_units"`);
        await queryRunner.query(`DROP INDEX "public"."uq_products_sku"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_860485c46a817f4b075a7a3265"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_86fec4df3ad775c726cd29edf1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_22ad5445514d484d9a67095b59"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_65711bca92032bc7211bf92121"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9c365ebf78f0e8a6d9e4827ea7"`);
        await queryRunner.query(`DROP TABLE "products"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4b1d950efd714318231b6ca443"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_96f340d5dff8bf3a3d2df26a2c"`);
        await queryRunner.query(`DROP TABLE "import_jobs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d3cc584c48eb3dc6d91e8647f4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c31afd6910bd3d99ee5736148e"`);
        await queryRunner.query(`DROP INDEX "public"."uq_part_crosses_pair"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b6e8b2d9b8817b356427023ad7"`);
        await queryRunner.query(`DROP TABLE "part_crosses"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7a133cf0147e91410b7b90e024"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bf1de49af41ffa618bec15bd16"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dd9dbfe6e83c5f5d42c807db4d"`);
        await queryRunner.query(`DROP INDEX "public"."uq_part_numbers_manufacturer"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0321d294871fc8892cee2afcd0"`);
        await queryRunner.query(`DROP TABLE "part_numbers"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a1ee1537672da0e3777582f5ca"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_05a380a8a11ed0df3f87916fca"`);
        await queryRunner.query(`DROP TABLE "prices"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d81dc2d06555a82b283c89cb54"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8666331c68d6b0c942879175a8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6d96f67bcf939af887d28acc58"`);
        await queryRunner.query(`DROP TABLE "unfound_queries"`);
        await queryRunner.query(`DROP INDEX "public"."uq_search_synonyms"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ac01b199e21a675e31d01c0dcd"`);
        await queryRunner.query(`DROP TABLE "search_synonyms"`);
        await queryRunner.query(`DROP INDEX "public"."uq_global_search_synonyms"`);
        await queryRunner.query(`DROP TABLE "global_search_synonyms"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_863e26ab4779b3de4faf463f0a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_25839d7c4c58b63caa8161b277"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7f7dd1c6e0bed2d098d8dbcccf"`);
        await queryRunner.query(`DROP TABLE "product_applicability"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8279bcad1e2a097b0c6095bdc4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_18b34a0218b261968bff4c3122"`);
        await queryRunner.query(`DROP TABLE "tenant_vehicle_generations"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2250ad96112e570b2a73eacae0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2fe96077f69feee8458493368c"`);
        await queryRunner.query(`DROP TABLE "tenant_vehicle_models"`);
        await queryRunner.query(`DROP INDEX "public"."uq_global_vin_wmi"`);
        await queryRunner.query(`DROP TABLE "global_vin_wmi"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3c7e505641849c9d5b221e571c"`);
        await queryRunner.query(`DROP TABLE "global_vehicle_modifications"`);
        await queryRunner.query(`DROP INDEX "public"."uq_global_vehicle_generations"`);
        await queryRunner.query(`DROP TABLE "global_vehicle_generations"`);
        await queryRunner.query(`DROP INDEX "public"."uq_global_vehicle_models"`);
        await queryRunner.query(`DROP TABLE "global_vehicle_models"`);
        await queryRunner.query(`DROP INDEX "public"."uq_counters_key"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9b2c8f9471ca39759d7b7cd32c"`);
        await queryRunner.query(`DROP TABLE "counters"`);
    }

}
