import type { LlmAdapter, ModelRequest, ModelResponse } from '../../runtime-core/src/model';
import type { IdProvider } from '../../protocol/src/domain/ports';

export class SequenceIdProvider implements IdProvider {
  private current = 0;

  newId(): string {
    this.current += 1;
    return `id-${this.current}`;
  }
}

export class FakeLlmAdapter implements LlmAdapter {
  readonly providerType = 'fake';
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly handler: (
      request: ModelRequest,
      signal: AbortSignal,
      index: number,
    ) => Promise<ModelResponse> | ModelResponse,
  ) {}

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    this.requests.push(request);
    return this.handler(request, signal, this.requests.length - 1);
  }
}

export function textResponse(content: string): ModelResponse {
  return {
    content,
    chunks: [content],
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: Math.max(1, Math.ceil(content.length / 4)) },
    stopReason: 'complete',
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
