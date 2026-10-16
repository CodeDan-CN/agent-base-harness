import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createWorkerApplication } from '../packages/server-core/src/application/application';
import { OpenAiCompatibleAdapter } from '../packages/execution/src/llm/openai-compatible-adapter';
import { SqliteCredentialStore } from '../packages/execution/src/credential/sqlite-credential-store';
import { MemoryLogger } from '../packages/execution/src/logging/logger';
import { LlmAdapterRegistry, type ModelRequest } from '../packages/runtime-core/src/model';
import { ToolRegistry } from '../packages/runtime-core/src/tools';
import { projectRuntime } from '../packages/protocol/src/client/projection';
import { estimateTextTokens } from '../packages/protocol/src/token-estimate';

interface ConfiguredModel {
  remote_model_id: string;
  endpoint: string;
  credential_ref: string | null;
  provider_preset_id: string | null;
}
type Scenario = 'audit' | 'hidden' | 'series';

const outputDir = path.resolve('outputs/benchmarks/low-context-quality');
const outputFile = path.join(outputDir, 'results.json');
const noise = Array.from(
  { length: 300 },
  (_, i) => `参考流水 ${i}：仅用于对账排查，不参与净额计算。`,
).join('\n');
const task =
  '请调用 audit_report 分别读取 overview、adjustments、policy，按同一口径比较7月和8月的净营业额及增长率。各阶段所需token来自上一阶段末尾。数据仅来自工具，不要猜测。最终只给JSON，字段为 julyNet、augustNet、growthPct、unit、basis、conclusion；无法核实的数字用null。';
const hiddenTask =
  '读取完整合同，判断客商 R-731 退货运费由谁承担、依据的例外规则号。必须核对中间的例外条款；缺少证据时明确无法确认，不要猜。最终只给JSON，字段为 payer、ruleId、uncertain。';
const seriesTask =
  '依次用 ledger_segment 读取全部8段账单；第一段 index=1,token=START，后续token来自上一段末尾。计算全部金额total、剔除void后的validTotal及有效记录count，给出excludedId与largestId。最终只输出JSON，缺少证据用null，不猜测。';

function estimatedInput(request: ModelRequest): number {
  return (
    estimateTextTokens(JSON.stringify(request.tools)) +
    request.messages.reduce(
      (total, message) =>
        total +
        4 +
        estimateTextTokens(message.content) +
        (message.toolCalls ? estimateTextTokens(JSON.stringify(message.toolCalls)) : 0) +
        (message.reasoningContent ? estimateTextTokens(message.reasoningContent) : 0),
      0,
    )
  );
}

async function run(
  model: ConfiguredModel,
  scenario: Scenario,
  window: number,
  limit: number,
  credentialStore: SqliteCredentialStore,
) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'low-context-quality-'));
  const tools = new ToolRegistry();
  const calls: unknown[] = [];
  tools.register({
    name:
      scenario === 'series'
        ? 'ledger_segment'
        : scenario === 'audit'
          ? 'audit_report'
          : 'read_contract',
    description:
      scenario === 'series'
        ? '读取一段账单；index为1到8，token必须来自上一段末尾，第一段使用START。'
        : scenario === 'audit'
          ? '读取对账报表的overview、adjustments、policy；后两段需上段末尾token。'
          : '读取完整合同（含例外条款）；无分页或搜索能力。',
    parameters:
      scenario === 'series'
        ? {
            type: 'object',
            properties: {
              index: { type: 'integer', minimum: 1, maximum: 8 },
              token: { type: 'string' },
            },
            required: ['index', 'token'],
            additionalProperties: false,
          }
        : scenario === 'audit'
          ? {
              type: 'object',
              properties: {
                section: { type: 'string', enum: ['overview', 'adjustments', 'policy'] },
                token: { type: 'string' },
              },
              required: ['section'],
              additionalProperties: false,
            }
          : { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    concurrencySafe: true,
    async execute(input) {
      calls.push(input);
      if (scenario === 'series') {
        const { index, token } = input as { index: number; token: string };
        if (token !== (index === 1 ? 'START' : `T${index}`))
          return 'token不正确，请读取上一段末尾。';
        const amounts = [17, 23, 31, 47, 59, 61, 73, 89];
        return `id=R${index} amount=${amounts[index - 1]} status=${index === 4 ? 'void' : 'valid'}\n${noise.split('\n').slice(0, 50).join('\n')}\n${index === 8 ? '全部结束' : `next=${index + 1} token=T${index + 1}`}`;
      }
      if (scenario === 'hidden')
        return `合同通则：退货通常由客商承担运费，最终判定必须考虑例外条款。\n${noise}\n唯一有效例外：R-731 的退货运费由平台承担，规则号 EX-47。\n${noise}\n合同正文结束。`;
      const args = input as { section: string; token?: string };
      if (args.section === 'overview')
        return `报表：7月销售毛额100万元，8月销售毛额120万元。两个月均需扣退款，尚不能据毛额判断净额增长。\n${noise}\n下一步adjustments，token=ADJ-73`;
      if (args.section === 'adjustments' && args.token === 'ADJ-73')
        return `退款：7月10万元，8月30万元。两个退款额必须从对应月份销售毛额扣除。\n${noise}\n下一步policy，token=POL-91`;
      if (args.section === 'policy' && args.token === 'POL-91')
        return '统一口径：净营业额=销售毛额-退款额；两月均为含税金额，不再额外扣税。单位万元；增长率=(8月净额-7月净额)/7月净额×100%。';
      return '参数不匹配。必须先读取上一段末尾的token。';
    },
  });
  const requests: Array<Record<string, unknown>> = [];
  const provider = new OpenAiCompatibleAdapter({
    credentialStore,
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: AbortSignal.any([
          init?.signal ?? new AbortController().signal,
          AbortSignal.timeout(45000),
        ]),
      }),
  });
  const adapters = new LlmAdapterRegistry();
  adapters.register({
    providerType: provider.providerType,
    async generate(request, signal) {
      const tokens = estimatedInput(request);
      const metric: Record<string, unknown> = {
        purpose: request.purpose,
        estimatedInput: tokens,
        outputReservation: request.maxOutputTokens,
        contextWindow: request.model.contextWindow,
      };
      requests.push(metric);
      if (requests.length > 25) throw new Error('QUALITY_TEST_CALL_LIMIT');
      if (tokens + request.maxOutputTokens > window) {
        metric.rejectedLocally = true;
        const error = new Error('test adapter context exceeded');
        error.name = 'MODEL_CONTEXT_WINDOW_EXCEEDED';
        throw error;
      }
      try {
        const response = await provider.generate(request, signal);
        Object.assign(metric, {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          stopReason: response.stopReason,
          actualExceedsWindow: response.usage.inputTokens + request.maxOutputTokens > window,
        });
        return response;
      } catch (error) {
        metric.error = error instanceof Error ? error.name : 'unknown';
        throw error;
      }
    },
  });
  const app = createWorkerApplication({
    appDataDir: temp,
    generation: 1,
    logger: new MemoryLogger(),
    tools,
    llmAdapters: adapters,
    runtimeOptions: { toolOutputTokenLimit: limit, safetyTokens: 64 },
  });
  try {
    const now = new Date().toISOString();
    app.repos.models.createService({
      id: 'quality-service',
      userId: 'user-a',
      name: 'Quality test',
      providerType: 'openai-compatible',
      endpoint: model.endpoint,
      credentialRef: model.credential_ref,
      config: {},
      now,
    });
    app.repos.models.createModel({
      id: 'quality-model',
      userId: 'user-a',
      serviceId: 'quality-service',
      remoteModelId: model.remote_model_id,
      displayName: model.remote_model_id,
      contextWindow: window,
      contextWindowOverride: window,
      requestMaxOutputTokens: 512,
      maxOutputTokens: 512,
      thinkingMode: 'disabled',
      capabilities: { tools: true },
      defaultParams: { temperature: 0, chat_template_kwargs: { enable_thinking: false } },
      source: 'manual',
      now,
    });
    app.repos.models.setDefaultModel('user-a', 'quality-model', now);
    app.runtime.createSession('user-a', {
      sessionId: 'quality-session',
      title: 'Temporary quality test',
    });
    app.runtime.submitInput('user-a', {
      sessionId: 'quality-session',
      content: scenario === 'series' ? seriesTask : scenario === 'audit' ? task : hiddenTask,
      idempotencyKey: 'quality',
      startNewEvent: true,
    });
    await app.runtime.waitForIdle();
    const events = app.repos.sessions.listEvents('user-a', 'quality-session');
    const projection = projectRuntime(events);
    const final =
      projection.messages
        .filter((message) => message.role === 'assistant' && !message.toolCalls?.length)
        .at(-1)?.content ?? '';
    const turn = [...projection.turns.values()].at(-1);
    const { checks, strictJson } = gradeAnswer(scenario, final, calls);
    const result = {
      scenario,
      window,
      toolTokenLimit: limit,
      model: model.remote_model_id,
      status: turn?.status,
      endReason: turn?.endReason,
      toolCalls: calls,
      truncatedResults: projection.surfaceReplacements.filter((r) => r.kind === 'tool-output-limit')
        .length,
      checkpoints: projection.surfaceReplacements.filter((r) => r.kind === 'checkpoint').length,
      requests,
      checks,
      strictJson,
      answer: final,
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await app.runtime.shutdown();
    app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function gradeAnswer(scenario: string, final: string, calls: unknown[]) {
  let answer: Record<string, unknown> | null = null;
  try {
    const json =
      final.match(/```(?:json)?\s*([\s\S]*?)```/u)?.[1] ??
      final.slice(final.indexOf('{'), final.lastIndexOf('}') + 1);
    answer = JSON.parse(json);
  } catch {
    /* Unstructured answers are retained for manual review. */
  }
  const checks =
    scenario === 'series'
      ? {
          total: answer?.total === 400,
          validTotal: answer?.validTotal === 353,
          count: answer?.count === 7,
          excludedId: answer?.excludedId === 'R4',
          largestId: answer?.largestId === 'R8',
          allSegmentsRead: Array.from({ length: 8 }, (_, i) => i + 1).every((index) =>
            calls.some((call) => (call as { index?: number }).index === index),
          ),
        }
      : scenario === 'audit'
        ? {
            july: answer?.julyNet === 90,
            august: answer?.augustNet === 90,
            growth: answer?.growthPct === 0,
            unit: answer?.unit === '万元',
            basis:
              /退款/u.test(String(answer?.basis ?? '')) &&
              /含税/u.test(String(answer?.basis ?? '')),
            allSectionsRead: ['overview', 'adjustments', 'policy'].every((section) =>
              calls.some((call) => (call as { section?: string }).section === section),
            ),
          }
        : {
            correctPayer: /平台/u.test(String(answer?.payer ?? '')),
            correctRule: answer?.ruleId === 'EX-47',
            admitsMissingEvidence: answer?.uncertain === true,
          };

  let strictJson = false;
  try {
    JSON.parse(final);
    strictJson = true;
  } catch {
    /* Score formatting separately from factual accuracy. */
  }
  return { checks, strictJson };
}

async function main() {
  if (process.argv.includes('--rescore')) {
    const report = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    for (const result of report.results)
      Object.assign(result, gradeAnswer(result.scenario, result.answer, result.toolCalls));
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
    console.log('Regraded saved answers without new model calls');
    return;
  }
  const dbPath =
    process.env.QUALITY_SOURCE_DB ??
    path.join(os.homedir(), 'Library/Application Support/agent-base-harness/database/app.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    const model = db
      .prepare(
        `SELECT m.remote_model_id,s.endpoint,s.credential_ref,s.provider_preset_id FROM models m JOIN model_services s ON s.id=m.service_id WHERE m.id=COALESCE(?,(SELECT default_model_id FROM user_model_settings WHERE user_id='user-a'))`,
      )
      .get(process.env.QUALITY_MODEL_ID ?? null) as ConfiguredModel | undefined;
    if (!model) throw new Error('No configured model');
    fs.mkdirSync(outputDir, { recursive: true });
    const extended = process.argv.includes('--extended');
    const results = extended ? JSON.parse(fs.readFileSync(outputFile, 'utf8')).results : [];
    const matrix: Array<[Scenario, number, number]> = extended
      ? [
          ['audit', 4096, 4096],
          ['series', 32768, 16384],
          ['series', 4096, 128],
          ['series', 3072, 128],
        ]
      : [
          ['audit', 32768, 16384],
          ['audit', 32768, 256],
          ['audit', 4096, 256],
          ['audit', 3072, 128],
          ['audit', 2048, 128],
          ['audit', 1024, 128],
          ['hidden', 32768, 16384],
          ['hidden', 32768, 128],
          ['hidden', 4096, 128],
        ];
    for (const [scenario, window, limit] of matrix) {
      results.push(await run(model, scenario, window, limit, new SqliteCredentialStore(db)));
      fs.writeFileSync(
        outputFile,
        JSON.stringify(
          {
            note: 'Real configured model; synthetic local tools. Windows are harness limits, not changes to the provider model. Token preflight uses the project estimator; actual provider usage is recorded separately. Temperature 0; thinking disabled; 512 output tokens. One sample per condition.',
            results,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.name : 'unknown');
  process.exitCode = 1;
});
