import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Проверки базы при старте: роль приложения без BYPASSRLS, LEAKPROOF для индексов поиска при RLS. */
@Injectable()
export class DbChecksService implements OnApplicationBootstrap {
  private readonly logger = new Logger('DbChecks');

  constructor(private readonly ds: DataSource) {}

  async onApplicationBootstrap() {
    try {
      const [role] = await this.ds.query(
        `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      if (role?.rolsuper || role?.rolbypassrls) {
        this.logger.error(
          `Приложение подключено под ролью «${role.rolname}» с ${role.rolsuper ? 'SUPERUSER' : 'BYPASSRLS'}: RLS не защищает данные магазинов! Используйте autoparts_app.`,
        );
      }
      const rows = await this.ds.query(
        `SELECT proname FROM pg_proc WHERE proname IN ('textlike', 'similarity_op', 'jsonb_contains') AND NOT proleakproof`,
      );
      if (rows.length) {
        this.logger.warn(
          `Функции ${rows.map((r: any) => r.proname).join(', ')} не LEAKPROOF — при RLS поиск не использует индексы и будет медленным. Выполните конец scripts/init-db.sql под postgres.`,
        );
      }
    } catch (e) {
      this.logger.warn(`Проверка базы не выполнена: ${(e as Error).message}`);
    }
  }
}
