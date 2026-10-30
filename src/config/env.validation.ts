import { plainToInstance, Type } from 'class-transformer';
import { IsBooleanString, IsIn, IsInt, IsOptional, IsString, MinLength, validateSync } from 'class-validator';

class EnvVars {
  @IsIn(['development', 'production', 'test'])
  NODE_ENV: string = 'development';

  @Type(() => Number)
  @IsInt()
  PORT: number = 3000;

  @IsString()
  CORS_ORIGINS: string = 'http://localhost:5173';

  @IsString()
  APP_PUBLIC_URL: string = 'http://localhost:5173';

  @IsString()
  DATABASE_URL: string;

  @IsString()
  DATABASE_OWNER_URL: string;

  @Type(() => Number)
  @IsInt()
  DB_POOL_SIZE: number = 20;

  @IsOptional()
  @IsBooleanString()
  DB_LOGGING?: string;

  @IsString()
  @MinLength(16)
  JWT_ACCESS_SECRET: string;

  @IsString()
  JWT_ACCESS_TTL: string = '15m';

  @Type(() => Number)
  @IsInt()
  REFRESH_TTL_DAYS: number = 30;

  @IsOptional()
  @IsBooleanString()
  COOKIE_SECURE?: string;

  @IsOptional()
  @IsString()
  COOKIE_DOMAIN?: string;

  @IsString()
  @MinLength(32)
  ENCRYPTION_KEY: string;

  @IsString()
  UPLOADS_DIR: string = 'uploads';

  @Type(() => Number)
  @IsInt()
  MAX_UPLOAD_MB: number = 10;

  @IsString()
  TOTP_ISSUER: string = 'AutopartsCRM';

  @Type(() => Number)
  @IsInt()
  OUTBOX_POLL_MS: number = 1000;

  /** Курсы НБКР (ТЗ 19.4) */
  @IsOptional()
  @IsString()
  NBKR_URL: string = 'https://www.nbkr.kg/XML/daily.xml';

  /** Telegram-бот платформы (ТЗ 22.2). Пусто — бот выключен */
  @IsOptional()
  @IsString()
  TELEGRAM_BOT_TOKEN?: string;

  @IsOptional()
  @IsString()
  TELEGRAM_BOT_USERNAME?: string;

  /** Секрет вебхука (заголовок X-Telegram-Bot-Api-Secret-Token) */
  @IsOptional()
  @IsString()
  TELEGRAM_WEBHOOK_SECRET?: string;

  @IsOptional()
  @IsString()
  TELEGRAM_API_URL: string = 'https://api.telegram.org';

  /** Сервис распознавания номеров с фото (ocr-service, PaddleOCR). Пусто — распознавание выключено */
  @IsOptional()
  @IsString()
  OCR_URL?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  OCR_TIMEOUT_MS: number = 15000;

  /** Прайсы по ссылке: разрешить адреса локальной сети (только для разработки) */
  @IsOptional()
  @IsString()
  PRICELIST_ALLOW_PRIVATE_URLS: string = 'false';

  /** Прайсы по ссылке: максимальный размер файла, МБ */
  @Type(() => Number)
  @IsInt()
  PRICELIST_MAX_MB: number = 100;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvVars, config, { enableImplicitConversion: true });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const msg = errors.map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`).join('\n');
    throw new Error(`Ошибка конфигурации .env:\n${msg}`);
  }
  return validated;
}
