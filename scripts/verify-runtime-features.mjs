// Exercise the installed archive with a deterministic local provider; no paid API key is needed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const executable = process.env.AGENT_RUNTIME_EXECUTABLE;
assert.ok(executable, 'Set AGENT_RUNTIME_EXECUTABLE to the extracted package bin/agent-harness');
const bundle = path.resolve(executable, '../..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-feature-smoke-'));
const dataDir = path.join(temporary, 'data');
const key = randomUUID();
const password = randomUUID();
const { AgentClient, MemoryAccountStorage } = createRequire(import.meta.url)(
  '../dist/client/index.cjs',
);
const accountStorage = new MemoryAccountStorage();
let server;
let output = '';
let authenticatedCalls = 0;
let memoryProbe;
const provider = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.headers.authorization !== `Bearer ${key}`) {
    response.writeHead(401).end();
    return;
  }
  authenticatedCalls++;
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const messages = body.messages;
  const lastUser = messages.findLastIndex((message) => message.role === 'user');
  const prompt = JSON.stringify(messages[lastUser]?.content);
  const hasTool = messages.slice(lastUser + 1).some((message) => message.role === 'tool');
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, finish = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: 'linux-fixture',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  if (prompt.includes('MEMORY_PROBE') && memoryProbe) {
    const stage = memoryProbe.stage++;
    if (stage < 2) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: `call_${randomUUID()}`,
            type: 'function',
            function: {
              name:
                stage === 0
                  ? 'mcp_load'
                  : `mcp__memory_agent__${memoryProbe.write ? 'create_entities' : 'read_graph'}`,
              arguments: JSON.stringify(
                stage === 0
                  ? { name: '本智能体记忆' }
                  : memoryProbe.write
                    ? {
                        entities: [
                          {
                            name: 'LinuxSmokeEntity',
                            entityType: 'verification',
                            observations: ['persisted'],
                          },
                        ],
                      }
                    : {},
              ),
            },
          },
        ],
      });
      emit({}, 'tool_calls');
    } else {
      memoryProbe.observedEntity = JSON.stringify(messages.at(-1)).includes('LinuxSmokeEntity');
      emit({ content: 'memory-runtime-ok' });
      emit({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  } else if (prompt.includes('BASH_PROBE') && !hasTool) {
    emit({
      tool_calls: [
        {
          index: 0,
          id: `call_${randomUUID()}`,
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({
              command:
                'mkdir -p artifacts; { node --version; python --version; } > artifacts/linux-proof.txt',
              description: 'Verify bundled Node and Python inside the workspace',
              network_access: prompt.includes('APPROVAL_BASH_PROBE'),
            }),
          },
        },
      ],
    });
    emit({}, 'tool_calls');
    response.end('data: [DONE]\n\n');
  } else {
    emit({ content: prompt.includes('SLOW_PROBE') ? 'slow-start' : 'linux-stream-' });
    const timer = setTimeout(
      () => {
        emit({ content: 'ok' });
        emit({}, 'stop');
        response.end('data: [DONE]\n\n');
      },
      prompt.includes('SLOW_PROBE') ? 15000 : 60,
    );
    response.on('close', () => clearTimeout(timer));
  }
});

async function start() {
  output = '';
  await rm(path.join(dataDir, 'server/discovery.json'), { force: true });
  server = spawn(
    executable,
    ['serve', '--data-dir', dataDir, '--port', '0', '--allow-registration'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    },
  );
  server.stdout.on('data', (chunk) => (output += chunk));
  server.stderr.on('data', (chunk) => (output += chunk));
  let discovery;
  await until(async () => {
    if (server.exitCode !== null) throw new Error(output.replaceAll(key, '[redacted]'));
    try {
      discovery = JSON.parse(await readFile(path.join(dataDir, 'server/discovery.json'), 'utf8'));
    } catch {
      return false;
    }
    return (await globalThis.fetch(`${discovery.baseUrl}/healthz`)).ok;
  });
  return new AgentClient({ accountStorage, baseUrl: discovery.baseUrl, clientKind: 'cli' });
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
  assert.equal(
    child.exitCode,
    0,
    `Runtime did not exit gracefully: ${child.signalCode ?? child.exitCode}; ${output.replaceAll(key, '[redacted]')}`,
  );
}
async function until(predicate, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for feature verification');
}
async function track(client, sessionId) {
  const events = [];
  const snapshot = await client.query('session.snapshot', { sessionId });
  let error;
  const close = client.subscribeSession(
    sessionId,
    snapshot.throughSeq,
    (event) => events.push(event),
    { onError: (value) => (error = value) },
  );
  return {
    events,
    close,
    wait: (type, match = () => true) =>
      until(() => {
        if (error) throw error;
        return events.find((event) => event.eventType === type && match(event));
      }),
  };
}
const submit = (client, sessionId, content) =>
  client.command('input.submit', {
    sessionId,
    content,
    mode: 'queue',
    startNewEvent: true,
    idempotencyKey: randomUUID(),
  });
const subscriptions = [];
try {
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  let client = await start();
  await client.registerRemote({ loginName: 'feature_smoke', password });
  let models = await client.query('model-management.snapshot');
  const service = await client.command('model-service.save', {
    name: 'Linux deterministic fixture',
    providerType: 'openai-compatible',
    endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
    enabled: true,
    credential: { action: 'replace', value: key },
    expectedRevision: models.revision,
  });
  models = await client.query('model-management.snapshot');
  const model = await client.command('model.save', {
    serviceId: service.id,
    remoteModelId: 'linux-fixture',
    displayName: 'Linux fixture',
    contextWindow: 32768,
    maxOutputTokens: 4096,
    capabilities: { tools: true, streaming: true, vision: false },
    enabled: true,
    expectedRevision: models.revision,
  });
  models = await client.query('model-management.snapshot');
  await client.command('model.default.set', {
    modelId: model.id,
    expectedRevision: models.revision,
  });
  const boot = await client.query('app.bootstrap');
  const session = await client.command('session.create', {
    agentId: boot.defaultAgentId,
    title: 'Linux features',
  });
  let stream = await track(client, session.id);
  subscriptions.push(stream.close);
  await submit(client, session.id, 'STREAM_PROBE');
  assert.equal((await stream.wait('turn.ended')).payload.status, 'completed');
  assert.ok(stream.events.some((event) => event.eventType === 'assistant.chunk'));
  stream.close();
  console.log('[features] model configuration, authenticated provider and streaming passed');

  await client.command('permission.preset.set', {
    sessionId: session.id,
    preset: 'approval-required',
  });
  stream = await track(client, session.id);
  subscriptions.push(stream.close);
  await submit(client, session.id, 'BASH_PROBE');
  assert.equal((await stream.wait('turn.ended')).payload.status, 'completed');
  const proof = await (
    await client.downloadSessionFile(session.id, 'artifacts/linux-proof.txt')
  ).text();
  const manifest = JSON.parse(
    await readFile(path.join(bundle, 'runtime/runtime-manifest.json'), 'utf8'),
  );
  assert.ok(proof.includes(`v${manifest.node.version}`), proof);
  assert.ok(proof.includes(`Python ${manifest.python.version}`), proof);
  stream.close();
  console.log(
    '[features] default restricted Bash, bundled Node/Python and artifact download passed',
  );
  stream = await track(client, session.id);
  subscriptions.push(stream.close);
  await submit(client, session.id, 'APPROVAL_BASH_PROBE');
  const approval = await stream.wait('approval.requested');
  await client.command('approval.resolve', {
    sessionId: session.id,
    approvalId: approval.payload.approvalId,
    resolution: 'allowed-once',
    idempotencyKey: randomUUID(),
  });
  assert.equal((await stream.wait('turn.ended')).payload.status, 'completed');
  stream.close();
  console.log('[features] explicit network permission approval passed');

  stream = await track(client, session.id);
  subscriptions.push(stream.close);
  await submit(client, session.id, 'SLOW_PROBE');
  await stream.wait('assistant.chunk');
  const started = await stream.wait('turn.started');
  await submit(client, session.id, 'QUEUED_PROBE');
  await client.command('turn.cancel', {
    sessionId: session.id,
    turnId: started.payload.turnId,
    keepNextTurn: true,
    keepNextStep: false,
    reason: 'verification',
  });
  assert.equal(
    (await stream.wait('turn.ended', (event) => event.payload.turnId === started.payload.turnId))
      .payload.status,
    'cancelled',
  );
  assert.equal(
    (await stream.wait('turn.ended', (event) => event.payload.turnId !== started.payload.turnId))
      .payload.status,
    'completed',
  );
  stream.close();
  console.log('[features] cancellation and queued input continuation passed');

  const callsBeforeRestart = authenticatedCalls;
  await stop();
  client = await start();
  await client.login('feature_smoke', password);
  assert.ok((await client.query('session.snapshot', { sessionId: session.id })).throughSeq > 0);
  stream = await track(client, session.id);
  subscriptions.push(stream.close);
  await submit(client, session.id, 'RESTART_PROBE');
  assert.equal((await stream.wait('turn.ended')).payload.status, 'completed');
  assert.ok(authenticatedCalls > callsBeforeRestart);
  stream.close();
  console.log('[features] credentials, model configuration and session survive service restart');

  await client.command('mcp-server.refresh', { id: 'builtin-memory' });
  for (const rawName of ['create_entities', 'read_graph']) {
    const snapshot = await client.query('mcp-management.snapshot');
    await client.command('mcp-tool.toggle', {
      serverId: 'builtin-memory',
      rawName,
      enabled: true,
      expectedRevision: snapshot.revision,
    });
  }
  // The fixture authorizes these deterministic calls; stdio still uses the OS sandbox.
  await client.command('permission.preset.set', { sessionId: session.id, preset: 'full-access' });
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      await stop();
      client = await start();
      await client.login('feature_smoke', password);
    }
    memoryProbe = { write: pass === 0, stage: 0 };
    stream = await track(client, session.id);
    subscriptions.push(stream.close);
    await submit(client, session.id, `MEMORY_PROBE_${pass}`);
    assert.equal((await stream.wait('turn.ended')).payload.status, 'completed');
    assert.ok(
      memoryProbe.observedEntity,
      'Runtime memory tool did not return the persisted entity',
    );
    const toolResults = stream.events.filter((event) => event.eventType === 'tool.result');
    for (const name of [
      'mcp_load',
      `mcp__memory_agent__${pass === 0 ? 'create_entities' : 'read_graph'}`,
    ]) {
      assert.ok(
        toolResults.some(
          (event) => event.payload.toolName === name && event.payload.status === 'success',
        ),
        `Runtime MCP call did not succeed: ${name}`,
      );
    }
    stream.close();
  }
  memoryProbe = undefined;
  console.log(
    '[features] Runtime-managed Memory MCP sandbox discovery, write/read and service restart persistence passed',
  );
  console.log(
    'RUNTIME_FEATURES_OK (local deterministic provider; no external model compatibility claim)',
  );
} finally {
  for (const close of subscriptions) close();
  await stop();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
