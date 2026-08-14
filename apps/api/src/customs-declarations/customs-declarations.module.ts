import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { RbacModule } from '../rbac/rbac.module';
import { CustomsDeclarationsController } from './customs-declarations.controller';
import { CustomsDeclarationsService } from './customs-declarations.service';
import { CUSTOMS_PDF_RENDERER, PuppeteerCustomsPdfRenderer } from './customs-pdf.renderer';

@Module({
  imports: [AuthModule, RbacModule, AuditModule, FilesModule],
  controllers: [CustomsDeclarationsController],
  providers: [
    CustomsDeclarationsService,
    PuppeteerCustomsPdfRenderer,
    { provide: CUSTOMS_PDF_RENDERER, useExisting: PuppeteerCustomsPdfRenderer },
  ],
})
export class CustomsDeclarationsModule {}
