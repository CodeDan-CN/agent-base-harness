/** system.health 响应契约（zod 驱动，全部脱敏）。 */

import { z } from 'zod';
import { runtimeWorkerStatusSchema } from './ipc';

export const interpreterStatusSchema = z.enum(['available', 'missing', 'error', 'unsupported']);
export type InterpreterStatus = z.infer<typeof interpreterStatusSchema>;

export const interpreterHealthSchema = z.object({
  status: interpreterStatusSchema,
  version: z.string().nullable(),
});
export type InterpreterHealth = z.infer<typeof interpreterHealthSchema>;

export const healthSnapshotSchema = z.object({
  worker: z.object({
    status: runtimeWorkerStatusSchema,
    generation: z.number(),
  }),
  database: z.object({
    status: z.enum(['ok', 'error']),
    schemaVersion: z.number(),
  }),
  credential: z.object({
    status: z.enum(['configured', 'unavailable', 'error']),
  }),
  skillRoot: z.object({
    status: z.enum(['ok', 'missing', 'error']),
    invalidCount: z.number(),
  }),
  interpreters: z.object({
    node: interpreterHealthSchema,
    python: interpreterHealthSchema,
    shell: interpreterHealthSchema,
  }),
});

export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;
