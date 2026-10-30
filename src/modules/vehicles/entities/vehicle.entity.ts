import { Column, Entity, Index } from 'typeorm';
import { PlatformEntity, TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

/** Модель (ТЗ 6.1). aliases — народные названия: «камри», «фит», «эстима». */
@Entity('global_vehicle_models')
@Index('uq_global_vehicle_models', ['makeId', 'code'], { unique: true })
@Index('ix_global_vehicle_models_aliases', { synchronize: false })
export class GlobalVehicleModel extends PlatformEntity {
  @Column({ type: 'uuid' }) makeId: string;
  @Column({ type: 'varchar', length: 80 }) code: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) aliases: string[];
  @Column({ type: 'int', default: 0 }) sort: number;
}

export type Restyle = 'pre' | 'post' | null;

/** Поколение: годы, рестайлинг, народные названия («Камри 40»), коды кузова (ACV40). */
@Entity('global_vehicle_generations')
@Index('uq_global_vehicle_generations', ['modelId', 'code'], { unique: true })
@Index('ix_global_vehicle_generations_aliases', { synchronize: false })
@Index('ix_global_vehicle_generations_body', { synchronize: false })
export class GlobalVehicleGeneration extends PlatformEntity {
  @Column({ type: 'uuid' }) modelId: string;
  @Column({ type: 'varchar', length: 80 }) code: string;
  /** XV40 */
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'smallint', nullable: true }) yearFrom: number | null;
  @Column({ type: 'smallint', nullable: true }) yearTo: number | null;
  @Column({ type: 'varchar', length: 5, nullable: true }) restyle: Restyle;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) aliases: string[];
  /** Префиксы кодов кузова: ACV40, ACV45, GSV40 */
  @Column({ type: 'text', array: true, default: () => "'{}'" }) bodyCodes: string[];
  @Column({ type: 'int', default: 0 }) sort: number;
}

/** Модификация: двигатель, топливо, КПП, привод, руль, рынок. */
@Entity('global_vehicle_modifications')
@Index(['generationId'])
export class GlobalVehicleModification extends PlatformEntity {
  @Column({ type: 'uuid' }) generationId: string;
  @Column({ type: 'varchar', length: 150 }) name: string;
  @Column({ type: 'varchar', length: 30, nullable: true }) engineCode: string | null;
  @Column({ type: 'numeric', precision: 4, scale: 1, nullable: true }) engineVolume: string | null;
  /** petrol | diesel | hybrid | electric | gas */
  @Column({ type: 'varchar', length: 15, nullable: true }) fuel: string | null;
  /** mt | at | cvt | robot */
  @Column({ type: 'varchar', length: 10, nullable: true }) transmission: string | null;
  /** fwd | rwd | awd */
  @Column({ type: 'varchar', length: 10, nullable: true }) drive: string | null;
  /** right | left */
  @Column({ type: 'varchar', length: 10, nullable: true }) steering: string | null;
  /** jp | us | eu | kr | cn | ru */
  @Column({ type: 'varchar', length: 10, nullable: true }) market: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) bodyCode: string | null;
  @Column({ type: 'smallint', nullable: true }) yearFrom: number | null;
  @Column({ type: 'smallint', nullable: true }) yearTo: number | null;
}

/** WMI — первые 3 символа VIN → марка (расшифровка — этап 6.1). */
@Entity('global_vin_wmi')
@Index('uq_global_vin_wmi', ['wmi'], { unique: true })
export class GlobalVinWmi extends PlatformEntity {
  @Column({ type: 'varchar', length: 3 }) wmi: string;
  @Column({ type: 'uuid' }) makeId: string;
  @Column({ type: 'varchar', length: 60, nullable: true }) country: string | null;
}

/** Своя модель магазина поверх общего справочника (видна только ему). */
@Entity('tenant_vehicle_models')
@Index(['tenantId', 'makeId'])
export class TenantVehicleModel extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) makeId: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) aliases: string[];
}

/** Своё поколение магазина (к глобальной или своей модели). */
@Entity('tenant_vehicle_generations')
@Index(['tenantId', 'modelId'])
export class TenantVehicleGeneration extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) modelId: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'smallint', nullable: true }) yearFrom: number | null;
  @Column({ type: 'smallint', nullable: true }) yearTo: number | null;
  @Column({ type: 'varchar', length: 5, nullable: true }) restyle: Restyle;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) aliases: string[];
  @Column({ type: 'text', array: true, default: () => "'{}'" }) bodyCodes: string[];
}

export type ApplicabilityPrecision = 'make' | 'model' | 'generation' | 'modification';

/** Применимость товара (ТЗ 6.2): три уровня точности. Марка обязательна. */
@Entity('product_applicability')
@Index(['tenantId', 'productId'])
@Index(['tenantId', 'makeId', 'modelId', 'generationId'])
export class ProductApplicability extends TenantEntity {
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'uuid' }) makeId: string;
  @Column({ type: 'uuid', nullable: true }) modelId: string | null;
  @Column({ type: 'uuid', nullable: true }) generationId: string | null;
  @Column({ type: 'uuid', nullable: true }) modificationId: string | null;
  @Column({ type: 'varchar', length: 15 }) precision: ApplicabilityPrecision;
  @Column({ type: 'smallint', nullable: true }) yearFrom: number | null;
  @Column({ type: 'smallint', nullable: true }) yearTo: number | null;
  /** right | left — уточнение для поколения */
  @Column({ type: 'varchar', length: 10, nullable: true }) steering: string | null;
  @Column({ type: 'varchar', length: 10, nullable: true }) market: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) note: string | null;
}
