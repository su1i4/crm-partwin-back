import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { Public } from './common/decorators/auth.decorators';

@ApiTags('Служебное')
@Controller('health')
export class HealthController {
  constructor(private readonly ds: DataSource) {}

  @Public()
  @Get()
  async health() {
    await this.ds.query('SELECT 1');
    return { status: 'ok', time: new Date().toISOString() };
  }
}
