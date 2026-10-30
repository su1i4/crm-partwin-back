import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { CompleteOnboardingDto } from './dto/onboarding.dto';
import { OnboardingService } from './onboarding.service';

@ApiTags('Мастер первого запуска')
@ApiBearerAuth()
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  @ApiOperation({ summary: 'Данные для мастера: типы магазинов, марки, чек-лист' })
  state() {
    return this.onboarding.state();
  }

  @Get('checklist')
  @ApiOperation({ summary: 'Чек-лист «Первые шаги»' })
  checklist() {
    return this.onboarding.checklist();
  }

  @Post('complete')
  @RequirePermission('settings.manage')
  @ApiOperation({
    summary: 'Завершить мастер: тип магазина → готовые категории, типы деталей, настройки; курс; кошельки',
  })
  complete(@Body() dto: CompleteOnboardingDto) {
    return this.onboarding.complete(dto);
  }
}
