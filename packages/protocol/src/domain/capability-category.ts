import type { LocalUserId } from './user';

export const UNCATEGORIZED_CATEGORY_ID = 'uncategorized';
export const MEMORY_CATEGORY_ID = 'memory';
export type CapabilityCategoryType = 'skill' | 'mcp';

export interface CapabilityCategory {
  id: string;
  userId: LocalUserId;
  type: CapabilityCategoryType;
  name: string;
  sortOrder: number;
  system: boolean;
  createdAt: string;
  updatedAt: string;
}
