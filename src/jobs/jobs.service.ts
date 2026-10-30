import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { AppConfig } from '../config/app.config';

/** Данные фоновой задачи всегда содержат tenantId (ТЗ 2.4.5), кроме платформенных задач. */
export interface TenantJobData {
  tenantId: string;
  userId?: string | null;
  [k: string]: unknown;
}

type Handler<T> = (data: T, job: PgBoss.Job<T>) => Promise<void>;

/**
 * Фоновые задачи и расписание на pg-boss (очередь на PostgreSQL, Redis не нужен).
 * Работает под ролью-владельцем (DATABASE_OWNER_URL): pg-boss сам создаёт схему pgboss.
 * Внутри обработчика данные магазина — только через TenantTransaction.run(..., { tenantId }).
 */
@Injectable()
export class JobsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private boss!: PgBoss;
  private readonly queues = new Set<string>();
  private readonly pendingWorkers: Array<() => Promise<void>> = [];
  private started = false;

  constructor(private readonly config: AppConfig) {}

  async onModuleInit() {
    this.boss = new PgBoss({
      connectionString: this.config.databaseOwnerUrl,
      schema: 'pgboss',
      max: 5,
    });
    this.boss.on('error', (e) => this.logger.error(`pg-boss: ${e.message}`));
    await this.boss.start();
    this.started = true;
    for (const w of this.pendingWorkers.splice(0)) await w();
    this.logger.log('pg-boss запущен');
  }

  async onApplicationShutdown() {
    if (this.started) await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  private chain: Promise<unknown> = Promise.resolve();

  /** Очереди создаются строго по одной: параллельный createQueue в pg-boss приводит к взаимной блокировке. */
  private ensureQueue(name: string): Promise<void> {
    const run = async () => {
      if (this.queues.has(name)) return;
      for (let attempt = 1; ; attempt++) {
        try {
          await this.boss.createQueue(name);
          break;
        } catch (e: any) {
          if (e?.code === '40P01' && attempt < 5) {
            await new Promise((r) => setTimeout(r, 100 * attempt));
            continue;
          }
          throw e;
        }
      }
      this.queues.add(name);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async send<T extends object>(queue: string, data: T, options: PgBoss.SendOptions = {}): Promise<string | null> {
    await this.ensureQueue(queue);
    return this.boss.send(queue, data, options);
  }

  /** Зарегистрировать обработчик (можно вызывать до старта — запустится после). */
  async work<T extends object>(queue: string, handler: Handler<T>, options: PgBoss.WorkOptions = {}) {
    const start = async () => {
      await this.ensureQueue(queue);
      await this.boss.work<T>(queue, options, async (jobs) => {
        for (const job of jobs) {
          try {
            await handler(job.data, job);
          } catch (e) {
            this.logger.error(`job ${queue}#${job.id}: ${(e as Error).message}`);
            throw e;
          }
        }
      });
    };
    if (this.started) await start();
    else this.pendingWorkers.push(start);
  }

  /** Расписание (cron, минимум — раз в минуту), по часовому поясу Asia/Bishkek. */
  async schedule(queue: string, cron: string, data: object = {}, tz = 'Asia/Bishkek') {
    const run = async () => {
      await this.ensureQueue(queue);
      await this.boss.schedule(queue, cron, data, { tz });
    };
    if (this.started) await run();
    else this.pendingWorkers.push(run);
  }
}
