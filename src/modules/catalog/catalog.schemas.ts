import { z } from 'zod';

const revisionSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, 'Ревизия должна быть неотрицательным целым числом')
  .default('0');

export const catalogSnapshotQuerySchema = z.object({
  cursor: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(50).max(1000).default(500),
  snapshotRevision: revisionSchema.optional(),
  epoch: z.string().trim().min(1).max(100).optional(),
});

export const catalogChangesQuerySchema = z.object({
  afterRevision: revisionSchema,
  limit: z.coerce.number().int().min(50).max(1000).default(500),
  epoch: z.string().trim().min(1).max(100).optional(),
});

export type CatalogSnapshotQuery = z.infer<typeof catalogSnapshotQuerySchema>;
export type CatalogChangesQuery = z.infer<typeof catalogChangesQuerySchema>;
