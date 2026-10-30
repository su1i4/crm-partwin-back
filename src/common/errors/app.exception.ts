import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Единый формат ошибки API: { code, message, details }.
 * code — машинный (STOCK_NOT_ENOUGH), message — по-русски для пользователя.
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const Errors = {
  notFound: (what = 'Объект') => new AppException('NOT_FOUND', `${what} не найден`, HttpStatus.NOT_FOUND),
  forbidden: (message = 'Недостаточно прав') => new AppException('FORBIDDEN', message, HttpStatus.FORBIDDEN),
  unauthorized: (message = 'Требуется вход в систему', code = 'UNAUTHORIZED') =>
    new AppException(code, message, HttpStatus.UNAUTHORIZED),
  conflict: (code: string, message: string, details?: unknown) =>
    new AppException(code, message, HttpStatus.CONFLICT, details),
  versionConflict: () =>
    new AppException('VERSION_CONFLICT', 'Документ изменён другим пользователем, обновите страницу', HttpStatus.CONFLICT),
  bad: (code: string, message: string, details?: unknown) =>
    new AppException(code, message, HttpStatus.BAD_REQUEST, details),
  tooMany: (message: string, details?: unknown) =>
    new AppException('TOO_MANY_ATTEMPTS', message, HttpStatus.TOO_MANY_REQUESTS, details),
};
