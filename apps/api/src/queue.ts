import { PgBoss } from 'pg-boss';
import type { AnalysisJobPayload, IngestionJobPayload } from '@gitflow/core';
import type { QueuePublisher } from './persistence.js';

export const ingestionQueueName = 'repository-ingestion';
export const analysisQueueName = 'repository-analysis';
export class PgBossPublisher implements QueuePublisher {
  constructor(private readonly boss: PgBoss) {}
  async publish(payload: IngestionJobPayload): Promise<void> { await this.boss.send(ingestionQueueName, payload, { singletonKey: `ingest:${payload.snapshotId}` }); }
}
export interface AnalysisQueuePublisher { publishAnalysis(payload: AnalysisJobPayload): Promise<void>; }
export class PgBossAnalysisPublisher implements AnalysisQueuePublisher {
  constructor(private readonly boss: PgBoss) {}
  async publishAnalysis(payload: AnalysisJobPayload): Promise<void> { await this.boss.send(analysisQueueName, payload, { singletonKey: `analysis:${payload.snapshotId}:${payload.analyzerVersion}:${payload.schemaVersion}` }); }
}
export async function startBoss(databaseUrl: string): Promise<PgBoss> { const boss = new PgBoss(databaseUrl); await boss.start(); await boss.createQueue(ingestionQueueName, { retryLimit: 3, retryDelay: 30 }); await boss.createQueue(analysisQueueName, { retryLimit: 3, retryDelay: 30 }); return boss; }
