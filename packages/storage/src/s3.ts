import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

export interface StorageConfig { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string; }
export function createObjectStorage(config: StorageConfig) {
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  return {
    async ensureBucket(): Promise<void> { try { await client.send(new HeadBucketCommand({ Bucket: config.bucket })); } catch { await client.send(new CreateBucketCommand({ Bucket: config.bucket })); } },
    async put(key: string, body: Buffer, contentType: string): Promise<void> { await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentLength: body.byteLength, ContentType: contentType, Metadata: { immutable: 'true' } })); },
    async delete(key: string): Promise<void> { await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })); },
    async get(key: string): Promise<Buffer> { const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key })); if (!result.Body) throw new Error('Object storage returned an empty body.'); return Buffer.from(await Readable.from(result.Body as Readable).reduce<Buffer>((acc, chunk) => Buffer.concat([acc, Buffer.from(chunk as Uint8Array)]), Buffer.alloc(0))); },
  };
}
export type ObjectStorage = ReturnType<typeof createObjectStorage>;
