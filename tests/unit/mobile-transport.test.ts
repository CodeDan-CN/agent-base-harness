import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createNativeTransport } from '../../apps/mobile/src/native-transport';
import type { AndroidTransport } from '../../apps/mobile/src/native-transport';

function fixture() {
  const events: typeof window = {} as typeof window;
  vi.stubGlobal('window', events);
  const native: AndroidTransport = { configure: vi.fn(), request: vi.fn(), cancel: vi.fn() };
  const fetcher = createNativeTransport(native);
  const id = (index = 0) => vi.mocked(native.request).mock.calls[index]![0];
  const emit = (event: Parameters<NonNullable<Window['__harnessHttp']>>[0]) =>
    events.__harnessHttp!(event);
  return { native, fetcher, id, emit };
}
afterEach(() => vi.unstubAllGlobals());

describe('mobile streaming HTTP bridge', () => {
  it('correlates native responses when randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const { fetcher, id, emit } = fixture();
    const pending = fetcher('https://remote.test/healthz');
    expect(id()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    emit({ id: id(), type: 'headers', status: 204, headers: {} });
    emit({ id: id(), type: 'end' });
    expect((await pending).status).toBe(204);
  });

  it('delivers headers before the stream ends and preserves split UTF-8 bytes', async () => {
    const { fetcher, id, emit } = fixture();
    const pending = fetcher('https://remote.test/v1/events');
    emit({
      id: id(),
      type: 'headers',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const response = await pending;
    const body = response.text();
    const bytes = Buffer.from('data: 手机\n\n');
    emit({ id: id(), type: 'chunk', data: bytes.subarray(0, 7).toString('base64') });
    emit({ id: id(), type: 'chunk', data: bytes.subarray(7).toString('base64') });
    emit({ id: id(), type: 'end' });
    expect(await body).toBe('data: 手机\n\n');
  });

  it('cancels a live SSE request and ignores late native chunks', async () => {
    const { fetcher, native, id, emit } = fixture();
    const controller = new AbortController();
    const pending = fetcher('https://remote.test/v1/events', { signal: controller.signal });
    emit({ id: id(), type: 'headers', status: 200, headers: {} });
    const reader = (await pending).body!.getReader();
    const waiting = reader.read();
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    emit({ id: id(), type: 'chunk', data: 'eA==' });
    emit({ id: id(), type: 'end' });
    await rejected;
    expect(native.cancel).toHaveBeenCalledWith(id());
  });

  it('does not start an already cancelled request', async () => {
    const { fetcher, native } = fixture();
    await expect(
      fetcher('https://remote.test', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.request).not.toHaveBeenCalled();
  });

  it('supports 204 logout responses', async () => {
    const { fetcher, id, emit } = fixture();
    const pending = fetcher('https://remote.test/v1/auth/logout');
    emit({ id: id(), type: 'headers', status: 204, headers: {} });
    emit({ id: id(), type: 'end' });
    expect((await pending).status).toBe(204);
  });

  it('isolates simultaneous HTTP responses', async () => {
    const { fetcher, id, emit } = fixture();
    const first = fetcher('https://remote.test/healthz');
    const second = fetcher('https://remote.test/v1/auth/me');
    emit({ id: id(1), type: 'headers', status: 401, headers: {} });
    emit({ id: id(1), type: 'end' });
    emit({ id: id(0), type: 'headers', status: 200, headers: {} });
    emit({ id: id(0), type: 'end' });
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(401);
  });
});
