import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowWhenSuspended, AuthUser, CurrentUser } from '../../common/decorators/auth.decorators';
import { MarkReadDto, NotificationsQueryDto, SetChannelsDto } from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('Уведомления')
@ApiBearerAuth()
@AllowWhenSuspended()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Мои уведомления (колокольчик) + число непрочитанных' })
  list(@CurrentUser() u: AuthUser, @Query() q: NotificationsQueryDto) {
    return this.service.list(u.userId, { unreadOnly: q.unreadOnly, page: q.page, limit: q.limit });
  }

  @Post('read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Отметить прочитанными (ids) или все' })
  async read(@CurrentUser() u: AuthUser, @Body() dto: MarkReadDto) {
    await this.service.markRead(u.userId, dto.ids?.length ? dto.ids : 'all');
  }

  @Get('channels')
  @ApiOperation({ summary: 'Каналы уведомлений по событиям' })
  channels(@CurrentUser() u: AuthUser) {
    return this.service.getChannels(u.userId);
  }

  @Put('channels')
  @ApiOperation({ summary: 'Выбрать каналы для событий' })
  setChannels(@CurrentUser() u: AuthUser, @Body() dto: SetChannelsDto) {
    return this.service.setChannels(u.userId, dto.channels);
  }
}
