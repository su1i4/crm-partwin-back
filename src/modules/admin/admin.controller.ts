import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Response } from 'express';
import { Public } from '../../common/decorators/auth.decorators';
import { AdminGuard, AdminRole, AdminService, AdminUser, SupportOwnerService } from './admin.service';
import { TenantExportService } from './tenant-export.service';

export class AdminLoginDto {
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() password: string;
  @ApiProperty({ description: 'Код из приложения-аутентификатора' }) @IsString() @Length(6, 6) code: string;
}
export class SubscriptionDto {
  @ApiPropertyOptional({ enum: ['trial', 'active', 'suspended'] }) @IsOptional() @IsIn(['trial', 'active', 'suspended']) status?: 'trial' | 'active' | 'suspended';
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsDateString() subscriptionUntil?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() plan?: string;
  @ApiPropertyOptional({ example: { stores: 3, registers: 6, staff: 15 } }) @IsOptional() @IsObject() limits?: Record<string, number>;
  @ApiPropertyOptional({ description: 'Заметка об оплате' }) @IsOptional() @IsString() note?: string;
}
export class SupportRequestDto {
  @ApiProperty() @IsString() @Length(5, 500) reason: string;
  @ApiPropertyOptional({ description: 'Аварийно — без согласия, с уведомлением владельцу' }) @IsOptional() @IsBoolean() emergency?: boolean;
  @ApiPropertyOptional({ description: 'Изменения — если владелец разрешил' }) @IsOptional() @IsBoolean() canWrite?: boolean;
}
export class GrantDto {
  @ApiPropertyOptional({ default: 24 }) @IsOptional() @IsInt() @Min(1) @Max(72) hours?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canWrite?: boolean;
  @ApiPropertyOptional({ description: 'Показывать закупочные цены, маржу и деньги' }) @IsOptional() @IsBoolean() showMoney?: boolean;
}

/** Админка платформы (ТЗ 24) — отдельные учётные записи, свой токен. */
@ApiTags('Админка платформы')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('auth/login')
  @ApiOperation({ summary: 'Вход сотрудника платформы: пароль + код 2FA' })
  login(@Body() dto: AdminLoginDto) {
    return this.admin.login(dto.email, dto.password, dto.code);
  }

  @Public() @UseGuards(AdminGuard) @Get('tenants')
  tenants(@Query('search') search?: string, @Query('status') status?: string) {
    return this.admin.tenants({ search, status });
  }

  @Public() @UseGuards(AdminGuard) @Get('tenants/:id')
  tenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.tenant(id);
  }

  @Public() @UseGuards(AdminGuard) @AdminRole('admin') @Patch('tenants/:id/subscription')
  @ApiOperation({ summary: 'Подписка вручную: статус, дата окончания, тариф, лимиты' })
  subscription(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubscriptionDto) {
    return this.admin.setSubscription(req.admin as AdminUser, id, dto);
  }

  @Public() @UseGuards(AdminGuard) @Post('tenants/:id/support')
  @ApiOperation({ summary: 'Вход поддержки: по разрешению владельца — сразу, иначе запрос; аварийно — с причиной' })
  support(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SupportRequestDto) {
    return this.admin.requestSupport(req.admin, id, dto);
  }

  @Public() @UseGuards(AdminGuard) @Post('support/:sessionId/enter')
  enter(@Req() req: any, @Param('sessionId', ParseUUIDPipe) id: string) {
    return this.admin.enterSupport(req.admin, id);
  }

  @Public() @UseGuards(AdminGuard) @Post('support/:sessionId/end')
  end(@Req() req: any, @Param('sessionId', ParseUUIDPipe) id: string) {
    return this.admin.endSupport(req.admin, id);
  }

  @Public() @UseGuards(AdminGuard) @Get('dictionaries/:kind')
  dictionary(@Param('kind') kind: 'makes' | 'brands' | 'synonyms' | 'wmi', @Query('q') q?: string) {
    return this.admin.dictionary(kind, q);
  }

  @Public() @UseGuards(AdminGuard) @AdminRole('admin') @Put('dictionaries/:kind')
  saveDictionary(@Req() req: any, @Param('kind') kind: 'makes' | 'brands' | 'synonyms' | 'wmi', @Body() row: Record<string, any>) {
    return this.admin.saveDictionary(req.admin, kind, row);
  }

  @Public() @UseGuards(AdminGuard) @AdminRole('admin') @Post('dictionaries/vehicles/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Импорт CSV/Excel марок, моделей, поколений, модификаций, кодов кузова' })
  importVehicles(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    return this.admin.importVehicles(req.admin, file);
  }

  @Public() @UseGuards(AdminGuard) @Get('monitoring')
  @ApiOperation({ summary: 'Мониторинг: outbox, неотправленные офлайн-чеки, зависшие импорты, расхождения остатков, качество OCR' })
  monitoring() {
    return this.admin.monitoring();
  }

  @Public() @UseGuards(AdminGuard) @AdminRole('admin') @Get('journal')
  journal(@Query('adminId') adminId?: string, @Query('tenantId') tenantId?: string) {
    return this.admin.journal({ adminId, tenantId });
  }
}

/** Владелец магазина: доступ поддержки и полная выгрузка данных. */
@ApiTags('Поддержка и выгрузка магазина')
@Controller()
export class SupportOwnerController {
  constructor(
    private readonly support: SupportOwnerService,
    private readonly exporter: TenantExportService,
  ) {}

  @Get('support')
  @ApiOperation({ summary: 'Разрешение поддержке, запросы, активный сеанс (баннер)' })
  state() {
    return this.support.state();
  }

  @Post('support/grant')
  @ApiOperation({ summary: '«Разрешить доступ поддержке на 24 часа»' })
  grant(@Body() dto: GrantDto) {
    return this.support.grant(dto);
  }

  @Post('support/revoke')
  revoke() {
    return this.support.revoke();
  }

  @Post('support/requests/:id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GrantDto) {
    return this.support.approve(id, dto);
  }

  @Post('support/requests/:id/decline')
  decline(@Param('id', ParseUUIDPipe) id: string) {
    return this.support.decline(id);
  }

  @Get('export/full')
  @ApiOperation({ summary: 'Полная выгрузка магазина (Excel + JSON одним архивом) — владелец' })
  async full(@Res({ passthrough: true }) res: Response) {
    const { name, stream } = await this.exporter.archiveForCurrent();
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` });
    return new StreamableFile(stream);
  }
}
