import { Column, Entity, Index } from 'typeorm';
import { TenantVersionedEntity } from '../../../database/tenant/base.entity';

/** Файл магазина: лежит в uploads/{tenantId}/…, отдаётся только авторизованным (ТЗ 2.1). */
@Entity('files')
@Index(['tenantId', 'entityType', 'entityId'])
export class StoredFile extends TenantVersionedEntity {
  /** logo | product_photo | attachment | import | receipt_screenshot … */
  @Column({ type: 'varchar', length: 40 })
  purpose: string;

  @Column({ type: 'varchar', length: 300 })
  originalName: string;

  @Column({ type: 'varchar', length: 100 })
  mime: string;

  @Column({ type: 'int' })
  size: number;

  /** Путь относительно UPLOADS_DIR: {tenantId}/2026/10/{uuid}.jpg */
  @Column({ type: 'varchar', length: 400 })
  storagePath: string;

  @Column({ type: 'varchar', length: 64 })
  sha256: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  entityType: string | null;

  @Column({ type: 'uuid', nullable: true })
  entityId: string | null;
}
