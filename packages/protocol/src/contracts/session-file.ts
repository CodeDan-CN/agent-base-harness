import { z } from 'zod';

export const MAX_SESSION_FILE_BYTES = 20 * 1024 * 1024;

export const sessionFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      name !== '.' &&
      name !== '..' &&
      !/[\\/]/.test(name) &&
      !Array.from(name).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      new TextEncoder().encode(name).length <= 255,
    'Invalid file name',
  );

export const sessionFileUploadSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    name: sessionFileNameSchema,
    bytes: z.instanceof(ArrayBuffer).refine((bytes) => bytes.byteLength <= MAX_SESSION_FILE_BYTES),
  })
  .strict();

export const uploadedSessionFileSchema = z
  .object({
    name: sessionFileNameSchema,
    path: z.string().min(1),
    size: z.number().int().nonnegative().max(MAX_SESSION_FILE_BYTES),
  })
  .strict();

export type UploadedSessionFile = z.infer<typeof uploadedSessionFileSchema>;
