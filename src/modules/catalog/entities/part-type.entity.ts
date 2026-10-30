import { Column, Entity, Index } from 'typeorm';
import { TenantVersionedEntity } from '../../../database/tenant/base.entity';

/** Тип детали — шаблон атрибутов (ТЗ 4.5). */
@Entity('part_types')
@Index('uq_part_types_tenant_code', ['tenantId', 'code'], { unique: true, where: 'deleted_at IS NULL' })
export class PartType extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 60 })
  code: string;

  @Column({ default: false })
  isSystem: boolean;

  @Column({ type: 'int', default: 0 })
  sort: number;
}

export const ATTRIBUTE_VALUE_TYPES = ['string', 'number', 'boolean', 'list', 'size'] as const;
export type AttributeValueType = (typeof ATTRIBUTE_VALUE_TYPES)[number];

/**
 * Атрибут (ТЗ 4.5). part_type_id = null — атрибут для всех деталей (сторона, ось, страна, состояние).
 * Значения у товара — в JSONB products.attributes по code.
 */
@Entity('attributes')
@Index('uq_attributes_type_code', ['tenantId', 'partTypeId', 'code'], { unique: true, where: 'deleted_at IS NULL' })
export class Attribute extends TenantVersionedEntity {
  @Column({ type: 'uuid', nullable: true })
  partTypeId: string | null;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 60 })
  code: string;

  @Column({ type: 'varchar', length: 20 })
  valueType: AttributeValueType;

  @Column({ type: 'varchar', length: 20, nullable: true })
  unit: string | null;

  @Column({ default: false })
  required: boolean;

  @Column({ default: false })
  filterable: boolean;

  @Column({ default: false })
  searchable: boolean;

  /** Для list — варианты; для size — подписи частей ['внутр.', 'наруж.', 'высота'] */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  options: string[];

  @Column({ default: false })
  isSystem: boolean;

  @Column({ type: 'int', default: 0 })
  sort: number;
}
