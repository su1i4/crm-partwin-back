import { Column, Entity, Index } from 'typeorm';
import { PlatformEntity, TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

/**
 * Устройство магазина. agent — локальный агент печати на кассовом ПК (ТЗ 12.2);
 * pos — браузер или телефон, привязанный к кассе (ТЗ 3.5): свой долгоживущий токен, серия номеров офлайн-чеков,
 * секрет для проверки PIN без сети. Токен устройства хранится хэшем.
 */
@Entity('devices')
@Index(['tenantId', 'registerId'])
@Index('uq_devices_token', ['tokenHash'], { unique: true })
export class Device extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 20, default: 'agent' }) kind: 'agent' | 'pos';
  @Column({ type: 'uuid' }) registerId: string;
  @Column({ type: 'uuid' }) storeId: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'varchar', length: 64 }) tokenHash: string;
  @Column({ type: 'varchar', length: 30, nullable: true }) agentVersion: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'" }) info: Record<string, any>;
  @Column({ type: 'timestamptz', nullable: true }) lastSeenAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) revokedAt: Date | null;
  /** pos: серия номеров чеков этого устройства (К1А-000457 → «А»); при переустановке — новая серия */
  @Column({ type: 'varchar', length: 4, nullable: true }) series: string | null;
  /** pos: секрет устройства (зашифрован ключом сервера) — для PIN без сети */
  @Column({ type: 'text', nullable: true }) secretEnc: string | null;
  /** pos: последняя принятая операция очереди и время синхронизации */
  @Column({ type: 'bigint', default: '0' }) lastOpSeq: string;
  @Column({ type: 'timestamptz', nullable: true }) lastSyncAt: Date | null;
}

/** Операция офлайн-очереди кассы: принимается один раз (ключ — UUID операции), строго по порядку (ТЗ 16.4). */
@Entity('offline_ops')
@Index('uq_offline_ops', ['tenantId', 'deviceId', 'opId'], { unique: true })
@Index(['tenantId', 'deviceId', 'seq'])
export class OfflineOp extends TenantEntity {
  @Column({ type: 'uuid' }) deviceId: string;
  @Column({ type: 'uuid' }) opId: string;
  @Column({ type: 'bigint' }) seq: string;
  /** shift_open | sale | return | cash_op | shift_close | customer | product_draft | debt_payment */
  @Column({ type: 'varchar', length: 20 }) type: string;
  /** accepted — принята; rejected — отклонена (ошибка в данных, касса покажет) */
  @Column({ type: 'varchar', length: 10 }) status: 'accepted' | 'rejected';
  @Column({ type: 'jsonb', default: () => "'{}'" }) result: Record<string, any>;
  @Column({ type: 'varchar', length: 300, nullable: true }) error: string | null;
  /** Время на устройстве (часы могут быть сбиты) */
  @Column({ type: 'timestamptz', nullable: true }) deviceAt: Date | null;
}

/** Офлайн-идентификатор → серверный: клиент, созданный на кассе, объединился по телефону с существующим и т. п. */
@Entity('offline_id_map')
@Index('uq_offline_id_map', ['tenantId', 'entity', 'clientId'], { unique: true })
export class OfflineIdMap extends TenantEntity {
  @Column({ type: 'uuid' }) deviceId: string;
  @Column({ type: 'varchar', length: 20 }) entity: 'customer' | 'product' | 'shift';
  @Column({ type: 'uuid' }) clientId: string;
  @Column({ type: 'uuid' }) serverId: string;
}

/** Код привязки агента: 6 цифр, 10 минут. Таблица платформы — агент ещё не знает магазин. */
@Entity('device_pairing_codes')
@Index('uq_device_pairing_codes_hash', ['codeHash'], { unique: true })
export class DevicePairingCode extends PlatformEntity {
  @Column({ type: 'uuid' }) tenantId: string;
  @Column({ type: 'uuid' }) registerId: string;
  @Column({ type: 'varchar', length: 64 }) codeHash: string;
  @Column({ type: 'timestamptz' }) expiresAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) usedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) createdBy: string | null;
}

export type PrintJobKind = 'receipt' | 'labels' | 'drawer' | 'test' | 'z_report';
export type PrintJobStatus = 'queued' | 'sent' | 'printed' | 'error' | 'cancelled';

/** Задание печати: ждёт в очереди, агент забирает и сообщает статус («Напечатано», «Нет бумаги»). */
@Entity('print_jobs')
@Index(['tenantId', 'deviceId', 'status', 'createdAt'])
export class PrintJob extends TenantEntity {
  @Column({ type: 'uuid' }) deviceId: string;
  @Column({ type: 'uuid' }) registerId: string;
  @Column({ type: 'varchar', length: 15 }) kind: PrintJobKind;
  @Column({ type: 'jsonb' }) payload: Record<string, any>;
  @Column({ type: 'varchar', length: 12, default: 'queued' }) status: PrintJobStatus;
  @Column({ type: 'varchar', length: 300, nullable: true }) error: string | null;
  @Column({ type: 'int', default: 0 }) attempts: number;
  @Column({ type: 'timestamptz', nullable: true }) sentAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) doneAt: Date | null;
}
