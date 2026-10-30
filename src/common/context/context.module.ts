import { Global, Module } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import { RequestContext } from './request-context';

@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: Request) => (req.headers['x-request-id'] as string) || randomUUID(),
        setup: (cls, req: Request) => {
          cls.set('ip', req.ip);
          cls.set('userAgent', req.headers['user-agent']);
        },
      },
    }),
  ],
  providers: [RequestContext],
  exports: [RequestContext],
})
export class ContextModule {}
