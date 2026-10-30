import { Logger, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { OutboxRegistry } from '../../jobs/outbox.registry';
import { deviceRoom, DevicesService } from './devices.service';

/**
 * WebSocket локального агента (ТЗ 12.1, канал 2): агент сам подключается к серверу с токеном устройства
 * (auth: { token }) и получает задания событием job; статус отправляет событием job.status.
 */
@WebSocketGateway({ path: '/socket.io', namespace: '/agent', cors: { origin: true, credentials: true } })
export class AgentGateway implements OnGatewayInit, OnGatewayConnection, OnModuleInit {
  private readonly logger = new Logger(AgentGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly devices: DevicesService,
    private readonly registry: OutboxRegistry,
  ) {}

  onModuleInit() {
    this.registry.on('print.job_created', async (e) => {
      this.server?.to(deviceRoom(e.tenantId, e.payload.deviceId)).emit('job', e.payload.job);
      if ((await this.server?.in(deviceRoom(e.tenantId, e.payload.deviceId)).fetchSockets())?.length) {
        await this.devices.markSent(e.tenantId, e.payload.deviceId, [e.payload.job.id]);
      }
    });
    this.registry.on('device.revoked', (e) => {
      this.server?.in(deviceRoom(e.tenantId, e.payload.deviceId)).disconnectSockets(true);
    });
  }

  afterInit(server: Server) {
    server.use(async (socket, next) => {
      try {
        const token = (socket.handshake.auth?.token as string | undefined) ?? '';
        const { tenantId, device } = await this.devices.authenticate(token);
        socket.data = { tenantId, deviceId: device.id, token };
        next();
      } catch {
        next(new Error('DEVICE_UNAUTHORIZED'));
      }
    });
  }

  async handleConnection(socket: Socket) {
    const d = socket.data as { tenantId: string; deviceId: string };
    if (!d?.tenantId) return socket.disconnect(true);
    await socket.join(deviceRoom(d.tenantId, d.deviceId));
    const jobs = await this.devices.pending(d.tenantId, d.deviceId);
    for (const j of jobs) socket.emit('job', j);
    await this.devices.markSent(d.tenantId, d.deviceId, jobs.map((j: any) => j.id));
  }

  @SubscribeMessage('job.status')
  async status(socket: Socket, body: { id: string; status: string; error?: string }) {
    try {
      return await this.devices.reportStatus(socket.data.token, body.id, body);
    } catch (e) {
      this.logger.warn(`job.status: ${(e as Error).message}`);
      return { ok: false };
    }
  }

  @SubscribeMessage('heartbeat')
  heartbeat(socket: Socket, body: { agentVersion?: string; info?: Record<string, any> }) {
    return this.devices.heartbeat(socket.data.token, body ?? {});
  }
}
