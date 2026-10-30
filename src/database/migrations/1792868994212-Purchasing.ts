import { MigrationInterface, QueryRunner } from "typeorm";
import { grantAppRole } from "../tenant/grants";
import { enableRls } from "../tenant/rls";

const TENANT_TABLES = [
  "supplier_products", "stock_rules", "price_lists", "price_list_rows", "price_list_loads", "price_list_price_history",
  "purchase_orders", "purchase_order_lines", "customer_requests", "customer_request_items", "waitlist_entries",
];

export class Purchasing1792868994212 implements MigrationInterface {
    name = 'Purchasing1792868994212'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "supplier_products" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "supplier_id" uuid NOT NULL, "product_id" uuid NOT NULL, "supplier_code" character varying(80), "multiplicity" numeric(18,3) NOT NULL DEFAULT '1', "min_qty" numeric(18,3) NOT NULL DEFAULT '0', "lead_days" integer, "last_price" numeric(18,6), "last_currency" character varying(3), "last_purchase_at" TIMESTAMP WITH TIME ZONE, "preferred" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_651e91706e362ef7393457c347e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_29c4fa01a57e796d8ce99846bb" ON "supplier_products" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_7d9a0fcabccb41bc1a0358e806" ON "supplier_products" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_supplier_products" ON "supplier_products" ("tenant_id", "supplier_id", "product_id") `);
        await queryRunner.query(`CREATE TABLE "stock_rules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "product_id" uuid NOT NULL, "store_id" uuid, "store_key" character varying(36) NOT NULL DEFAULT '', "min_qty" numeric(18,3), "max_qty" numeric(18,3), "summer_min" numeric(18,3), "summer_max" numeric(18,3), "winter_min" numeric(18,3), "winter_max" numeric(18,3), "supplier_id" uuid, CONSTRAINT "PK_349dc04133903c3c4fff3b2aaad" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_673af81f2656a7a361434b2cac" ON "stock_rules" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_stock_rules" ON "stock_rules" ("tenant_id", "product_id", "store_key") `);
        await queryRunner.query(`CREATE TABLE "price_lists" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "supplier_id" uuid NOT NULL, "name" character varying(200) NOT NULL, "currency" character varying(3) NOT NULL DEFAULT 'KGS', "url" character varying(1000), "schedule" character varying(10), "mapping" jsonb NOT NULL DEFAULT '{}', "header_row" integer NOT NULL DEFAULT '1', "default_lead_days" integer, "status" character varying(12) NOT NULL DEFAULT 'empty', "rows_count" integer NOT NULL DEFAULT '0', "loaded_at" TIMESTAMP WITH TIME ZONE, "last_error" text, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_fd66ee20b065696da25c97fa45a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_35de7c0f11722fb48e2b09a466" ON "price_lists" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8332097b28d43044d9dec3ec79" ON "price_lists" ("tenant_id", "supplier_id") `);
        await queryRunner.query(`CREATE TABLE "price_list_rows" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "price_list_id" uuid NOT NULL, "supplier_id" uuid NOT NULL, "brand_id" uuid, "brand_text" character varying(100), "brand_key" character varying(100) NOT NULL DEFAULT '', "number" character varying(80) NOT NULL, "normalized" character varying(80) NOT NULL, "name" character varying(300), "price" numeric(18,6), "currency" character varying(3) NOT NULL DEFAULT 'KGS', "stock_text" character varying(30), "stock_qty" numeric(18,3), "lead_days" integer, "multiplicity" numeric(18,3), "oem" character varying(500), "applicability" character varying(1000), "product_id" uuid, "load_id" uuid, CONSTRAINT "PK_74628fedaa5426590f6d41d7691" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1b6f0bca4c1c301eda85f7656a" ON "price_list_rows" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5a8c49f127dfe5a43299354aba" ON "price_list_rows" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8bd53dea97aba800ef46c57318" ON "price_list_rows" ("tenant_id", "normalized") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_price_list_rows" ON "price_list_rows" ("tenant_id", "price_list_id", "normalized", "brand_key") `);
        await queryRunner.query(`CREATE TABLE "price_list_loads" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "price_list_id" uuid NOT NULL, "file_id" uuid, "source" character varying(10) NOT NULL, "status" character varying(12) NOT NULL DEFAULT 'queued', "rows" integer NOT NULL DEFAULT '0', "added" integer NOT NULL DEFAULT '0', "updated" integer NOT NULL DEFAULT '0', "removed" integer NOT NULL DEFAULT '0', "price_changes" integer NOT NULL DEFAULT '0', "skipped" integer NOT NULL DEFAULT '0', "crosses_added" integer NOT NULL DEFAULT '0', "error" text, "started_at" TIMESTAMP WITH TIME ZONE, "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_fba89ddef28866dac5772a22ecb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_32eb2fe558de2ac7d772fdc326" ON "price_list_loads" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_b9f203299c4a49305b0e353397" ON "price_list_loads" ("tenant_id", "price_list_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "price_list_price_history" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "price_list_id" uuid NOT NULL, "normalized" character varying(80) NOT NULL, "brand_key" character varying(100) NOT NULL DEFAULT '', "old_price" numeric(18,6), "new_price" numeric(18,6), "currency" character varying(3) NOT NULL, "load_id" uuid, CONSTRAINT "PK_abac1c8615954a362a11cf832c9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2e1de18af4b64059deda733ad4" ON "price_list_price_history" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_823d6374fb48fecf668d227cf9" ON "price_list_price_history" ("tenant_id", "price_list_id", "normalized") `);
        await queryRunner.query(`CREATE TABLE "purchase_orders" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "number" character varying(40) NOT NULL, "supplier_id" uuid NOT NULL, "store_id" uuid NOT NULL, "warehouse_id" uuid, "status" character varying(20) NOT NULL DEFAULT 'draft', "source" character varying(10) NOT NULL DEFAULT 'manual', "currency" character varying(3) NOT NULL DEFAULT 'KGS', "total_amount" numeric(18,2) NOT NULL DEFAULT '0', "expected_at" date, "sent_at" TIMESTAMP WITH TIME ZONE, "confirmed_at" TIMESTAMP WITH TIME ZONE, "closed_at" TIMESTAMP WITH TIME ZONE, "comment" text, "history" jsonb NOT NULL DEFAULT '[]', CONSTRAINT "PK_05148947415204a897e8beb2553" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_237678c98436e0abb48b3060c8" ON "purchase_orders" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e37571aa69038c0e81eab1facf" ON "purchase_orders" ("tenant_id", "status", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_09c2c47baac280f3b778a50ae4" ON "purchase_orders" ("tenant_id", "supplier_id", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_purchase_orders_number" ON "purchase_orders" ("tenant_id", "number") `);
        await queryRunner.query(`CREATE TABLE "purchase_order_lines" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "order_id" uuid NOT NULL, "line_no" integer NOT NULL, "product_id" uuid NOT NULL, "unit_id" uuid NOT NULL, "factor" numeric(18,3) NOT NULL, "qty" numeric(18,3) NOT NULL, "price" numeric(18,6), "received_qty" numeric(18,3) NOT NULL DEFAULT '0', "request_item_id" uuid, "note" character varying(500), "extra" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_34a2082d2abb10c5d8713bc19b8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c07c8a298555beb9a5064d53da" ON "purchase_order_lines" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_262d62ee63bb822f08d35bad41" ON "purchase_order_lines" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_2ef4389ee86bf20e3e1108db26" ON "purchase_order_lines" ("tenant_id", "order_id") `);
        await queryRunner.query(`CREATE TABLE "customer_requests" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "number" character varying(40) NOT NULL, "store_id" uuid NOT NULL, "kind" character varying(10) NOT NULL DEFAULT 'order', "status" character varying(12) NOT NULL DEFAULT 'new', "customer_id" uuid, "customer_name" character varying(200), "customer_phone" character varying(20), "customer_vehicle_id" uuid, "vehicle_text" character varying(200), "assignee_id" uuid, "due_at" TIMESTAMP WITH TIME ZONE, "prepaid" numeric(18,2) NOT NULL DEFAULT '0', "prepayment_item_ids" uuid array NOT NULL DEFAULT '{}', "receipt_id" uuid, "refuse_reason" character varying(500), "comment" text, "closed_at" TIMESTAMP WITH TIME ZONE, "overdue_notified_at" TIMESTAMP WITH TIME ZONE, "history" jsonb NOT NULL DEFAULT '[]', CONSTRAINT "PK_45ef185f553e792da9b83fa2464" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a1731c49008ab4dc1eb26cf5c3" ON "customer_requests" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8f136ca31863c4c877139d2d69" ON "customer_requests" ("tenant_id", "customer_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ee6bb67072d40aa5fb260d5496" ON "customer_requests" ("tenant_id", "store_id", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_customer_requests_number" ON "customer_requests" ("tenant_id", "number") `);
        await queryRunner.query(`CREATE TABLE "customer_request_items" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "request_id" uuid NOT NULL, "line_no" integer NOT NULL, "number" character varying(80), "name" character varying(300) NOT NULL, "qty" numeric(18,3) NOT NULL DEFAULT '1', "photo_file_ids" uuid array NOT NULL DEFAULT '{}', "product_id" uuid, "sale_price" numeric(18,2), "source_id" uuid, "source_kind" character varying(10), "purchase_price" numeric(18,6), "purchase_order_line_id" uuid, "arrived_at" TIMESTAMP WITH TIME ZONE, "offers" jsonb NOT NULL DEFAULT '[]', CONSTRAINT "PK_1c1f09ac84745ae293b7444032a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a9ed8fa0ef18d575e4657c1295" ON "customer_request_items" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_03079991634020ae099ee7c2a0" ON "customer_request_items" ("tenant_id", "request_id") `);
        await queryRunner.query(`CREATE TABLE "waitlist_entries" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "store_id" uuid NOT NULL, "product_id" uuid, "query" character varying(300), "normalized" character varying(80), "customer_id" uuid, "customer_name" character varying(200), "customer_phone" character varying(20), "qty" numeric(18,3) NOT NULL DEFAULT '1', "status" character varying(12) NOT NULL DEFAULT 'waiting', "notified_at" TIMESTAMP WITH TIME ZONE, "note" character varying(500), CONSTRAINT "PK_bd0ef66fff81d3be7b7a1568a4d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_073a7abc7767eea666373644dd" ON "waitlist_entries" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_05a556884509eb0013ad8b47a0" ON "waitlist_entries" ("tenant_id", "store_id", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_cf1c38c009039a85f80e818e92" ON "waitlist_entries" ("tenant_id", "product_id", "status") `);
        await queryRunner.query(`ALTER TABLE "receipt_payments" ADD "advance_item_ids" uuid array NOT NULL DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "price_list_rows" ADD CONSTRAINT "FK_1c543f97544eea386527077aceb" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "FK_6d450e4816970bce04843945015" FOREIGN KEY ("order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "customer_request_items" ADD CONSTRAINT "FK_1c655a69c5f7a483090d860491b" FOREIGN KEY ("request_id") REFERENCES "customer_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        for (const t of TENANT_TABLES) await enableRls(queryRunner, t);
        await grantAppRole(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "customer_request_items" DROP CONSTRAINT "FK_1c655a69c5f7a483090d860491b"`);
        await queryRunner.query(`ALTER TABLE "purchase_order_lines" DROP CONSTRAINT "FK_6d450e4816970bce04843945015"`);
        await queryRunner.query(`ALTER TABLE "price_list_rows" DROP CONSTRAINT "FK_1c543f97544eea386527077aceb"`);
        await queryRunner.query(`ALTER TABLE "receipt_payments" DROP COLUMN "advance_item_ids"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cf1c38c009039a85f80e818e92"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_05a556884509eb0013ad8b47a0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_073a7abc7767eea666373644dd"`);
        await queryRunner.query(`DROP TABLE "waitlist_entries"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_03079991634020ae099ee7c2a0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a9ed8fa0ef18d575e4657c1295"`);
        await queryRunner.query(`DROP TABLE "customer_request_items"`);
        await queryRunner.query(`DROP INDEX "public"."uq_customer_requests_number"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ee6bb67072d40aa5fb260d5496"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8f136ca31863c4c877139d2d69"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a1731c49008ab4dc1eb26cf5c3"`);
        await queryRunner.query(`DROP TABLE "customer_requests"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2ef4389ee86bf20e3e1108db26"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_262d62ee63bb822f08d35bad41"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c07c8a298555beb9a5064d53da"`);
        await queryRunner.query(`DROP TABLE "purchase_order_lines"`);
        await queryRunner.query(`DROP INDEX "public"."uq_purchase_orders_number"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_09c2c47baac280f3b778a50ae4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e37571aa69038c0e81eab1facf"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_237678c98436e0abb48b3060c8"`);
        await queryRunner.query(`DROP TABLE "purchase_orders"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_823d6374fb48fecf668d227cf9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2e1de18af4b64059deda733ad4"`);
        await queryRunner.query(`DROP TABLE "price_list_price_history"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b9f203299c4a49305b0e353397"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_32eb2fe558de2ac7d772fdc326"`);
        await queryRunner.query(`DROP TABLE "price_list_loads"`);
        await queryRunner.query(`DROP INDEX "public"."uq_price_list_rows"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8bd53dea97aba800ef46c57318"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5a8c49f127dfe5a43299354aba"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1b6f0bca4c1c301eda85f7656a"`);
        await queryRunner.query(`DROP TABLE "price_list_rows"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8332097b28d43044d9dec3ec79"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_35de7c0f11722fb48e2b09a466"`);
        await queryRunner.query(`DROP TABLE "price_lists"`);
        await queryRunner.query(`DROP INDEX "public"."uq_stock_rules"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_673af81f2656a7a361434b2cac"`);
        await queryRunner.query(`DROP TABLE "stock_rules"`);
        await queryRunner.query(`DROP INDEX "public"."uq_supplier_products"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7d9a0fcabccb41bc1a0358e806"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_29c4fa01a57e796d8ce99846bb"`);
        await queryRunner.query(`DROP TABLE "supplier_products"`);
    }

}
