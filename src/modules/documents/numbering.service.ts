import { Injectable } from '@nestjs/common';
import { dayjs } from '../../common/utils/dates';
import { CountersService } from '../../database/tenant/counters.service';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { Store } from '../stores/entities/store.entity';
import { DOCUMENT_TYPES, DocumentType } from './entities/document.entity';

/** Номер документа присваивает сервер: ПН-ОШ-2026-000123, счётчик отдельный для вида, точки и года (ТЗ 9.2). */
@Injectable()
export class NumberingService {
  constructor(private readonly counters: CountersService) {}

  async next(tx: TenantTx, type: DocumentType, storeId: string | null, date: Date): Promise<string> {
    const store = storeId ? await tx.repo(Store).findById(storeId) : null;
    const code = store?.code ?? 'ЦС';
    const year = dayjs(date).tz(store?.timezone ?? 'Asia/Bishkek').year();
    const prefix = DOCUMENT_TYPES[type].prefix;
    const n = await this.counters.next(tx, `doc:${type}:${store?.id ?? 'central'}:${year}`);
    return `${prefix}-${code}-${year}-${String(n).padStart(6, '0')}`;
  }
}
