import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientId } from '../../packages/protocol/src/client/client-id';

afterEach(() => vi.unstubAllGlobals());

describe('client UUID compatibility', () => {
  it('uses native randomUUID when available', () => {
    const randomUUID = vi.fn(() => '3c8d0bc3-6478-4617-b2c9-31578741672c');
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', { randomUUID, getRandomValues });

    expect(createClientId()).toBe('3c8d0bc3-6478-4617-b2c9-31578741672c');
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it.each([
    [Array.from({ length: 16 }, (_, index) => index), '00010203-0405-4607-8809-0a0b0c0d0e0f'],
    [Array<number>(16).fill(255), 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  ])('preserves random bytes and sets UUID v4 version and variant bits', (bytes, expected) => {
    vi.stubGlobal('crypto', {
      getRandomValues: (target: Uint8Array) => {
        target.set(bytes);
        return target;
      },
    });

    expect(createClientId()).toBe(expected);
  });

  it('generates independent session and idempotency IDs without randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const ids = Array.from({ length: 256 }, () => createClientId());

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('fails clearly when no cryptographic random source is available', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => createClientId()).toThrow('当前环境不支持安全随机数');
  });
});
