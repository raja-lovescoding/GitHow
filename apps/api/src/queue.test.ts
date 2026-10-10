import { describe, expect, it, vi } from 'vitest';
import { PgBossAnalysisPublisher } from './queue.js';

describe('analysis queue contract', () => {
  it('uses a snapshot/version singleton key for duplicate deliveries', async () => {
    const send = vi.fn(async () => 'job-id');
    const publisher = new PgBossAnalysisPublisher({ send } as never);
    await publisher.publishAnalysis({ jobId: '00000000-0000-0000-0000-000000000001', snapshotId: '00000000-0000-0000-0000-000000000002', archiveKey: 'a', manifestKey: 'm', sha: 'a'.repeat(40), analyzerVersion: 'v1', schemaVersion: 'rig-v1' });
    expect(send).toHaveBeenCalledWith('repository-analysis', expect.anything(), { singletonKey: 'analysis:00000000-0000-0000-0000-000000000002:v1:rig-v1' });
  });
});
