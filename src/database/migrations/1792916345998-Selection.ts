import { MigrationInterface, QueryRunner } from "typeorm";
import { MODIFICATIONS_PRESET, WMI_PRESET } from "../seeds/presets/vin.preset";
import { grantAppRole } from "../tenant/grants";
import { enableRls } from "../tenant/rls";

export class Selection1792916345998 implements MigrationInterface {
    name = 'Selection1792916345998'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ocr_recognitions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "file_id" uuid, "provider" character varying(30) NOT NULL, "lines" jsonb NOT NULL DEFAULT '[]', "candidates" jsonb NOT NULL DEFAULT '[]', "found_count" integer NOT NULL DEFAULT '0', "ms" integer NOT NULL DEFAULT '0', "context" character varying(20), "chosen_product_id" uuid, "corrected_text" character varying(80), "corrected_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_7f7d4b8c787db45554410f6c9aa" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8f37fa2eceb9f514c867495016" ON "ocr_recognitions" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_593ef32d5509fbf16b07277eae" ON "ocr_recognitions" ("tenant_id", "created_at") `);
        await enableRls(queryRunner, "ocr_recognitions");
        await grantAppRole(queryRunner);
        // Стартовое наполнение: WMI для расшифровки VIN и модификации популярных поколений (ТЗ 6.1)
        for (const [wmi, make, country] of WMI_PRESET) {
            await queryRunner.query(
                `INSERT INTO global_vin_wmi (wmi, make_id, country) SELECT $1, id, $3 FROM global_vehicle_makes WHERE code = $2 ON CONFLICT (wmi) DO NOTHING`,
                [wmi, make, country],
            );
        }
        for (const [make, model, gen, name, engine, vol, fuel, kpp, drive, steering, market, body] of MODIFICATIONS_PRESET) {
            await queryRunner.query(
                `INSERT INTO global_vehicle_modifications (generation_id, name, engine_code, engine_volume, fuel, transmission, drive, steering, market, body_code)
                 SELECT g.id, $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12 FROM global_vehicle_generations g
                   JOIN global_vehicle_models m ON m.id = g.model_id JOIN global_vehicle_makes mk ON mk.id = m.make_id
                  WHERE mk.code = $1 AND m.code = $2 AND g.code = $3`,
                [make, model, gen, name, engine, vol, fuel, kpp, drive, steering, market, body],
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM global_vehicle_modifications`);
        await queryRunner.query(`DELETE FROM global_vin_wmi`);
        await queryRunner.query(`DROP INDEX "public"."IDX_593ef32d5509fbf16b07277eae"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8f37fa2eceb9f514c867495016"`);
        await queryRunner.query(`DROP TABLE "ocr_recognitions"`);
    }

}
