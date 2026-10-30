import { Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { AppConfig } from '../../config/app.config';
import { Errors } from '../../common/errors/app.exception';
import { randomToken, sha256 } from '../../common/utils/crypto';
import { PlatformDb } from '../../database/tenant/platform-db';
import { UserSession } from '../users/entities/user-session.entity';
import { AccessService } from './access.service';
import { TokenService } from './token.service';

export interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
}

const ROTATION_GRACE_MS = 30_000;

/** Сессии и токены (ТЗ 3.5): короткий access 15 мин + длинный refresh 30 дней с ротацией. */
@Injectable()
export class SessionsService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly tokens: TokenService,
    private readonly config: AppConfig,
    private readonly access: AccessService,
  ) {}

  private get repo() {
    return this.platform.repo(UserSession);
  }

  private expiry() {
    return new Date(Date.now() + this.config.refreshTtlDays * 86_400_000);
  }

  async create(
    userId: string,
    tenant: { tenantId: string; membershipId: string } | null,
    meta: ClientMeta,
  ): Promise<IssuedTokens> {
    const refreshToken = randomToken(48);
    const session = await this.repo.save(
      this.repo.create({
        userId,
        tenantId: tenant?.tenantId ?? null,
        membershipId: tenant?.membershipId ?? null,
        refreshHash: sha256(refreshToken),
        expiresAt: this.expiry(),
        lastUsedAt: new Date(),
        ip: meta.ip?.slice(0, 64) ?? null,
        userAgent: meta.userAgent?.slice(0, 400) ?? null,
      }),
    );
    return this.issue(session, refreshToken);
  }

  /** Переключить сессию на магазин (новый access + ротация refresh). */
  async switchTenant(sessionId: string, tenantId: string | null, membershipId: string | null): Promise<IssuedTokens> {
    const session = await this.repo.findOne({ where: { id: sessionId, revokedAt: IsNull() } });
    if (!session) throw Errors.unauthorized('Сессия завершена', 'SESSION_REVOKED');
    session.tenantId = tenantId;
    session.membershipId = membershipId;
    const refreshToken = this.rotateInPlace(session);
    await this.repo.save(session);
    this.access.invalidateSession(session.id);
    return this.issue(session, refreshToken);
  }

  /** Обновление по refresh-токену. Повторное использование старого токена после ротации — отзыв сессии. */
  async refresh(refreshToken: string, meta: ClientMeta): Promise<IssuedTokens & { session: UserSession }> {
    const hash = sha256(refreshToken);
    let session = await this.repo.findOne({ where: { refreshHash: hash } });
    if (!session) {
      const prev = await this.repo.findOne({ where: { prevRefreshHash: hash } });
      if (prev && prev.rotatedAt && Date.now() - prev.rotatedAt.getTime() < ROTATION_GRACE_MS && !prev.revokedAt) {
        session = prev; // параллельная вкладка — допускаем
      } else {
        if (prev && !prev.revokedAt) await this.revoke(prev.id, 'refresh_reuse');
        throw Errors.unauthorized('Сессия завершена, войдите снова', 'SESSION_REVOKED');
      }
    }
    if (session.revokedAt || session.expiresAt < new Date()) {
      throw Errors.unauthorized('Сессия завершена, войдите снова', 'SESSION_REVOKED');
    }
    const newRefresh = this.rotateInPlace(session);
    session.expiresAt = this.expiry();
    session.lastUsedAt = new Date();
    if (meta.ip) session.ip = meta.ip.slice(0, 64);
    await this.repo.save(session);
    this.access.invalidateSession(session.id);
    return { ...this.issue(session, newRefresh), session };
  }

  async revoke(sessionId: string, reason: string) {
    await this.repo.update({ id: sessionId, revokedAt: IsNull() }, { revokedAt: new Date(), revokeReason: reason });
    this.access.invalidateSession(sessionId);
  }

  /** Выйти на всех устройствах (кроме, по желанию, текущего). */
  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string) {
    const qb = this.repo
      .createQueryBuilder()
      .update()
      .set({ revokedAt: () => 'now()', revokeReason: reason })
      .where('user_id = :userId AND revoked_at IS NULL', { userId });
    if (exceptSessionId) qb.andWhere('id <> :sid', { sid: exceptSessionId });
    await qb.execute();
    this.access.invalidateUserSessions(userId);
  }

  /** Завершить сессии пользователя в конкретном магазине (увольнение, отключение участия). */
  async revokeForMembership(userId: string, tenantId: string, reason: string) {
    await this.repo
      .createQueryBuilder()
      .update()
      .set({ revokedAt: () => 'now()', revokeReason: reason })
      .where('user_id = :userId AND tenant_id = :tenantId AND revoked_at IS NULL', { userId, tenantId })
      .execute();
    this.access.invalidateUserSessions(userId);
  }

  listActive(userId: string) {
    return this.repo
      .createQueryBuilder('s')
      .select([
        's.id',
        's.tenantId',
        's.createdAt',
        's.lastUsedAt',
        's.expiresAt',
        's.ip',
        's.userAgent',
      ])
      .where('s.user_id = :userId AND s.revoked_at IS NULL AND s.expires_at > now()', { userId })
      .orderBy('s.last_used_at', 'DESC')
      .getMany();
  }

  async getOwned(userId: string, sessionId: string) {
    const s = await this.repo.findOne({ where: { id: sessionId, userId } });
    if (!s) throw Errors.notFound('Сессия');
    return s;
  }

  private rotateInPlace(session: UserSession): string {
    const refreshToken = randomToken(48);
    session.prevRefreshHash = session.refreshHash;
    session.refreshHash = sha256(refreshToken);
    session.rotatedAt = new Date();
    return refreshToken;
  }

  private issue(session: UserSession, refreshToken: string): IssuedTokens {
    const accessToken = this.tokens.signAccess({
      sub: session.userId,
      sid: session.id,
      ...(session.tenantId && session.membershipId ? { tid: session.tenantId, mid: session.membershipId } : {}),
    });
    return { accessToken, refreshToken, refreshExpiresAt: session.expiresAt, sessionId: session.id };
  }
}
