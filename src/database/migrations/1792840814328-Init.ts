import { MigrationInterface, QueryRunner } from "typeorm";
import { MAKES_PRESET } from "../seeds/presets/makes.preset";
import { grantAppRole, makeAppendOnly } from "../tenant/grants";
import { CURRENT_USER, enableRls } from "../tenant/rls";

/** Таблицы магазина — с Row Level Security (ТЗ 2.4.5). */
const TENANT_TABLES = [
  "memberships", "membership_roles", "membership_store_access", "membership_warehouse_access", "invitations",
  "stores", "warehouses", "registers", "tenant_settings", "roles", "role_permissions",
  "price_types", "shop_rates", "money_accounts", "notifications", "notification_settings", "files",
  "categories", "part_types", "attributes", "audit_log",
];

export class Init1792840814328 implements MigrationInterface {
    name = 'Init1792840814328'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
        await queryRunner.query(`CREATE TABLE "outbox_events" ("id" BIGSERIAL NOT NULL, "tenant_id" uuid NOT NULL, "type" character varying(100) NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}', "user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "available_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "processed_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', "last_error" text, CONSTRAINT "PK_6689a16c00d09b8089f6237f1d2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_outbox_pending" ON "outbox_events" ("available_at") WHERE processed_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "global_vehicle_makes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "code" character varying(60) NOT NULL, "name" character varying(100) NOT NULL, "country" character varying(60), "aliases" text array NOT NULL DEFAULT '{}', "popular_kg" boolean NOT NULL DEFAULT false, "sort" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_8662822beb92b57436cc304b42b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_global_vehicle_makes_code" ON "global_vehicle_makes" ("code") `);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "phone" character varying(20), "email" character varying(200), "name" character varying(200) NOT NULL, "password_hash" character varying(100) NOT NULL, "locale" character varying(5) NOT NULL DEFAULT 'ru', "is_active" boolean NOT NULL DEFAULT true, "failed_login_count" integer NOT NULL DEFAULT '0', "locked_until" TIMESTAMP WITH TIME ZONE, "totp_secret_enc" character varying(300), "totp_enabled" boolean NOT NULL DEFAULT false, "telegram_chat_id" bigint, "last_login_at" TIMESTAMP WITH TIME ZONE, "password_changed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_users_email" ON "users" ("email") WHERE email IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_users_phone" ON "users" ("phone") WHERE phone IS NOT NULL`);
        await queryRunner.query(`CREATE TABLE "user_sessions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "tenant_id" uuid, "membership_id" uuid, "refresh_hash" character varying(64) NOT NULL, "prev_refresh_hash" character varying(64), "rotated_at" TIMESTAMP WITH TIME ZONE, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "user_agent" character varying(400), "ip" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_used_at" TIMESTAMP WITH TIME ZONE NOT NULL, "revoked_at" TIMESTAMP WITH TIME ZONE, "revoke_reason" character varying(50), CONSTRAINT "PK_e93e031a5fed190d4789b6bfd83" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a5daf9363dc4e176e6531c86d8" ON "user_sessions" ("refresh_hash") `);
        await queryRunner.query(`CREATE INDEX "IDX_935c75f5a92225727ae3bb2c72" ON "user_sessions" ("prev_refresh_hash") `);
        await queryRunner.query(`CREATE INDEX "IDX_0500261b4f4ada1ce868296858" ON "user_sessions" ("user_id", "revoked_at") `);
        await queryRunner.query(`CREATE TABLE "memberships" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "user_id" uuid NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'active', "is_owner" boolean NOT NULL DEFAULT false, "all_stores" boolean NOT NULL DEFAULT false, "position" character varying(100), "disabled_at" TIMESTAMP WITH TIME ZONE, "access_version" integer NOT NULL DEFAULT '1', CONSTRAINT "PK_25d28bd932097a9e90495ede7b4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a9c14741084d57ac0ec0cb52af" ON "memberships" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_7c1e2fdfed4f6838e0c05ae505" ON "memberships" ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_memberships_tenant_user" ON "memberships" ("tenant_id", "user_id") `);
        await queryRunner.query(`CREATE TABLE "membership_roles" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "membership_id" uuid NOT NULL, "role_id" uuid NOT NULL, CONSTRAINT "PK_29085525c53a6d0b695d8e0f6ec" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4fb6fc336438da0e615712b57b" ON "membership_roles" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_c625b47ba8734dafec257d918f" ON "membership_roles" ("role_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_membership_roles" ON "membership_roles" ("membership_id", "role_id") `);
        await queryRunner.query(`CREATE TABLE "membership_store_access" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "membership_id" uuid NOT NULL, "store_id" uuid NOT NULL, CONSTRAINT "PK_33c60cca360afe82d13d6d2385c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_001ee8bedae9d04b04ab319821" ON "membership_store_access" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_b875a565b6e3f38a636bd49c91" ON "membership_store_access" ("store_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_membership_store_access" ON "membership_store_access" ("membership_id", "store_id") `);
        await queryRunner.query(`CREATE TABLE "membership_warehouse_access" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "membership_id" uuid NOT NULL, "warehouse_id" uuid NOT NULL, CONSTRAINT "PK_c35e4508e76324f9cdc0fce6f92" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_77507afdbf568b2ee254db5d59" ON "membership_warehouse_access" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_05d7ece86cd1867a3056a3f3b1" ON "membership_warehouse_access" ("warehouse_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_membership_warehouse_access" ON "membership_warehouse_access" ("membership_id", "warehouse_id") `);
        await queryRunner.query(`CREATE TABLE "invitations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "code_hash" character varying(64) NOT NULL, "login" character varying(200), "name" character varying(200), "role_ids" uuid array NOT NULL DEFAULT '{}', "store_ids" uuid array NOT NULL DEFAULT '{}', "all_stores" boolean NOT NULL DEFAULT false, "position" character varying(100), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "accepted_at" TIMESTAMP WITH TIME ZONE, "accepted_by" uuid, "revoked_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_5dec98cfdfd562e4ad3648bbb07" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_290e75d606ba89eb421b8b5ec4" ON "invitations" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3eed502b8bf2cd7805e77353c6" ON "invitations" ("code_hash") `);
        await queryRunner.query(`CREATE TABLE "warehouses" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "store_id" uuid, "name" character varying(200) NOT NULL, "code" character varying(20) NOT NULL, "type" character varying(20) NOT NULL DEFAULT 'sales_floor', "storage_level" smallint NOT NULL DEFAULT '1', "counterparty_id" uuid, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_56ae21ee2432b2270b48867e4be" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_09106b8068aeaf74fa33666df8" ON "warehouses" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_035b0e906706d87fb664f2d988" ON "warehouses" ("tenant_id", "store_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_warehouses_tenant_code" ON "warehouses" ("tenant_id", "code") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "tenants" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying(200) NOT NULL, "legal_form" character varying(30), "inn" character varying(20), "address" character varying(300), "phone" character varying(50), "city" character varying(100), "requisites" jsonb NOT NULL DEFAULT '{}', "logo_file_id" uuid, "shop_type" character varying(20), "language" character varying(5) NOT NULL DEFAULT 'ru', "status" character varying(20) NOT NULL DEFAULT 'trial', "subscription_until" TIMESTAMP WITH TIME ZONE, "plan" character varying(50), "limits" jsonb NOT NULL DEFAULT '{}', "owner_user_id" uuid NOT NULL, "onboarding_completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_53be67a04681c66b87ee27c9321" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "registers" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "store_id" uuid NOT NULL, "code" character varying(10) NOT NULL, "name" character varying(100) NOT NULL, "warehouse_id" uuid NOT NULL, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_c80e46007c1de9f8d1c59b3b9b9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b923656be8487cea6434cb56a0" ON "registers" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_4a91b678d8d16def8566c45dc5" ON "registers" ("tenant_id", "store_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_registers_tenant_code" ON "registers" ("tenant_id", "code") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "tenant_settings" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "data" jsonb NOT NULL DEFAULT '{}', "version" integer NOT NULL DEFAULT '1', CONSTRAINT "PK_69225c0ca64bcbbf9af8a217043" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a6abc1c3ed0df635955fc852f1" ON "tenant_settings" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_tenant_settings_tenant" ON "tenant_settings" ("tenant_id") `);
        await queryRunner.query(`CREATE TABLE "price_types" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "name" character varying(100) NOT NULL, "code" character varying(40) NOT NULL, "currency" character varying(3) NOT NULL DEFAULT 'KGS', "is_retail" boolean NOT NULL DEFAULT false, "is_system" boolean NOT NULL DEFAULT false, "sort" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_623e93be1356fb26b7241a991a3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cd926010066ac35fb58d3ee88b" ON "price_types" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_price_types_tenant_code" ON "price_types" ("tenant_id", "code") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "shop_rates" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "currency" character varying(3) NOT NULL DEFAULT 'USD', "rate" numeric(18,6) NOT NULL, "note" character varying(200), CONSTRAINT "PK_db46386336403e19100640ee82b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c48773c3d93d5cc66bc83f61eb" ON "shop_rates" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ac8b2c58c1d1ac8075ff7ebfb2" ON "shop_rates" ("tenant_id", "currency", "created_at") `);
        await queryRunner.query(`CREATE TABLE "notifications" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "user_id" uuid NOT NULL, "type" character varying(100) NOT NULL, "title" character varying(300) NOT NULL, "body" text, "entity_type" character varying(60), "entity_id" uuid, "store_id" uuid, "link" character varying(300), "data" jsonb NOT NULL DEFAULT '{}', "read_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d93ddd7e1b890535ecafbb334e" ON "notifications" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_9a82efd78ea29fa333d5dfb1a0" ON "notifications" ("tenant_id", "user_id", "read_at", "created_at") `);
        await queryRunner.query(`CREATE TABLE "notification_settings" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "user_id" uuid NOT NULL, "channels" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_d131abd7996c475ef768d4559ba" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fb263cb5ff30c4a95f96f936f7" ON "notification_settings" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_notification_settings_user" ON "notification_settings" ("tenant_id", "user_id") `);
        await queryRunner.query(`CREATE TABLE "money_accounts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "type" character varying(20) NOT NULL, "name" character varying(200) NOT NULL, "currency" character varying(3) NOT NULL DEFAULT 'KGS', "store_id" uuid, "register_id" uuid, "holder_membership_id" uuid, "details" jsonb NOT NULL DEFAULT '{}', "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_9b8854b554c676a4c077aace3a2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f0ef2fb97031d312f69407dd91" ON "money_accounts" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_aa0866b9ca45f17589de940b7f" ON "money_accounts" ("tenant_id", "type") `);
        await queryRunner.query(`CREATE TABLE "files" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "purpose" character varying(40) NOT NULL, "original_name" character varying(300) NOT NULL, "mime" character varying(100) NOT NULL, "size" integer NOT NULL, "storage_path" character varying(400) NOT NULL, "sha256" character varying(64) NOT NULL, "entity_type" character varying(60), "entity_id" uuid, CONSTRAINT "PK_6c16b9093a142e0e7613b04a3d9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_484acb2ff8f3e134dfac8f01e8" ON "files" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_d7196e4c9176a16869055aed93" ON "files" ("tenant_id", "entity_type", "entity_id") `);
        await queryRunner.query(`CREATE TABLE "roles" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "name" character varying(100) NOT NULL, "code" character varying(50), "description" character varying(500), "is_system" boolean NOT NULL DEFAULT false, "settings" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_c1433d71a4838793a49dcad46ab" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e59a01f4fe46ebbece575d9a0f" ON "roles" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_roles_tenant_code" ON "roles" ("tenant_id", "code") WHERE deleted_at IS NULL AND code IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_roles_tenant_name" ON "roles" ("tenant_id", "name") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "role_permissions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "role_id" uuid NOT NULL, "permission" character varying(100) NOT NULL, CONSTRAINT "PK_84059017c90bfcb701b8fa42297" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d6fcb39857e2116aff96b97df0" ON "role_permissions" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_role_permissions" ON "role_permissions" ("role_id", "permission") `);
        await queryRunner.query(`CREATE TABLE "part_types" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "name" character varying(120) NOT NULL, "code" character varying(60) NOT NULL, "is_system" boolean NOT NULL DEFAULT false, "sort" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_7ffd345eaf4cae28b2823dd5f07" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_ae12334f4f08426c53e1212ec1" ON "part_types" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_part_types_tenant_code" ON "part_types" ("tenant_id", "code") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "attributes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "part_type_id" uuid, "name" character varying(120) NOT NULL, "code" character varying(60) NOT NULL, "value_type" character varying(20) NOT NULL, "unit" character varying(20), "required" boolean NOT NULL DEFAULT false, "filterable" boolean NOT NULL DEFAULT false, "searchable" boolean NOT NULL DEFAULT false, "options" jsonb NOT NULL DEFAULT '[]', "is_system" boolean NOT NULL DEFAULT false, "sort" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_32216e2e61830211d3a5d7fa72c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8df16cd370327023ca61899161" ON "attributes" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_attributes_type_code" ON "attributes" ("tenant_id", "part_type_id", "code") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "categories" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "parent_id" uuid, "name" character varying(200) NOT NULL, "path" character varying(2000) NOT NULL DEFAULT '/', "level" smallint NOT NULL DEFAULT '0', "sort" integer NOT NULL DEFAULT '0', "preset_code" character varying(80), "settings" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_24dbc6126a28ff948da33e97d3b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5d4fe23b360b1b9e16a3f41727" ON "categories" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_categories_name_in_parent" ON "categories" ("tenant_id", "parent_id", "name") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_b43e7c0396e495d1b8ac8eaede" ON "categories" ("tenant_id", "parent_id") `);
        await queryRunner.query(`CREATE TABLE "audit_log" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" uuid, "membership_id" uuid, "action" character varying(100) NOT NULL, "entity_type" character varying(60), "entity_id" uuid, "summary" character varying(300), "before" jsonb, "after" jsonb, "diff" jsonb, "important" boolean NOT NULL DEFAULT false, "store_id" uuid, "ip" character varying(64), "user_agent" character varying(400), "device_id" uuid, "support_session_id" uuid, CONSTRAINT "PK_07fefa57f7f5ab8fc3f52b3ed0b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1103990577f248b70c62a23496" ON "audit_log" ("tenant_id", "important", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_298316f9af44f2dd7eadcb3248" ON "audit_log" ("tenant_id", "entity_type", "entity_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ad217a94f778851d62c38b82d4" ON "audit_log" ("tenant_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "stores" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "name" character varying(200) NOT NULL, "code" character varying(10) NOT NULL, "address" character varying(300), "phone" character varying(50), "timezone" character varying(64) NOT NULL DEFAULT 'Asia/Bishkek', "register_mode" character varying(10) NOT NULL DEFAULT 'single', "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_7aa6e7d71fa7acdd7ca43d7c9cb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b65b13e803690c2055e7620caf" ON "stores" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_stores_tenant_code" ON "stores" ("tenant_id", "code") WHERE deleted_at IS NULL`);

        // ── Row Level Security ──────────────────────────────────
        for (const t of TENANT_TABLES) await enableRls(queryRunner, t);

        // Пользователь видит свои участия во всех магазинах (список магазинов при входе)
        await queryRunner.query(`CREATE POLICY memberships_self ON "memberships" FOR SELECT USING (user_id = ${CURRENT_USER})`);
        // Приглашение находится по хэшу кода до выбора магазина
        await queryRunner.query(
            `CREATE POLICY invitations_by_code ON "invitations" FOR SELECT USING (code_hash = nullif(current_setting('app.invite_code_hash', true), ''))`,
        );

        // ── Журнал действий: только дополняется (ТЗ 22.3) ────────
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF TG_OP = 'UPDATE' THEN
                RAISE EXCEPTION 'audit_log: изменение записей запрещено';
              END IF;
              -- Удаление: только очистка старше 3 лет под ролью-владельцем
              IF OLD.created_at > now() - interval '3 years' THEN
                RAISE EXCEPTION 'audit_log: удаление записей моложе 3 лет запрещено';
              END IF;
              RETURN OLD;
            END $$`);
        await queryRunner.query(
            `CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_guard()`,
        );

        // ── Права роли приложения ────────────────────────────────
        await grantAppRole(queryRunner);
        await makeAppendOnly(queryRunner, "audit_log");

        // ── Справочник марок (ТЗ 6.1) ───────────────────────────
        let sort = 0;
        for (const m of MAKES_PRESET) {
            sort += 10;
            await queryRunner.query(
                `INSERT INTO global_vehicle_makes (code, name, country, aliases, popular_kg, sort) VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (code) DO NOTHING`,
                [m.code, m.name, m.country, m.aliases, m.popularKg, sort],
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS audit_log_no_change ON "audit_log"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS audit_log_guard()`);
        await queryRunner.query(`DROP INDEX "public"."uq_stores_tenant_code"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b65b13e803690c2055e7620caf"`);
        await queryRunner.query(`DROP TABLE "stores"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ad217a94f778851d62c38b82d4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_298316f9af44f2dd7eadcb3248"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1103990577f248b70c62a23496"`);
        await queryRunner.query(`DROP TABLE "audit_log"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b43e7c0396e495d1b8ac8eaede"`);
        await queryRunner.query(`DROP INDEX "public"."uq_categories_name_in_parent"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5d4fe23b360b1b9e16a3f41727"`);
        await queryRunner.query(`DROP TABLE "categories"`);
        await queryRunner.query(`DROP INDEX "public"."uq_attributes_type_code"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8df16cd370327023ca61899161"`);
        await queryRunner.query(`DROP TABLE "attributes"`);
        await queryRunner.query(`DROP INDEX "public"."uq_part_types_tenant_code"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ae12334f4f08426c53e1212ec1"`);
        await queryRunner.query(`DROP TABLE "part_types"`);
        await queryRunner.query(`DROP INDEX "public"."uq_role_permissions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d6fcb39857e2116aff96b97df0"`);
        await queryRunner.query(`DROP TABLE "role_permissions"`);
        await queryRunner.query(`DROP INDEX "public"."uq_roles_tenant_name"`);
        await queryRunner.query(`DROP INDEX "public"."uq_roles_tenant_code"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e59a01f4fe46ebbece575d9a0f"`);
        await queryRunner.query(`DROP TABLE "roles"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d7196e4c9176a16869055aed93"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_484acb2ff8f3e134dfac8f01e8"`);
        await queryRunner.query(`DROP TABLE "files"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_aa0866b9ca45f17589de940b7f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f0ef2fb97031d312f69407dd91"`);
        await queryRunner.query(`DROP TABLE "money_accounts"`);
        await queryRunner.query(`DROP INDEX "public"."uq_notification_settings_user"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fb263cb5ff30c4a95f96f936f7"`);
        await queryRunner.query(`DROP TABLE "notification_settings"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9a82efd78ea29fa333d5dfb1a0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d93ddd7e1b890535ecafbb334e"`);
        await queryRunner.query(`DROP TABLE "notifications"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ac8b2c58c1d1ac8075ff7ebfb2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c48773c3d93d5cc66bc83f61eb"`);
        await queryRunner.query(`DROP TABLE "shop_rates"`);
        await queryRunner.query(`DROP INDEX "public"."uq_price_types_tenant_code"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cd926010066ac35fb58d3ee88b"`);
        await queryRunner.query(`DROP TABLE "price_types"`);
        await queryRunner.query(`DROP INDEX "public"."uq_tenant_settings_tenant"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a6abc1c3ed0df635955fc852f1"`);
        await queryRunner.query(`DROP TABLE "tenant_settings"`);
        await queryRunner.query(`DROP INDEX "public"."uq_registers_tenant_code"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4a91b678d8d16def8566c45dc5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b923656be8487cea6434cb56a0"`);
        await queryRunner.query(`DROP TABLE "registers"`);
        await queryRunner.query(`DROP TABLE "tenants"`);
        await queryRunner.query(`DROP INDEX "public"."uq_warehouses_tenant_code"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_035b0e906706d87fb664f2d988"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_09106b8068aeaf74fa33666df8"`);
        await queryRunner.query(`DROP TABLE "warehouses"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3eed502b8bf2cd7805e77353c6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_290e75d606ba89eb421b8b5ec4"`);
        await queryRunner.query(`DROP TABLE "invitations"`);
        await queryRunner.query(`DROP INDEX "public"."uq_membership_warehouse_access"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_05d7ece86cd1867a3056a3f3b1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_77507afdbf568b2ee254db5d59"`);
        await queryRunner.query(`DROP TABLE "membership_warehouse_access"`);
        await queryRunner.query(`DROP INDEX "public"."uq_membership_store_access"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b875a565b6e3f38a636bd49c91"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_001ee8bedae9d04b04ab319821"`);
        await queryRunner.query(`DROP TABLE "membership_store_access"`);
        await queryRunner.query(`DROP INDEX "public"."uq_membership_roles"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c625b47ba8734dafec257d918f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4fb6fc336438da0e615712b57b"`);
        await queryRunner.query(`DROP TABLE "membership_roles"`);
        await queryRunner.query(`DROP INDEX "public"."uq_memberships_tenant_user"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7c1e2fdfed4f6838e0c05ae505"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a9c14741084d57ac0ec0cb52af"`);
        await queryRunner.query(`DROP TABLE "memberships"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0500261b4f4ada1ce868296858"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_935c75f5a92225727ae3bb2c72"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a5daf9363dc4e176e6531c86d8"`);
        await queryRunner.query(`DROP TABLE "user_sessions"`);
        await queryRunner.query(`DROP INDEX "public"."uq_users_phone"`);
        await queryRunner.query(`DROP INDEX "public"."uq_users_email"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP INDEX "public"."uq_global_vehicle_makes_code"`);
        await queryRunner.query(`DROP TABLE "global_vehicle_makes"`);
        await queryRunner.query(`DROP INDEX "public"."ix_outbox_pending"`);
        await queryRunner.query(`DROP TABLE "outbox_events"`);
    }

}
