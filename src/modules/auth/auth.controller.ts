import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AppConfig } from '../../config/app.config';
import { AllowNoTenant, AllowWhenSuspended, AuthUser, CurrentUser, Public } from '../../common/decorators/auth.decorators';
import { Errors } from '../../common/errors/app.exception';
import { UsersService } from '../users/users.service';
import {
  AcceptInviteDto,
  ChangePasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  SelectTenantDto,
  TotpCodeDto,
  TotpDisableDto,
  UpdateProfileDto,
} from './dto/auth.dto';
import { AuthResult, AuthService } from './auth.service';
import { MeService } from './me.service';
import { ClientMeta, IssuedTokens, SessionsService } from './sessions.service';

export const REFRESH_COOKIE = 'refresh_token';
const STRICT = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('Вход и сессии')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly users: UsersService,
    private readonly me: MeService,
    private readonly config: AppConfig,
  ) {}

  private meta(req: Request): ClientMeta {
    return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
  }

  private setCookie(res: Response, tokens: IssuedTokens) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      domain: this.config.cookieDomain,
      path: '/api/auth',
      expires: tokens.refreshExpiresAt,
    });
  }

  private clearCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth', domain: this.config.cookieDomain });
  }

  private respond(res: Response, r: AuthResult) {
    this.setCookie(res, r.tokens);
    return {
      accessToken: r.tokens.accessToken,
      sessionId: r.tokens.sessionId,
      user: r.user,
      tenants: r.tenants,
      currentTenantId: r.currentTenantId,
    };
  }

  @Public()
  @Throttle(STRICT)
  @Post('register')
  @ApiOperation({ summary: 'Регистрация владельца вместе с магазином (мастер, шаг 1)' })
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.register(dto, this.meta(req)));
  }

  @Public()
  @Throttle(STRICT)
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Вход по телефону или email',
    description:
      'Если у пользователя один магазин — токен сразу на него. Если несколько — токен без магазина и список tenants, затем /auth/select-tenant. Ошибка TOTP_REQUIRED — повторить с totpCode.',
  })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto, this.meta(req)));
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Обновить access-токен по refresh (httpOnly cookie). Refresh ротируется' })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? dto.refreshToken;
    try {
      const { tokens, tenantDropped } = await this.auth.refresh(token, this.meta(req));
      this.setCookie(res, tokens);
      return { accessToken: tokens.accessToken, sessionId: tokens.sessionId, tenantDropped };
    } catch (e) {
      this.clearCookie(res);
      throw e;
    }
  }

  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  @Get('tenants')
  @ApiOperation({ summary: 'Магазины, в которых я сотрудник' })
  tenants(@CurrentUser() u: AuthUser) {
    return this.users.listTenants(u.userId);
  }

  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  @Post('select-tenant')
  @HttpCode(200)
  @ApiOperation({ summary: 'Выбрать магазин — новый токен на этот магазин' })
  async selectTenant(
    @CurrentUser() u: AuthUser,
    @Body() dto: SelectTenantDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.selectTenant(u.userId, u.sessionId, dto.tenantId));
  }

  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Кто я: пользователь, магазин, права, доступные точки' })
  getMe(@CurrentUser() u: AuthUser) {
    return this.me.get(u);
  }

  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  @Patch('me')
  @ApiOperation({ summary: 'Изменить имя и язык' })
  async updateMe(@CurrentUser() u: AuthUser, @Body() dto: UpdateProfileDto) {
    await this.users.repo.update(u.userId, { ...(dto.name ? { name: dto.name.trim() } : {}), ...(dto.locale ? { locale: dto.locale } : {}) });
    return this.users.toPublic(await this.users.getById(u.userId));
  }

  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  @Throttle(STRICT)
  @Post('change-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Сменить пароль (остальные сессии завершаются)' })
  async changePassword(@CurrentUser() u: AuthUser, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(u.userId, u.sessionId, dto.oldPassword, dto.newPassword);
  }

  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Выйти (текущая сессия)' })
  async logout(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(u.sessionId, 'logout');
    this.clearCookie(res);
  }

  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Выйти на всех устройствах' })
  async logoutAll(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revokeAllForUser(u.userId, 'logout_all');
    this.clearCookie(res);
  }

  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({ summary: 'Активные сессии' })
  async listSessions(@CurrentUser() u: AuthUser) {
    const list = await this.sessions.listActive(u.userId);
    return list.map((s) => ({ ...s, current: s.id === u.sessionId }));
  }

  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Завершить сессию' })
  async revokeSession(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const s = await this.sessions.getOwned(u.userId, id);
    await this.sessions.revoke(s.id, 'revoked_by_user');
  }

  // ── 2FA ─────────────────────────────────────────────────

  @AllowNoTenant()
  @ApiBearerAuth()
  @Post('2fa/setup')
  @ApiOperation({ summary: 'Начать настройку 2FA: секрет и otpauth-ссылка для QR' })
  setup2fa(@CurrentUser() u: AuthUser) {
    return this.users.startTotpSetup(u.userId, this.config.totpIssuer);
  }

  @AllowNoTenant()
  @ApiBearerAuth()
  @Post('2fa/enable')
  @HttpCode(204)
  @ApiOperation({ summary: 'Включить 2FA, подтвердив код из приложения' })
  async enable2fa(@CurrentUser() u: AuthUser, @Body() dto: TotpCodeDto) {
    await this.users.enableTotp(u.userId, dto.code);
  }

  @AllowNoTenant()
  @ApiBearerAuth()
  @Throttle(STRICT)
  @Post('2fa/disable')
  @HttpCode(204)
  @ApiOperation({ summary: 'Отключить 2FA (пароль + код)' })
  async disable2fa(@CurrentUser() u: AuthUser, @Body() dto: TotpDisableDto) {
    await this.users.disableTotp(u.userId, dto.password, dto.code);
  }

  // ── Приглашения ─────────────────────────────────────────

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('invite/:code')
  @ApiOperation({ summary: 'Посмотреть приглашение по коду' })
  previewInvite(@Param('code') code: string) {
    if (!code || code.length > 64) throw Errors.notFound('Приглашение');
    return this.auth.previewInvite(code);
  }

  @Public()
  @Throttle(STRICT)
  @Post('accept-invite')
  @ApiOperation({
    summary: 'Принять приглашение',
    description: 'Есть учётная запись — укажите её пароль. Нет — она будет создана (нужно имя).',
  })
  async acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.acceptInvite(dto, this.meta(req)));
  }
}
