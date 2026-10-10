import 'dotenv/config';
import { loadConfig } from '@gitflow/config';
import { createDatabase } from '@gitflow/db';
import { createDurablePersistence } from './persistence.js';
import { createApp } from './app.js';
import { PgBossPublisher, startBoss } from './queue.js';

const config = loadConfig();
const { db, sql } = createDatabase(config.DATABASE_URL);
const boss = await startBoss(config.DATABASE_URL);
const app = createApp({ persistence: createDurablePersistence(db), queue: new PgBossPublisher(boss), analyzerVersion: config.ANALYZER_VERSION });
const shutdown = async () => { await app.close(); await boss.stop(); await sql.end(); process.exit(0); };
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
