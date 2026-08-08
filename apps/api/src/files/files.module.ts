import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FileDownloadController } from './file-download.controller';
import { FilesService } from './files.service';
import { RbacModule } from '../rbac/rbac.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [RbacModule, AuditModule, AuthModule],
  // FileDownloadController is listed first so its literal `download` route is
  // registered before FilesController's `:id` param route (otherwise
  // GET /api/files/download would hit :id and fail ParseUUIDPipe).
  controllers: [FileDownloadController, FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
