import { z } from 'zod';
import {
  ScopedFileSystemError,
  type ScopedFileSystem,
  type EditFileResult,
  type ReadFileResult,
  type WriteFileResult,
} from '../infrastructure/filesystem/scoped-file-system';
import {
  ShellExecutionError,
  type ShellExecutor,
  type ShellExecutionResult,
} from '../infrastructure/process/shell-executor';
import {
  ToolExecutionError,
  textContent,
  type JsonSchema,
  type RuntimeTool,
  type ToolResult,
} from './tools';

export function createFirstPartyTools(deps: {
  fileSystem: ScopedFileSystem;
  shell: ShellExecutor;
}): RuntimeTool<unknown>[] {
  return [
    readTool(deps.fileSystem),
    writeTool(deps.fileSystem),
    editTool(deps.fileSystem),
    bashTool(deps.shell),
  ];
}

function readTool(fileSystem: ScopedFileSystem): RuntimeTool<ReadFileResult> {
  const input = z
    .object({
      file_path: z.string().min(1).max(4096),
      offset: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(2000).default(200),
    })
    .strict();
  return {
    name: 'read',
    description:
      '读取当前 Session 工作区、当前用户的 ../memory-profile.md 或已启用 Skill 中的 UTF-8 文件，返回带行号的有界文本窗口。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 1, default: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    output: {
      schema: readOutputSchema,
      render(_args, value) {
        const suffix = value.truncated
          ? `\n[Showing lines ${value.offset}-${value.offset + value.limit - 1} of ${value.totalLines}]`
          : '';
        return textContent(`${value.content}${suffix}`);
      },
      presentationMeta(_args, value) {
        return {
          path: value.path,
          offset: value.offset,
          limit: value.limit,
          totalLines: value.totalLines,
          truncated: value.truncated,
        };
      },
    },
    concurrencySafe: true,
    replaySafe: true,
    timeoutMs: 10_000,
    async execute(raw, context) {
      const parsed = input.parse(raw);
      try {
        return await fileSystem.read(context, parsed.file_path, parsed.offset, parsed.limit, {
          allowOutsideWorkspace: true,
        });
      } catch (error) {
        throw fileError(error);
      }
    },
    presentCall(raw) {
      const parsed = input.safeParse(raw);
      return parsed.success
        ? { kind: 'read', title: '读取文件', path: parsed.data.file_path }
        : undefined;
    },
    presentResult(raw, result) {
      const parsed = input.safeParse(raw);
      if (!parsed.success) return undefined;
      return {
        kind: 'read',
        title: '读取文件',
        path: parsed.data.file_path,
        status: result.status === 'success' ? 'success' : 'error',
      };
    },
  };
}

function writeTool(fileSystem: ScopedFileSystem): RuntimeTool<WriteFileResult> {
  const input = z
    .object({
      file_path: z.string().min(1).max(4096),
      content: z.string().max(2 * 1024 * 1024),
    })
    .strict();
  return {
    name: 'write',
    description:
      '在当前 Session 工作区或当前用户的 ../memory-profile.md 创建、整体写入 UTF-8 文件；覆盖已有文件前必须先使用 read 读取最新版本。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
    output: {
      schema: writeOutputSchema,
      render(_args, value) {
        return textContent(
          `${value.created ? 'Created' : 'Wrote'} ${value.path} (${value.bytes} bytes).`,
        );
      },
      presentationMeta(_args, value) {
        return { path: value.path, bytes: value.bytes, created: value.created };
      },
    },
    concurrencySafe: false,
    replaySafe: false,
    exclusive: true,
    timeoutMs: 10_000,
    resolveApprovalPolicy(raw, context) {
      const parsed = input.parse(raw);
      return fileSystem.isOutsideWorkspace(context, parsed.file_path) ? 'always' : 'never';
    },
    async execute(raw, context) {
      const parsed = input.parse(raw);
      try {
        return await fileSystem.write(context, parsed.file_path, parsed.content, {
          allowOutsideWorkspace:
            context.permissionPreset === 'full-access' || Boolean(context.approvalGranted),
        });
      } catch (error) {
        throw fileError(error);
      }
    },
    presentCall(raw) {
      const parsed = input.safeParse(raw);
      return parsed.success
        ? { kind: 'diff', title: '写入文件', path: parsed.data.file_path }
        : undefined;
    },
    presentResult: fileResultPresenter(input, '写入文件'),
  };
}

function editTool(fileSystem: ScopedFileSystem): RuntimeTool<EditFileResult> {
  const input = z
    .object({
      file_path: z.string().min(1).max(4096),
      old_string: z
        .string()
        .min(1)
        .max(2 * 1024 * 1024),
      new_string: z.string().max(2 * 1024 * 1024),
      replace_all: z.boolean().default(false),
    })
    .strict();
  return {
    name: 'edit',
    description:
      '精确替换当前 Session 工作区或当前用户 ../memory-profile.md 中的文本；编辑前必须 read，默认要求 old_string 唯一匹配。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', minLength: 1 },
        old_string: { type: 'string', minLength: 1 },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', default: false },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    output: {
      schema: {
        ...writeOutputSchema,
        properties: {
          ...(writeOutputSchema.properties as Record<string, unknown>),
          replacements: { type: 'integer', minimum: 1 },
        },
        required: ['path', 'bytes', 'created', 'version', 'replacements'],
      },
      render(_args, value) {
        return textContent(
          `Edited ${value.path}: ${value.replacements} replacement(s), ${value.bytes} bytes.`,
        );
      },
      presentationMeta(_args, value) {
        return { path: value.path, bytes: value.bytes, replacements: value.replacements };
      },
    },
    concurrencySafe: false,
    replaySafe: false,
    exclusive: true,
    timeoutMs: 10_000,
    resolveApprovalPolicy(raw, context) {
      const parsed = input.parse(raw);
      return fileSystem.isOutsideWorkspace(context, parsed.file_path) ? 'always' : 'never';
    },
    async execute(raw, context) {
      const parsed = input.parse(raw);
      try {
        return await fileSystem.edit(
          context,
          parsed.file_path,
          parsed.old_string,
          parsed.new_string,
          parsed.replace_all,
          {
            allowOutsideWorkspace:
              context.permissionPreset === 'full-access' || Boolean(context.approvalGranted),
          },
        );
      } catch (error) {
        throw fileError(error);
      }
    },
    presentCall(raw) {
      const parsed = input.safeParse(raw);
      return parsed.success
        ? { kind: 'diff', title: '编辑文件', path: parsed.data.file_path }
        : undefined;
    },
    presentResult: fileResultPresenter(input, '编辑文件'),
  };
}

function bashTool(shell: ShellExecutor): RuntimeTool<ShellExecutionResult> {
  const input = z
    .object({
      command: z
        .string()
        .min(1)
        .max(128 * 1024),
      description: z.string().min(1).max(500),
      timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
      workdir: z.string().min(1).max(4096).optional(),
      network_access: z.boolean().default(false),
      writable_paths: z.array(z.string().min(1).max(4096)).max(20).default([]),
    })
    .strict();
  return {
    name: 'bash',
    description:
      '在当前 Session 工作区或已启用 Skill 目录中执行一次有界前台 Bash 命令；持久化展示文件写入 $AGENT_ARTIFACTS_DIR；不提供 TTY、后台 Job 或持久 Shell。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1 },
        description: { type: 'string', minLength: 1 },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 120000, default: 15000 },
        workdir: { type: 'string', minLength: 1 },
        network_access: {
          type: 'boolean',
          default: false,
          description: '命令是否需要访问网络；未声明时受限模式会阻止网络。',
        },
        writable_paths: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1 },
          default: [],
          description: '除当前工作区外，命令需要写入的精确文件或目录路径。',
        },
      },
      required: ['command', 'description'],
      additionalProperties: false,
    },
    output: {
      schema: bashOutputSchema,
      render(_args, value) {
        const parts = [
          value.stdout ? `stdout:\n${value.stdout}` : '',
          value.stderr ? `stderr:\n${value.stderr}` : '',
          `exitCode: ${value.exitCode ?? 'null'}`,
          value.signal ? `signal: ${value.signal}` : '',
          value.stdoutTruncated || value.stderrTruncated ? '[output truncated]' : '',
        ].filter(Boolean);
        return textContent(parts.join('\n'));
      },
      presentationMeta(_args, value) {
        return {
          cwd: value.cwd,
          exitCode: value.exitCode,
          signal: value.signal,
          timedOut: value.timedOut,
          cancelled: value.cancelled,
          stdoutTruncated: value.stdoutTruncated,
          stderrTruncated: value.stderrTruncated,
          locations: value.locations,
        };
      },
    },
    concurrencySafe: false,
    replaySafe: false,
    exclusive: true,
    timeoutMs: 125_000,
    resolveApprovalPolicy(raw, context) {
      const parsed = input.parse(raw);
      return shell.requiresApproval(context, {
        networkAccess: parsed.network_access,
        writablePaths: parsed.writable_paths,
      })
        ? 'always'
        : 'never';
    },
    async execute(raw, context) {
      const parsed = input.parse(raw);
      try {
        const result = await shell.execute({
          ...context,
          command: parsed.command,
          workdir: parsed.workdir,
          timeoutMs: parsed.timeoutMs,
          networkAccess: parsed.network_access,
          writablePaths: parsed.writable_paths,
        });
        if (result.cancelled) {
          throw new ToolExecutionError(
            'PROCESS_CANCELLED',
            'cancelled',
            result,
            'Bash command cancelled.',
          );
        }
        if (result.timedOut) {
          throw new ToolExecutionError(
            'PROCESS_TIMEOUT',
            'fatal_error',
            result,
            'Bash command timed out.',
          );
        }
        return result;
      } catch (error) {
        if (error instanceof ToolExecutionError) throw error;
        if (error instanceof ShellExecutionError) {
          throw new ToolExecutionError(error.code, 'fatal_error', undefined, error.message);
        }
        throw new ToolExecutionError('PROCESS_START_FAILED');
      }
    },
    presentCall(raw) {
      const parsed = input.safeParse(raw);
      return parsed.success
        ? {
            kind: 'terminal',
            title: parsed.data.description,
            command: parsed.data.command,
            detail: parsed.data.network_access ? '需要网络访问' : parsed.data.workdir,
            locations: parsed.data.writable_paths.map((path) => ({ path })),
          }
        : undefined;
    },
    presentResult(raw, result) {
      const parsed = input.safeParse(raw);
      if (!parsed.success) return undefined;
      const meta = recordOf(result.meta);
      const exitCode = typeof meta?.exitCode === 'number' ? meta.exitCode : null;
      return {
        kind: 'terminal',
        title: parsed.data.description,
        command: parsed.data.command,
        detail: parsed.data.workdir,
        status: result.status === 'success' && exitCode === 0 ? 'success' : 'error',
        locations:
          result.status === 'success' && exitCode === 0 ? locationsOf(meta?.locations) : [],
      };
    },
  };
}

const readOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
    offset: { type: 'integer' },
    limit: { type: 'integer' },
    totalLines: { type: 'integer' },
    truncated: { type: 'boolean' },
    version: { type: 'string' },
  },
  required: ['path', 'content', 'offset', 'limit', 'totalLines', 'truncated', 'version'],
  additionalProperties: false,
};

const writeOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    bytes: { type: 'integer' },
    created: { type: 'boolean' },
    version: { type: 'string' },
  },
  required: ['path', 'bytes', 'created', 'version'],
  additionalProperties: false,
};

const bashOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    cwd: { type: 'string' },
    command: { type: 'string' },
    exitCode: { type: ['integer', 'null'] },
    signal: { type: ['string', 'null'] },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    timedOut: { type: 'boolean' },
    cancelled: { type: 'boolean' },
    stdoutTruncated: { type: 'boolean' },
    stderrTruncated: { type: 'boolean' },
    locations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'cwd',
    'command',
    'exitCode',
    'signal',
    'stdout',
    'stderr',
    'timedOut',
    'cancelled',
    'stdoutTruncated',
    'stderrTruncated',
    'locations',
  ],
  additionalProperties: false,
};

function fileError(error: unknown): ToolExecutionError {
  if (error instanceof ScopedFileSystemError) {
    return new ToolExecutionError(error.code, 'fatal_error', undefined, error.message);
  }
  return new ToolExecutionError('FILE_OPERATION_FAILED');
}

function fileResultPresenter(
  schema: z.ZodType<{ file_path: string }>,
  title: string,
): (raw: unknown, result: ToolResult) => ReturnType<NonNullable<RuntimeTool['presentResult']>> {
  return (raw, result) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return undefined;
    const meta = recordOf(result.meta);
    const path = typeof meta?.path === 'string' ? meta.path : parsed.data.file_path;
    return {
      kind: 'diff',
      title,
      path,
      status: result.status === 'success' ? 'success' : 'error',
      locations: result.status === 'success' ? [{ path }] : [],
    };
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function locationsOf(value: unknown): Array<{ path: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordOf(item);
    return typeof record?.path === 'string' ? [{ path: record.path }] : [];
  });
}
