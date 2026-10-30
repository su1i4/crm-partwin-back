import { MigrationInterface, QueryRunner } from "typeorm";
import { grantAppRole } from "../tenant/grants";
import { enableRls } from "../tenant/rls";

const TENANT_TABLES = [
  "documents", "document_lines", "document_links", "stock_movements", "stock_balances", "product_costs",
  "cost_recalc_queue", "product_places", "serial_items", "stock_snapshots", "period_closes",
  "inventory_sheets", "inventory_counts", "counterparties",
];

export class Stock1792844081051 implements MigrationInterface {
    name = 'Stock1792844081051'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "documents" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "type" character varying(30) NOT NULL, "number" character varying(40) NOT NULL, "doc_date" TIMESTAMP WITH TIME ZONE NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'draft', "deletion_mark" boolean NOT NULL DEFAULT false, "store_id" uuid, "warehouse_id" uuid, "warehouse_to_id" uuid, "counterparty_id" uuid, "currency" character varying(3) NOT NULL DEFAULT 'KGS', "rate" numeric(18,6) NOT NULL DEFAULT '1', "total_amount" numeric(18,2) NOT NULL DEFAULT '0', "total_qty" numeric(18,3) NOT NULL DEFAULT '0', "base_document_id" uuid, "comment" text, "extra" jsonb NOT NULL DEFAULT '{}', "posted_at" TIMESTAMP WITH TIME ZONE, "posted_by" uuid, "has_negative" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_ac51aa5181ee2036f5ca482857c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5109a94ccfd3f39bf4a7a1e1fa" ON "documents" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_4e7d47ebbdb67b76f40ffe2b72" ON "documents" ("tenant_id", "counterparty_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_34b9daae2772b7975cbb21fc16" ON "documents" ("tenant_id", "store_id", "doc_date") `);
        await queryRunner.query(`CREATE INDEX "IDX_94c5cf72ca9b662ca98f55363c" ON "documents" ("tenant_id", "status", "doc_date") `);
        await queryRunner.query(`CREATE INDEX "IDX_73b85f4d78e15805e9e0fcd2d2" ON "documents" ("tenant_id", "type", "doc_date") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_documents_number" ON "documents" ("tenant_id", "number") `);
        await queryRunner.query(`CREATE TABLE "document_lines" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "document_id" uuid NOT NULL, "line_no" integer NOT NULL, "product_id" uuid NOT NULL, "unit_id" uuid NOT NULL, "factor" numeric(18,3) NOT NULL, "qty" numeric(18,3) NOT NULL, "base_qty" numeric(18,3) NOT NULL, "price" numeric(18,6), "amount" numeric(18,2), "unit_cost" numeric(18,6), "cost_amount" numeric(20,6), "product_to_id" uuid, "unit_to_id" uuid, "serial_item_ids" uuid array NOT NULL DEFAULT '{}', "place" character varying(50), "extra" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_3f9692db21994098cef719fb534" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_32503810d5f8d95441ee7d9eee" ON "document_lines" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8d2ab80db002ab9e5844696dca" ON "document_lines" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_aac9713bc40152a11308e791da" ON "document_lines" ("tenant_id", "document_id", "line_no") `);
        await queryRunner.query(`CREATE TABLE "document_links" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "from_id" uuid NOT NULL, "to_id" uuid NOT NULL, "kind" character varying(30) NOT NULL, CONSTRAINT "PK_462367301c7f0a30fc3fbaa4ea9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b4f1ecd3beb64ddb9b4437cb30" ON "document_links" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e224c2be284ca00c114a7258b0" ON "document_links" ("tenant_id", "to_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_document_links" ON "document_links" ("tenant_id", "from_id", "to_id") `);
        await queryRunner.query(`CREATE TABLE "stock_movements" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "document_id" uuid NOT NULL, "line_id" uuid NOT NULL, "warehouse_id" uuid NOT NULL, "product_id" uuid NOT NULL, "unit_id" uuid NOT NULL, "serial_item_id" uuid, "location_id" uuid, "kind" character varying(15) NOT NULL, "qty" numeric(18,3) NOT NULL, "cost_amount" numeric(20,6) NOT NULL, "pair_of_id" uuid, "moved_at" TIMESTAMP WITH TIME ZONE NOT NULL, "seq" BIGSERIAL NOT NULL, CONSTRAINT "PK_57a26b190618550d8e65fb860e7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_30dd9acc22dcb6ae51d7d34f16" ON "stock_movements" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_c26bfb3558a029009ff994462a" ON "stock_movements" ("tenant_id", "pair_of_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_09e774e74bae3fc0f49172f975" ON "stock_movements" ("tenant_id", "warehouse_id", "moved_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_58934c118be0d7e3caacbfb040" ON "stock_movements" ("tenant_id", "document_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ce0e4fb704ba327b57c93052a4" ON "stock_movements" ("tenant_id", "product_id", "moved_at", "seq") `);
        await queryRunner.query(`CREATE INDEX "IDX_6fbe38eaea56584af64b1817ee" ON "stock_movements" ("tenant_id", "product_id", "warehouse_id", "moved_at") `);
        await queryRunner.query(`CREATE TABLE "stock_balances" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "warehouse_id" uuid NOT NULL, "product_id" uuid NOT NULL, "location_id" uuid, "qty" numeric(18,3) NOT NULL DEFAULT '0', "cost_amount" numeric(20,6) NOT NULL DEFAULT '0', CONSTRAINT "PK_4c0d249ce58f9a559eb7df31b23" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a79262fc08bedb2c6485e6fc0e" ON "stock_balances" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_a1b479c1a07e4d6f8937849af0" ON "stock_balances" ("tenant_id", "warehouse_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_fa2764cfc18c2109190058032d" ON "stock_balances" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE TABLE "product_costs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "product_id" uuid NOT NULL, "qty" numeric(18,3) NOT NULL DEFAULT '0', "cost_amount" numeric(20,6) NOT NULL DEFAULT '0', "last_unit_cost" numeric(18,6) NOT NULL DEFAULT '0', CONSTRAINT "PK_95e8435aca3582e927b2cd9d54c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_66ad317eb43ab003b0a2832d9d" ON "product_costs" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_product_costs" ON "product_costs" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE TABLE "cost_recalc_queue" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "product_id" uuid NOT NULL, "from_date" TIMESTAMP WITH TIME ZONE NOT NULL, "attempts" integer NOT NULL DEFAULT '0', "last_error" text, CONSTRAINT "PK_7fe390d3cbc4326d448f1f1bf54" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_dd6f30996336c9e860d095e6e3" ON "cost_recalc_queue" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_cost_recalc_queue" ON "cost_recalc_queue" ("tenant_id", "product_id") `);
        await queryRunner.query(`CREATE TABLE "product_places" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "warehouse_id" uuid NOT NULL, "product_id" uuid NOT NULL, "place" character varying(50) NOT NULL, CONSTRAINT "PK_8f174e96b196f244a8bd839d1a8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b5a39f2ae5b79554aa9f9ef261" ON "product_places" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_a88e0b0925c1a0eedae3ff025d" ON "product_places" ("tenant_id", "warehouse_id", "place") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_product_places" ON "product_places" ("tenant_id", "warehouse_id", "product_id") `);
        await queryRunner.query(`CREATE TABLE "serial_items" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "product_id" uuid NOT NULL, "serial_number" character varying(80) NOT NULL, "inventory_number" character varying(80), "condition" character varying(100), "note" text, "photo_file_ids" uuid array NOT NULL DEFAULT '{}', "price" numeric(18,2), "warehouse_id" uuid, "place" character varying(50), "status" character varying(15) NOT NULL DEFAULT 'in_stock', "source_document_id" uuid, "donor_id" uuid, CONSTRAINT "PK_f399a88b1e29fa2d411fc8ad7b6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cdeaa97c8300c42ed8ae1decdb" ON "serial_items" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_serial_items_number" ON "serial_items" ("tenant_id", "product_id", "serial_number") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_cffa97fed491d67ddc65e4ef2e" ON "serial_items" ("tenant_id", "product_id", "status") `);
        await queryRunner.query(`CREATE TABLE "stock_snapshots" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "period_end" TIMESTAMP WITH TIME ZONE NOT NULL, "warehouse_id" uuid NOT NULL, "product_id" uuid NOT NULL, "qty" numeric(18,3) NOT NULL, "cost_amount" numeric(20,6) NOT NULL, CONSTRAINT "PK_b5f2a97eae382bcdfe7d8ffb808" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9307590bae83575a66ba9a47df" ON "stock_snapshots" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_stock_snapshots" ON "stock_snapshots" ("tenant_id", "period_end", "warehouse_id", "product_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ff450eefb1f13b58514d19f51f" ON "stock_snapshots" ("tenant_id", "period_end", "product_id") `);
        await queryRunner.query(`CREATE TABLE "period_closes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "month" date NOT NULL, "period_end" TIMESTAMP WITH TIME ZONE NOT NULL, "status" character varying(10) NOT NULL DEFAULT 'closed', "closed_at" TIMESTAMP WITH TIME ZONE NOT NULL, "closed_by" uuid, "reopened_at" TIMESTAMP WITH TIME ZONE, "reopened_by" uuid, "reopen_reason" character varying(500), CONSTRAINT "PK_0ee380fade0edb35280c00f1569" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_27e872bcb6bd96dfcc35ae9c1e" ON "period_closes" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_period_closes_month" ON "period_closes" ("tenant_id", "month") `);
        await queryRunner.query(`CREATE TABLE "inventory_sheets" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "document_id" uuid NOT NULL, "name" character varying(100) NOT NULL, "assigned_to" uuid, "status" character varying(10) NOT NULL DEFAULT 'open', CONSTRAINT "PK_a67f0b90ac84dbeba37c2f0a8a7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_90566091c19fc971120b0ee31a" ON "inventory_sheets" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_76393ac72563ebd36466bfbf24" ON "inventory_sheets" ("tenant_id", "document_id") `);
        await queryRunner.query(`CREATE TABLE "inventory_counts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "document_id" uuid NOT NULL, "sheet_id" uuid NOT NULL, "product_id" uuid NOT NULL, "serial_item_id" uuid, "qty" numeric(18,3) NOT NULL, "scanned_at" TIMESTAMP WITH TIME ZONE NOT NULL, "place" character varying(50), CONSTRAINT "PK_8230343330002d07a2efb485680" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c7aa63f822a12e66ee7d8adc56" ON "inventory_counts" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_feec26e1c6f21fc8c0674e82b6" ON "inventory_counts" ("tenant_id", "document_id", "product_id") `);
        await queryRunner.query(`CREATE TABLE "counterparties" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "name" character varying(200) NOT NULL, "kind" character varying(10) NOT NULL DEFAULT 'person', "phone" character varying(20), "phones" text array NOT NULL DEFAULT '{}', "inn" character varying(20), "address" character varying(300), "roles" text array NOT NULL DEFAULT '{}', "messengers" jsonb NOT NULL DEFAULT '{}', "supplier_terms" jsonb NOT NULL DEFAULT '{}', "note" text, "tags" text array NOT NULL DEFAULT '{}', CONSTRAINT "PK_9f045dc184ca2426af5e9dfb13b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3322affcdf9cf4019d6761d9f4" ON "counterparties" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_a057984260edc8c25f072d9f97" ON "counterparties" ("tenant_id", "phone") `);
        await queryRunner.query(`ALTER TABLE "document_lines" ADD CONSTRAINT "FK_a691976233f2c8a7ac097686761" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_70fd9157df440ab606f50ea84de" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_e7831147f5a8ee3c42e6eaeee2e" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_2c1bb05b80ddcc562cd28d826c6" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_balances" ADD CONSTRAINT "FK_ec718dfbbf08afb84b0f665fc0d" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_balances" ADD CONSTRAINT "FK_b940a160f793ee34c4a057b7c9e" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);

        await queryRunner.query(
            `CREATE UNIQUE INDEX "uq_stock_balances" ON "stock_balances" ("tenant_id", "warehouse_id", "product_id", COALESCE("location_id", '00000000-0000-0000-0000-000000000000'::uuid))`,
        );
        await queryRunner.query(`CREATE INDEX "ix_counterparties_roles" ON "counterparties" USING gin ("roles")`);
        for (const t of TENANT_TABLES) await enableRls(queryRunner, t);
        await grantAppRole(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stock_balances" DROP CONSTRAINT "FK_b940a160f793ee34c4a057b7c9e"`);
        await queryRunner.query(`ALTER TABLE "stock_balances" DROP CONSTRAINT "FK_ec718dfbbf08afb84b0f665fc0d"`);
        await queryRunner.query(`ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_2c1bb05b80ddcc562cd28d826c6"`);
        await queryRunner.query(`ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_e7831147f5a8ee3c42e6eaeee2e"`);
        await queryRunner.query(`ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_70fd9157df440ab606f50ea84de"`);
        await queryRunner.query(`ALTER TABLE "document_lines" DROP CONSTRAINT "FK_a691976233f2c8a7ac097686761"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a057984260edc8c25f072d9f97"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3322affcdf9cf4019d6761d9f4"`);
        await queryRunner.query(`DROP TABLE "counterparties"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_feec26e1c6f21fc8c0674e82b6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c7aa63f822a12e66ee7d8adc56"`);
        await queryRunner.query(`DROP TABLE "inventory_counts"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_76393ac72563ebd36466bfbf24"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_90566091c19fc971120b0ee31a"`);
        await queryRunner.query(`DROP TABLE "inventory_sheets"`);
        await queryRunner.query(`DROP INDEX "public"."uq_period_closes_month"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_27e872bcb6bd96dfcc35ae9c1e"`);
        await queryRunner.query(`DROP TABLE "period_closes"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ff450eefb1f13b58514d19f51f"`);
        await queryRunner.query(`DROP INDEX "public"."uq_stock_snapshots"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9307590bae83575a66ba9a47df"`);
        await queryRunner.query(`DROP TABLE "stock_snapshots"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cffa97fed491d67ddc65e4ef2e"`);
        await queryRunner.query(`DROP INDEX "public"."uq_serial_items_number"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cdeaa97c8300c42ed8ae1decdb"`);
        await queryRunner.query(`DROP TABLE "serial_items"`);
        await queryRunner.query(`DROP INDEX "public"."uq_product_places"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a88e0b0925c1a0eedae3ff025d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b5a39f2ae5b79554aa9f9ef261"`);
        await queryRunner.query(`DROP TABLE "product_places"`);
        await queryRunner.query(`DROP INDEX "public"."uq_cost_recalc_queue"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dd6f30996336c9e860d095e6e3"`);
        await queryRunner.query(`DROP TABLE "cost_recalc_queue"`);
        await queryRunner.query(`DROP INDEX "public"."uq_product_costs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_66ad317eb43ab003b0a2832d9d"`);
        await queryRunner.query(`DROP TABLE "product_costs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fa2764cfc18c2109190058032d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a1b479c1a07e4d6f8937849af0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a79262fc08bedb2c6485e6fc0e"`);
        await queryRunner.query(`DROP TABLE "stock_balances"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6fbe38eaea56584af64b1817ee"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ce0e4fb704ba327b57c93052a4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_58934c118be0d7e3caacbfb040"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_09e774e74bae3fc0f49172f975"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c26bfb3558a029009ff994462a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_30dd9acc22dcb6ae51d7d34f16"`);
        await queryRunner.query(`DROP TABLE "stock_movements"`);
        await queryRunner.query(`DROP INDEX "public"."uq_document_links"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e224c2be284ca00c114a7258b0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b4f1ecd3beb64ddb9b4437cb30"`);
        await queryRunner.query(`DROP TABLE "document_links"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_aac9713bc40152a11308e791da"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8d2ab80db002ab9e5844696dca"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_32503810d5f8d95441ee7d9eee"`);
        await queryRunner.query(`DROP TABLE "document_lines"`);
        await queryRunner.query(`DROP INDEX "public"."uq_documents_number"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_73b85f4d78e15805e9e0fcd2d2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_94c5cf72ca9b662ca98f55363c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_34b9daae2772b7975cbb21fc16"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4e7d47ebbdb67b76f40ffe2b72"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5109a94ccfd3f39bf4a7a1e1fa"`);
        await queryRunner.query(`DROP TABLE "documents"`);
    }

}
