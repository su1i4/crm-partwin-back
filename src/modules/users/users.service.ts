import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import { EntityManager } from 'typeorm';
import { AppConfig } from '../../config/app.config';
import { Errors } from '../../common/errors/app.exception';
import { LoginKind, parseLogin } from '../../common/utils/login';
import { SecretBox } from '../../common/utils/secret-box';
import { PlatformDb } from '../../database/tenant/platform-db';
import { User } from './entities/user.entity';

const BCRYPT_ROUNDS = 11;
const MAX_FAILED = 10;
const LOCK_MINUTES = 15;

export interface UserTenantRow {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  isOwner: boolean;
  onboardingCompleted: boolean;
}

/** Учётные записи пользователей (платформенный уровень, ТЗ 3.2). */
@Injectable()
export class UsersService {
  private readonly box: SecretBox;
  private readonly dummyHash = bcrypt.hashSync('timing-equalizer', BCRYPT_ROUNDS);

  constructor(
    private readonly platform: PlatformDb,
    config: AppConfig,
  ) {
    this.box = new SecretBox(config.encryptionKey);
  }

  get repo() {
    return this.platform.repo(User);
  }

  parseLoginOrFail(raw: string): LoginKind {
    const login = parseLogin(raw);
    if (!login) throw Errors.bad('BAD_LOGIN', 'Укажите телефон или email');
    return login;
  }

  loginString(l: LoginKind) {
    return 'phone' in l ? l.phone : l.email;
  }

  async findByLogin(login: LoginKind, withSecrets = false, manager?: EntityManager): Promise<User | null> {
    const repo = manager ? this.platform.repoIn(manager, User) : this.repo;
    const qb = repo.createQueryBuilder('u');
    if (withSecrets) qb.addSelect(['u.passwordHash', 'u.totpSecretEnc']);
    if ('phone' in login) qb.where('u.phone = :v', { v: login.phone });
    else qb.where('u.email = :v', { v: login.email });
    return qb.getOne();
  }

  async findById(id: string, withSecrets = false): Promise<User | null> {
    const qb = this.repo.createQueryBuilder('u').where('u.id = :id', { id });
    if (withSecrets) qb.addSelect(['u.passwordHash', 'u.totpSecretEnc']);
    return qb.getOne();
  }

  async getById(id: string, withSecrets = false): Promise<User> {
    const u = await this.findById(id, withSecrets);
    if (!u) throw Errors.notFound('Пользователь');
    return u;
  }

  hash(password: string) {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  async create(
    data: { name: string; login: LoginKind; password: string; locale?: string },
    manager?: EntityManager,
  ): Promise<User> {
    const repo = manager ? this.platform.repoIn(manager, User) : this.repo;
    const existing = await this.findByLogin(data.login, false, manager);
    if (existing) throw Errors.conflict('LOGIN_TAKEN', 'Пользователь с таким телефоном или email уже есть');
    const user = repo.create({
      name: data.name.trim(),
      phone: 'phone' in data.login ? data.login.phone : null,
      email: 'email' in data.login ? data.login.email : null,
      passwordHash: await this.hash(data.password),
      locale: data.locale ?? 'ru',
      passwordChangedAt: new Date(),
    });
    return repo.save(user);
  }

  /**
   * Проверка пароля с защитой от перебора: 10 неудач подряд → блокировка на 15 минут.
   * Ошибка одинаковая для «нет пользователя» и «неверный пароль».
   */
  async verifyCredentials(login: LoginKind, password: string, totpCode?: string): Promise<User> {
    const user = await this.findByLogin(login, true);
    const invalid = () => Errors.unauthorized('Неверный логин или пароль', 'INVALID_CREDENTIALS');
    if (!user) {
      await bcrypt.compare(password, this.dummyHash); // выравниваем время ответа
      throw invalid();
    }
    if (!user.isActive) throw Errors.unauthorized('Учётная запись отключена', 'USER_DISABLED');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw Errors.tooMany('Слишком много неудачных попыток. Попробуйте позже', { lockedUntil: user.lockedUntil });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      await this.repo.update(user.id, {
        failedLoginCount: failed >= MAX_FAILED ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      });
      throw invalid();
    }
    if (user.totpEnabled) {
      if (!totpCode) throw Errors.unauthorized('Введите код из приложения-аутентификатора', 'TOTP_REQUIRED');
      if (!this.checkTotp(user, totpCode)) throw Errors.unauthorized('Неверный код', 'TOTP_INVALID');
    }
    if (user.failedLoginCount || user.lockedUntil) {
      await this.repo.update(user.id, { failedLoginCount: 0, lockedUntil: null });
    }
    return user;
  }

  async verifyPasswordOnly(userId: string, password: string): Promise<User> {
    const user = await this.getById(userId, true);
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw Errors.bad('INVALID_PASSWORD', 'Неверный пароль');
    }
    return user;
  }

  async setPassword(userId: string, password: string) {
    await this.repo.update(userId, {
      passwordHash: await this.hash(password),
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
    });
  }

  async touchLogin(userId: string) {
    await this.repo.update(userId, { lastLoginAt: new Date() });
  }

  // ── 2FA (TOTP) ─────────────────────────────────────────

  async startTotpSetup(userId: string, issuer: string) {
    const user = await this.getById(userId);
    if (user.totpEnabled) throw Errors.conflict('TOTP_ALREADY_ENABLED', 'Двухфакторная защита уже включена');
    const secret = authenticator.generateSecret();
    await this.repo.update(userId, { totpSecretEnc: this.box.encrypt(secret) });
    const label = user.email ?? user.phone ?? user.name;
    return { secret, otpauthUrl: authenticator.keyuri(label, issuer, secret) };
  }

  async enableTotp(userId: string, code: string) {
    const user = await this.getById(userId, true);
    if (!user.totpSecretEnc) throw Errors.bad('TOTP_NOT_SETUP', 'Сначала начните настройку');
    if (!this.checkTotp(user, code)) throw Errors.bad('TOTP_INVALID', 'Неверный код');
    await this.repo.update(userId, { totpEnabled: true });
  }

  async disableTotp(userId: string, password: string, code: string) {
    const user = await this.verifyPasswordOnly(userId, password);
    if (!user.totpEnabled) return;
    if (!this.checkTotp(user, code)) throw Errors.bad('TOTP_INVALID', 'Неверный код');
    await this.repo.update(userId, { totpEnabled: false, totpSecretEnc: null });
  }

  private checkTotp(user: User, code: string): boolean {
    if (!user.totpSecretEnc) return false;
    try {
      authenticator.options = { window: 1 };
      return authenticator.check(code, this.box.decrypt(user.totpSecretEnc));
    } catch {
      return false;
    }
  }

  // ── Магазины пользователя ───────────────────────────────

  /**
   * Список магазинов, где пользователь — активный участник.
   * Запрос идёт мимо tenant-контекста по политике RLS memberships_self (только свои строки).
   */
  async listTenants(userId: string, includeDisabled = false): Promise<UserTenantRow[]> {
    return this.platform.transaction(async (m) => {
      await m.query(`SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', '', true)`, [userId]);
      const rows = await m.query(
        `SELECT m.id AS membership_id, m.tenant_id, m.is_owner, m.status, t.name, t.status AS tenant_status,
                t.onboarding_completed_at
           FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 ${includeDisabled ? '' : `AND m.status = 'active'`}
          ORDER BY t.name`,
        [userId],
      );
      return rows.map((r: any) => ({
        membershipId: r.membership_id,
        tenantId: r.tenant_id,
        tenantName: r.name,
        tenantStatus: r.tenant_status,
        isOwner: r.is_owner,
        onboardingCompleted: !!r.onboarding_completed_at,
      }));
    });
  }

  toPublic(u: User) {
    return {
      id: u.id,
      name: u.name,
      phone: u.phone,
      email: u.email,
      locale: u.locale,
      totpEnabled: u.totpEnabled,
      telegramLinked: !!u.telegramChatId,
      lastLoginAt: u.lastLoginAt,
    };
  }
}
