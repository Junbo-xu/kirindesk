import { Module } from '@nestjs/common';
import { AuthSessionService } from './auth-session.service';

@Module({
  providers: [AuthSessionService],
  exports: [AuthSessionService],
})
export class AuthSessionModule {}
