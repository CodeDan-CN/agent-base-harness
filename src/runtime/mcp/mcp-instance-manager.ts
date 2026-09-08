export type McpInstanceScopeType = 'user' | 'agent';

export interface McpInstanceKey {
  userId: string;
  serverId: string;
  scopeType: McpInstanceScopeType;
  scopeId: string;
}

export interface McpInstanceView {
  key: McpInstanceKey;
  status: 'connecting' | 'connected' | 'suspended' | 'error';
  generation: number;
  activeCalls: number;
  lastUsed: string | null;
  error: string | null;
}

export interface McpInstanceLease<Client> {
  readonly client: Client;
  readonly generation: number;
  runExclusive<T>(work: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T>;
  release(): void;
}

interface InstanceState<Client> {
  key: McpInstanceKey;
  status: 'connecting' | 'connected' | 'error';
  client: Client | null;
  connecting: Promise<Client> | null;
  generation: number;
  activeCalls: number;
  lastUsedMs: number;
  error: string | null;
  idleTimer: NodeJS.Timeout | null;
  serialTail: Promise<void>;
  invalidated: boolean;
}

export class McpInstanceCapacityError extends Error {
  readonly code = 'MCP_CAPACITY_EXCEEDED';

  constructor() {
    super('MCP instance capacity is exhausted');
    this.name = 'McpInstanceCapacityError';
  }
}

/** Host-level, scope-aware pool for lazy MCP connections. */
export class McpInstanceManager<Client extends { close(): Promise<void> }> {
  private readonly states = new Map<string, InstanceState<Client>>();
  private readonly inactive = new Map<string, McpInstanceView>();
  private readonly generations = new Map<string, number>();
  private capacityTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly options: {
      idleMs?: number;
      maxPerUser?: number;
      maxHost?: number;
      now?: () => number;
    } = {},
  ) {}

  async acquire(input: {
    key: McpInstanceKey;
    open(): Promise<Client>;
    signal?: AbortSignal;
  }): Promise<McpInstanceLease<Client>> {
    if (this.disposed) throw new Error('MCP instance manager is closed');
    throwIfAborted(input.signal);
    const encoded = encodeKey(input.key);
    let state = this.states.get(encoded);
    if (state?.invalidated) {
      if (state.activeCalls > 0) throw new Error('MCP instance is being reconfigured');
      await this.closeState(encoded, state);
      state = undefined;
    }
    if (!state) {
      const previousReservation = this.capacityTail;
      let finishReservation!: () => void;
      this.capacityTail = new Promise<void>((resolve) => {
        finishReservation = resolve;
      });
      await previousReservation;
      try {
        state = this.states.get(encoded);
        if (!state) await this.reserveCapacity(input.key.userId);
        state = this.states.get(encoded);
        if (!state) {
          const generation = (this.generations.get(encoded) ?? 0) + 1;
          this.generations.set(encoded, generation);
          state = {
            key: input.key,
            status: 'connecting',
            client: null,
            connecting: null,
            generation,
            activeCalls: 0,
            lastUsedMs: this.now(),
            error: null,
            idleTimer: null,
            serialTail: Promise.resolve(),
            invalidated: false,
          };
          this.inactive.delete(encoded);
          this.states.set(encoded, state);
          const connecting = input.open();
          state.connecting = connecting;
          void connecting
            .then(async (client) => {
              const current = this.states.get(encoded);
              if (this.disposed || current !== state || state!.invalidated) {
                await client.close().catch(() => undefined);
                return;
              }
              state!.client = client;
              state!.status = 'connected';
              state!.connecting = null;
              state!.lastUsedMs = this.now();
              this.scheduleIdle(encoded, state!);
            })
            .catch((error: unknown) => {
              if (this.states.get(encoded) !== state) return;
              state!.status = 'error';
              state!.connecting = null;
              state!.error = safeError(error);
            });
        }
      } finally {
        finishReservation();
      }
    }
    if (state.connecting) await abortable(state.connecting, input.signal);
    if (!state.client || state.status !== 'connected') {
      const error = state.error;
      await this.closeState(encoded, state, error ? 'error' : 'suspended');
      throw new Error(error ?? 'MCP instance failed to connect');
    }
    clearIdle(state);
    state.activeCalls += 1;
    state.lastUsedMs = this.now();
    let released = false;
    return {
      client: state.client,
      generation: state.generation,
      runExclusive: async <T>(work: (client: Client) => Promise<T>, signal?: AbortSignal) => {
        throwIfAborted(signal);
        const previous = state!.serialTail;
        let unlock!: () => void;
        state!.serialTail = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        try {
          await abortable(previous, signal);
        } catch (error) {
          void previous.finally(unlock);
          throw error;
        }
        try {
          throwIfAborted(signal);
          return await work(state!.client!);
        } finally {
          unlock();
        }
      },
      release: () => {
        if (released) return;
        released = true;
        state!.activeCalls = Math.max(0, state!.activeCalls - 1);
        state!.lastUsedMs = this.now();
        if (state!.invalidated && state!.activeCalls === 0) {
          void this.closeState(encoded, state!);
        } else {
          this.scheduleIdle(encoded, state!);
        }
      },
    };
  }

  snapshot(userId?: string): McpInstanceView[] {
    const active = [...this.states.entries()].map(
      ([encoded, state]) =>
        [
          encoded,
          {
            key: { ...state.key },
            status: state.status,
            generation: state.generation,
            activeCalls: state.activeCalls,
            lastUsed: state.lastUsedMs ? new Date(state.lastUsedMs).toISOString() : null,
            error: state.error,
          } satisfies McpInstanceView,
        ] as const,
    );
    return [...new Map([...this.inactive, ...active]).values()].filter(
      (view) => !userId || view.key.userId === userId,
    );
  }

  async invalidate(userId: string, serverId: string): Promise<void> {
    const targets = [...this.states.entries()].filter(
      ([, state]) => state.key.userId === userId && state.key.serverId === serverId,
    );
    for (const [encoded, state] of targets) {
      state.invalidated = true;
      if (state.activeCalls === 0) await this.closeState(encoded, state);
    }
  }

  connectionClosed(key: McpInstanceKey, client: Client, error = 'Connection closed'): void {
    const encoded = encodeKey(key);
    const state = this.states.get(encoded);
    if (!state || state.client !== client) return;
    clearIdle(state);
    state.client = null;
    state.status = 'error';
    state.error = error;
    this.states.delete(encoded);
    this.inactive.set(encoded, this.view(state, 'error'));
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.states.entries()];
    await Promise.all(entries.map(([encoded, state]) => this.closeState(encoded, state)));
  }

  private async reserveCapacity(userId: string): Promise<void> {
    const maxPerUser = this.options.maxPerUser ?? 5;
    const maxHost = this.options.maxHost ?? 20;
    while (
      this.states.size >= maxHost ||
      [...this.states.values()].filter((state) => state.key.userId === userId).length >= maxPerUser
    ) {
      const candidate = [...this.states.entries()]
        .filter(([, state]) => state.activeCalls === 0 && state.status !== 'connecting')
        .sort((left, right) => left[1].lastUsedMs - right[1].lastUsedMs)[0];
      if (!candidate) throw new McpInstanceCapacityError();
      await this.closeState(candidate[0], candidate[1]);
    }
  }

  private scheduleIdle(encoded: string, state: InstanceState<Client>): void {
    if (state.activeCalls > 0 || state.status !== 'connected' || state.invalidated) return;
    clearIdle(state);
    state.idleTimer = setTimeout(
      () => {
        if (state.activeCalls === 0) void this.closeState(encoded, state);
      },
      this.options.idleMs ?? 10 * 60_000,
    );
    state.idleTimer.unref();
  }

  private async closeState(
    encoded: string,
    state: InstanceState<Client>,
    status: 'suspended' | 'error' = 'suspended',
  ): Promise<void> {
    if (this.states.get(encoded) !== state) return;
    clearIdle(state);
    this.states.delete(encoded);
    const client = state.client;
    state.client = null;
    if (client) await client.close().catch(() => undefined);
    this.inactive.set(encoded, this.view(state, status));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private view(state: InstanceState<Client>, status: 'suspended' | 'error'): McpInstanceView {
    return {
      key: { ...state.key },
      status,
      generation: state.generation,
      activeCalls: 0,
      lastUsed: state.lastUsedMs ? new Date(state.lastUsedMs).toISOString() : null,
      error: status === 'error' ? state.error : null,
    };
  }
}

function encodeKey(key: McpInstanceKey): string {
  return `${key.userId}\0${key.serverId}\0${key.scopeType}\0${key.scopeId}`;
}

function clearIdle<Client>(state: InstanceState<Client>): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Operation aborted'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
