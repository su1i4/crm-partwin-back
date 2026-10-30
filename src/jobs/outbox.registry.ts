import { Injectable, Logger } from '@nestjs/common';
import { OutboxEvent } from './entities/outbox-event.entity';

export type OutboxHandler = (event: OutboxEvent) => Promise<void> | void;

/**
 * Реестр обработчиков событий outbox. Модули регистрируют их в onModuleInit:
 *   registry.on('notification.created', (e) => ...)
 *   registry.on('*', ...) — на все события
 */
@Injectable()
export class OutboxRegistry {
  private readonly logger = new Logger(OutboxRegistry.name);
  private readonly handlers = new Map<string, OutboxHandler[]>();

  on(type: string, handler: OutboxHandler) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  async dispatch(event: OutboxEvent) {
    const list = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get('*') ?? [])];
    for (const h of list) await h(event);
  }

  has(type: string) {
    return this.handlers.has(type) || this.handlers.has('*');
  }
}
