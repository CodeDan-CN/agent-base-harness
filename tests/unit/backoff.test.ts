import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from '../../packages/server-core/src/legacy/worker-supervisor';

describe('M03-014 退避策略有界指数增长', () => {
  it('序列按幂次增长', () => {
    expect(backoffDelayMs(1, 100, 5000)).toBe(100);
    expect(backoffDelayMs(2, 100, 5000)).toBe(200);
    expect(backoffDelayMs(3, 100, 5000)).toBe(400);
    expect(backoffDelayMs(4, 100, 5000)).toBe(800);
  });

  it('超过上限被钳制', () => {
    for (const attempt of [10, 20, 50, 100]) {
      expect(backoffDelayMs(attempt, 100, 5000)).toBeLessThanOrEqual(5000);
    }
  });

  it('attempt<=0 按首次退避', () => {
    expect(backoffDelayMs(0, 100, 5000)).toBe(100);
  });
});
