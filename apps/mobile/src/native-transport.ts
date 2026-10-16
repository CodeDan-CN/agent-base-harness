import { createClientId } from '@client-contracts';

export interface AndroidTransport {
  configure(url: string): string;
  request(id: string, url: string, method: string, headers: string, body: string): void;
  cancel(id: string): void;
}
type NativeEvent =
  | { id: string; type: 'headers'; status: number; headers: Record<string, string> }
  | { id: string; type: 'chunk'; data: string }
  | { id: string; type: 'end' }
  | { id: string; type: 'error'; message: string };
declare global {
  interface Window {
    HarnessNative?: AndroidTransport;
    __harnessHttp?: (event: NativeEvent) => void;
  }
}

/** A streaming fetch adapter: native HTTP avoids CORS without relaxing Gateway origins. */
export function createNativeTransport(native: AndroidTransport): typeof fetch {
  const pending = new Map<string, (event: NativeEvent) => void>();
  window.__harnessHttp = (event) => pending.get(event.id)?.(event);
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const id = createClientId();
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    return new Promise<Response>((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        cancel() {
          native.cancel(id);
          cleanup();
        },
      });
      const cleanup = () => {
        pending.delete(id);
        request.signal.removeEventListener('abort', abort);
      };
      const fail = (error: Error) => {
        cleanup();
        controller.error(error);
        reject(error);
      };
      const abort = () => {
        native.cancel(id);
        fail(new DOMException('Aborted', 'AbortError'));
      };
      pending.set(id, (event) => {
        if (event.type === 'headers')
          resolve(
            new Response([204, 205, 304].includes(event.status) ? null : stream, {
              status: event.status,
              headers: event.headers,
            }),
          );
        else if (event.type === 'chunk')
          controller.enqueue(Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0)));
        else if (event.type === 'end') {
          cleanup();
          controller.close();
        } else fail(new Error(event.message));
      });
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) {
        abort();
        return;
      }
      try {
        native.request(
          id,
          request.url,
          request.method,
          JSON.stringify(Object.fromEntries(request.headers)),
          body,
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
}
