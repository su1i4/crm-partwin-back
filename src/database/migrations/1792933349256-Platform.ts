import { MigrationInterface, QueryRunner } from "typeorm";
import { grantAppRole } from "../tenant/grants";
import { enableRls } from "../tenant/rls";

export class Platform1792933349256 implements MigrationInterface {
    name = 'Platform1792933349256'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "platform_admins" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "email" character varying(200) NOT NULL, "name" character varying(100) NOT NULL, "password_hash" character varying(200) NOT NULL, "totp_secret_enc" character varying(300) NOT NULL, "role" character varying(10) NOT NULL DEFAULT 'support', "is_active" boolean NOT NULL DEFAULT true, "failed_logins" integer NOT NULL DEFAULT '0', "locked_until" TIMESTAMP WITH TIME ZONE, "last_login_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_faecb3398d1962507b44c76e4f0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7ddfa7abfaf477f671ccc566c8" ON "platform_admins" ("email") `);
        await queryRunner.query(`CREATE TABLE "platform_admin_log" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "admin_id" uuid NOT NULL, "action" character varying(60) NOT NULL, "tenant_id" uuid, "details" jsonb NOT NULL DEFAULT '{}', "ip" character varying(60), CONSTRAINT "PK_a20f8e6ceb1b5accb0f92ca2418" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_dd5ba6f4767a3cea82bd6025fb" ON "platform_admin_log" ("created_at") `);
        await queryRunner.query(`CREATE TABLE "support_sessions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenant_id" uuid NOT NULL, "admin_id" uuid NOT NULL, "status" character varying(10) NOT NULL, "reason" character varying(500) NOT NULL, "emergency" boolean NOT NULL DEFAULT false, "can_write" boolean NOT NULL DEFAULT false, "show_money" boolean NOT NULL DEFAULT false, "approved_by" uuid, "started_at" TIMESTAMP WITH TIME ZONE, "expires_at" TIMESTAMP WITH TIME ZONE, "ended_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_3f42d6581b7be63ce898b1d0f65" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2131a76ed674feeb91a9d953ea" ON "support_sessions" ("tenant_id", "status") `);
        await queryRunner.query(`CREATE TABLE "support_grants" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenant_id" uuid NOT NULL, "granted_by" uuid NOT NULL, "until" TIMESTAMP WITH TIME ZONE NOT NULL, "can_write" boolean NOT NULL DEFAULT false, "show_money" boolean NOT NULL DEFAULT false, "revoked_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_74d34257a4bcd88faf45097d40e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e1aa034fa0b8a19acdb4f314c4" ON "support_grants" ("tenant_id") `);
        // Журнал админов — только добавление (неизменяемый)
        await queryRunner.query(`CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'platform_admin_log is append-only'; END $$`);
        await queryRunner.query(`CREATE TRIGGER platform_admin_log_ro BEFORE UPDATE OR DELETE ON platform_admin_log FOR EACH ROW EXECUTE FUNCTION forbid_change()`);
        await grantAppRole(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS platform_admin_log_ro ON platform_admin_log`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e1aa034fa0b8a19acdb4f314c4"`);
        await queryRunner.query(`DROP TABLE "support_grants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2131a76ed674feeb91a9d953ea"`);
        await queryRunner.query(`DROP TABLE "support_sessions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dd5ba6f4767a3cea82bd6025fb"`);
        await queryRunner.query(`DROP TABLE "platform_admin_log"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7ddfa7abfaf477f671ccc566c8"`);
        await queryRunner.query(`DROP TABLE "platform_admins"`);
    }

}
