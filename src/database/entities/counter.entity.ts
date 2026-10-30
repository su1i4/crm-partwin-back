import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../tenant/base.entity';

/** Счётчики магазина: артикулы, внутренние штрихкоды, номера документов (ТЗ 9.2). */
@Entity('counters')
@Index('uq_counters_key', ['tenantId', 'key'], { unique: true })
export class Counter extends TenantEntity {
  @Column({ type: 'varchar', length: 100 })
  key: string;

  @Column({ type: 'bigint', default: 0 })
  value: string;
}
