import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig } from '../../config/app.config';
import { AccessService } from './access.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MeService } from './me.service';
import { ScopeService } from './scope.service';
import { SessionsService } from './sessions.service';
import { TokenService } from './token.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfig],
      useFactory: (c: AppConfig) => ({
        secret: c.jwtAccessSecret,
        signOptions: { expiresIn: c.jwtAccessTtl as any },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionsService, TokenService, AccessService, ScopeService, MeService],
  exports: [AuthService, SessionsService, TokenService, AccessService, ScopeService, JwtModule],
})
export class AuthModule {}
