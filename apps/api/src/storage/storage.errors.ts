import { InternalServerErrorException } from '@nestjs/common';

/**
 * Raised when the object storage backend (S3/MinIO) fails. Deliberately carries
 * a generic, vendor-neutral message so raw AWS SDK errors — which can include
 * endpoint, region, bucket and other infrastructure details — never reach the
 * client or escape into upper layers unscrubbed. The original error is logged
 * server-side (summary only) at the provider boundary.
 */
export class StorageException extends InternalServerErrorException {
  constructor(operation: string) {
    super(`Storage operation failed: ${operation}`);
  }
}
