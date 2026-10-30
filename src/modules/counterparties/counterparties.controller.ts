import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { PageQueryDto } from '../../common/dto/pagination.dto';
import { COUNTERPARTY_ROLES, CounterpartyRole } from './entities/counterparty.entity';
import { CounterpartiesService } from './counterparties.service';

class CounterpartyDto {
  @ApiPropertyOptional({ example: 'ОсОО «Авто Импорт»' }) @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional({ enum: ['person', 'company'] }) @IsOptional() @IsIn(['person', 'company']) kind?: 'person' | 'company';
  @ApiPropertyOptional({ example: '0555123456' }) @IsOptional() @IsString() @Length(0, 30) phone?: string | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) phones?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 20) inn?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 300) address?: string | null;
  @ApiPropertyOptional({ enum: COUNTERPARTY_ROLES, isArray: true }) @IsOptional() @IsArray() @IsIn(COUNTERPARTY_ROLES, { each: true }) roles?: CounterpartyRole[];
  @ApiPropertyOptional({ example: { telegram: '@supplier', whatsapp: '996555123456' } }) @IsOptional() @IsObject() messengers?: Record<string, string>;
  @ApiPropertyOptional({ example: { currency: 'USD', paymentDelayDays: 14, leadTimeDays: 7 } }) @IsOptional() @IsObject() supplierTerms?: Record<string, any>;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 2000) note?: string | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() groupId?: string | null;
  @ApiPropertyOptional({ example: '1990-05-17' }) @IsOptional() @IsDateString() birthday?: string | null;
  @ApiPropertyOptional({ description: 'Свой тип цены (иначе — из группы)' }) @IsOptional() @IsUUID() priceTypeId?: string | null;
  @ApiPropertyOptional({ example: '5' }) @IsOptional() @IsNumberString() discountPercent?: string | null;
  @ApiPropertyOptional({ example: '20000', description: 'Лимит долга, сом; 0 — в долг нельзя' }) @IsOptional() @IsNumberString() debtLimit?: string | null;
  @ApiPropertyOptional({ example: 30 }) @IsOptional() @IsInt() @Min(0) @Max(3650) debtDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() confirmDuplicatePhone?: boolean;
}

class UpdateCounterpartyDto extends CounterpartyDto {
  @ApiProperty() @IsInt() version: number;
}

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

class CounterpartyQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: COUNTERPARTY_ROLES }) @IsOptional() @IsIn(COUNTERPARTY_ROLES) role?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() groupId?: string;
  @ApiPropertyOptional({ description: 'Сегмент: не покупал N дней' }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) noPurchaseDays?: number;
  @ApiPropertyOptional({ description: 'Сегмент: купил больше, сом' }) @IsOptional() @IsNumberString() minTotal?: string;
  @ApiPropertyOptional({ description: 'Сегмент: владельцы марки' }) @IsOptional() @IsUUID() makeId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() hasDebt?: boolean;
}

class GroupDto {
  @ApiPropertyOptional({ example: 'Таксопарки' }) @IsOptional() @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() priceTypeId?: string | null;
  @ApiPropertyOptional({ example: '3' }) @IsOptional() @IsNumberString() discountPercent?: string;
  @ApiPropertyOptional({ example: '50000' }) @IsOptional() @IsNumberString() debtLimit?: string | null;
  @ApiPropertyOptional({ example: 30 }) @IsOptional() @IsInt() @Min(0) debtDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() sort?: number;
}
class UpdateGroupDto extends GroupDto {
  @ApiProperty() @IsInt() version: number;
}

class ContactDto {
  @ApiProperty() @IsString() @Length(1, 200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 100) position?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 30) phone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) note?: string | null;
}
class ContactsDto {
  @ApiProperty({ type: [ContactDto] }) @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ContactDto) contacts: ContactDto[];
}

class VehicleDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() makeId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() modelId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() generationId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() modificationId?: string | null;
  @ApiPropertyOptional({ example: 'Камри 40 белая' }) @IsOptional() @IsString() @Length(1, 200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 20) vin?: string | null;
  @ApiPropertyOptional({ example: 'ACV40' }) @IsOptional() @IsString() @Length(0, 30) bodyCode?: string | null;
  @ApiPropertyOptional({ example: 2009 }) @IsOptional() @IsInt() @Min(1950) @Max(2100) year?: number | null;
  @ApiPropertyOptional({ example: '01 KG 123 ABC' }) @IsOptional() @IsString() @Length(0, 20) plate?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) mileage?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) note?: string | null;
}
class UpdateVehicleDto extends VehicleDto {
  @ApiProperty() @IsInt() version: number;
}

class MergeCounterpartiesDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(20) @IsUUID('4', { each: true }) duplicateIds: string[];
}

@ApiTags('Клиенты и контрагенты')
@Controller()
export class CounterpartiesController {
  constructor(private readonly service: CounterpartiesService) {}

  @Get('counterparties')
  @RequireAnyPermission('customers.read', 'purchasing.suppliers', 'stock.receive', 'pos.use')
  @ApiOperation({ summary: 'Контрагенты: поиск по имени, телефону, госномеру; сегменты' })
  list(@Query() q: CounterpartyQueryDto) {
    return this.service.list(q);
  }

  @Get('counterparties/duplicates')
  @RequirePermission('customers.write')
  @ApiOperation({ summary: 'Возможные дубли по телефону' })
  duplicates() {
    return this.service.duplicates();
  }

  @Get('counterparties/:id')
  @RequireAnyPermission('customers.read', 'purchasing.suppliers', 'stock.receive', 'pos.use')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Get('counterparties/:id/card')
  @RequireAnyPermission('customers.read', 'pos.use')
  @ApiOperation({ summary: 'Карточка: условия, покупки, средний чек, долги по валютам и машинам, гараж, контакты' })
  card(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.card(id);
  }

  @Post('counterparties')
  @RequireAnyPermission('customers.write', 'purchasing.suppliers', 'stock.receive')
  create(@Body() dto: CounterpartyDto) {
    return this.service.create(dto);
  }

  @Patch('counterparties/:id')
  @RequireAnyPermission('customers.write', 'purchasing.suppliers')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCounterpartyDto) {
    return this.service.update(id, dto.version, dto);
  }

  @Post('counterparties/:id/merge')
  @RequirePermission('customers.write')
  @ApiOperation({ summary: 'Объединить дубли в эту карточку' })
  merge(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MergeCounterpartiesDto) {
    return this.service.merge(id, dto.duplicateIds);
  }

  @Put('counterparties/:id/contacts')
  @RequireAnyPermission('customers.write', 'purchasing.suppliers')
  contacts(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ContactsDto) {
    return this.service.setContacts(id, dto.contacts);
  }

  @Get('counterparties/:id/vehicles')
  @RequireAnyPermission('customers.read', 'pos.use')
  @ApiOperation({ summary: 'Гараж клиента' })
  vehicles(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.vehicles(id);
  }

  @Post('counterparties/:id/vehicles')
  @RequireAnyPermission('customers.write', 'pos.use')
  addVehicle(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VehicleDto) {
    return this.service.addVehicle(id, dto);
  }

  @Patch('customer-vehicles/:id')
  @RequireAnyPermission('customers.write', 'pos.use')
  updateVehicle(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVehicleDto) {
    return this.service.updateVehicle(id, dto.version, dto);
  }

  @Delete('customer-vehicles/:id')
  @HttpCode(204)
  @RequirePermission('customers.write')
  async removeVehicle(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.service.removeVehicle(id, version);
  }

  @Get('customer-vehicles/:id/history')
  @RequireAnyPermission('customers.read', 'pos.use')
  @ApiOperation({ summary: 'История покупок по машине' })
  vehicleHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.vehicleHistory(id);
  }

  @Get('counterparty-groups')
  @RequireAnyPermission('customers.read', 'pos.use')
  groups() {
    return this.service.listGroups();
  }

  @Post('counterparty-groups')
  @RequirePermission('customers.write')
  createGroup(@Body() dto: GroupDto) {
    return this.service.createGroup({ ...dto, name: dto.name ?? '' });
  }

  @Patch('counterparty-groups/:id')
  @RequirePermission('customers.write')
  updateGroup(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGroupDto) {
    return this.service.updateGroup(id, dto.version, dto);
  }

  @Delete('counterparty-groups/:id')
  @HttpCode(204)
  @RequirePermission('customers.write')
  async removeGroup(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.service.removeGroup(id, version);
  }
}
