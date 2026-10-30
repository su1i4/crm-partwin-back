import { MigrationInterface, QueryRunner } from "typeorm";
import { grantAppRole } from "../tenant/grants";
import { enableRls } from "../tenant/rls";

export class StoLoyalty1792932444403 implements MigrationInterface {
    name = 'StoLoyalty1792932444403'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "selection_issues" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "number" character varying(30) NOT NULL, "store_id" uuid NOT NULL, "counterparty_id" uuid NOT NULL, "customer_vehicle_id" uuid, "warehouse_id" uuid NOT NULL, "customer_warehouse_id" uuid NOT NULL, "issue_document_id" uuid NOT NULL, "return_document_id" uuid, "receipt_id" uuid, "lines" jsonb NOT NULL, "due_date" date NOT NULL, "status" character varying(10) NOT NULL DEFAULT 'open', "closed_at" TIMESTAMP WITH TIME ZONE, "reminded_at" TIMESTAMP WITH TIME ZONE, "comment" character varying(500), CONSTRAINT "PK_33524f96cd0d9cb1cfb71be57fd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c83f484d09e71725e33b5ca29a" ON "selection_issues" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8582f0e247fc4f4ec1e9f06f2c" ON "selection_issues" ("tenant_id", "status") `);
        await queryRunner.query(`CREATE TABLE "master_bonus_rules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "master_id" uuid, "category_id" uuid, "kind" character varying(15) NOT NULL, "value" numeric(12,2) NOT NULL, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_b1fa39c90c8438732e57089f97f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_83b76cd1ee2d17ad1ed2ae85df" ON "master_bonus_rules" ("tenant_id") `);
        await queryRunner.query(`CREATE TABLE "master_bonuses" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "master_id" uuid NOT NULL, "receipt_id" uuid NOT NULL, "amount" numeric(18,2) NOT NULL, "debt_item_id" uuid, CONSTRAINT "PK_95061481d4b5d914546ea46cbd4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fdef61d58f0c3fde6ce1a751a2" ON "master_bonuses" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_370da56ecbac085c41adce54ad" ON "master_bonuses" ("tenant_id", "receipt_id") `);
        await queryRunner.query(`CREATE TABLE "personal_prices" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "counterparty_id" uuid NOT NULL, "product_id" uuid NOT NULL, "price" numeric(18,2) NOT NULL, "currency" character varying(3) NOT NULL DEFAULT 'KGS', CONSTRAINT "PK_ddb4710fca58241121dad040902" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_553d0a6d5cf7bd4e8fb26a8b2a" ON "personal_prices" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2f6173bbcdb28f6d5f1eaaec2a" ON "personal_prices" ("tenant_id", "counterparty_id", "product_id") `);
        await queryRunner.query(`CREATE TABLE "tasks" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "title" character varying(300) NOT NULL, "description" text, "assignee_id" uuid, "store_id" uuid, "due_at" TIMESTAMP WITH TIME ZONE, "remind_at" TIMESTAMP WITH TIME ZONE, "reminded_at" TIMESTAMP WITH TIME ZONE, "status" character varying(10) NOT NULL DEFAULT 'open', "counterparty_id" uuid, "customer_vehicle_id" uuid, "entity_type" character varying(30), "entity_id" uuid, "auto_kind" character varying(30), "auto_key" character varying(120), "done_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_8d12ff38fcc62aaba2cab748772" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_93edccfc42408754c4b5957105" ON "tasks" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a8a8476ccfa72358e116d5514f" ON "tasks" ("tenant_id", "auto_key") WHERE auto_key IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_fc8a051f27309978d32d1d09f0" ON "tasks" ("tenant_id", "status", "due_at") `);
        await queryRunner.query(`CREATE TABLE "customer_activities" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "counterparty_id" uuid NOT NULL, "kind" character varying(10) NOT NULL, "text" text NOT NULL, CONSTRAINT "PK_359c4a3763df0f71a998ae7cdf6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_ae1755fc6b0b5a98eedacf1b4a" ON "customer_activities" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_68a03a19d682e55b2300d99b0d" ON "customer_activities" ("tenant_id", "counterparty_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "message_templates" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "code" character varying(40) NOT NULL, "name" character varying(100) NOT NULL, "text_ru" text NOT NULL, "text_ky" text, CONSTRAINT "PK_9ac2bd9635be662d183f314947d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f54dca32de3d375d837cf18bd3" ON "message_templates" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c848cf90f931bc457340927fa6" ON "message_templates" ("tenant_id", "code") `);
        await queryRunner.query(`CREATE TABLE "oil_reminder_rules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "category_id" uuid, "months" smallint NOT NULL DEFAULT '6', "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_0b32266dbd3beef99bf5cfebac4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8200df69e10953e93fea2c5fa0" ON "oil_reminder_rules" ("tenant_id") `);
        await queryRunner.query(`CREATE TABLE "promotions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "name" character varying(150) NOT NULL, "kind" character varying(20) NOT NULL, "percent" numeric(5,2) NOT NULL, "min_amount" numeric(18,2), "category_ids" jsonb NOT NULL DEFAULT '[]', "brand_ids" jsonb NOT NULL DEFAULT '[]', "quality_classes" jsonb NOT NULL DEFAULT '[]', "make_ids" jsonb NOT NULL DEFAULT '[]', "product_ids" jsonb NOT NULL DEFAULT '[]', "store_ids" jsonb NOT NULL DEFAULT '[]', "starts_on" date, "ends_on" date, "stackable" boolean NOT NULL DEFAULT false, "by_code" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_380cecbbe3ac11f0e5a7c452c34" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f8bcbc3a412f82f76f493769a9" ON "promotions" ("tenant_id") `);
        await queryRunner.query(`CREATE TABLE "promo_codes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "code" character varying(40) NOT NULL, "promotion_id" uuid NOT NULL, "max_uses" integer, "used_count" integer NOT NULL DEFAULT '0', "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_c7b4f01710fda5afa056a2b4a35" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1e4175ea4d65e29b2876b4a766" ON "promo_codes" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6b5389361f0dcc4d1c63ef6e98" ON "promo_codes" ("tenant_id", "code") `);
        await queryRunner.query(`CREATE TABLE "loyalty_cards" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "number" character varying(20) NOT NULL, "counterparty_id" uuid NOT NULL, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_a6f17521640723e5ca1607904e9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_134909d268acaf551f39be8ce3" ON "loyalty_cards" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_26b18f389f5248ca30a16756d4" ON "loyalty_cards" ("tenant_id", "counterparty_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_92538a55ac05f4613eeec5a5c7" ON "loyalty_cards" ("tenant_id", "number") `);
        await queryRunner.query(`CREATE TABLE "bonus_entries" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "counterparty_id" uuid NOT NULL, "kind" character varying(12) NOT NULL, "amount" numeric(18,2) NOT NULL, "remaining" numeric(18,2) NOT NULL DEFAULT '0', "receipt_id" uuid, "expires_at" TIMESTAMP WITH TIME ZONE, "comment" character varying(300), CONSTRAINT "PK_f54f1d89d20b857e00a9b047ae1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_df7ef19278d9282e07d40d6f7b" ON "bonus_entries" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c5ed397a130f1384b669899cdb" ON "bonus_entries" ("tenant_id", "receipt_id", "kind") WHERE receipt_id IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_9932dd9d0ced5605cd0fe94b7c" ON "bonus_entries" ("tenant_id", "counterparty_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "customer_telegram" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "counterparty_id" uuid NOT NULL, "chat_id" character varying(30) NOT NULL, "price_list_subscribed" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_9e40582723c860b472cee5079b9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_800a224318fa8a3f0b607e2cdd" ON "customer_telegram" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6694b670a450c3e9805d8f8d07" ON "customer_telegram" ("tenant_id", "chat_id") `);
        await queryRunner.query(`ALTER TABLE "receipts" ADD "promo_code" character varying(40)`);
        await queryRunner.query(`ALTER TABLE "receipts" ADD "bonus_amount" numeric(18,2) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "receipts" ADD "promotions" jsonb NOT NULL DEFAULT '[]'`);
        await enableRls(queryRunner, "selection_issues");
        await enableRls(queryRunner, "master_bonus_rules");
        await enableRls(queryRunner, "master_bonuses");
        await enableRls(queryRunner, "personal_prices");
        await enableRls(queryRunner, "tasks");
        await enableRls(queryRunner, "customer_activities");
        await enableRls(queryRunner, "message_templates");
        await enableRls(queryRunner, "oil_reminder_rules");
        await enableRls(queryRunner, "promotions");
        await enableRls(queryRunner, "promo_codes");
        await enableRls(queryRunner, "loyalty_cards");
        await enableRls(queryRunner, "bonus_entries");
        await grantAppRole(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "receipts" DROP COLUMN "promotions"`);
        await queryRunner.query(`ALTER TABLE "receipts" DROP COLUMN "bonus_amount"`);
        await queryRunner.query(`ALTER TABLE "receipts" DROP COLUMN "promo_code"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6694b670a450c3e9805d8f8d07"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_800a224318fa8a3f0b607e2cdd"`);
        await queryRunner.query(`DROP TABLE "customer_telegram"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9932dd9d0ced5605cd0fe94b7c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c5ed397a130f1384b669899cdb"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_df7ef19278d9282e07d40d6f7b"`);
        await queryRunner.query(`DROP TABLE "bonus_entries"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_92538a55ac05f4613eeec5a5c7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_26b18f389f5248ca30a16756d4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_134909d268acaf551f39be8ce3"`);
        await queryRunner.query(`DROP TABLE "loyalty_cards"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6b5389361f0dcc4d1c63ef6e98"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1e4175ea4d65e29b2876b4a766"`);
        await queryRunner.query(`DROP TABLE "promo_codes"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f8bcbc3a412f82f76f493769a9"`);
        await queryRunner.query(`DROP TABLE "promotions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8200df69e10953e93fea2c5fa0"`);
        await queryRunner.query(`DROP TABLE "oil_reminder_rules"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c848cf90f931bc457340927fa6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f54dca32de3d375d837cf18bd3"`);
        await queryRunner.query(`DROP TABLE "message_templates"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_68a03a19d682e55b2300d99b0d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ae1755fc6b0b5a98eedacf1b4a"`);
        await queryRunner.query(`DROP TABLE "customer_activities"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fc8a051f27309978d32d1d09f0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a8a8476ccfa72358e116d5514f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_93edccfc42408754c4b5957105"`);
        await queryRunner.query(`DROP TABLE "tasks"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2f6173bbcdb28f6d5f1eaaec2a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_553d0a6d5cf7bd4e8fb26a8b2a"`);
        await queryRunner.query(`DROP TABLE "personal_prices"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_370da56ecbac085c41adce54ad"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fdef61d58f0c3fde6ce1a751a2"`);
        await queryRunner.query(`DROP TABLE "master_bonuses"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_83b76cd1ee2d17ad1ed2ae85df"`);
        await queryRunner.query(`DROP TABLE "master_bonus_rules"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8582f0e247fc4f4ec1e9f06f2c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c83f484d09e71725e33b5ca29a"`);
        await queryRunner.query(`DROP TABLE "selection_issues"`);
    }

}
