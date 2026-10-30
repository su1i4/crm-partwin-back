import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppConfig } from './app.config';
import { validateEnv } from './env.validation';

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true })],
  providers: [{ provide: AppConfig, inject: [ConfigService], useFactory: (c: ConfigService) => new AppConfig(c) }],
  exports: [AppConfig],
})
export class AppConfigModule {}
