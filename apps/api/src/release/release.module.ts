import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { WorkflowReleaseModeGuard } from './workflow-release-mode.guard';
import { WorkflowReleaseModeService } from './workflow-release-mode.service';

@Global()
@Module({
  providers: [
    WorkflowReleaseModeService,
    {
      provide: APP_GUARD,
      useClass: WorkflowReleaseModeGuard,
    },
  ],
  exports: [WorkflowReleaseModeService],
})
export class ReleaseModule {}
