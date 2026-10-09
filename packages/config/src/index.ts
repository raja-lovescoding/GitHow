import { z } from 'zod';
export const configSchema = z.object({ DATABASE_URL: z.string().url().optional(), GITHUB_TOKEN: z.string().optional(), API_PORT: z.coerce.number().int().positive().default(4000), NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:4000') });
export function loadConfig(env: NodeJS.ProcessEnv = process.env) { return configSchema.parse(env); }
