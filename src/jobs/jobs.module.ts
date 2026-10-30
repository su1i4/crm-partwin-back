import { Global, Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { OutboxProcessor } from './outbox.processor';
import { OutboxRegistry } from './outbox.registry';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  providers: [OutboxService, OutboxRegistry, OutboxProcessor, JobsService],
  exports: [OutboxService, OutboxRegistry, JobsService, OutboxProcessor],
})
export class JobsModule {}
