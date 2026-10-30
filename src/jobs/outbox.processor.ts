import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../config/app.config';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxRegistry } from './outbox.registry';

const BATCH = 100;
const MAX_ATTEMPTS = 10;

/**
 * Обработчик outbox (ТЗ 2.4.9): раз в OUTBOX_POLL_MS забирает пачку событий
 * (FOR UPDATE SKIP LOCKED — безопасно при нескольких процессах), рассылает и отмечает обработанными.
 * Ошибка → повтор с растущей задержкой; после 10 попыток событие остаётся с last_error.
 */
@Injectable()
export class OutboxProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly ds: DataSource,
    private readonly registry: OutboxRegistry,
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    const interval = this.config.outboxPollMs;
    this.timer = setInterval(() => void this.tick(), interval);
  }

  onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      let total = 0;
      for (let i = 0; i < 10; i++) {
        const n = await this.processBatch();
        total += n;
        if (n < BATCH) break;
      }
      return total;
    } catch (e) {
      this.logger.error(`outbox: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private processBatch(): Promise<number> {
    return this.ds.transaction(async (m) => {
      const rows: any[] = await m.query(
        `SELECT * FROM outbox_events
          WHERE processed_at IS NULL AND available_at <= now() AND attempts < $1
          ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [MAX_ATTEMPTS, BATCH],
      );
      for (const r of rows) {
        const ev = Object.assign(new OutboxEvent(), {
          id: r.id,
          tenantId: r.tenant_id,
          type: r.type,
          payload: r.payload,
          userId: r.user_id,
          createdAt: r.created_at,
          attempts: r.attempts,
        });
        try {
          await this.registry.dispatch(ev);
          await m.query(`UPDATE outbox_events SET processed_at = now(), attempts = attempts + 1 WHERE id = $1`, [r.id]);
        } catch (e) {
          const attempts = r.attempts + 1;
          const delaySec = Math.min(3600, 2 ** attempts);
          this.logger.warn(`outbox #${r.id} ${r.type}: попытка ${attempts} — ${(e as Error).message}`);
          await m.query(
            `UPDATE outbox_events SET attempts = $2, last_error = $3, available_at = now() + ($4 || ' seconds')::interval
              WHERE id = $1`,
            [r.id, attempts, String((e as Error).message).slice(0, 2000), String(delaySec)],
          );
        }
      }
      return rows.length;
    });
  }
}
