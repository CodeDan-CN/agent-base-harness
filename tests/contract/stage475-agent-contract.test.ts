import { describe, expect, it } from 'vitest';
import { API_VERSION, commandRequestSchema, queryRequestSchema } from '../../packages/protocol/src/contracts/schemas';

describe('4.7.5 gateway contract', () => {
  it('uses protocol v2 and requires an agent for new sessions', () => {
    expect(API_VERSION).toBe(2);
    expect(
      commandRequestSchema.safeParse({
        apiVersion: 2,
        method: 'session.create',
        params: { title: 'missing owner' },
      }).success,
    ).toBe(false);
    expect(
      commandRequestSchema.safeParse({
        apiVersion: 2,
        method: 'session.create',
        params: { title: 'owned', agentId: 'dylan' },
      }).success,
    ).toBe(true);
  });

  it('exposes separate profile and home commands plus navigation query', () => {
    expect(
      commandRequestSchema.safeParse({
        apiVersion: 2,
        method: 'agent.create',
        params: {
          name: '金融研究员',
          description: '',
          avatarKey: null,
          instructions: '',
          defaultModelId: null,
          permissionPreset: 'guarded',
          expectedRevision: 0,
        },
      }).success,
    ).toBe(true);
    expect(
      commandRequestSchema.safeParse({
        apiVersion: 2,
        method: 'agent.home.add',
        params: { agentId: 'finance', expectedRevision: 1 },
      }).success,
    ).toBe(true);
    expect(
      queryRequestSchema.safeParse({
        apiVersion: 2,
        method: 'agent.navigation',
        params: { sessionsPerAgent: 20 },
      }).success,
    ).toBe(true);
  });
});
