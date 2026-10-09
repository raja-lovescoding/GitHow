import { PgBoss } from 'pg-boss';

const boss = new PgBoss(process.env.DATABASE_URL ?? 'postgres://gitflow:gitflow@localhost:5432/gitflow');
await boss.start();
await boss.createQueue('repository-ingestion');
await boss.work('repository-ingestion', async (jobs) => {
  console.log(JSON.stringify({ event: 'ingestion_job_received', jobId: jobs[0]?.id, stage: 'queued' }));
  // Archive download, safe manifesting, and object storage are owned by this process.
  // The API never executes repository code or performs archive parsing in a request.
});
console.log(JSON.stringify({ event: 'worker_started', queue: 'repository-ingestion' }));
