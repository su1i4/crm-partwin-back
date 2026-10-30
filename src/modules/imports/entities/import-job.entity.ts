import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../../../database/tenant/base.entity';

export type ImportType = 'products' | 'crosses' | 'applicability';
export type ImportStatus = 'uploaded' | 'previewed' | 'queued' | 'running' | 'done' | 'failed' | 'rolled_back';

/** Фоновый импорт Excel/CSV (ТЗ 4.8, 21.2): сопоставление колонок, предпросмотр, ошибки по строкам, откат. */
@Entity('import_jobs')
@Index(['tenantId', 'createdAt'])
export class ImportJob extends TenantEntity {
  @Column({ type: 'varchar', length: 20 }) type: ImportType;
  @Column({ type: 'varchar', length: 20, default: 'uploaded' }) status: ImportStatus;
  @Column({ type: 'uuid' }) fileId: string;
  @Column({ type: 'varchar', length: 300 }) fileName: string;
  /** Колонки файла */
  @Column({ type: 'jsonb', default: () => "'[]'" }) columns: string[];
  /** поле → номер колонки */
  @Column({ type: 'jsonb', default: () => "'{}'" }) mapping: Record<string, number>;
  @Column({ type: 'jsonb', default: () => "'{}'" }) options: Record<string, unknown>;
  @Column({ type: 'int', default: 0 }) totalRows: number;
  @Column({ type: 'int', default: 0 }) processedRows: number;
  @Column({ type: 'int', default: 0 }) createdCount: number;
  @Column({ type: 'int', default: 0 }) updatedCount: number;
  @Column({ type: 'int', default: 0 }) errorCount: number;
  /** Первые 2000 ошибок: { row, field, message } */
  @Column({ type: 'jsonb', default: () => "'[]'" }) errors: { row: number; field?: string; message: string }[];
  @Column({ type: 'text', nullable: true }) failReason: string | null;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) finishedAt: Date | null;
}
