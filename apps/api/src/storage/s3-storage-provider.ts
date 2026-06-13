import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { StorageProvider } from './storage-provider.interface';
import type { StorageConfig } from './storage.config';
import { StorageException } from './storage.errors';

/**
 * S3-compatible StorageProvider. Works against AWS S3 and MinIO; for MinIO and
 * other self-hosted servers, forcePathStyle must be true and endpoint points at
 * the server. Credentials and bucket come from StorageConfig (env-derived).
 *
 * Every backend call is wrapped so a raw AWS SDK error — which can embed
 * endpoint, region, bucket and other infrastructure metadata — is never allowed
 * to bubble up. Failures are logged server-side (message only, no full object)
 * and re-thrown as a generic StorageException.
 */
export class S3StorageProvider implements StorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  // Logs a scrubbed summary of a backend failure and throws a vendor-neutral
  // error. Only err.name + err.message are logged (never the full SDK error
  // object, which may carry request metadata); the key is included for
  // server-side debugging but never reaches the client.
  private fail(operation: string, key: string, err: unknown): never {
    const name = (err as { name?: string }).name ?? 'Error';
    const message = (err as { message?: string }).message ?? String(err);
    this.logger.error(`S3 ${operation} failed for key=${key}: ${name}: ${message}`);
    throw new StorageException(operation);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    } catch (err) {
      this.fail('put', key, err);
    }
  }

  async get(key: string): Promise<Readable> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      // In Node.js the SDK returns the body as a Readable stream.
      return res.Body as Readable;
    } catch (err) {
      this.fail('get', key, err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      // DeleteObject is idempotent on S3: deleting a missing key returns 204.
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      this.fail('delete', key, err);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === 'NotFound') {
        return false;
      }
      // A non-404 failure (auth, network, misconfig) is a real error, not
      // "absent" — scrub and rethrow like the other operations.
      this.fail('exists', key, err);
    }
  }
}
