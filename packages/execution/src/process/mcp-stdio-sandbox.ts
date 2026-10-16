import { existsSync } from 'node:fs';
import { linuxSandboxCommand } from './linux-sandbox';

export class McpConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

export function stdioSandboxCommand(
  command: string,
  args: string[],
  writableRoot: string,
  cwd: string,
  readOnlyRoots: readonly string[],
): { command: string; args: string[] } {
  if (process.platform === 'linux') {
    if (!existsSync('/usr/bin/bwrap')) {
      throw new McpConnectionError(
        'MCP_SANDBOX_DEPENDENCY_MISSING',
        'Linux stdio MCP 需要安装 bubblewrap（/usr/bin/bwrap）。',
      );
    }
    const launch = linuxSandboxCommand(
      {
        cmd: command,
        args,
        cwd,
        // MCP servers may use network APIs; filesystem access remains restricted.
        sandbox: { mode: 'workspace-write', writableRoots: [writableRoot], allowNetwork: true },
      },
      readOnlyRoots,
    );
    return { command: launch.cmd, args: launch.args };
  }
  if (process.platform !== 'darwin') {
    throw new McpConnectionError(
      'MCP_SANDBOX_UNSUPPORTED',
      '当前平台尚不支持 stdio MCP 文件沙箱。',
    );
  }
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (subpath ' + JSON.stringify(writableRoot) + '))',
  ].join('\n');
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, command, ...args] };
}

/** Only expose our own diagnostic text, never arbitrary child stderr or credential values. */
export function mcpConnectionDiagnostic(error: unknown, stderr = ''): McpConnectionError {
  if (error instanceof McpConnectionError) return error;
  if (/bwrap:.*(?:namespace|Operation not permitted|Permission denied)/i.test(stderr)) {
    return new McpConnectionError(
      'MCP_SANDBOX_DENIED',
      'Linux stdio MCP 沙箱启动被系统拒绝，请检查 bubblewrap 的用户命名空间与 AppArmor 配置。',
    );
  }
  if (/bwrap: execvp .*: No such file or directory/.test(stderr)) {
    return new McpConnectionError(
      'MCP_STDIO_COMMAND_NOT_FOUND',
      'stdio MCP 命令在沙箱内不可用，请检查命令及其依赖是否位于系统、捆绑 Runtime 或当前实例目录。',
    );
  }
  if (/bwrap:/.test(stderr)) {
    return new McpConnectionError(
      'MCP_SANDBOX_START_FAILED',
      'Linux stdio MCP 沙箱初始化失败，请检查挂载路径和系统沙箱配置。',
    );
  }
  if (error instanceof TypeError || error instanceof DOMException) {
    return new McpConnectionError(
      'MCP_NETWORK_ERROR',
      'MCP 网络连接失败，请检查服务地址、网络和凭据。',
    );
  }
  return new McpConnectionError(
    'MCP_CONNECTION_FAILED',
    'MCP 连接或协议握手失败，请检查服务命令、依赖、地址和凭据。',
  );
}
