import { Injectable } from '@nestjs/common';
import { TenantTx } from '../database/tenant/tenant-tx';
import { OutboxEvent } from './entities/outbox-event.entity';

/**
 * Запись события в outbox в той же транзакции (ТЗ 2.4.9).
 * Если транзакция откатится — событие не уйдёт; при сбое после COMMIT — не потеряется.
 */
@Injectable()
export class OutboxService {
  async emit(tx: TenantTx, type: string, payload: Record<string, any> = {}, delayMs = 0): Promise<void> {
    await tx.manager.insert(OutboxEvent, {
      tenantId: tx.tenantId,
      type,
      payload,
      userId: tx.userId,
      availableAt: delayMs ? new Date(Date.now() + delayMs) : undefined,
    });
  }
}
