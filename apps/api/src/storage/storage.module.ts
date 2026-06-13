import { Module, Global } from '@nestjs/common';
import { STORAGE_PROVIDER } from './storage-provider.interface';
import { S3StorageProvider } from './s3-storage-provider';
import { loadStorageConfig } from './storage.config';

/**
 * Wires the active StorageProvider. The factory reads env config at startup
 * (loadStorageConfig throws on missing vars), so a misconfigured backend fails
 * fast. Global so any module can inject STORAGE_PROVIDER without re-importing.
 */
@Global()
@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useFactory: () => new S3StorageProvider(loadStorageConfig()),
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
