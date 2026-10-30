import { Body, Controller, Delete, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, Length, MaxLength, MinLength } from 'class-validator';
import { RequestContext } from '../../common/context/request-context';
import { AllowNoTenant, AllowWhenSuspended, AuthUser, CurrentUser, Public } from '../../common/decorators/auth.decorators';
import { Errors } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app.config';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../auth/sessions.service';
import { UsersService } from '../users/users.service';
import { TelegramService } from './telegram.service';

const STRICT = { default: { limit: 5, ttl: 60_000 } };

export class TgResetRequestDto {
  @ApiProperty({ example: '0555123456' }) @IsString() @Length(3, 100) login: string;
}

export class TgResetConfirmDto {
  @ApiProperty() @IsString() @Length(3, 100) login: string;
  @ApiProperty({ example: '123456' }) @IsString() @Length(6, 6) code: string;
  @ApiProperty({ minLength: 6 }) @IsString() @MinLength(6) @MaxLength(100) password: string;
}

@ApiTags('Telegram-бот')
@Controller()
export class TelegramController {
  constructor(
    private readonly tg: TelegramService,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly config: AppConfig,
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTransaction,
    private readonly audit: AuditService,
  ) {}

  @Get('me/telegram')
  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  async status(@CurrentUser() u: AuthUser) {
    return { linked: await this.tg.isLinked(u.userId), botEnabled: this.tg.enabled, botUsername: this.config.telegram.username };
  }

  @Post('me/telegram/link')
  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Код привязки Telegram (15 минут): открыть бота по ссылке или отправить ему код' })
  link(@CurrentUser() u: AuthUser) {
    return this.tg.linkCode(u.userId);
  }

  @Delete('me/telegram')
  @AllowNoTenant()
  @AllowWhenSuspended()
  @ApiBearerAuth()
  unlink(@CurrentUser() u: AuthUser) {
    return this.tg.unlink(u.userId);
  }

  @Public()
  @Post('telegram/webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Вебхук Telegram (заголовок X-Telegram-Bot-Api-Secret-Token)' })
  webhook(@Headers('x-telegram-bot-api-secret-token') secret: string | undefined, @Body() update: any) {
    const expected = this.config.telegram.webhookSecret;
    if (!expected || secret !== expected) throw Errors.forbidden('Неверный секрет вебхука');
    return this.tg.handleUpdate(update);
  }

  @Public()
  @Throttle(STRICT)
  @Post('auth/telegram-reset/request')
  @HttpCode(200)
  @ApiOperation({ summary: 'Забыли пароль: код в Telegram (если привязан). Ответ всегда одинаковый' })
  async resetRequest(@Body() dto: TgResetRequestDto) {
    const login = this.users.parseLoginOrFail(dto.login);
    const u = await this.users.findByLogin(login);
    if (u?.isActive && (await this.tg.isLinked(u.id)) && this.tg.enabled) {
      await this.tg.sendCode(u.id, 'reset', (code) => `Код для сброса пароля: ${code}\nДействует 10 минут. Если это не вы — ничего не делайте.`);
    }
    return { sent: true, message: 'Если к учётной записи привязан Telegram, код отправлен туда' };
  }

  @Public()
  @Throttle(STRICT)
  @Post('auth/telegram-reset/confirm')
  @HttpCode(200)
  async resetConfirm(@Body() dto: TgResetConfirmDto) {
    const u = await this.users.findByLogin(this.users.parseLoginOrFail(dto.login));
    if (!u) throw Errors.bad('CODE_INVALID', 'Неверный код');
    await this.tg.verifyCode(u.id, 'reset', dto.code);
    await this.users.setPassword(u.id, dto.password);
    await this.sessions.revokeAllForUser(u.id, 'password_reset');
    return { ok: true };
  }

  @Post('staff/transfer-ownership/code')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Код подтверждения передачи владения — в Telegram владельца' })
  async ownershipCode() {
    if (!this.ctx.isOwner) throw Errors.forbidden('Передать владение может только владелец');
    const res = await this.tg.sendCode(this.ctx.userId!, 'ownership', (code) => `Код подтверждения передачи владения магазином: ${code}\nНикому его не сообщайте.`);
    await this.tenantTx.run((tx) => this.audit.log(tx, { action: 'owner.transfer_code', entityType: 'tenant', summary: 'Запрошен код передачи владения', important: true }));
    return res;
  }
}
