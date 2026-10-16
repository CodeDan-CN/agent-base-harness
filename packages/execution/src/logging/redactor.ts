/** 日志脱敏：注册的显式 secret 精确替换 + 常见敏感形态正则替换。 */

const SENSITIVE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // {"authorization":"value"} / "token":"value" 形态（JSON）
  [
    /("(?:authorization|api[_-]?key|token|secret|password|credential)"\s*:\s*")([^"]*)(")/gi,
    '$1[REDACTED]$3',
  ],
  // key=value（无引号）形态
  [
    /(\b(?:authorization|api[_-]?key|token|secret|password|credential)\s*=\s*)([^&"'\s]+)/gi,
    '$1[REDACTED]',
  ],
  // Bearer <token>
  [/(bearer\s+)[a-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  // sk-... 形态的 API key
  [/(sk-[a-zA-Z0-9_-]{8,})/g, '[REDACTED]'],
];

export class Redactor {
  private readonly secrets: string[] = [];

  registerSecret(secret: string): void {
    if (!secret || secret.length < 3) return;
    if (this.secrets.includes(secret)) return;
    this.secrets.push(secret);
  }

  redact(input: string): string {
    let out = input;
    for (const secret of this.secrets) {
      out = out.split(secret).join('[REDACTED]');
    }
    for (const [re, replacement] of SENSITIVE_PATTERNS) {
      out = out.replace(re, replacement);
    }
    return out;
  }

  redactDeep(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[this.redact(k)] = this.redactDeep(v);
      }
      return out;
    }
    return value;
  }
}
