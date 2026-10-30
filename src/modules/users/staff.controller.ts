import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { CreateInvitationDto, StaffQueryDto, TransferOwnershipDto, UpdateMemberDto } from './dto/staff.dto';
import { StaffService } from './staff.service';

@ApiTags('Сотрудники')
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @RequirePermission('staff.read')
  @ApiOperation({ summary: 'Сотрудники (управляющий видит сотрудников своих точек)' })
  list(@Query() q: StaffQueryDto) {
    return this.staff.list(q);
  }

  @Get('invitations')
  @RequirePermission('staff.manage')
  @ApiOperation({ summary: 'Действующие приглашения' })
  invitations() {
    return this.staff.listInvitations();
  }

  @Post('invitations')
  @RequirePermission('staff.manage')
  @ApiOperation({ summary: 'Пригласить сотрудника: код и ссылка (выдать можно только свои права и свои точки)' })
  invite(@Body() dto: CreateInvitationDto) {
    return this.staff.createInvitation(dto);
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @RequirePermission('staff.manage')
  async revokeInvite(@Param('id', ParseUUIDPipe) id: string) {
    await this.staff.revokeInvitation(id);
  }

  @Post('transfer-ownership')
  @ApiOperation({ summary: 'Передать владение (только владелец, подтверждение паролем)' })
  transfer(@Body() dto: TransferOwnershipDto) {
    return this.staff.transferOwnership(dto);
  }

  @Get(':id')
  @RequirePermission('staff.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.get(id);
  }

  @Patch(':id')
  @RequirePermission('staff.manage')
  @ApiOperation({ summary: 'Изменить роли, точки, склады, должность' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMemberDto) {
    return this.staff.update(id, dto);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @RequirePermission('staff.manage')
  @ApiOperation({ summary: 'Отключить сотрудника: сессии завершаются, история сохраняется' })
  disable(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.disable(id);
  }

  @Post(':id/enable')
  @HttpCode(200)
  @RequirePermission('staff.manage')
  enable(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.enable(id);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @RequirePermission('staff.manage')
  @ApiOperation({ summary: 'Сброс пароля владельцем — выдаёт временный пароль' })
  resetPassword(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.resetPassword(id);
  }
}
