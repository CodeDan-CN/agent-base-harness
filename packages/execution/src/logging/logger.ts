/** 结构化 JSONL 日志：字段关联、脱敏与有界轮转。 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Redactor } from './redactor';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** 派生一个携带固定上下文字段的子 Logger。 */
  child(fields: LogFields): Logger;
  registerSecret(secret: string): void;
}

const BASE_FIELDS_KEYS = new Set(['timestamp', 'level', 'message', 'scope']);

export interface JsonlLoggerOptions {
  dir: string;
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
  level?: LogLevel;
  /** 是否同时输出到 stdout（开发模式）。 */
  console?: boolean;
}

export class JsonlLogger implements Logger {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly level: LogLevel;
  private readonly consoleOutput: boolean;
  private readonly redactor: Redactor;
  private readonly scope: LogFields;
  private id: string;

  constructor(
    opts: JsonlLoggerOptions,
    scope: LogFields = {},
    redactor: Redactor = new Redactor(),
  ) {
    this.maxBytes = opts.maxBytes ?? 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 5;
    this.level = opts.level ?? 'info';
    this.consoleOutput = opts.console ?? false;
    this.redactor = redactor;
    this.scope = { ...scope };
    this.id = crypto.randomUUID();
    this.filePath = path.join(opts.dir, opts.fileName ?? 'app.log');
    mkdirSync(opts.dir, { recursive: true });
  }

  get currentFilePath(): string {
    return this.filePath;
  }

  child(fields: LogFields): Logger {
    return new JsonlLogger(
      {
        dir: path.dirname(this.filePath),
        fileName: path.basename(this.filePath),
        maxBytes: this.maxBytes,
        maxFiles: this.maxFiles,
        level: this.level,
        console: this.consoleOutput,
      },
      { ...this.scope, ...fields },
      this.redactor,
    );
  }

  registerSecret(secret: string): void {
    this.redactor.registerSecret(secret);
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields: LogFields = {}): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields: LogFields = {}): void {
    this.log('error', msg, fields);
  }

  private log(level: LogLevel, msg: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message: msg,
      loggerId: this.id,
      ...this.scope,
    };
    for (const [k, v] of Object.entries(fields)) {
      if (BASE_FIELDS_KEYS.has(k)) continue;
      entry[k] = v;
    }

    const line = this.redactor.redact(JSON.stringify(entry));

    if (this.consoleOutput) {
      const fn =
        level === 'debug'
          ? 'log'
          : level === 'warn'
            ? 'warn'
            : level === 'error'
              ? 'error'
              : 'info';
      console[fn](line);
    }

    this.rotateIfNeeded();
    writeFileSync(this.filePath, line + '\n', { flag: 'a' });
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath)) return;
    const size = statSync(this.filePath).size;
    if (size < this.maxBytes) return;

    // 删除最旧的第 maxFiles 份。
    const oldest = `${this.filePath}.${this.maxFiles}`;
    if (existsSync(oldest)) {
      writeFileSync(oldest, '');
      renameSync(oldest, `${oldest}.tmp`);
      // 简单实现：直接删除最旧文件。
    }
    // 依次后移 app.log.N -> app.log.N+1
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      const to = `${this.filePath}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(this.filePath, `${this.filePath}.1`);
  }
}

/** 内存 Logger：测试与断言用，共享同一个 Redactor。 */
export class MemoryLogger implements Logger {
  readonly entries: Record<string, unknown>[] = [];
  private readonly redactor: Redactor;
  private readonly scope: LogFields;

  constructor(scope: LogFields = {}, redactor: Redactor = new Redactor()) {
    this.scope = scope;
    this.redactor = redactor;
  }

  child(fields: LogFields): Logger {
    return new MemoryLogger({ ...this.scope, ...fields }, this.redactor);
  }

  registerSecret(secret: string): void {
    this.redactor.registerSecret(secret);
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.entries.push(this.serialize('debug', msg, fields));
  }
  info(msg: string, fields: LogFields = {}): void {
    this.entries.push(this.serialize('info', msg, fields));
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.entries.push(this.serialize('warn', msg, fields));
  }
  error(msg: string, fields: LogFields = {}): void {
    this.entries.push(this.serialize('error', msg, fields));
  }

  private serialize(level: LogLevel, msg: string, fields: LogFields): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message: msg,
      ...this.scope,
    };
    for (const [k, v] of Object.entries(fields)) {
      if (BASE_FIELDS_KEYS.has(k)) continue;
      entry[k] = v;
    }
    // 记录脱敏后的 JSON 字符串，供写入断言。
    return { ...entry, _redacted: this.redactor.redact(JSON.stringify(entry)) };
  }

  /** 用于断言“日志中不存在某哨兵值”。 */
  contains(substr: string): boolean {
    return this.entries.some((e) => (e._redacted as string).includes(substr));
  }
}

/** 收集日志目录中全部轮转文件的文本，供敏感信息扫描。 */
export function readAllLogFiles(dir: string): string {
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir).filter((f) => f.startsWith('app.log'));
  return files
    .map((f) => {
      const p = path.join(dir, f);
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return '';
      }
    })
    .join('');
}
