#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_APP_DATA = path.join(
  process.env.HOME || '',
  'Library',
  'Application Support',
  'agent-base-harness',
);
const DEFAULT_SCENARIO = path.resolve(
  ROOT,
  '../dcone/aiwenx/curry-studio/tests/fixtures/travel-agent-benchmark/continuous-trip-story.json',
);
const DEFAULT_EVALUATOR = path.resolve(
  ROOT,
  '../dcone/aiwenx/curry-studio/scripts/agent-travel-benchmark.mjs',
);

function parseArgs(argv) {
  const args = {
    appData: DEFAULT_APP_DATA,
    userId: 'user-a',
    agentName: 'Agent Base Harness 出行助手',
    scenarioPath: DEFAULT_SCENARIO,
    evaluatorPath: DEFAULT_EVALUATOR,
    outputDir: path.join(ROOT, 'outputs/benchmarks/travel-agent'),
    workerPath: path.join(ROOT, 'dist/worker/index.cjs'),
    includeEvents: false,
    validateOnly: false,
    timeoutMs: 12 * 60 * 1000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--app-data') args.appData = path.resolve(argv[++index]);
    else if (value === '--user-id') args.userId = argv[++index];
    else if (value === '--agent-name') args.agentName = argv[++index];
    else if (value === '--scenario') args.scenarioPath = path.resolve(argv[++index]);
    else if (value === '--evaluator') args.evaluatorPath = path.resolve(argv[++index]);
    else if (value === '--output-dir') args.outputDir = path.resolve(argv[++index]);
    else if (value === '--worker') args.workerPath = path.resolve(argv[++index]);
    else if (value === '--timeout-ms') args.timeoutMs = Number(argv[++index]);
    else if (value === '--include-events') args.includeEvents = true;
    else if (value === '--validate-only') args.validateOnly = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function printHelp() {
  process.stdout.write(`
Usage:
  npm run benchmark:travel -- \\
    --scenario ${DEFAULT_SCENARIO} \\
    --output-dir outputs/benchmarks/travel-agent/harness-run-1

This runner must execute with Electron so the live application's native SQLite ABI and
macOS Keychain configuration are reused. The package script handles that automatically.
`);
}

function safeFilePart(value) {
  return String(value)
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function configuredRuntime(
  root = path.join(ROOT, '.runtime-cache', `${process.platform}-${process.arch}`),
) {
  return fs
    .readFile(path.join(root, 'runtime-manifest.json'), 'utf8')
    .then(JSON.parse)
    .then((manifest) => ({
      platform: manifest.target.platform,
      arch: manifest.target.arch,
      rootDir: root,
      binDir: path.resolve(root, manifest.binDir),
      node: {
        version: manifest.node.version,
        executable: path.resolve(root, manifest.node.executable),
      },
      python: {
        version: manifest.python.version,
        executable: path.resolve(root, manifest.python.executable),
      },
      mcp: {
        memory: {
          package: manifest.mcp.memory.package,
          version: manifest.mcp.memory.version,
          entrypoint: path.resolve(root, manifest.mcp.memory.entrypoint),
        },
      },
    }))
    .catch(() => undefined);
}

async function readConfiguredSecrets(appData, userId) {
  const secrets = [];
  const skillRoot = path.join(appData, 'skills', userId);
  let skillNames = [];
  try {
    skillNames = await fs.readdir(skillRoot);
  } catch {
    return secrets;
  }
  for (const skillName of skillNames) {
    const configPath = path.join(skillRoot, skillName, 'config.json');
    try {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      for (const [key, value] of Object.entries(asRecord(config))) {
        if (
          /key|token|secret|password/iu.test(key) &&
          typeof value === 'string' &&
          value.length >= 8
        ) {
          secrets.push(value);
        }
      }
    } catch {
      // A Skill does not have to use config.json.
    }
  }
  return secrets;
}

function createSecurityGuard(secrets) {
  const unique = [
    ...new Set(secrets.filter((value) => typeof value === 'string' && value.length >= 8)),
  ];
  const containsSecret = (value) => {
    let serialized;
    try {
      serialized = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
    return unique.some((secret) => serialized.includes(secret));
  };
  const redactString = (value) => {
    let safe = value;
    for (const secret of unique) safe = safe.split(secret).join('[REDACTED]');
    return safe
      .replace(/([?&](?:key|api_key|apikey)=)[^&\s"']+/giu, '$1[REDACTED]')
      .replace(/(AMAP_(?:WEBSERVICE_)?KEY\s*[=:]\s*)[^\s;"']+/giu, '$1[REDACTED]')
      .replace(/("(?:api_?key|token|secret|password)"\s*:\s*")[^"]+("?)/giu, '$1[REDACTED]$2');
  };
  const redact = (value) => {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    }
    return value;
  };
  return { containsSecret, redact };
}

export class WorkerRpcClient {
  constructor(workerPath, workerData) {
    this.generation = workerData.generation;
    this.worker = new Worker(workerPath, { workerData });
    this.pending = new Map();
    this.events = [];
    this.eventListeners = new Set();
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.worker.on('message', (message) => this.onMessage(message));
    this.worker.on('error', (error) => {
      this.readyReject(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    this.worker.on('exit', (code) => {
      if (code === 0) return;
      const error = new Error(`Runtime worker exited with code ${code}`);
      this.readyReject(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  onMessage(message) {
    if (message.type === 'ready') {
      this.readyResolve(message);
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else
        pending.reject(
          Object.assign(
            new Error(message.error?.message || 'Worker request failed'),
            message.error,
          ),
        );
      return;
    }
    if (message.type === 'session-events') {
      const receivedAtMs = Date.now();
      for (const event of message.events || [])
        this.events.push({ ...event, __receivedAtMs: receivedAtMs });
      for (const listener of this.eventListeners) listener(message);
      return;
    }
    if (message.type === 'fatal') {
      const error = new Error(message.reason || 'Runtime worker failed');
      this.readyReject(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    }
  }

  async request(userId, method, params) {
    await this.ready;
    const requestId = crypto.randomUUID();
    const promise = new Promise((resolve, reject) =>
      this.pending.set(requestId, { resolve, reject }),
    );
    this.worker.postMessage({
      type: 'request',
      requestId,
      userId,
      windowId: 'travel-benchmark',
      workerGeneration: this.generation,
      method,
      params,
    });
    return promise;
  }

  sessionEvents(sessionId) {
    return this.events.filter((event) => event.sessionId === sessionId);
  }

  async waitForTurnEnd(sessionId, afterSeq, timeoutMs) {
    const find = () =>
      this.events.find(
        (event) =>
          event.sessionId === sessionId && event.seq > afterSeq && event.eventType === 'turn.ended',
      );
    const existing = find();
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.eventListeners.delete(listener);
        reject(new Error(`Timed out waiting for turn completion after ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = () => {
        const event = find();
        if (!event) return;
        clearTimeout(timeout);
        this.eventListeners.delete(listener);
        resolve(event);
      };
      this.eventListeners.add(listener);
    });
  }

  async close() {
    this.worker.postMessage({ type: 'shutdown' });
    await Promise.race([
      new Promise((resolve) => this.worker.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    await this.worker.terminate();
  }
}

function turnEvents(allEvents, turnEnd, afterSeq) {
  const turnId = asRecord(turnEnd.payload).turnId;
  return allEvents.filter(
    (event) =>
      event.seq > afterSeq &&
      (asRecord(event.payload).turnId === turnId || event.eventType === 'model.request.context'),
  );
}

function normalizeToolCall(event, securityGuard) {
  const payload = asRecord(event.payload);
  if (payload.toolName === 'skill_load') {
    return {
      toolCallId: payload.toolCallId,
      toolName: 'Skill',
      input: { skill: asRecord(payload.input).skillName },
    };
  }
  return securityGuard.redact({
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    input: payload.input,
  });
}

function normalizeToolResult(event, securityGuard) {
  const payload = asRecord(event.payload);
  return securityGuard.redact({
    type: payload.status === 'success' ? 'tool-result' : 'tool-error',
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    output: payload.output,
  });
}

export function normalizeTurnResponse(
  events,
  statistics,
  startedAtMs,
  completedAtMs,
  securityGuard,
  includeEvents,
) {
  const assistantMessages = events
    .filter((event) => event.eventType === 'assistant.message')
    .map((event) => asRecord(event.payload))
    .filter((payload) => typeof payload.content === 'string' && payload.content.trim().length > 0);
  const textBlocks = assistantMessages.map((payload) => payload.content.trim());
  const toolCalls = events
    .filter((event) => event.eventType === 'tool.call')
    .map((event) => normalizeToolCall(event, securityGuard));
  const toolResults = events
    .filter((event) => event.eventType === 'tool.result')
    .map((event) => normalizeToolResult(event, securityGuard));
  const firstEventAt = Math.min(
    ...events.map((event) => event.__receivedAtMs || Date.parse(event.occurredAt)),
  );
  const visibleEvents = events.filter(
    (event) =>
      event.eventType === 'assistant.chunk' || event.eventType === 'assistant.reasoning.chunk',
  );
  const reasoningEvents = events.filter((event) => event.eventType === 'assistant.reasoning.chunk');
  const firstVisibleAt = visibleEvents.length
    ? Math.min(
        ...visibleEvents.map((event) => event.__receivedAtMs || Date.parse(event.occurredAt)),
      )
    : null;
  const firstReasoningAt = reasoningEvents.length
    ? Math.min(
        ...reasoningEvents.map((event) => event.__receivedAtMs || Date.parse(event.occurredAt)),
      )
    : null;
  const stepIds = new Set(
    events
      .map((event) => asRecord(event.payload).stepId)
      .filter((value) => typeof value === 'string'),
  );
  const calls = (statistics.items || [])
    .filter((item) => stepIds.has(item.stepId))
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const contextByRequest = new Map(
    events
      .filter((event) => event.eventType === 'model.request.context')
      .map((event) => [asRecord(event.payload).requestId, asRecord(event.payload)]),
  );
  const contextUsageEvents = calls.map((call, index) => ({
    type: 'context-usage',
    callIndex: index + 1,
    requestId: call.requestId,
    inputTokens: call.inputTokens || call.estimatedInputTokens || 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: call.outputTokens || 0,
    contextTokens: (call.inputTokens || call.estimatedInputTokens || 0) + (call.outputTokens || 0),
    estimatedInputTokens: contextByRequest.get(call.requestId)?.estimatedInputTokens ?? null,
  }));
  const totalInputTokens = calls.reduce((sum, call) => sum + (call.inputTokens || 0), 0);
  const totalOutputTokens = calls.reduce((sum, call) => sum + (call.outputTokens || 0), 0);
  const secretExposureDetected = events.some((event) => securityGuard.containsSecret(event));
  const response = {
    text: securityGuard.redact(textBlocks.join('\n\n').trim()),
    final_text: securityGuard.redact(textBlocks.at(-1) || ''),
    timing: {
      first_event_ms: Number.isFinite(firstEventAt)
        ? Math.max(0, firstEventAt - startedAtMs)
        : null,
      first_visible_text_ms:
        firstVisibleAt === null ? null : Math.max(0, firstVisibleAt - startedAtMs),
      first_reasoning_text_ms:
        firstReasoningAt === null ? null : Math.max(0, firstReasoningAt - startedAtMs),
      end_to_end_ms: completedAtMs - startedAtMs,
    },
    tool_calls: toolCalls,
    tool_results: toolResults,
    errors: toolResults.filter((item) => item.type === 'tool-error').map((item) => item.output),
    security: { secret_exposure_detected: secretExposureDetected },
    context_usage_events: contextUsageEvents,
    model_call_timings: calls.map((call, index) => ({
      callIndex: index + 1,
      stream_started_at_ms: Math.max(0, Date.parse(call.startedAt) - startedAtMs),
      first_visible_text_at_ms:
        call.firstTokenAt === null
          ? null
          : Math.max(0, Date.parse(call.firstTokenAt) - startedAtMs),
      first_reasoning_text_at_ms: null,
      stream_finished_at_ms:
        call.completedAt === null ? null : Math.max(0, Date.parse(call.completedAt) - startedAtMs),
    })),
    finish_steps: calls.map((call) => ({ finishReason: call.stopReason || 'unknown' })),
    model_metrics: {
      model_call_count: calls.length,
      entry_context_tokens: contextUsageEvents[0]?.inputTokens ?? null,
      peak_context_tokens: contextUsageEvents.length
        ? Math.max(...contextUsageEvents.map((item) => item.inputTokens))
        : null,
      entry_total_context_tokens: contextUsageEvents[0]?.contextTokens ?? null,
      peak_total_context_tokens: contextUsageEvents.length
        ? Math.max(...contextUsageEvents.map((item) => item.contextTokens))
        : null,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
    },
    tool_metrics: {
      call_count: toolCalls.length,
      error_count: toolResults.filter((item) => item.type === 'tool-error').length,
    },
    event_count: events.length,
  };
  if (includeEvents)
    response.events = securityGuard.redact(events.map(({ __receivedAtMs: _, ...event }) => event));
  return response;
}

function usageForCalls(calls) {
  return {
    summary: {
      runCount: 1,
      modelCallCount: calls.length,
      totalInputTokens: calls.reduce((sum, call) => sum + (call.inputTokens || 0), 0),
      totalOutputTokens: calls.reduce((sum, call) => sum + (call.outputTokens || 0), 0),
      totalTokens: calls.reduce((sum, call) => sum + (call.totalTokens || 0), 0),
      averageTimeToFirstTokenMs: average(calls.map((call) => call.ttftMs)),
      averageOutputTokensPerSecond: average(calls.map((call) => call.tps)),
      maxInputTokens: Math.max(0, ...calls.map((call) => call.inputTokens || 0)),
      maxOutputTokens: Math.max(0, ...calls.map((call) => call.outputTokens || 0)),
      maxContextTokens: Math.max(0, ...calls.map((call) => call.estimatedInputTokens || 0)),
      estimatedCallCount: calls.filter((call) => !call.inputTokens).length,
      missingUsageCallCount: calls.filter((call) => !call.inputTokens && !call.outputTokens).length,
    },
    calls,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const evaluator = await import(pathToFileURL(args.evaluatorPath).href);
  const scenarioRaw = JSON.parse(await fs.readFile(args.scenarioPath, 'utf8'));
  const scenario = evaluator.renderTemplates(scenarioRaw);
  if (!Array.isArray(scenario.turns) || scenario.turns.length === 0) {
    throw new Error('Scenario must contain at least one turn');
  }
  if (args.validateOnly) {
    process.stdout.write(`${JSON.stringify(scenario, null, 2)}\n`);
    return;
  }
  const secrets = await readConfiguredSecrets(args.appData, args.userId);
  const securityGuard = createSecurityGuard(secrets);
  const generation = Date.now();
  const runtime = await configuredRuntime();
  const client = new WorkerRpcClient(args.workerPath, {
    appDataDir: args.appData,
    generation,
    logDir: path.join(args.appData, 'logs'),
    debug: false,
    useSystemCredential: true,
    skipRecovery: true,
    runtime,
  });
  const runStartedAt = new Date().toISOString();
  let session;
  const result = {
    schema_version: 2,
    run: {
      started_at: runStartedAt,
      completed_at: null,
      base_url: 'electron-worker://agent-base-harness',
      health: null,
      scenario: {
        id: scenario.id,
        description: scenario.description,
        benchmark: scenario.benchmark,
        source: path.resolve(args.scenarioPath),
      },
      agent: null,
      session: null,
      sessions: [],
    },
    turns: [],
    final_context: null,
    usage: null,
    usage_by_session: [],
  };
  try {
    await client.ready;
    const [health, management] = await Promise.all([
      client.request(args.userId, 'system.health'),
      client.request(args.userId, 'model-management.snapshot'),
    ]);
    const model = (management.models || []).find((item) => item.id === management.defaultModelId);
    if (!model) throw new Error(`No default model configured for ${args.userId}`);
    result.run.health = health;
    result.run.agent = {
      id: `${args.userId}:single-agent`,
      name: args.agentName,
      type: 'agent-base-harness',
      model: model.remoteModelId,
      simplified_mode: false,
    };
    session = await client.request(args.userId, 'session.create', {
      title: `${scenario.id} ${new Date().toISOString()}`,
    });
    result.run.session = { id: session.id, kept: true };
    result.run.sessions = [{ id: session.id, created_before_turn: 0, kept: true }];
    process.stdout.write(
      `Agent: ${args.agentName} (${model.remoteModelId})\nSession: ${session.id}\n`,
    );

    for (const [index, turn] of scenario.turns.entries()) {
      const beforeSnapshot = await client.request(args.userId, 'session.snapshot', {
        sessionId: session.id,
      });
      const afterSeq = beforeSnapshot.throughSeq || 0;
      const startedAtMs = Date.now();
      const turnStartedAt = new Date(startedAtMs).toISOString();
      process.stdout.write(
        `[${index + 1}/${scenario.turns.length}] ${turn.id || `turn-${index + 1}`} ... `,
      );
      await client.request(args.userId, 'input.submit', {
        sessionId: session.id,
        content: turn.content,
        idempotencyKey: crypto.randomUUID(),
        startNewEvent: false,
        mode: 'queue',
      });
      const ended = await client.waitForTurnEnd(session.id, afterSeq, args.timeoutMs);
      const completedAtMs = ended.__receivedAtMs || Date.now();
      const allSessionEvents = client.sessionEvents(session.id);
      const events = turnEvents(allSessionEvents, ended, afterSeq);
      const statistics = await client.request(args.userId, 'model-call-statistics.query', {
        sessionId: session.id,
        from: turnStartedAt,
        limit: 200,
      });
      const response = normalizeTurnResponse(
        events,
        statistics,
        startedAtMs,
        completedAtMs,
        securityGuard,
        args.includeEvents,
      );
      const stepIds = new Set(
        events
          .map((event) => asRecord(event.payload).stepId)
          .filter((value) => typeof value === 'string'),
      );
      const turnCalls = (statistics.items || []).filter((call) => stepIds.has(call.stepId));
      const usage = usageForCalls(turnCalls);
      const contextAfter = await client.request(args.userId, 'session.snapshot', {
        sessionId: session.id,
      });
      const evaluation = evaluator.evaluateTurn(
        turn,
        response,
        result.turns.map((completedTurn) => completedTurn.response),
      );
      result.turns.push({
        id: turn.id || `turn-${index + 1}`,
        session_id: session.id,
        scored: turn.score !== false,
        checkpoint: turn.checkpoint,
        prompt: turn.content,
        context_before: { throughSeq: beforeSnapshot.throughSeq, usage: beforeSnapshot.usage },
        response,
        usage,
        context_after: { throughSeq: contextAfter.throughSeq, usage: contextAfter.usage },
        evaluation,
      });
      process.stdout.write(
        `done; task=${evaluation.task_success}, quality=${evaluation.quality_score}, ` +
          `visible TTFT=${response.timing.first_visible_text_ms ?? 'n/a'}ms, ` +
          `E2E=${response.timing.end_to_end_ms}ms\n`,
      );
    }
    result.final_context = await client.request(args.userId, 'session.snapshot', {
      sessionId: session.id,
    });
    const finalStatistics = await client.request(args.userId, 'model-call-statistics.query', {
      sessionId: session.id,
      from: runStartedAt,
      limit: 200,
    });
    result.usage = usageForCalls(finalStatistics.items || []);
    result.usage_by_session = [{ session_id: session.id, usage: result.usage }];
    result.run.completed_at = new Date().toISOString();
  } finally {
    await client.close();
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.mkdir(args.outputDir, { recursive: true });
  const outputPath = path.join(
    args.outputDir,
    `${timestamp}__${safeFilePart(args.agentName)}__${safeFilePart(scenario.id)}.json`,
  );
  const safeResult = securityGuard.redact(result);
  await fs.writeFile(outputPath, `${JSON.stringify(safeResult, null, 2)}\n`, 'utf8');
  const scored = safeResult.turns.filter((turn) => turn.scored !== false);
  const passed = scored.filter((turn) => turn.evaluation.task_success).length;
  process.stdout.write(`Result: ${outputPath}\nBusiness success: ${passed}/${scored.length}\n`);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exit(1);
    });
}
