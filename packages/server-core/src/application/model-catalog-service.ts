import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  simplifyModelsDevCatalog,
  validateCatalog,
  type ModelCatalog,
} from '../../../runtime-core/src/model-catalog';

const SOURCE = 'https://models.dev/api.json';
const MAX_BYTES = 32 * 1024 * 1024;

/** Public capability metadata only. Credentials and provider requests never enter this cache. */
export class ModelCatalogService {
  private current: ModelCatalog;
  private fetchedAt: number | null = null;
  private retryAfter = 0;
  private inflight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private error: string | null = null;
  private source: 'bundled' | 'cache' | 'remote' = 'bundled';
  private closed = false;

  constructor(
    private readonly options: {
      bundled: ModelCatalog;
      cachePath: string;
      fetch?: typeof globalThis.fetch;
      now?: () => number;
      ttlMs?: number;
      timeoutMs?: number;
    },
  ) {
    this.current = validateCatalog(options.bundled);
    try {
      const saved = JSON.parse(readFileSync(options.cachePath, 'utf8')) as Record<string, unknown>;
      const catalog = validateCatalog(saved.catalog);
      const bundledDate = Date.parse(this.current.generatedAt.split('#')[0]!);
      const cachedDate = Date.parse(catalog.generatedAt.split('#')[0]!);
      const olderThanBundle =
        Number.isFinite(bundledDate) && Number.isFinite(cachedDate) && cachedDate < bundledDate;
      if (
        !olderThanBundle &&
        typeof saved.fetchedAt === 'number' &&
        Number.isFinite(saved.fetchedAt)
      ) {
        this.current = catalog;
        this.fetchedAt = saved.fetchedAt;
        this.source = 'cache';
      }
    } catch {
      /* A missing or damaged cache falls back to the validated bundled catalog. */
    }
  }

  get catalog(): ModelCatalog {
    return this.current;
  }

  get status() {
    return {
      source: this.source,
      version: this.current.generatedAt,
      fetchedAt: this.fetchedAt === null ? null : new Date(this.fetchedAt).toISOString(),
      stale:
        this.fetchedAt === null ||
        this.now() - this.fetchedAt >= (this.options.ttlMs ?? 86_400_000),
      refreshing: this.inflight !== null,
      error: this.error,
    };
  }

  refresh(force = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inflight) return this.inflight;
    if (!force && (!this.status.stale || this.now() < this.retryAfter)) return Promise.resolve();
    this.inflight = this.download().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async download(): Promise<void> {
    this.controller = new AbortController();
    const timer = setTimeout(() => this.controller?.abort(), this.options.timeoutMs ?? 5000);
    const temporary = `${this.options.cachePath}.${process.pid}.tmp`;
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(SOURCE, {
        signal: this.controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > MAX_BYTES)
        throw new Error('CATALOG_TOO_LARGE');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('CATALOG_EMPTY');
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          throw new Error('CATALOG_TOO_LARGE');
        }
        chunks.push(value);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
      const version = `${response.headers.get('last-modified') ?? new Date(this.now()).toISOString()}#${digest}`;
      const catalog = simplifyModelsDevCatalog(JSON.parse(raw), version);
      if (this.closed) return;
      const fetchedAt = this.now();
      mkdirSync(path.dirname(this.options.cachePath), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ fetchedAt, catalog }), 'utf8');
      renameSync(temporary, this.options.cachePath);
      this.current = catalog;
      this.fetchedAt = fetchedAt;
      this.source = 'remote';
      this.error = null;
    } catch {
      if (!this.closed) {
        this.error = '目录更新失败，继续使用上一份有效数据';
        this.retryAfter = this.now() + 300_000;
      }
    } finally {
      clearTimeout(timer);
      this.controller = null;
      rmSync(temporary, { force: true });
    }
  }
}
