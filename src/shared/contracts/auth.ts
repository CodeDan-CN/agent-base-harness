import { z } from 'zod';
import type { LocalUserId } from '../domain/user';

export const CLIENT_KINDS = ['cli', 'electron'] as const;
export const clientKindSchema = z.enum(CLIENT_KINDS);
export type ClientKind = z.infer<typeof clientKindSchema>;

export const registerRequestSchema = z
  .object({
    loginName: z.string().min(3).max(64),
    password: z.string().min(6).max(1024),
  })
  .strict();
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z
  .object({
    loginName: z.string().min(1).max(64),
    password: z.string().min(1).max(1024),
    clientKind: clientKindSchema,
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface AuthenticatedUser {
  id: LocalUserId;
  loginName: string;
  displayName: string;
}

export interface AuthResult {
  accessToken: string;
  expiresAt: string;
  user: AuthenticatedUser;
}

export interface AuthSessionView {
  id: string;
  expiresAt: string;
  clientKind: ClientKind;
  user: AuthenticatedUser;
}
