import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createHmac, randomBytes } from 'crypto';
import { Server, Socket } from 'socket.io';
import { AppConfig } from '../../config/app.config';
import { AccessService } from '../auth/access.service';
import { TokenService } from '../auth/token.service';
import { rooms } from './rooms';

/**
 * WebSocket (Socket.IO). Комнаты строго внутри магазина: t:{tenantId}:… (ТЗ 2.4.5).
 * Клиент подключается с auth: { token: <access>, storeId?: <текущая точка> }.
 * После обновления access-токена клиент переподключается с новым токеном.
 */
@WebSocketGateway({ path: '/socket.io', cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly access: AccessService,
    private readonly config: AppConfig,
  ) {}

  afterInit(server: Server) {
    server.use(async (socket, next) => {
      try {
        const token = (socket.handshake.auth?.token as string | undefined) ?? '';
        const p = this.tokens.verifyAccess(token);
        if (!p || !p.tid || !p.mid) return next(new Error('UNAUTHORIZED'));
        const session = await this.access.getSession(p.sid);
        if (!session || session.revokedAt) return next(new Error('SESSION_REVOKED'));
        const m = await this.access.getMembershipAccess(p.tid, p.mid, p.sub);
        if (!m || m.status !== 'active') return next(new Error('MEMBERSHIP_DISABLED'));
        socket.data = {
          userId: p.sub,
          tenantId: p.tid,
          membershipId: p.mid,
          sessionId: p.sid,
          allStores: m.allStores,
          storeIds: m.storeIds,
        };
        next();
      } catch (e) {
        next(e as Error);
      }
    });
  }

  async handleConnection(socket: Socket) {
    const d = socket.data as SocketData;
    if (!d?.tenantId) return socket.disconnect(true);
    await socket.join([rooms.tenant(d.tenantId), rooms.user(d.tenantId, d.userId), rooms.session(d.tenantId, d.sessionId)]);
    const storeId = socket.handshake.auth?.storeId as string | undefined;
    if (storeId) await this.joinStore(socket, storeId);
  }

  /** Сменить текущую точку без переподключения. */
  @SubscribeMessage('store:select')
  async selectStore(socket: Socket, storeId: string) {
    for (const r of socket.rooms) if (r.includes(':s:')) await socket.leave(r);
    return this.joinStore(socket, storeId);
  }

  private async joinStore(socket: Socket, storeId: string) {
    const d = socket.data as SocketData;
    if (!d.allStores && !d.storeIds.includes(storeId)) return { ok: false, code: 'FORBIDDEN' };
    await socket.join(rooms.store(d.tenantId, storeId));
    return { ok: true };
  }

  // ── Телефон как сканер для кассы на ПК (ТЗ 11.4) ─────────
  // ПК: scanner:pair → { pairId, token } (QR на экране кассы). Телефон того же магазина: scanner:attach { token }.
  // Телефон: scanner:scan { code, kind } → ПК получает scanner:code. Токен живёт 10 минут, пара — пока открыты сокеты.

  @SubscribeMessage('scanner:pair')
  async scannerPair(socket: Socket, body: { registerId?: string } = {}) {
    const d = socket.data as SocketData;
    const pairId = randomBytes(9).toString('base64url');
    const exp = Date.now() + 10 * 60_000;
    const token = `${pairId}.${exp}.${this.sign(`${d.tenantId}:${pairId}:${exp}`)}`;
    await socket.join(rooms.scanner(d.tenantId, pairId));
    (socket.data as any).scannerPairId = pairId;
    return { ok: true, pairId, token, registerId: body?.registerId ?? null, expiresInSec: 600 };
  }

  @SubscribeMessage('scanner:attach')
  async scannerAttach(socket: Socket, body: { token: string }) {
    const d = socket.data as SocketData;
    const [pairId, exp, sig] = String(body?.token ?? '').split('.');
    if (!pairId || !exp || !sig || Number(exp) < Date.now() || sig !== this.sign(`${d.tenantId}:${pairId}:${exp}`)) {
      return { ok: false, code: 'SCANNER_TOKEN_INVALID', message: 'QR устарел или от другого магазина — обновите его на кассе' };
    }
    const room = rooms.scanner(d.tenantId, pairId);
    await socket.join(room);
    (socket.data as any).scannerRoom = room;
    socket.to(room).emit('scanner:attached', { userId: d.userId, at: new Date().toISOString() });
    return { ok: true, pairId };
  }

  @SubscribeMessage('scanner:scan')
  scannerScan(socket: Socket, body: { code: string; kind?: 'barcode' | 'number' }) {
    const room = (socket.data as any).scannerRoom as string | undefined;
    const code = String(body?.code ?? '').trim().slice(0, 100);
    if (!room) return { ok: false, code: 'NOT_PAIRED' };
    if (!code) return { ok: false, code: 'EMPTY' };
    socket.to(room).emit('scanner:code', { code, kind: body?.kind ?? 'barcode', at: new Date().toISOString() });
    return { ok: true };
  }

  private sign(s: string) {
    return createHmac('sha256', this.config.encryptionKey).update(`scanner:${s}`).digest('base64url').slice(0, 32);
  }

  /** Отключить все сокеты сессии/пользователя (выход, увольнение). */
  disconnectUser(tenantId: string, userId: string) {
    this.server?.in(rooms.user(tenantId, userId)).disconnectSockets(true);
  }
}

export interface SocketData {
  userId: string;
  tenantId: string;
  membershipId: string;
  sessionId: string;
  allStores: boolean;
  storeIds: string[];
}
