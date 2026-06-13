import { Readable } from 'node:stream';
import type { StorageProvider } from '../src/storage/storage-provider.interface';

/**
 * In-memory StorageProvider for integration tests. Keeps uploaded bytes in a
 * Map so tests exercise the full upload/download flow without a real MinIO/S3
 * backend (keeps CI hermetic). Mirrors S3StorageProvider semantics: delete is
 * idempotent, get rejects on missing key.
 */
export class FakeStorageProvider implements StorageProvider {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async get(key: string): Promise<Readable> {
    const obj = this.objects.get(key);
    if (!obj) {
      throw new Error(`FakeStorage: missing key ${key}`);
    }
    return Readable.from(obj.body);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}
