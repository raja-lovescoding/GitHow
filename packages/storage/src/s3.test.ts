import { describe, expect, it } from 'vitest';
import { createObjectStorage } from './s3.js';

describe('S3 storage integration', () => {
  it.skipIf(process.env.INTEGRATION !== '1')('uploads and retrieves an object from MinIO', async () => {
    const storage = createObjectStorage({ endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000', region: 'us-east-1', accessKeyId: 'minio', secretAccessKey: 'miniosecret', bucket: `gitflow-test-${process.pid}` });
    await storage.ensureBucket();
    const key = `tests/${Date.now()}.txt`;
    await storage.put(key, Buffer.from('durable'), 'text/plain');
    await expect(storage.get(key)).resolves.toEqual(Buffer.from('durable'));
    await storage.delete(key);
  });
});
