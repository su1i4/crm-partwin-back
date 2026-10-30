import { Injectable } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { rooms } from './rooms';

/** Отправка событий в WebSocket. Вызывается из обработчиков outbox (после COMMIT). */
@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  private get io() {
    return this.gateway.server;
  }

  toTenant(tenantId: string, event: string, data: unknown) {
    this.io?.to(rooms.tenant(tenantId)).emit(event, data);
  }
  toUser(tenantId: string, userId: string, event: string, data: unknown) {
    this.io?.to(rooms.user(tenantId, userId)).emit(event, data);
  }
  toStore(tenantId: string, storeId: string, event: string, data: unknown) {
    this.io?.to(rooms.store(tenantId, storeId)).emit(event, data);
  }
  toRoom(room: string, event: string, data: unknown) {
    if (!room.startsWith('t:')) throw new Error('Комната без префикса магазина');
    this.io?.to(room).emit(event, data);
  }
  disconnectUser(tenantId: string, userId: string) {
    this.gateway.disconnectUser(tenantId, userId);
  }
}
