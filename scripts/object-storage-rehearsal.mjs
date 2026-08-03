import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const apiRequire = createRequire(resolve(ROOT, 'apps/api/package.json'));
const {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = apiRequire('@aws-sdk/client-s3');

const endpoint = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const endpointUrl = new URL(endpoint);
if (!['127.0.0.1', 'localhost', '::1'].includes(endpointUrl.hostname)) {
  throw new Error(
    `Refusing object restore rehearsal against non-loopback endpoint ${endpointUrl.host}.`,
  );
}

const sourceBucket = process.env.S3_BUCKET ?? 'kirindesk-files';
const restoreBucket = `kirindesk-release-restore-${randomUUID().slice(0, 12)}`;
const canaryKey = `_release-rehearsal/${randomUUID()}.txt`;
const canaryBody = Buffer.from(`kirindesk release rehearsal ${randomUUID()}\n`, 'utf8');
const client = new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'kirindesk',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'kirindesk_dev_secret',
  },
});

async function listObjects(bucket) {
  const keys = [];
  let continuationToken;
  do {
    const result = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );
    for (const object of result.Contents ?? []) {
      if (object.Key) keys.push(object.Key);
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys.sort();
}

async function readObject(bucket, key) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`Object ${bucket}/${key} has no body.`);
  return Buffer.from(await result.Body.transformToByteArray());
}

function digest(body) {
  return createHash('sha256').update(body).digest('hex');
}

let restoreBucketCreated = false;
try {
  await client.send(new HeadBucketCommand({ Bucket: sourceBucket }));
  await client.send(
    new PutObjectCommand({ Bucket: sourceBucket, Key: canaryKey, Body: canaryBody }),
  );
  await client.send(new CreateBucketCommand({ Bucket: restoreBucket }));
  restoreBucketCreated = true;

  const sourceManifest = {};
  for (const key of await listObjects(sourceBucket)) {
    const body = await readObject(sourceBucket, key);
    sourceManifest[key] = { bytes: body.length, sha256: digest(body) };
    await client.send(new PutObjectCommand({ Bucket: restoreBucket, Key: key, Body: body }));
  }

  const restoredManifest = {};
  for (const key of await listObjects(restoreBucket)) {
    const body = await readObject(restoreBucket, key);
    restoredManifest[key] = { bytes: body.length, sha256: digest(body) };
  }
  if (JSON.stringify(sourceManifest) !== JSON.stringify(restoredManifest)) {
    throw new Error('Object storage restore manifest does not match the source backup.');
  }
  if (sourceManifest[canaryKey]?.sha256 !== digest(canaryBody)) {
    throw new Error('Synthetic object restore canary failed checksum verification.');
  }

  process.stdout.write(
    JSON.stringify(
      {
        status: 'PASS',
        endpoint: endpointUrl.host,
        restoredObjects: Object.keys(restoredManifest).length,
        canarySha256: digest(canaryBody),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await client
    .send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: canaryKey }))
    .catch(() => undefined);
  if (restoreBucketCreated) {
    for (const key of await listObjects(restoreBucket).catch(() => [])) {
      await client
        .send(new DeleteObjectCommand({ Bucket: restoreBucket, Key: key }))
        .catch(() => undefined);
    }
    await client.send(new DeleteBucketCommand({ Bucket: restoreBucket })).catch(() => undefined);
  }
  client.destroy();
}
