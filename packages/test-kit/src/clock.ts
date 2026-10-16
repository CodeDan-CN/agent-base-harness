import type { Clock, IdProvider } from '../../protocol/src/domain/ports';

export class FixedClock implements Clock {
  private currentMs: number;

  constructor(initialIso = '2026-01-01T00:00:00.000Z') {
    this.currentMs = Date.parse(initialIso);
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advanceMs(ms: number): void {
    this.currentMs += ms;
  }

  setIso(iso: string): void {
    this.currentMs = Date.parse(iso);
  }
}

export class SequentialIdProvider implements IdProvider {
  private counter: number;

  constructor(
    private readonly prefix = 'id',
    start = 1,
  ) {
    this.counter = start;
  }

  newId(): string {
    const id = `${this.prefix}-${this.counter}`;
    this.counter += 1;
    return id;
  }
}
