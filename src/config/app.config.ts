import { ConfigService } from '@nestjs/config';

/** Типизированный доступ к конфигурации. */
export class AppConfig {
  constructor(private readonly config: ConfigService) {}

  get isProd() {
    return this.config.get<string>('NODE_ENV') === 'production';
  }
  get port() {
    return Number(this.config.get('PORT'));
  }
  get corsOrigins(): string[] {
    return String(this.config.get('CORS_ORIGINS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  get publicUrl() {
    return String(this.config.get('APP_PUBLIC_URL'));
  }
  get databaseUrl() {
    return String(this.config.get('DATABASE_URL'));
  }
  get databaseOwnerUrl() {
    return String(this.config.get('DATABASE_OWNER_URL'));
  }
  get dbPoolSize() {
    return Number(this.config.get('DB_POOL_SIZE'));
  }
  get dbLogging() {
    return this.config.get('DB_LOGGING') === 'true';
  }
  get jwtAccessSecret() {
    return String(this.config.get('JWT_ACCESS_SECRET'));
  }
  get jwtAccessTtl() {
    return String(this.config.get('JWT_ACCESS_TTL'));
  }
  get refreshTtlDays() {
    return Number(this.config.get('REFRESH_TTL_DAYS'));
  }
  get cookieSecure() {
    return this.config.get('COOKIE_SECURE') === 'true';
  }
  get cookieDomain(): string | undefined {
    return this.config.get<string>('COOKIE_DOMAIN') || undefined;
  }
  get encryptionKey() {
    return String(this.config.get('ENCRYPTION_KEY'));
  }
  get uploadsDir() {
    return String(this.config.get('UPLOADS_DIR'));
  }
  get maxUploadBytes() {
    return Number(this.config.get('MAX_UPLOAD_MB')) * 1024 * 1024;
  }
  get totpIssuer() {
    return String(this.config.get('TOTP_ISSUER'));
  }
  get outboxPollMs() {
    return Number(this.config.get('OUTBOX_POLL_MS'));
  }
  get nbkrUrl(): string {
    return this.config.get('NBKR_URL') || 'https://www.nbkr.kg/XML/daily.xml';
  }
  get telegram() {
    return {
      token: this.config.get<string>('TELEGRAM_BOT_TOKEN') || null,
      username: this.config.get<string>('TELEGRAM_BOT_USERNAME') || null,
      webhookSecret: this.config.get<string>('TELEGRAM_WEBHOOK_SECRET') || null,
      apiUrl: (this.config.get<string>('TELEGRAM_API_URL') || 'https://api.telegram.org').replace(/\/$/, ''),
    };
  }
  get ocrUrl(): string | null {
    return this.config.get('OCR_URL') || null;
  }
  get ocrTimeoutMs() {
    return Number(this.config.get('OCR_TIMEOUT_MS') ?? 15000);
  }
  get pricelistAllowPrivateUrls() {
    return this.config.get('PRICELIST_ALLOW_PRIVATE_URLS') === 'true';
  }
  get pricelistMaxBytes() {
    return Number(this.config.get('PRICELIST_MAX_MB') ?? 100) * 1024 * 1024;
  }
}
