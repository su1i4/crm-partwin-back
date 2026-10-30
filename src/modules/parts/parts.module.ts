import { Global, Module } from '@nestjs/common';
import { CrossesService } from './crosses.service';
import { PartsController } from './parts.controller';

@Global()
@Module({ controllers: [PartsController], providers: [CrossesService], exports: [CrossesService] })
export class PartsModule {}
