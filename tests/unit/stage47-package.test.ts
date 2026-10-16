import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_HARNESS_VERSION } from '../../packages/protocol/src/contracts/version';

describe('4.7.0 server package manifest', () => {
  it('ships one server/CLI package without desktop dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve('build-support/server-package/package.json'), 'utf8'),
    ) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      allowScripts: Record<string, boolean>;
      dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe('@agent-harness/server');
    expect(manifest.version).toBe(AGENT_HARNESS_VERSION);
    expect(manifest.bin['agent-harness']).toBe('dist/cli/index.cjs');
    expect(manifest.allowScripts).toEqual({ 'better-sqlite3@13.0.3': true });
    expect(manifest.dependencies).toHaveProperty('better-sqlite3', '13.0.3');
    expect(manifest.dependencies).not.toHaveProperty('electron');
    expect(manifest.dependencies).not.toHaveProperty('react');
  });
});
