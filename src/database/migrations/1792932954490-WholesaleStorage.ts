import { MigrationInterface, QueryRunner } from "typeorm";
import { grantAppRole } from "../tenant/grants";
import { enableRls } from "../tenant/rls";

export class WholesaleStorage1792932954490 implements MigrationInterface {
    name = 'WholesaleStorage1792932954490'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "containers" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "number" character varying(30) NOT NULL, "supplier_id" uuid NOT NULL, "store_id" uuid NOT NULL, "warehouse_id" uuid NOT NULL, "currency" character varying(3) NOT NULL DEFAULT 'USD', "rate" numeric(18,6), "status" character varying(12) NOT NULL DEFAULT 'draft', "prepayments" jsonb NOT NULL DEFAULT '[]', "costs" jsonb NOT NULL DEFAULT '[]', "distribution" character varying(10) NOT NULL DEFAULT 'amount', "expected_on" date, "receiving_document_ids" jsonb NOT NULL DEFAULT '[]', "history" jsonb NOT NULL DEFAULT '[]', "comment" character varying(500), CONSTRAINT "PK_21cbac3e68f7b1cf53d39cda70c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fad5d80e1e7683eb9e8bcec8df" ON "containers" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_2cee94cc2f781aaf47f8d3b58b" ON "containers" ("tenant_id", "status") `);
        await queryRunner.query(`CREATE TABLE "container_lines" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "container_id" uuid NOT NULL, "line_no" integer NOT NULL, "invoice_code" character varying(100), "invoice_name" character varying(300), "product_id" uuid, "qty" numeric(18,3) NOT NULL, "price" numeric(18,6) NOT NULL, "volume" numeric(12,4), "weight" numeric(12,3), "manual_cost" numeric(18,2), "received_qty" numeric(18,3) NOT NULL DEFAULT '0', "damaged_qty" numeric(18,3) NOT NULL DEFAULT '0', CONSTRAINT "PK_b81da9afee0268da6d254a35953" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c343d506fdc5d86370ebbbbc5a" ON "container_lines" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_2d75cf73f00972a660519fef27" ON "container_lines" ("tenant_id", "container_id") `);
        await queryRunner.query(`CREATE TABLE "invoice_mappings" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "supplier_id" uuid NOT NULL, "key" character varying(300) NOT NULL, "product_id" uuid NOT NULL, CONSTRAINT "PK_ab4341e46dce9e54a3654e54c8a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5ebe3fb85c089a197178a7b1f1" ON "invoice_mappings" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ab4a5d1fd6aacc4d3cb7821826" ON "invoice_mappings" ("tenant_id", "supplier_id", "key") `);
        await queryRunner.query(`CREATE TABLE "sales_orders" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "number" character varying(30) NOT NULL, "store_id" uuid NOT NULL, "counterparty_id" uuid NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'new', "total" numeric(18,2) NOT NULL DEFAULT '0', "prepayment_item_ids" jsonb NOT NULL DEFAULT '[]', "receipt_ids" jsonb NOT NULL DEFAULT '[]', "due_on" date, "address" character varying(300), "driver_id" uuid, "delivery_cost" numeric(18,2), "delivery_status" character varying(12), "history" jsonb NOT NULL DEFAULT '[]', "comment" character varying(500), CONSTRAINT "PK_5328297e067ca929fbe7cf989dd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_77e3868b735c09c41f48951170" ON "sales_orders" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_15970428fc19e5d6273becfad2" ON "sales_orders" ("tenant_id", "status") `);
        await queryRunner.query(`CREATE TABLE "sales_order_lines" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "order_id" uuid NOT NULL, "line_no" integer NOT NULL, "product_id" uuid NOT NULL, "warehouse_id" uuid, "qty" numeric(18,3) NOT NULL, "price" numeric(18,2) NOT NULL, "shipped_qty" numeric(18,3) NOT NULL DEFAULT '0', CONSTRAINT "PK_91a9fd0ffdb8572374cf89df4da" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fe460d031e961e9e3801ed0ed9" ON "sales_order_lines" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_0bacf8bb613a65e456fbf07ca4" ON "sales_order_lines" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_14bd7416719c2c68b3d08f4f5c" ON "sales_order_lines" ("tenant_id", "order_id") `);
        await queryRunner.query(`CREATE TABLE "consignment_reports" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "counterparty_id" uuid NOT NULL, "return_document_id" uuid NOT NULL, "receipt_id" uuid, "amount" numeric(18,2) NOT NULL, CONSTRAINT "PK_fe0a6d8fa394b5dcf7369b9194c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_819d4acbfb03f4abdfd8c7ea25" ON "consignment_reports" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_f02821565e0fc2b8022abffd0f" ON "consignment_reports" ("tenant_id", "counterparty_id") `);
        await queryRunner.query(`CREATE TABLE "donors" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "number" character varying(30) NOT NULL, "store_id" uuid NOT NULL, "warehouse_id" uuid NOT NULL, "title" character varying(200) NOT NULL, "make_id" uuid, "model_id" uuid, "generation_id" uuid, "year" smallint, "vin" character varying(20), "body_code" character varying(30), "engine" character varying(60), "transmission" character varying(60), "purchase_price" numeric(18,2) NOT NULL DEFAULT '0', "delivery_cost" numeric(18,2) NOT NULL DEFAULT '0', "customs_cost" numeric(18,2) NOT NULL DEFAULT '0', "other_cost" numeric(18,2) NOT NULL DEFAULT '0', "expected_total" numeric(18,2) NOT NULL DEFAULT '0', "distributed" numeric(18,2) NOT NULL DEFAULT '0', "document_ids" jsonb NOT NULL DEFAULT '[]', "status" character varying(10) NOT NULL DEFAULT 'open', "counterparty_id" uuid, CONSTRAINT "PK_7fafae759bcc8cc1dfa09c3fbcf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e8f40ef5bb895bb5e5d67c9b01" ON "donors" ("tenant_id") `);
        await queryRunner.query(`CREATE TABLE "storage_locations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "warehouse_id" uuid NOT NULL, "parent_id" uuid, "code" character varying(40) NOT NULL, "name" character varying(100), "kind" character varying(6) NOT NULL, "cell_type" character varying(10) NOT NULL DEFAULT 'storage', "capacity" numeric(12,3), "size_class" character varying(8), "mixed" boolean NOT NULL DEFAULT true, "pick_priority" integer NOT NULL DEFAULT '0', "walk_order" integer NOT NULL DEFAULT '0', "blocked" boolean NOT NULL DEFAULT false, "category_ids" jsonb NOT NULL DEFAULT '[]', "make_ids" jsonb NOT NULL DEFAULT '[]', "barcode" character varying(40), "last_counted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_1f8980d88f9ebaba668dddd27cc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5e784800eb29c8ba8148714569" ON "storage_locations" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b489759c9bcf2b7093ddef0a5c" ON "storage_locations" ("tenant_id", "warehouse_id", "code") `);
        await queryRunner.query(`CREATE TABLE "product_locations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "product_id" uuid NOT NULL, "location_id" uuid NOT NULL, "warehouse_id" uuid NOT NULL, "is_main" boolean NOT NULL DEFAULT false, "min_qty" numeric(12,3), CONSTRAINT "PK_4d067f0bc961f33b2ca6b59935d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1a534989abc8e1d838b9e55d22" ON "product_locations" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5b079fd84a49908f6f526191a9" ON "product_locations" ("tenant_id", "product_id", "location_id") `);
        await queryRunner.query(`CREATE TABLE "cell_stock" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "warehouse_id" uuid NOT NULL, "location_id" uuid NOT NULL, "product_id" uuid NOT NULL, "qty" numeric(18,3) NOT NULL DEFAULT '0', CONSTRAINT "PK_ce89c6b90d9f309671ca2fecf9f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4516731fa31ac569940d8518e2" ON "cell_stock" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_04d1edb57d5f4ab85d69c492c1" ON "cell_stock" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_736fab6a03ec35c5052967ad0c" ON "cell_stock" ("tenant_id", "location_id", "product_id") `);
        await queryRunner.query(`CREATE TABLE "warehouse_tasks" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "number" character varying(30) NOT NULL, "warehouse_id" uuid NOT NULL, "kind" character varying(12) NOT NULL, "status" character varying(12) NOT NULL DEFAULT 'open', "assignee_id" uuid, "lines" jsonb NOT NULL, "source_type" character varying(30), "source_id" uuid, "started_at" TIMESTAMP WITH TIME ZONE, "done_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_e68aa60bd20bd61d9a93f17c9b5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c6e01623cc471d700407c788ce" ON "warehouse_tasks" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5497f1a528282f5ecf850664d7" ON "warehouse_tasks" ("tenant_id", "status") `);
        await enableRls(queryRunner, "containers");
        await enableRls(queryRunner, "container_lines");
        await enableRls(queryRunner, "invoice_mappings");
        await enableRls(queryRunner, "sales_orders");
        await enableRls(queryRunner, "sales_order_lines");
        await enableRls(queryRunner, "consignment_reports");
        await enableRls(queryRunner, "donors");
        await enableRls(queryRunner, "storage_locations");
        await enableRls(queryRunner, "product_locations");
        await enableRls(queryRunner, "cell_stock");
        await enableRls(queryRunner, "warehouse_tasks");
        await grantAppRole(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_5497f1a528282f5ecf850664d7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c6e01623cc471d700407c788ce"`);
        await queryRunner.query(`DROP TABLE "warehouse_tasks"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_736fab6a03ec35c5052967ad0c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_04d1edb57d5f4ab85d69c492c1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4516731fa31ac569940d8518e2"`);
        await queryRunner.query(`DROP TABLE "cell_stock"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5b079fd84a49908f6f526191a9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1a534989abc8e1d838b9e55d22"`);
        await queryRunner.query(`DROP TABLE "product_locations"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b489759c9bcf2b7093ddef0a5c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5e784800eb29c8ba8148714569"`);
        await queryRunner.query(`DROP TABLE "storage_locations"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e8f40ef5bb895bb5e5d67c9b01"`);
        await queryRunner.query(`DROP TABLE "donors"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f02821565e0fc2b8022abffd0f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_819d4acbfb03f4abdfd8c7ea25"`);
        await queryRunner.query(`DROP TABLE "consignment_reports"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_14bd7416719c2c68b3d08f4f5c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0bacf8bb613a65e456fbf07ca4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fe460d031e961e9e3801ed0ed9"`);
        await queryRunner.query(`DROP TABLE "sales_order_lines"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_15970428fc19e5d6273becfad2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_77e3868b735c09c41f48951170"`);
        await queryRunner.query(`DROP TABLE "sales_orders"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ab4a5d1fd6aacc4d3cb7821826"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5ebe3fb85c089a197178a7b1f1"`);
        await queryRunner.query(`DROP TABLE "invoice_mappings"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2d75cf73f00972a660519fef27"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c343d506fdc5d86370ebbbbc5a"`);
        await queryRunner.query(`DROP TABLE "container_lines"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2cee94cc2f781aaf47f8d3b58b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fad5d80e1e7683eb9e8bcec8df"`);
        await queryRunner.query(`DROP TABLE "containers"`);
    }

}
