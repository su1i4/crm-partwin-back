import { Column, Entity, Index } from 'typeorm';
import { PlatformEntity } from '../../../database/tenant/base.entity';

/** Марка автомобиля — общий справочник платформы (ТЗ 6.1), только чтение для магазинов. */
@Entity('global_vehicle_makes')
@Index('uq_global_vehicle_makes_code', ['code'], { unique: true })
export class GlobalVehicleMake extends PlatformEntity {
  /** toyota, lexus, mercedes-benz … */
  @Column({ type: 'varchar', length: 60 })
  code: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Япония, Корея, Германия … */
  @Column({ type: 'varchar', length: 60, nullable: true })
  country: string | null;

  /** Народные названия и синонимы: «тойота», «мерс», «MB» */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  aliases: string[];

  /** Популярна в КР — в стартовой подборке «наших марок» */
  @Column({ default: false })
  popularKg: boolean;

  @Column({ type: 'int', default: 0 })
  sort: number;
}
