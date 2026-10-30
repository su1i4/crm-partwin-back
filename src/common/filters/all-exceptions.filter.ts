import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

const HTTP_CODES: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'Некорректный запрос' },
  401: { code: 'UNAUTHORIZED', message: 'Требуется вход в систему' },
  403: { code: 'FORBIDDEN', message: 'Недостаточно прав' },
  404: { code: 'NOT_FOUND', message: 'Не найдено' },
  409: { code: 'CONFLICT', message: 'Конфликт данных' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Слишком большой файл или запрос' },
  429: { code: 'TOO_MANY_REQUESTS', message: 'Слишком много запросов, попробуйте позже' },
};

/** Приводит любые ошибки к формату { code, message, details }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') return;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ErrorBody = { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse() as any;
      if (r && typeof r === 'object' && typeof r.code === 'string') {
        body = { code: r.code, message: r.message, details: r.details };
      } else {
        const def = HTTP_CODES[status] ?? { code: 'ERROR', message: exception.message };
        body = { code: def.code, message: def.message };
        if (r && typeof r === 'object' && r.message && status !== 404) body.details = r.message;
      }
    } else if (exception instanceof QueryFailedError) {
      const pg = (exception as any).driverError ?? {};
      switch (pg.code) {
        case '23505':
          status = HttpStatus.CONFLICT;
          body = { code: 'DUPLICATE', message: 'Такая запись уже существует', details: { constraint: pg.constraint } };
          break;
        case '23503':
          status = HttpStatus.CONFLICT;
          body = { code: 'REFERENCED', message: 'Есть связанные данные', details: { constraint: pg.constraint } };
          break;
        case '22P02':
          status = HttpStatus.BAD_REQUEST;
          body = { code: 'BAD_REQUEST', message: 'Некорректный идентификатор или значение' };
          break;
        case '42501':
          // RLS / нет прав на таблицу — это ошибка в коде, наружу отдаём 404, в лог — подробно
          this.logger.error(`RLS/permission violation: ${exception.message}`);
          status = HttpStatus.NOT_FOUND;
          body = { code: 'NOT_FOUND', message: 'Не найдено' };
          break;
        case '40P01':
        case '40001':
          status = HttpStatus.CONFLICT;
          body = { code: 'RETRY', message: 'Одновременное изменение данных, повторите действие' };
          break;
        default:
          this.logger.error(exception.message, (exception as Error).stack);
      }
    } else {
      this.logger.error(
        `${req.method} ${req.url}: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }

    res.status(status).json(body);
  }
}
