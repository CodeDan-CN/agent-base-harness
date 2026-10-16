import { describe, expect, it } from 'vitest';
import { parseServeArguments } from '../../packages/server-core/src';
import { clientKindSchema } from '../../packages/protocol/src/contracts/auth';

describe('Web server options', () => {
  it('parses an explicit public listener and Web asset root', () => {
    expect(
      parseServeArguments([
        '--host',
        '0.0.0.0',
        '--port',
        '4317',
        '--web-root',
        '/srv/agent/web',
        '--allow-web-registration',
      ]),
    ).toEqual({
      host: '0.0.0.0',
      port: 4317,
      webRoot: '/srv/agent/web',
      allowWebRegistration: true,
    });
  });

  it('recognizes browser clients without changing the existing client kinds', () => {
    expect(clientKindSchema.parse('web')).toBe('web');
    expect(clientKindSchema.parse('electron')).toBe('electron');
    expect(clientKindSchema.parse('cli')).toBe('cli');
  });
});
