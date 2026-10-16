import { describe, expect, it } from 'vitest';
import { Redactor } from '../../packages/execution/src/logging/redactor';

describe('M12-002 日志脱敏', () => {
  it('显式 secret 被替换', () => {
    const redactor = new Redactor();
    redactor.registerSecret('sk-topsecret-12345');
    expect(redactor.redact('value=sk-topsecret-12345 done')).not.toContain('topsecret');
  });

  it('Bearer token 形态被脱敏', () => {
    const redactor = new Redactor();
    const out = redactor.redact('authorization: Bearer abc.def.ghi');
    expect(out).not.toContain('abc.def');
  });

  it('api-key / token 键值形态被脱敏', () => {
    const redactor = new Redactor();
    expect(redactor.redact('api-key=mysecretvalue')).not.toContain('mysecretvalue');
    expect(redactor.redact('{"token":"abc123def456"}')).not.toContain('abc123def');
  });

  it('redactDeep 递归处理对象中的注册 secret', () => {
    const redactor = new Redactor();
    redactor.registerSecret('p@ss');
    const out = redactor.redactDeep({ nested: { password: 'p@ss' } }) as {
      nested: { password: string };
    };
    expect(out.nested.password).not.toContain('p@ss');
    expect(out.nested.password).toContain('[REDACTED]');
  });
});
