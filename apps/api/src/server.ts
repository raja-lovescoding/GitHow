import 'dotenv/config';
import { loadConfig } from '@gitflow/config';
import { createDatabase } from '@gitflow/db';
import { createObjectStorage } from '@gitflow/storage';
import { createDurablePersistence } from './persistence.js';
import { createApp } from './app.js';
import { PgBossPublisher, startBoss } from './queue.js';
import { createSnapshotSourceReader } from './source.js';

const config = loadConfig();
const { db, sql } = createDatabase(config.DATABASE_URL);
const boss = await startBoss(config.DATABASE_URL);
const persistence = createDurablePersistence(db);
const storage = createObjectStorage({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY, bucket: config.S3_BUCKET });
const app = createApp({ persistence, queue: new PgBossPublisher(boss), analyzerVersion: config.ANALYZER_VERSION, sourceReader: createSnapshotSourceReader({ storage, getSnapshot: (snapshotId) => persistence.getSnapshot(snapshotId) }) });
const shutdown = async () => { await app.close(); await boss.stop(); await sql.end(); process.exit(0); };
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
