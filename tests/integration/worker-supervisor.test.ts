import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { RuntimeWorkerSupervisor } from '../../packages/server-core/src/legacy/worker-supervisor';
import type {
  WorkerControlMessage,
  WorkerEventMessage,
} from '../../packages/protocol/src/contracts/worker-messages';
import type { WorkerBootstrapData } from '../../packages/server-core/src/application/index';
import type { LifecycleEvent } from '../../packages/protocol/src/contracts/ipc';
import { FixedClock } from '../../packages/test-kit/src/clock';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';

class FakeWorker extends EventEmitter {
  posted: WorkerControlMessage[] = [];

  constructor(public readonly data: WorkerBootstrapData) {
    super();
  }

  postMessage(message: WorkerControlMessage): void {
    this.posted.push(message);
    if (message.type === 'shutdown') {
      setImmediate(() => this.emit('exit', 0));
    }
  }

  terminate(): Promise<number> {
    return Promise.resolve(0);
  }

  emitReady(generation: number): void {
    const msg: WorkerEventMessage = {
      type: 'ready',
      workerGeneration: generation,
      schemaVersion: 1,
      activeUserId: 'user-a',
      capabilities: { model: 'foundation', skill: 'foundation', runtime: 'pending' },
    };
    this.emit('message', msg);
  }

  emitExit(code: number): void {
    this.emit('exit', code);
  }
}

function createHarness(opts: Partial<{ backoffMinMs: number; backoffMaxMs: number }> = {}) {
  let worker: FakeWorker | null = null;
  const events: LifecycleEvent[] = [];
  const supervisor = new RuntimeWorkerSupervisor({
    factory: (data) => {
      worker = new FakeWorker(data);
      return worker;
    },
    workerData: (generation: number): WorkerBootstrapData => ({
      appDataDir: '/tmp/fake',
      generation,
    }),
    clock: new FixedClock(),
    logger: new MemoryLogger(),
    backoffMinMs: opts.backoffMinMs ?? 1,
    backoffMaxMs: opts.backoffMaxMs ?? 1,
    startupTimeoutMs: 5000,
    onLifecycle: (event) => events.push(event),
  });
  return { supervisor, events, getWorker: () => worker };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('M03 Runtime Worker Supervisor', () => {
  it('S1-M03-001 正常启动进入 ready，generation=1', async () => {
    const { supervisor, getWorker } = createHarness();
    const promise = supervisor.start();
    getWorker()!.emitReady(1);
    await promise;

    expect(supervisor.getState().status).toBe('ready');
    expect(supervisor.getState().generation).toBe(1);
    await supervisor.stop();
  });

  it('S1-M03-002 ready 前请求返回 RUNTIME_NOT_READY', async () => {
    const { supervisor } = createHarness();
    await expect(
      supervisor.request({
        requestId: 'r1',
        userId: 'user-a',
        windowId: 'w',
        method: 'app.bootstrap',
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
    await supervisor.stop();
  });

  it('S1-M03-004 未完成请求在崩溃时确定失败 RUNTIME_RESTARTED', async () => {
    const { supervisor, getWorker } = createHarness({ backoffMaxMs: 1000 });
    const ready = supervisor.start();
    getWorker()!.emitReady(1);
    await ready;

    const request = supervisor.request({
      requestId: 'r1',
      userId: 'user-a',
      windowId: 'w',
      method: 'app.bootstrap',
    });
    getWorker()!.emitExit(1);

    await expect(request).rejects.toMatchObject({ code: 'RUNTIME_RESTARTED' });
    await supervisor.stop();
  });

  it('S1-M03-005 旧 generation 迟到响应被丢弃', async () => {
    const { supervisor, getWorker } = createHarness();
    const ready1 = supervisor.start();
    const gen1 = getWorker()!;
    gen1.emitReady(1);
    await ready1;

    gen1.emitExit(1);

    await sleep(30);
    const gen2 = getWorker()!;
    expect(gen2).not.toBe(gen1);
    expect(gen2.data.generation).toBe(2);
    gen2.emitReady(2);

    expect(supervisor.getState().generation).toBe(2);

    const request = supervisor.request({
      requestId: 'r2',
      userId: 'user-a',
      windowId: 'w',
      method: 'system.health',
    });
    request.catch(() => undefined);
    const reqCommand = gen2.posted.find((m) => m.type === 'request' && m.requestId === 'r2');
    expect(reqCommand).toBeTruthy();

    const stale: WorkerEventMessage = {
      type: 'response',
      requestId: 'r2',
      workerGeneration: 1,
      ok: true,
      result: { stale: true },
    };
    gen1.emit('message', stale);

    await sleep(10);
    expect(supervisor.getState().generation).toBe(2);
    await supervisor.stop();
  });

  it('S1-M03-011 生命周期订阅事件顺序一致', async () => {
    const { supervisor, events, getWorker } = createHarness();
    const ready1 = supervisor.start();
    getWorker()!.emitReady(1);
    await ready1;
    getWorker()!.emitExit(1);

    await sleep(30);
    getWorker()!.emitReady(2);

    const statuses = events.map((e) => (e.type === 'runtime' ? e.status : e.type));
    expect(statuses[0]).toBe('starting');
    expect(statuses[1]).toBe('ready');
    expect(statuses[2]).toBe('restarting');
    expect(statuses[3]).toBe('starting');
    await supervisor.stop();
  });

  it('S1-M03 正常关闭 ready → stopping → stopped', async () => {
    const { supervisor, getWorker } = createHarness();
    const ready = supervisor.start();
    getWorker()!.emitReady(1);
    await ready;

    await supervisor.stop();
    expect(supervisor.getState().status).toBe('stopped');
  });

  it('S1-M03-009 failed 后手动重试会创建新 generation 并恢复 ready', async () => {
    const { supervisor, getWorker } = createHarness();
    const initial = supervisor.start();
    const failed = expect(initial).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });

    for (let generation = 1; generation <= 6; generation += 1) {
      getWorker()!.emitExit(1);
      await sleep(5);
    }
    await failed;
    expect(supervisor.getState().status).toBe('failed');

    const retried = supervisor.retry();
    getWorker()!.emitReady(7);
    await retried;

    expect(supervisor.getState()).toMatchObject({ status: 'ready', generation: 7 });
    await supervisor.stop();
  });
});
