import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { RbacModule } from '../rbac/rbac.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import {
  DocumentLinksController,
  DocumentSetsController,
  PublicDocumentsController,
} from './document-sets.controller';
import { DocumentSetsService } from './document-sets.service';
import { DOCUMENT_PDF_RENDERER, PuppeteerDocumentPdfRenderer } from './document-pdf.renderer';
import { ProductFieldsController, ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [AuthModule, RbacModule, AuditModule, FilesModule, SubscriptionModule],
  controllers: [
    PublicDocumentsController,
    ProductsController,
    ProductFieldsController,
    DocumentSetsController,
    DocumentLinksController,
  ],
  providers: [
    ProductsService,
    DocumentSetsService,
    PuppeteerDocumentPdfRenderer,
    {
      provide: DOCUMENT_PDF_RENDERER,
      useExisting: PuppeteerDocumentPdfRenderer,
    },
  ],
})
export class DocumentWorkbenchModule {}
