import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../../../database/tenant/base.entity';

/** Распознавание номера с фото (ТЗ 11.3): что прочитал OCR, какие кандидаты, что выбрал / исправил продавец. */
@Entity('ocr_recognitions')
@Index(['tenantId', 'createdAt'])
export class OcrRecognition extends TenantEntity {
  @Column({ type: 'uuid', nullable: true }) fileId: string | null;
  @Column({ type: 'varchar', length: 30 }) provider: string;
  /** Строки OCR: текст и уверенность */
  @Column({ type: 'jsonb', default: () => "'[]'" }) lines: { text: string; score?: number }[];
  /** Кандидаты в номера и найдено ли по каждому */
  @Column({ type: 'jsonb', default: () => "'[]'" }) candidates: Record<string, any>[];
  @Column({ type: 'int', default: 0 }) foundCount: number;
  /** Время распознавания и поиска, мс */
  @Column({ type: 'int', default: 0 }) ms: number;
  /** pos | receiving | inventory | search | product | garage */
  @Column({ type: 'varchar', length: 20, nullable: true }) context: string | null;
  @Column({ type: 'uuid', nullable: true }) chosenProductId: string | null;
  /** Продавец исправил распознанный номер — для статистики качества */
  @Column({ type: 'varchar', length: 80, nullable: true }) correctedText: string | null;
  @Column({ type: 'timestamptz', nullable: true }) correctedAt: Date | null;
}
