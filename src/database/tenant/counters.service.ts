import { Injectable } from '@nestjs/common';
import { TenantTx } from './tenant-tx';

/** Счётчики магазина без дыр при параллельных вставках (строка блокируется до конца транзакции). */
@Injectable()
export class CountersService {
  async next(tx: TenantTx, key: string, by = 1): Promise<number> {
    const rows = await tx.query<{ value: string }>(
      `INSERT INTO counters (tenant_id, key, value, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = counters.value + $3, updated_at = now()
       RETURNING value`,
      [tx.tenantId, key, by, tx.userId],
    );
    return Number(rows[0].value);
  }
}
