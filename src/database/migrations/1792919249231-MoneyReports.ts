import { MigrationInterface, QueryRunner } from "typeorm";
import { grantAppRole } from "../tenant/grants";
import { enableRls } from "../tenant/rls";

export class MoneyReports1792919249231 implements MigrationInterface {
    name = 'MoneyReports1792919249231'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "telegram_codes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" uuid NOT NULL, "purpose" character varying(15) NOT NULL, "code_hash" character varying(64) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "attempts" smallint NOT NULL DEFAULT '0', "data" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_78cd73f97632bbc8ab6cf0687d2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4d4a37dbdce07835dfd7184d59" ON "telegram_codes" ("code_hash") `);
        await queryRunner.query(`CREATE TABLE "rpt_sales_daily" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "day" date NOT NULL, "store_id" uuid, "seller_id" uuid, "customer_id" uuid, "product_id" uuid NOT NULL, "qty" numeric(18,3) NOT NULL DEFAULT '0', "revenue" numeric(18,2) NOT NULL DEFAULT '0', "cost" numeric(18,6) NOT NULL DEFAULT '0', "discount" numeric(18,2) NOT NULL DEFAULT '0', "returned_qty" numeric(18,3) NOT NULL DEFAULT '0', "returned_amount" numeric(18,2) NOT NULL DEFAULT '0', CONSTRAINT "PK_360a09d2d6f5335525ebec499da" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3ead28956fcfb008ea75d85e10" ON "rpt_sales_daily" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_030fb8795fc413dda928923dba" ON "rpt_sales_daily" ("tenant_id", "product_id", "day") `);
        await queryRunner.query(`CREATE INDEX "IDX_703f0a7114d03e44dfaf52c5d9" ON "rpt_sales_daily" ("tenant_id", "day", "store_id") `);
        await queryRunner.query(`CREATE TABLE "report_views" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "user_id" uuid NOT NULL, "report" character varying(60) NOT NULL, "name" character varying(100) NOT NULL, "params" jsonb NOT NULL DEFAULT '{}', "shared" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_ac4164dca5a8b09f4b6f6903b34" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c0383fbc16123b1052944a654f" ON "report_views" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5dc82cbff43953e0e18b6e53b6" ON "report_views" ("tenant_id", "user_id") `);
        await queryRunner.query(`CREATE TABLE "owner_summaries" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "day" date NOT NULL, "data" jsonb NOT NULL, "sent_to" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_194f6629a1ba2735b7b0ee22b92" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b003dc7234ab83be64057c2493" ON "owner_summaries" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_988f6e68d17d76eb3fa9ad2615" ON "owner_summaries" ("tenant_id", "day") `);
        await queryRunner.query(`CREATE TABLE "expense_articles" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "code" character varying(40) NOT NULL, "name" character varying(100) NOT NULL, "kind" character varying(10) NOT NULL DEFAULT 'expense', "is_system" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_219ab1fba0c2a37b6246f5145e7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_61a874494abde830a65a89123a" ON "expense_articles" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_72c06ad071808af24ca3adc84f" ON "expense_articles" ("tenant_id", "code") `);
        await queryRunner.query(`CREATE TABLE "expenses" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "article_id" uuid NOT NULL, "account_id" uuid NOT NULL, "store_id" uuid, "currency" character varying(3) NOT NULL, "amount" numeric(18,2) NOT NULL, "amount_kgs" numeric(18,2) NOT NULL, "expense_date" date NOT NULL, "counterparty_id" uuid, "membership_id" uuid, "recurring_id" uuid, "comment" character varying(500), "status" character varying(10) NOT NULL DEFAULT 'posted', "cancelled_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_94c3ceb17e3140abc9282c20610" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e86e6bebe054a040132d2aeb5b" ON "expenses" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_2ba8f6cfe0b7273b7b02c4eb32" ON "expenses" ("tenant_id", "expense_date") `);
        await queryRunner.query(`CREATE TABLE "recurring_expenses" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "article_id" uuid NOT NULL, "account_id" uuid NOT NULL, "store_id" uuid, "amount" numeric(18,2) NOT NULL, "counterparty_id" uuid, "day_of_month" smallint NOT NULL, "next_date" date NOT NULL, "comment" character varying(300), "is_active" boolean NOT NULL DEFAULT true, "last_run_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_592b47923f3bdb6035439182e66" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a252e7932fad09d5bcddd1548e" ON "recurring_expenses" ("tenant_id") `);
        await queryRunner.query(`CREATE TABLE "fx_revaluations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "month" character varying(7) NOT NULL, "debt_item_id" uuid NOT NULL, "counterparty_id" uuid NOT NULL, "direction" character varying(10) NOT NULL, "currency" character varying(3) NOT NULL, "remaining" numeric(18,2) NOT NULL, "rate_from" numeric(18,6) NOT NULL, "rate_to" numeric(18,6) NOT NULL, "diff_kgs" numeric(18,2) NOT NULL, CONSTRAINT "PK_924c209bd1f8cd784605aa205c5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2d32bc70a0875ec6b725e7d520" ON "fx_revaluations" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_cb31668f1ce4ed18e15d77ee39" ON "fx_revaluations" ("tenant_id", "month") `);
        await queryRunner.query(`CREATE TABLE "salary_rules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "membership_id" uuid NOT NULL, "base_monthly" numeric(18,2) NOT NULL DEFAULT '0', "percent" numeric(6,3) NOT NULL DEFAULT '0', "basis" character varying(10) NOT NULL DEFAULT 'sales', "plan_monthly" numeric(18,2), CONSTRAINT "PK_d74fef3f2a320a5342d2fec2302" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_70af9e21ecff2fabf0afcce99d" ON "salary_rules" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_69bd6eb994df5c351ce572bc8a" ON "salary_rules" ("tenant_id", "membership_id") `);
        await queryRunner.query(`CREATE TABLE "nbkr_rates" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "rate_date" date NOT NULL, "currency" character varying(3) NOT NULL, "rate" numeric(18,6) NOT NULL, CONSTRAINT "PK_49087c16dfdd39ec8ab2973010b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c7378287ce53ed3457399adede" ON "nbkr_rates" ("rate_date", "currency") `);
        await enableRls(queryRunner, "expense_articles");
        await enableRls(queryRunner, "expenses");
        await enableRls(queryRunner, "recurring_expenses");
        await enableRls(queryRunner, "fx_revaluations");
        await enableRls(queryRunner, "salary_rules");
        await enableRls(queryRunner, "rpt_sales_daily");
        await enableRls(queryRunner, "report_views");
        await enableRls(queryRunner, "owner_summaries");
        await grantAppRole(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_c7378287ce53ed3457399adede"`);
        await queryRunner.query(`DROP TABLE "nbkr_rates"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_69bd6eb994df5c351ce572bc8a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_70af9e21ecff2fabf0afcce99d"`);
        await queryRunner.query(`DROP TABLE "salary_rules"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cb31668f1ce4ed18e15d77ee39"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2d32bc70a0875ec6b725e7d520"`);
        await queryRunner.query(`DROP TABLE "fx_revaluations"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a252e7932fad09d5bcddd1548e"`);
        await queryRunner.query(`DROP TABLE "recurring_expenses"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2ba8f6cfe0b7273b7b02c4eb32"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e86e6bebe054a040132d2aeb5b"`);
        await queryRunner.query(`DROP TABLE "expenses"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_72c06ad071808af24ca3adc84f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_61a874494abde830a65a89123a"`);
        await queryRunner.query(`DROP TABLE "expense_articles"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_988f6e68d17d76eb3fa9ad2615"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b003dc7234ab83be64057c2493"`);
        await queryRunner.query(`DROP TABLE "owner_summaries"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5dc82cbff43953e0e18b6e53b6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c0383fbc16123b1052944a654f"`);
        await queryRunner.query(`DROP TABLE "report_views"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_703f0a7114d03e44dfaf52c5d9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_030fb8795fc413dda928923dba"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3ead28956fcfb008ea75d85e10"`);
        await queryRunner.query(`DROP TABLE "rpt_sales_daily"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4d4a37dbdce07835dfd7184d59"`);
        await queryRunner.query(`DROP TABLE "telegram_codes"`);
    }

}
