import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { validationExceptionFactory } from './common/filters/validation.factory';
import { AppConfig } from './config/app.config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  const config = app.get(AppConfig);

  app.set('trust proxy', 1); // Apache reverse proxy
  app.setGlobalPrefix('api');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '5mb' });
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.enableShutdownHooks();

  const swagger = new DocumentBuilder()
    .setTitle('CRM для магазинов автозапчастей — API')
    .setDescription(
      'Ошибки: { code, message, details }. Списки: ?page&limit&sort → { items, total }. ' +
        'Токен: POST /api/auth/login → accessToken (15 мин), refresh — httpOnly cookie. ' +
        'Заголовок X-Store-Id — текущая точка.',
    )
    .setVersion('0.1')
    .addBearerAuth()
    .build();
  const doc = SwaggerModule.createDocument(app, swagger);
  SwaggerModule.setup('api/docs', app, doc, {
    swaggerOptions: { persistAuthorization: true, withCredentials: true },
  });

  await app.listen(config.port);
  Logger.log(`API: http://localhost:${config.port}/api · Swagger: http://localhost:${config.port}/api/docs`, 'Bootstrap');
}
void bootstrap();
