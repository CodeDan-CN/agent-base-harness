import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ProcessRunner } from '../infrastructure/process/process-runner';
import type { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import { projectRuntime } from '../client-contracts/projection';
import type { RuntimeTool, ToolRegistry } from './tools';

export interface BuiltinToolDeps {
  repos: SqliteRepositories;
  processRunner: ProcessRunner;
  appDataDir: string;
}

export function registerBuiltinRuntimeTools(registry: ToolRegistry, deps: BuiltinToolDeps): void {
  for (const tool of createBuiltinTools(deps)) registry.register(tool);
}

export function createBuiltinTools(deps: BuiltinToolDeps): RuntimeTool[] {
  return [
    requestUserInputTool(),
    eventSearchTool(deps.repos),
    eventReadTool(deps.repos),
    turnListTool(deps.repos),
    turnReadTool(deps.repos),
    skillLoadTool(deps.repos),
    hostCommandTool(deps.repos, deps.processRunner, deps.appDataDir),
  ];
}

function requestUserInputTool(): RuntimeTool {
  const schema = z
    .object({
      prompt: z.string().min(1).max(4000),
      kind: z.enum(['text', 'confirm', 'select', 'approval', 'selection', 'form']).default('text'),
      options: z.array(z.string().min(1)).max(20).optional(),
      schema: z.record(z.unknown()).optional(),
    })
    .strict();
  return {
    definition: {
      name: 'request_user_input',
      description: '缺少必要信息时暂停当前任务并向用户提出一个问题。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          kind: { enum: ['text', 'confirm', 'select', 'approval', 'selection', 'form'] },
          options: { type: 'array', items: { type: 'string' } },
          schema: { type: 'object' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
    concurrencySafe: false,
    replaySafe: true,
    exclusive: true,
    timeoutMs: 5_000,
    async execute(input) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return { status: 'fatal_error', output: null, errorCode: 'INVALID_TOOL_INPUT' };
      }
      return {
        status: 'needs_input',
        output: { requested: true },
        interaction: parsed.data,
      };
    },
  };
}

function eventSearchTool(repos: SqliteRepositories): RuntimeTool {
  const schema = z
    .object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(10) })
    .strict();
  return {
    definition: {
      name: 'event_search',
      description: '在当前会话的历史事件与消息中搜索关键词，只返回摘要和标识。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    concurrencySafe: true,
    replaySafe: true,
    timeoutMs: 5_000,
    async execute(input, context) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return invalidInput();
      const projection = projectRuntime(
        repos.sessions.listEvents(context.userId, context.sessionId),
      );
      const query = parsed.data.query.toLocaleLowerCase();
      const found = [...projection.events.values()]
        .filter((event) => {
          if (`${event.title}\n${event.summary ?? ''}`.toLocaleLowerCase().includes(query))
            return true;
          return projection.messages.some(
            (message) =>
              message.eventId === event.id && message.content.toLocaleLowerCase().includes(query),
          );
        })
        .slice(0, parsed.data.limit)
        .map((event) => ({ eventId: event.id, title: event.title, summary: event.summary }));
      return { status: 'success', output: found };
    },
  };
}

function eventReadTool(repos: SqliteRepositories): RuntimeTool {
  const schema = z.object({ eventId: z.string().min(1) }).strict();
  return {
    definition: {
      name: 'event_read',
      description: '读取当前会话内一个事件的完整用户可见问答记录。',
      inputSchema: {
        type: 'object',
        properties: { eventId: { type: 'string' } },
        required: ['eventId'],
        additionalProperties: false,
      },
    },
    concurrencySafe: true,
    replaySafe: true,
    timeoutMs: 5_000,
    async execute(input, context) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return invalidInput();
      const projection = projectRuntime(
        repos.sessions.listEvents(context.userId, context.sessionId),
      );
      const event = projection.events.get(parsed.data.eventId);
      if (!event) return { status: 'fatal_error', output: null, errorCode: 'EVENT_NOT_FOUND' };
      return {
        status: 'success',
        output: {
          ...event,
          messages: projection.messages.filter((message) => message.eventId === event.id),
        },
      };
    },
  };
}

function turnListTool(repos: SqliteRepositories): RuntimeTool {
  return {
    definition: {
      name: 'turn_list',
      description: '列出当前会话最近的执行轮次。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    concurrencySafe: true,
    replaySafe: true,
    timeoutMs: 5_000,
    async execute(_input, context) {
      const projection = projectRuntime(
        repos.sessions.listEvents(context.userId, context.sessionId),
      );
      return { status: 'success', output: [...projection.turns.values()].slice(-20) };
    },
  };
}

function turnReadTool(repos: SqliteRepositories): RuntimeTool {
  const schema = z.object({ turnId: z.string().min(1) }).strict();
  return {
    definition: {
      name: 'turn_read',
      description: '读取当前会话内一个执行轮次的消息与结果。',
      inputSchema: {
        type: 'object',
        properties: { turnId: { type: 'string' } },
        required: ['turnId'],
        additionalProperties: false,
      },
    },
    concurrencySafe: true,
    replaySafe: true,
    timeoutMs: 5_000,
    async execute(input, context) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return invalidInput();
      const projection = projectRuntime(
        repos.sessions.listEvents(context.userId, context.sessionId),
      );
      const turn = projection.turns.get(parsed.data.turnId);
      if (!turn) return { status: 'fatal_error', output: null, errorCode: 'TURN_NOT_FOUND' };
      return {
        status: 'success',
        output: {
          ...turn,
          messages: projection.messages.filter((message) => message.turnId === turn.id),
        },
      };
    },
  };
}

function skillLoadTool(repos: SqliteRepositories): RuntimeTool {
  const schema = z
    .object({
      skillName: z.string().min(1),
      resourcePath: z.string().min(1).max(1000).default('SKILL.md'),
    })
    .strict();
  return {
    definition: {
      name: 'skill_load',
      description: '按名称加载当前用户已启用 Skill 的 SKILL.md 指令。',
      inputSchema: {
        type: 'object',
        properties: {
          skillName: { type: 'string' },
          resourcePath: { type: 'string', description: 'Skill 根目录内的相对资源路径' },
        },
        required: ['skillName'],
        additionalProperties: false,
      },
    },
    concurrencySafe: true,
    replaySafe: true,
    timeoutMs: 10_000,
    async execute(input, context) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return invalidInput();
      const installation = repos.skills.getInstallation(context.userId, parsed.data.skillName);
      if (!installation || !installation.enabled || installation.status !== 'valid') {
        return { status: 'fatal_error', output: null, errorCode: 'SKILL_NOT_AVAILABLE' };
      }
      const root = path.resolve(installation.rootPath);
      const file = path.resolve(root, parsed.data.resourcePath);
      if (!isInside(root, file)) {
        return { status: 'fatal_error', output: null, errorCode: 'SKILL_PATH_INVALID' };
      }
      try {
        const realRoot = await realpath(root);
        const realFile = await realpath(file);
        if (!isInside(realRoot, realFile)) {
          return { status: 'fatal_error', output: null, errorCode: 'SKILL_PATH_INVALID' };
        }
        const metadata = await stat(realFile);
        if (!metadata.isFile() || metadata.size > 1024 * 1024) {
          return { status: 'fatal_error', output: null, errorCode: 'SKILL_RESOURCE_TOO_LARGE' };
        }
        return {
          status: 'success',
          output: {
            skillName: installation.skillName,
            resourcePath: parsed.data.resourcePath,
            content: await readFile(realFile, 'utf8'),
            executionBase: `skill://${encodeURIComponent(installation.skillName)}`,
            usageHint:
              '调用 host_command 执行该 Skill 时，将 cwd 设为 executionBase，并把 {baseDir}/ 替换为相对路径。',
          },
        };
      } catch {
        return { status: 'fatal_error', output: null, errorCode: 'SKILL_READ_FAILED' };
      }
    },
  };
}

function hostCommandTool(
  repos: SqliteRepositories,
  processRunner: ProcessRunner,
  appDataDir: string,
): RuntimeTool {
  const schema = z
    .object({
      executable: z.string().min(1),
      args: z.array(z.string()).max(100).default([]),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    })
    .strict();
  return {
    definition: {
      name: 'host_command',
      description:
        '在宿主机受控目录中运行 Node、Python 或普通可执行文件；不使用 shell 拼接。运行已加载 Skill 时，cwd 使用 skill://技能名，args 使用 Skill 内相对路径。',
      inputSchema: {
        type: 'object',
        properties: {
          executable: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
        },
        required: ['executable'],
        additionalProperties: false,
      },
    },
    concurrencySafe: false,
    replaySafe: false,
    exclusive: true,
    timeoutMs: 120_000,
    async execute(input, context) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return invalidInput();
      const workspaceRoot = path.join(appDataDir, 'workspaces', context.userId);
      const skillRoot = path.join(appDataDir, 'skills', context.userId);
      const cwd = resolveToolWorkingDirectory(
        repos,
        context.userId,
        parsed.data.cwd,
        workspaceRoot,
      );
      if (!cwd) {
        return { status: 'fatal_error', output: null, errorCode: 'SKILL_NOT_AVAILABLE' };
      }
      const canonicalCwd = canonicalPath(cwd);
      if (
        !isInside(canonicalPath(workspaceRoot), canonicalCwd) &&
        !isInside(canonicalPath(skillRoot), canonicalCwd)
      ) {
        return { status: 'fatal_error', output: null, errorCode: 'WORKING_DIRECTORY_NOT_ALLOWED' };
      }
      try {
        await mkdir(workspaceRoot, { recursive: true });
        await mkdir(skillRoot, { recursive: true });
        await mkdir(cwd, { recursive: true });
        const [realWorkspaceRoot, realSkillRoot, realCwd] = await Promise.all([
          realpath(workspaceRoot),
          realpath(skillRoot),
          realpath(cwd),
        ]);
        if (!isInside(realWorkspaceRoot, realCwd) && !isInside(realSkillRoot, realCwd)) {
          return {
            status: 'fatal_error',
            output: null,
            errorCode: 'WORKING_DIRECTORY_NOT_ALLOWED',
          };
        }
        const result = await processRunner.run({
          cmd: parsed.data.executable,
          args: parsed.data.args,
          cwd: realCwd,
          timeoutMs: parsed.data.timeoutMs,
          signal: context.signal,
        });
        return {
          status: result.cancelled
            ? 'cancelled'
            : result.exitCode === 0
              ? 'success'
              : 'fatal_error',
          output: result,
          errorCode: result.exitCode === 0 ? undefined : 'PROCESS_EXIT_NONZERO',
        };
      } catch {
        return { status: 'fatal_error', output: null, errorCode: 'PROCESS_START_FAILED' };
      }
    },
  };
}

function resolveToolWorkingDirectory(
  repos: SqliteRepositories,
  userId: string,
  requested: string | undefined,
  workspaceRoot: string,
): string | null {
  if (!requested) return path.resolve(workspaceRoot);
  if (!requested.startsWith('skill://')) return path.resolve(requested);
  try {
    const reference = requested.slice('skill://'.length);
    const separator = reference.indexOf('/');
    const encodedName = separator < 0 ? reference : reference.slice(0, separator);
    const encodedRelative = separator < 0 ? '' : reference.slice(separator + 1);
    if (!encodedName) return null;
    const skillName = decodeURIComponent(encodedName);
    const installation = repos.skills.getInstallation(userId, skillName);
    if (!installation || !installation.enabled || installation.status !== 'valid') return null;
    const relative = decodeURIComponent(encodedRelative);
    const target = path.resolve(installation.rootPath, relative);
    return isInside(installation.rootPath, target) ? target : null;
  } catch {
    return null;
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function invalidInput() {
  return { status: 'fatal_error' as const, output: null, errorCode: 'INVALID_TOOL_INPUT' };
}
