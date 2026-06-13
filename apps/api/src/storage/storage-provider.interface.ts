import type { Readable } from 'node:stream';

/**
 * Abstraction over object storage (S3 / MinIO / future providers). The Files
 * module depends only on this interface; the concrete provider is wired by DI
 * token STORAGE_PROVIDER so vendors are never hardcoded into business logic.
 *
 * Keys are caller-generated, tenant-prefixed, opaque strings (e.g.
 * `<tenantId>/<uuid>`). Implementations must not interpret the original file
 * name.
 */
export interface StorageProvider {
  /** Stores the given bytes under key, with the provided content type. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Returns a readable stream of the object's bytes. Rejects if missing. */
  get(key: string): Promise<Readable>;
  /** Deletes the object. Idempotent: succeeds even if key is absent. */
  delete(key: string): Promise<void>;
  /** True if an object exists under key. */
  exists(key: string): Promise<boolean>;
}

/** DI token for the active StorageProvider implementation. */
export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';
