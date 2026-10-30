import { Global, Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { UsersService } from './users.service';

@Global()
@Module({
  imports: [RolesModule],
  controllers: [StaffController],
  providers: [UsersService, StaffService],
  exports: [UsersService, StaffService],
})
export class UsersModule {}
