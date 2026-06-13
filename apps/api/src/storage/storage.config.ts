import { requireEnv } from '../common/env';

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // MinIO and most non-AWS S3 servers require path-style addressing
  // (http://endpoint/bucket/key) rather than virtual-host style
  // (http://bucket.endpoint/key).
  forcePathStyle: boolean;
}

/**
 * Reads S3/MinIO settings from the environment. Throws at startup (via
 * requireEnv) if any required variable is missing, so a misconfigured storage
 * backend fails fast rather than at first upload.
 */
export function loadStorageConfig(): StorageConfig {
  return {
    endpoint: requireEnv('S3_ENDPOINT'),
    region: process.env.S3_REGION || 'us-east-1',
    bucket: requireEnv('S3_BUCKET'),
    accessKeyId: requireEnv('S3_ACCESS_KEY'),
    secretAccessKey: requireEnv('S3_SECRET_KEY'),
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  };
}
