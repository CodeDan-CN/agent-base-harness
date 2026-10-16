import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpConnectionError,
  mcpConnectionDiagnostic,
  stdioSandboxCommand,
} from '../../packages/execution/src/process/mcp-stdio-sandbox';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const platform = process.platform;
const roots: string[] = [];
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('MCP stdio sandbox launch', () => {
  it('fails closed with a specific diagnostic when Linux bubblewrap is missing', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(() => stdioSandboxCommand('node', [], '/instance', '/instance', [])).toThrow(
      expect.objectContaining({ code: 'MCP_SANDBOX_DEPENDENCY_MISSING' }),
    );
  });

  it('mounts only runtime code read-only and one instance writable, preserving argv', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-launch-')));
    roots.push(root);
    const runtime = path.join(root, 'runtime');
    const instance = path.join(root, 'instance');
    fs.mkdirSync(runtime);
    fs.mkdirSync(instance);
    const { existsSync: exists } = await vi.importActual<typeof fs>('node:fs');
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (name) => name === '/usr/bin/bwrap' || exists(name),
    );
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const args = ['-e', 'process.stdout.write("literal $(not-a-shell)")'];
    const launch = stdioSandboxCommand('node', args, instance, instance, [runtime]);
    expect(launch.command).toBe('/usr/bin/bwrap');
    const bindings = launch.args.flatMap((arg, index) =>
      arg === '--bind' ? [launch.args.slice(index, index + 3)] : [],
    );
    expect(bindings).toEqual([['--bind', instance, instance]]);
    expect(launch.args.join('\0')).toContain(['--ro-bind', runtime, runtime].join('\0'));
    expect(launch.args).toContain('--unshare-pid');
    expect(launch.args).not.toContain('--unshare-net');
    expect(launch.args.slice(-4)).toEqual(['--', 'node', ...args]);
    expect(launch.args).not.toContain(root);
  });

  it('retains macOS protection and rejects unsupported platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(stdioSandboxCommand('node', [], '/instance', '/instance', [])).toMatchObject({
      command: '/usr/bin/sandbox-exec',
    });
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(() => stdioSandboxCommand('node', [], '/instance', '/instance', [])).toThrow(
      expect.objectContaining({ code: 'MCP_SANDBOX_UNSUPPORTED' }),
    );
  });

  it('classifies namespace failures without returning stderr, URLs, or credentials', () => {
    const secret = 'private-fixture-password';
    const diagnostic = mcpConnectionDiagnostic(
      new Error(secret),
      `bwrap: Creating new namespace failed: Operation not permitted ${secret}`,
    );
    expect(diagnostic.code).toBe('MCP_SANDBOX_DENIED');
    expect(diagnostic.message).not.toContain(secret);
    expect(mcpConnectionDiagnostic(new Error(`https://user:${secret}@host`)).message).not.toContain(
      secret,
    );
    expect(mcpConnectionDiagnostic(new TypeError(secret)).code).toBe('MCP_NETWORK_ERROR');
    expect(
      mcpConnectionDiagnostic(new McpConnectionError('MCP_SANDBOX_UNSUPPORTED', 'unsupported'))
        .code,
    ).toBe('MCP_SANDBOX_UNSUPPORTED');
  });
});
