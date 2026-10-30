import { Global, Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeRelayService } from './realtime-relay.service';
import { RealtimeService } from './realtime.service';

@Global()
@Module({
  providers: [RealtimeGateway, RealtimeService, RealtimeRelayService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
