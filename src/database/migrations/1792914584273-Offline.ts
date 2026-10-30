import { MigrationInterface, QueryRunner } from "typeorm";
import { grantAppRole } from "../tenant/grants";
import { enableRls } from "../tenant/rls";

export class Offline1792914584273 implements MigrationInterface {
    name = 'Offline1792914584273'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "offline_ops" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "device_id" uuid NOT NULL, "op_id" uuid NOT NULL, "seq" bigint NOT NULL, "type" character varying(20) NOT NULL, "status" character varying(10) NOT NULL, "result" jsonb NOT NULL DEFAULT '{}', "error" character varying(300), "device_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_c08b2fff7c85d54d33edad1be41" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9ca954a0ae70c7f3d4fd074253" ON "offline_ops" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_7e922d157ba26643af7af24cb5" ON "offline_ops" ("tenant_id", "device_id", "seq") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_offline_ops" ON "offline_ops" ("tenant_id", "device_id", "op_id") `);
        await queryRunner.query(`CREATE TABLE "offline_id_map" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "device_id" uuid NOT NULL, "entity" character varying(20) NOT NULL, "client_id" uuid NOT NULL, "server_id" uuid NOT NULL, CONSTRAINT "PK_bb1cf23aacc6e2f4091578dd72f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b5d0df5ea9c3925c8e0d9bd36a" ON "offline_id_map" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_offline_id_map" ON "offline_id_map" ("tenant_id", "entity", "client_id") `);
        await queryRunner.query(`ALTER TABLE "memberships" ADD "pin_offline_hash" character varying(100)`);
        await queryRunner.query(`ALTER TABLE "receipts" ADD "device_id" uuid`);
        await queryRunner.query(`ALTER TABLE "receipts" ADD "offline" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "receipts" ADD "device_created_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "receipts" ADD "received_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "receipts" ADD "flags" jsonb NOT NULL DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "shifts" ADD "client_id" uuid`);
        await queryRunner.query(`ALTER TABLE "devices" ADD "series" character varying(4)`);
        await queryRunner.query(`ALTER TABLE "devices" ADD "secret_enc" text`);
        await queryRunner.query(`ALTER TABLE "devices" ADD "last_op_seq" bigint NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "devices" ADD "last_sync_at" TIMESTAMP WITH TIME ZONE`);
        for (const t of ["offline_ops", "offline_id_map"]) await enableRls(queryRunner, t);
        await grantAppRole(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN "last_sync_at"`);
        await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN "last_op_seq"`);
        await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN "secret_enc"`);
        await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN "series"`);
        await queryRunner.query(`ALTER TABLE "shifts" DROP COLUMN "client_id"`);
        await queryRunner.query(`ALTER TABLE "receipts" DROP COLUMN "flags"`);
        await queryRunner.query(`ALTER TABLE "receipts" DROP COLUMN "received_at"`);
        await queryRunner.query(`ALTER TABLE "receipts" DROP COLUMN "device_created_at"`);
        await queryRunner.query(`ALTER TABLE "receipts" DROP COLUMN "offline"`);
        await queryRunner.query(`ALTER TABLE "receipts" DROP COLUMN "device_id"`);
        await queryRunner.query(`ALTER TABLE "memberships" DROP COLUMN "pin_offline_hash"`);
        await queryRunner.query(`DROP INDEX "public"."uq_offline_id_map"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b5d0df5ea9c3925c8e0d9bd36a"`);
        await queryRunner.query(`DROP TABLE "offline_id_map"`);
        await queryRunner.query(`DROP INDEX "public"."uq_offline_ops"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7e922d157ba26643af7af24cb5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9ca954a0ae70c7f3d4fd074253"`);
        await queryRunner.query(`DROP TABLE "offline_ops"`);
    }

}
