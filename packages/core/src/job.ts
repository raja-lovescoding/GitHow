import { z } from 'zod';
export const ingestionJobPayloadSchema = z.object({ jobId: z.string().uuid(), snapshotId: z.string().uuid(), owner: z.string(), name: z.string(), sha: z.string().regex(/^[0-9a-f]{40}$/i), analyzerVersion: z.string() });
export type IngestionJobPayload = z.infer<typeof ingestionJobPayloadSchema>;
export const analysisJobPayloadSchema = z.object({ jobId: z.string().uuid(), snapshotId: z.string().uuid(), archiveKey: z.string().min(1), manifestKey: z.string().min(1), sha: z.string().regex(/^[0-9a-f]{40}$/i), analyzerVersion: z.string(), schemaVersion: z.string() });
export type AnalysisJobPayload = z.infer<typeof analysisJobPayloadSchema>;
