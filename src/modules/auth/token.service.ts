import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface AccessTokenPayload {
  sub: string; // userId
  sid: string; // sessionId
  tid?: string; // tenantId
  mid?: string; // membershipId
  typ: 'access';
}

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  signAccess(p: Omit<AccessTokenPayload, 'typ'>): string {
    return this.jwt.sign({ ...p, typ: 'access' });
  }

  /** Токен сотрудника платформы (админка) и сеанса поддержки — отдельные типы, тот же ключ с суффиксом. */
  signPlatform(p: { sub: string; typ: 'admin' | 'support'; ssid?: string; tid?: string }, secret: string, ttl: string) {
    return this.jwt.sign(p, { secret, expiresIn: ttl as any });
  }

  verifyPlatform(token: string, secret: string, typ: 'admin' | 'support'): { sub: string; ssid?: string; tid?: string } | null {
    try {
      const p = this.jwt.verify<any>(token, { secret });
      return p.typ === typ ? p : null;
    } catch {
      return null;
    }
  }

  verifyAccess(token: string): AccessTokenPayload | null {
    try {
      const p = this.jwt.verify<AccessTokenPayload>(token);
      return p.typ === 'access' ? p : null;
    } catch {
      return null;
    }
  }
}
