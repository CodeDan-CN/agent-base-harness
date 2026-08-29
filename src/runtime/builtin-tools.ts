import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ScopedFileSystem } from '../infrastructure/filesystem/scoped-file-system';
import type { ShellExecutor } from '../infrastructure/process/shell-executor';
import type { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import { materializeSkillResourceBase } from '../infrastructure/workspace/session-workspace';
import { projectRuntime } from '../client-contracts/projection';
import { createFirstPartyTools } from './first-party-tools';
import {
  ToolExecutionError,
  ToolInteractionError,
  textContent,
  type RuntimeTool,
  type ToolRegistry,
} from './tools';

export interface BuiltinToolDeps {
  appDataDir: string;
  repos: SqliteRepositories;
  fileSystem: ScopedFileSystem;
  shell: ShellExecutor;
}

export function registerBuiltinRuntimeTools(registry: ToolRegistry, deps: BuiltinToolDeps): void {
  for (const tool of createBuiltinTools(deps)) registry.register(tool);
}

export function createBuiltinTools(deps: BuiltinToolDeps): RuntimeTool<unknown>[] {
  return [
    requestUserInputTool(),
    eventSearchTool(deps.repos),
    eventReadTool(deps.repos),
    turnListTool(deps.repos),
    turnReadTool(deps.repos),
    skillLoadTool(deps.repos, deps.appDataDir),
    ...createFirstPartyTools({ fileSystem: deps.fileSystem, shell: deps.shell }),
  ];
}

function requestUserInputTool(): RuntimeTool<never> {
  const input = z
    .object({
      prompt: z.string().min(1).max(4000),
      kind: z.enum(['text', 'confirm', 'select', 'approval', 'selection', 'form']).default('text'),
      options: z.array(z.string().min(1)).max(20).optional(),
      schema: z.record(z.unknown()).optional(),
    })
    .strict();
  return {
    name: 'request_user_input',
    description: '缺少必要信息时暂停当前任务并向用户提出一个问题。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1 },
        kind: { enum: ['text', 'confirm', 'select', 'approval', 'selection', 'form'] },
        options: { type: 'array', items: { type: 'string' } },
        schema: { type: 'object' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: { schema: {}, render: textContent },
    concurrencySafe: false,
    replaySafe: true,
    exclusive: true,
    timeoutMs: 5_000,
    async execute(raw) {
      const parsed = input.parse(raw);
      throw new ToolInteractionError(parsed);
    },
  };
}

function eventSearchTool(repos: SqliteRepositories): RuntimeTool<unknown> {
  const input = z
    .object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(10) })
    .strict();
  return simpleTool({
    name: 'event_search',
    description: '在当前会话的历史事件与消息中搜索关键词，只返回摘要和标识。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(raw, context) {
      const parsed = input.parse(raw);
      const projection = projectRuntime(
        repos.sessions.listEvents(context.userId, context.sessionId),
      );
      const query = parsed.query.toLocaleLowerCase();
      return [...projection.events.values()]
        .filter((event) => {
          if (`${event.title}\n${event.summary ?? ''}`.toLocaleLowerCase().includes(query)) {
            return true;
          }
          return projection.messages.some(
            (message) =>
              message.eventId === event.id && message.content.toLocaleLowerCase().includes(query),
          );
        })
        .slice(0, parsed.limit)
        .map((event) => ({ eventId: event.id, title: event.title, summary: event.summary }));
    },
  });
}

function eventReadTool(repos: SqliteRepositories): RuntimeTool<unknown> {
  const input = z.object({ eventId: z.string().min(1) }).strict();
  return simpleTool({
    name: 'event_read',
    description: '读取当前会话内一个事件的完整用户可见问答记录。',
    parameters: {
      type: 'object',
      properties: { eventId: { type: 'string', minLength: 1 } },
      required: ['eventId'],
      additionalProperties: false,
    },
    async execute(raw, context) {
      const parsed = input.parse(raw);
      const projection = projectRuntime(
        repos.sessions.listEvents(context.userId, context.sessionId),
      );
      const event = projection.events.get(parsed.eventId);
      if (!event) throw new ToolExecutionError('EVENT_NOT_FOUND');
      return {
        ...event,
        messages: projection.messages.filter((message) => message.eventId === event.id),
      };
    },
  });
}

function turnListTool(repos: SqliteRepositories): RuntimeTool<unknown> {
  return simpleTool({
    name: 'turn_list',
    description: '列出当前会话最近的执行轮次。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_raw, context) {
      const projection = projectRuntime(
        repos.sessions.listEvents(context.userId, context.sessionId),
      );
      return [...projection.turns.values()].slice(-20);
    },
  });
}

function turnReadTool(repos: SqliteRepositories): RuntimeTool<unknown> {
  const input = z.object({ turnId: z.string().min(1) }).strict();
  return simpleTool({
    name: 'turn_read',
    description: '读取当前会话内一个执行轮次的消息与结果。',
    parameters: {
      type: 'object',
      properties: { turnId: { type: 'string', minLength: 1 } },
      required: ['turnId'],
      additionalProperties: false,
    },
    async execute(raw, context) {
      const parsed = input.parse(raw);
      const projection = projectRuntime(
        repos.sessions.listEvents(context.userId, context.sessionId),
      );
      const turn = projection.turns.get(parsed.turnId);
      if (!turn) throw new ToolExecutionError('TURN_NOT_FOUND');
      return {
        ...turn,
        messages: projection.messages.filter((message) => message.turnId === turn.id),
      };
    },
  });
}

interface SkillLoadResult {
  skillName: string;
  resourceBase: { kind: 'directory'; path: string };
  content: string;
}

function skillLoadTool(
  repos: SqliteRepositories,
  appDataDir: string,
): RuntimeTool<SkillLoadResult> {
  const input = z.object({ skillName: z.string().min(1) }).strict();
  return {
    name: 'skill_load',
    description: '按名称加载当前用户已启用 Skill，并返回完整指令和真实资源基目录。',
    parameters: {
      type: 'object',
      properties: { skillName: { type: 'string', minLength: 1 } },
      required: ['skillName'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          skillName: { type: 'string' },
          resourceBase: {
            type: 'object',
            properties: {
              kind: { const: 'directory' },
              path: { type: 'string' },
            },
            required: ['kind', 'path'],
            additionalProperties: false,
          },
          content: { type: 'string' },
        },
        required: ['skillName', 'resourceBase', 'content'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textContent(renderSkillContent(value));
      },
      presentationMeta(_args, value) {
        return { resourceBase: value.resourceBase };
      },
    },
    concurrencySafe: true,
    replaySafe: true,
    timeoutMs: 10_000,
    async execute(raw, context) {
      const parsed = input.parse(raw);
      const installation = repos.skills.getInstallation(context.userId, parsed.skillName);
      if (!installation || !installation.enabled || installation.status !== 'valid') {
        throw new ToolExecutionError('SKILL_NOT_AVAILABLE');
      }
      const root = path.resolve(installation.rootPath);
      const file = path.resolve(root, 'SKILL.md');
      if (!isInside(root, file)) throw new ToolExecutionError('SKILL_PATH_INVALID');
      try {
        const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
        if (!isInside(realRoot, realFile)) throw new ToolExecutionError('SKILL_PATH_INVALID');
        const metadata = await stat(realFile);
        if (!metadata.isFile() || metadata.size > 1024 * 1024) {
          throw new ToolExecutionError('SKILL_RESOURCE_TOO_LARGE');
        }
        const resourceBase = await materializeSkillResourceBase({
          appDataDir,
          scope: context,
          skillName: installation.skillName,
          sourceRoot: realRoot,
        });
        return {
          skillName: installation.skillName,
          resourceBase: { kind: 'directory', path: resourceBase },
          content: await readFile(path.join(resourceBase, 'SKILL.md'), 'utf8'),
        };
      } catch (error) {
        if (error instanceof ToolExecutionError) throw error;
        throw new ToolExecutionError('SKILL_READ_FAILED');
      }
    },
  };
}

function renderSkillContent(skill: SkillLoadResult): string {
  return [
    `<skill_content name="${escapeXml(skill.skillName)}">`,
    '<skill_resources>',
    `Base directory for this skill: ${escapeXml(skill.resourceBase.path)}`,
    'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function simpleTool(input: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: RuntimeTool<unknown>['execute'];
}): RuntimeTool<unknown> {
  return {
    ...input,
    output: {
      schema: {},
      render(_args, value) {
        return textContent(value);
      },
    },
    concurrencySafe: true,
    replaySafe: true,
    timeoutMs: 10_000,
  };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
