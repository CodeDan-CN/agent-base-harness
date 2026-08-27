/**
 * 领域基础端口：时间与 ID 通过依赖注入提供，保证测试确定性。
 */

/** 单调递增 ID 提供者。 */
export interface IdProvider {
  newId(): string;
}

/** 可注入的时钟。 */
export interface Clock {
  now(): Date;
  /** ISO-8601 UTC 时间字符串，用于落库。 */
  nowIso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}

/** 基于 crypto.randomUUID 的生产 ID 提供者。 */
export class UuidIdProvider implements IdProvider {
  newId(): string {
    return crypto.randomUUID();
  }
}
