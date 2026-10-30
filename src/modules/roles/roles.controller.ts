import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { RolesService } from './roles.service';

@ApiTags('Роли и разрешения')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequireAnyPermission('roles.manage', 'staff.read')
  @ApiOperation({ summary: 'Каталог разрешений по группам' })
  catalog() {
    return this.roles.catalog();
  }

  @Get()
  @RequireAnyPermission('roles.manage', 'staff.read')
  @ApiOperation({ summary: 'Роли магазина' })
  list() {
    return this.roles.list();
  }

  @Get(':id')
  @RequireAnyPermission('roles.manage', 'staff.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.roles.get(id);
  }

  @Post()
  @RequirePermission('roles.manage')
  @ApiOperation({ summary: 'Создать роль (только из своих разрешений)' })
  create(@Body() dto: CreateRoleDto) {
    return this.roles.create(dto);
  }

  @Patch(':id')
  @RequirePermission('roles.manage')
  @ApiOperation({ summary: 'Изменить роль' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) {
    return this.roles.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('roles.manage')
  @ApiQuery({ name: 'version', type: Number })
  @ApiOperation({ summary: 'Удалить свою роль (если не назначена)' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.roles.remove(id, version);
  }
}
