import { readFile, realpath, stat } from 'node:fs/promises';
import { isHistoricalConversationMessage } from '../client-contracts/assistant-output-policy';
import path from 'node:path';
import { z } from 'zod';
import type { ScopedFileSystem } from '../infrastructure/filesystem/scoped-file-system';
import type { ShellExecutor } from '../infrastructure/process/shell-executor';
import type { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import {
  BUILTIN_SKILL_CREATOR_NAME,
  GeneratedSkillPublishError,
  type PublishGeneratedSkillInput,
  type PublishGeneratedSkillResult,
} from '../infrastructure/skills/generated-skill-publisher';
import { materializeSkillResourceBase } from '../infrastructure/workspace/session-workspace';
import { projectRuntime } from '../client-contracts/projection';
import { createCapabilitySearchTool, type CapabilitySelector } from './capability-discovery';
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
  selectCapabilities: CapabilitySelector;
  publishSkill?: (
    userId: string,
    input: PublishGeneratedSkillInput,
  ) => PublishGeneratedSkillResult | Promise<PublishGeneratedSkillResult>;
}

export function registerBuiltinRuntimeTools(registry: ToolRegistry, deps: BuiltinToolDeps): void {
  for (const tool of createBuiltinTools({
    ...deps,
    exposeTurnTools: (userId, sessionId, turnId, tools) =>
      registry.exposeTurnTools(userId, sessionId, turnId, tools),
  })) {
    registry.register(tool);
  }
}

interface BuiltinToolFactoryDeps extends BuiltinToolDeps {
  exposeTurnTools?: (
    userId: string,
    sessionId: string,
    turnId: string,
    tools: readonly RuntimeTool<unknown>[],
  ) => void;
}

export function createBuiltinTools(deps: BuiltinToolFactoryDeps): RuntimeTool<unknown>[] {
  const skillPublisher = deps.publishSkill ? skillPublishTool(deps.publishSkill) : undefined;
  return [
    requestUserInputTool(),
    createCapabilitySearchTool(deps.repos, deps.selectCapabilities),
    eventSearchTool(deps.repos),
    eventReadTool(deps.repos),
    turnListTool(deps.repos),
    turnReadTool(deps.repos),
    skillLoadTool(
      deps.repos,
      deps.appDataDir,
      skillPublisher && deps.exposeTurnTools
        ? (userId, sessionId, turnId) =>
            deps.exposeTurnTools?.(userId, sessionId, turnId, [skillPublisher])
        : undefined,
    ),
    ...createFirstPartyTools({ fileSystem: deps.fileSystem, shell: deps.shell }),
  ];
}

function requestUserInputTool(): RuntimeTool<string> {
  const question = z
    .object({
      id: z.string().min(1).max(64),
      header: z.string().min(1).max(80).optional(),
      question: z.string().min(1).max(1000),
      options: z.array(z.string().min(1).max(200)).min(2).max(5),
    })
    .strict();
  const input = z
    .object({
      prompt: z.string().min(1).max(4000),
      kind: z.enum(['text', 'confirm', 'select', 'selection', 'form']).default('text'),
      options: z.array(z.string().min(1)).max(20).optional(),
      questions: z.array(question).min(1).max(6).optional(),
      schema: z.record(z.unknown()).optional(),
      requiresUserProvidedFact: z.boolean().default(false),
    })
    .strict()
    .refine(
      (value) =>
        !value.questions ||
        new Set(value.questions.map((item) => item.id)).size === value.questions.length,
      { message: 'question ids must be unique', path: ['questions'] },
    );
  return {
    name: 'request_user_input',
    description:
      '缺少必要信息时暂停当前任务并请用户补充。需要同时询问多个相关问题时，优先使用 questions；每题提供 2–3 个具体、互斥的推荐选项。界面会自动追加“其他”，不要把“其他”写入 options。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, description: '简短说明为什么需要这些信息。' },
        kind: { enum: ['text', 'confirm', 'select', 'selection', 'form'] },
        options: { type: 'array', items: { type: 'string' } },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          description: '多问题表单。每题推荐 2–3 个选项，不要包含“其他”。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, description: '稳定、唯一的英文字段名。' },
              header: { type: 'string', description: '可选的简短标题。' },
              question: { type: 'string', minLength: 1 },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 5,
                items: { type: 'string', minLength: 1 },
              },
            },
            required: ['id', 'question', 'options'],
            additionalProperties: false,
          },
        },
        schema: { type: 'object' },
        requiresUserProvidedFact: {
          type: 'boolean',
          default: false,
          description:
            '仅当缺少不可推断且任务无法继续的用户事实时设为 true；不得用于偏好、方案、格式、可逆选择或任何密码、验证码、API Key。',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => textContent(value) },
    concurrencySafe: false,
    replaySafe: true,
    exclusive: true,
    timeoutMs: 5_000,
    async execute(raw, context) {
      const parsed = input.parse(raw);
      if (context.permissionPreset === 'full-access' && !parsed.requiresUserProvidedFact) {
        return '完全访问：此项由模型自主决定。请选择风险最低、可逆且符合目标的方案继续；不得编造不可推断事实。';
      }
      throw new ToolInteractionError({
        ...parsed,
        kind: parsed.questions?.length ? 'form' : parsed.kind,
      });
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
              message.eventId === event.id &&
              isHistoricalConversationMessage(message) &&
              message.content.toLocaleLowerCase().includes(query),
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
        messages: projection.messages.filter(
          (message) => message.eventId === event.id && isHistoricalConversationMessage(message),
        ),
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
  exposePublisher?: (userId: string, sessionId: string, turnId: string) => void,
): RuntimeTool<SkillLoadResult> {
  const input = z
    .object({ capabilityId: z.string().min(1).optional(), skillName: z.string().min(1).optional() })
    .strict()
    .refine((value) => Boolean(value.capabilityId || value.skillName));
  return {
    name: 'skill_load',
    description: '按 capability_search 返回的 capabilityId 加载当前智能体已授权 Skill。',
    parameters: {
      type: 'object',
      properties: {
        capabilityId: { type: 'string', minLength: 1 },
        skillName: { type: 'string', minLength: 1, description: 'Legacy internal alias.' },
      },
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
      const requestedId = parsed.capabilityId;
      const bindings = repos.agents.hasSchema
        ? repos.agents.listBindings(context.userId, context.agentId)
        : null;
      if (bindings && (!requestedId || !bindings.skillIds.includes(requestedId)))
        throw new ToolExecutionError('SKILL_NOT_AVAILABLE');
      const installation = repos.skills
        .listInstallations(context.userId)
        .find((candidate) =>
          requestedId ? candidate.id === requestedId : candidate.skillName === parsed.skillName,
        );
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
        const result = {
          skillName: installation.skillName,
          resourceBase: { kind: 'directory', path: resourceBase },
          content: await readFile(path.join(resourceBase, 'SKILL.md'), 'utf8'),
        } satisfies SkillLoadResult;
        if (
          installation.skillName === BUILTIN_SKILL_CREATOR_NAME &&
          installation.sourceType === 'bundled'
        ) {
          exposePublisher?.(context.userId, context.sessionId, context.turnId);
        }
        return result;
      } catch (error) {
        if (error instanceof ToolExecutionError) throw error;
        throw new ToolExecutionError('SKILL_READ_FAILED');
      }
    },
  };
}

function skillPublishTool(
  publish: NonNullable<BuiltinToolDeps['publishSkill']>,
): RuntimeTool<PublishGeneratedSkillResult> {
  const input = z
    .object({
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      description: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .refine((value) => !/[\r\n]/.test(value)),
      instructions: z.string().trim().min(1).max(100_000),
    })
    .strict();
  return {
    name: 'skill_publish',
    description: '把 skill-creator 整理出的纯文本 Skill 发布到当前用户目录并立即启用。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
          description: '小写英文、数字和连字符组成的唯一名称。',
        },
        description: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          pattern: '^[^\\r\\n]+$',
          description: '一行说明 Skill 的能力和触发条件。',
        },
        instructions: {
          type: 'string',
          minLength: 1,
          maxLength: 100000,
          description: '可复用的完整 Markdown 指令正文，不要包含 YAML frontmatter。',
        },
      },
      required: ['name', 'description', 'instructions'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          skillName: { type: 'string' },
          description: { type: 'string' },
          scope: { const: 'user' },
          enabled: { const: true },
          contentDigest: { type: 'string' },
        },
        required: ['skillName', 'description', 'scope', 'enabled', 'contentDigest'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textContent({
          skillName: value.skillName,
          scope: value.scope,
          enabled: value.enabled,
          contentDigest: value.contentDigest,
        });
      },
    },
    concurrencySafe: false,
    replaySafe: false,
    exclusive: true,
    timeoutMs: 10_000,
    approvalPolicy: 'always',
    approvalScope: 'local',
    permissionIdentity: 'skill:publish:user',
    async execute(raw, context) {
      const parsed = input.parse(raw);
      try {
        return await publish(context.userId, parsed);
      } catch (error) {
        if (error instanceof GeneratedSkillPublishError) {
          throw new ToolExecutionError(error.code);
        }
        throw new ToolExecutionError('SKILL_PUBLISH_FAILED');
      }
    },
    presentCall(raw) {
      const parsed = input.safeParse(raw);
      return parsed.success
        ? { kind: 'generic', title: '发布 Skill', detail: parsed.data.name }
        : undefined;
    },
    presentResult(raw, result) {
      const parsed = input.safeParse(raw);
      if (!parsed.success) return undefined;
      return {
        kind: 'generic',
        title: '发布 Skill',
        detail: parsed.data.name,
        status: result.status === 'success' ? 'success' : 'error',
      };
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
