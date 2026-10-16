import { describe, expect, it } from 'vitest';
import {
  hasAcknowledgedFullAccess,
  rememberFullAccessAcknowledgement,
} from '../../packages/app-ui/src/permission-consent';

describe('完全访问首次确认', () => {
  it('按本地用户分别记录确认状态', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    };

    expect(hasAcknowledgedFullAccess('user-a', storage)).toBe(false);
    rememberFullAccessAcknowledgement('user-a', storage);
    expect(hasAcknowledgedFullAccess('user-a', storage)).toBe(true);
    expect(hasAcknowledgedFullAccess('user-b', storage)).toBe(false);
  });

  it('存储不可用时安全回退为再次确认', () => {
    const storage = {
      getItem() {
        throw new Error('unavailable');
      },
      setItem() {
        throw new Error('unavailable');
      },
    };

    expect(hasAcknowledgedFullAccess('user-a', storage)).toBe(false);
    expect(() => rememberFullAccessAcknowledgement('user-a', storage)).not.toThrow();
  });
});
