import { Injectable, OnModuleInit } from '@nestjs/common';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { RealtimeService } from './realtime.service';

/**
 * События outbox → WebSocket. Отправка — только после коммита транзакции (через outbox),
 * чтобы клиент не увидел то, что потом откатилось.
 */
const TENANT_EVENTS = ['rate.changed', 'prices.changed'];
const STORE_EVENTS = ['receipts.deferred_changed', 'shift.changed', 'receipt.completed'];

@Injectable()
export class RealtimeRelayService implements OnModuleInit {
  constructor(
    private readonly registry: OutboxRegistry,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit() {
    for (const type of TENANT_EVENTS) {
      this.registry.on(type, (e) => this.realtime.toTenant(e.tenantId, type, e.payload));
    }
    for (const type of STORE_EVENTS) {
      this.registry.on(type, (e) => {
        if (e.payload?.storeId) this.realtime.toStore(e.tenantId, e.payload.storeId, type, e.payload);
      });
    }
  }
}
