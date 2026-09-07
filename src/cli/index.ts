import { randomUUID } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { AgentClientError, type AgentClient } from '../client/agent-client';
import { LocalConnector } from '../client/local-connector';
import { FileSessionStore } from '../client/session-store';
import { runServerProcess } from '../server';
import { defaultAppDataDir, servicePaths } from '../server/paths';
import type { ModelManagementSnapshot } from '../shared/contracts/management';
import type { SessionLogEvent } from '../shared/domain/session';

interface CliContext {
  dataDir: string;
  args: string[];
}

interface SessionSummary {
  id: string;
  title: string;
  status: string;
}

interface SessionSnapshot {
  throughSeq: number;
  approvals?: Array<{
    id: string;
    toolName: string;
    status: string;
    presentation?: unknown;
  }>;
  activeTurnId?: string | null;
  messages?: Array<{ role?: string; content?: string }>;
}

export async function runCli(rawArguments = process.argv.slice(2)): Promise<void> {
  const context = parseGlobalOptions(rawArguments);
  const [command, ...arguments_] = context.args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'serve') {
    await runServerProcess(['--data-dir', context.dataDir, ...arguments_]);
    return;
  }

  const connector = new LocalConnector({ dataDir: context.dataDir, clientKind: 'cli' });
  const sessionStore = new FileSessionStore(servicePaths(context.dataDir).cliSessionFile);

  if (command === 'server') {
    await runServerCommand(connector, arguments_);
    return;
  }

  const { client } = await connector.connectOrStart();
  const stored = sessionStore.load();
  if (stored) client.setAccessToken(stored.accessToken);

  switch (command) {
    case 'register':
      await register(connector, client, sessionStore, arguments_);
      return;
    case 'login':
      await login(client, sessionStore, arguments_);
      return;
    case 'logout':
      await client.logout();
      sessionStore.clear();
      stdout.write('Logged out\n');
      return;
    case 'whoami': {
      const current = await client.me();
      stdout.write(`${current.user.loginName} (${current.user.displayName}, ${current.user.id})\n`);
      return;
    }
    case 'setup':
      requireLogin(client);
      await setup(client, arguments_);
      return;
    case 'run':
      requireLogin(client);
      await runOnce(client, arguments_);
      return;
    case 'chat':
      requireLogin(client);
      await chat(client, arguments_);
      return;
    case 'session':
      requireLogin(client);
      await sessionCommand(client, arguments_);
      return;
    case 'approval':
      requireLogin(client);
      await approvalCommand(client, arguments_);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runServerCommand(connector: LocalConnector, arguments_: string[]): Promise<void> {
  const action = arguments_[0];
  const { client, discovery } = await connector.connect();
  if (action === 'status') {
    const health = await client.health();
    stdout.write(
      `${health.status} pid=${discovery.pid} instance=${discovery.instanceId} ${discovery.baseUrl}\n`,
    );
    return;
  }
  if (action === 'stop') {
    await client.stopService(connector.readBootstrapToken());
    stdout.write('Stopping local service\n');
    return;
  }
  throw new Error('Usage: agent-harness server status|stop');
}

async function register(
  connector: LocalConnector,
  client: AgentClient,
  store: FileSessionStore,
  arguments_: string[],
): Promise<void> {
  const options = parseOptions(arguments_);
  const loginName = option(options, 'login') ?? (await ask('Login name: '));
  const password = await passwordFrom(options, 'New password: ');
  const confirmation = options.has('password-stdin')
    ? password
    : await readSecret('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match');
  const result = await client.register(connector.readBootstrapToken(), { loginName, password });
  store.save(result);
  stdout.write(`Registered and logged in as ${result.user.loginName}\n`);
}

async function login(
  client: AgentClient,
  store: FileSessionStore,
  arguments_: string[],
): Promise<void> {
  const options = parseOptions(arguments_);
  const loginName = option(options, 'login') ?? (await ask('Login name: '));
  const password = await passwordFrom(options, 'Password: ');
  const result = await client.login(loginName, password);
  store.save(result);
  stdout.write(`Logged in as ${result.user.loginName}\n`);
}

async function setup(client: AgentClient, arguments_: string[]): Promise<void> {
  const options = parseOptions(arguments_);
  const name = option(options, 'name') ?? (await ask('Service name: '));
  const endpoint = option(options, 'endpoint') ?? (await ask('OpenAI-compatible endpoint: '));
  const remoteModelId = option(options, 'model') ?? (await ask('Model ID: '));
  const contextWindow = Number(option(options, 'context-window') ?? '32768');
  if (!Number.isInteger(contextWindow) || contextWindow < 1024) {
    throw new Error('--context-window must be an integer of at least 1024');
  }
  const apiKey = await secretFromStdinOrPrompt(options, 'api-key-stdin', 'API key: ');
  let snapshot = await client.query<ModelManagementSnapshot>('model-management.snapshot');
  const service = await client.command<{ id: string }>('model-service.save', {
    name,
    providerType: 'openai-compatible',
    endpoint,
    enabled: true,
    config: {},
    credential: { action: 'replace', value: apiKey },
    expectedRevision: snapshot.revision,
  });
  snapshot = await client.query<ModelManagementSnapshot>('model-management.snapshot');
  const model = await client.command<{ id: string }>('model.save', {
    serviceId: service.id,
    remoteModelId,
    displayName: remoteModelId,
    contextWindow,
    maxOutputTokens: Math.min(8192, Math.max(1024, Math.floor(contextWindow / 4))),
    capabilities: { tools: true, streaming: true, vision: false },
    defaultParams: {},
    enabled: true,
    expectedRevision: snapshot.revision,
  });
  snapshot = await client.query<ModelManagementSnapshot>('model-management.snapshot');
  await client.command('model.default.set', {
    modelId: model.id,
    expectedRevision: snapshot.revision,
  });
  stdout.write(`Configured ${remoteModelId} as the default model\n`);
}

async function runOnce(client: AgentClient, arguments_: string[]): Promise<void> {
  const prompt = arguments_.join(' ').trim() || (await readAllStdin()).trim();
  if (!prompt) throw new Error('Usage: agent-harness run <prompt>');
  const session = await client.command<SessionSummary>('session.create', {
    title: prompt.slice(0, 80),
  });
  await submitAndFollow(client, session.id, prompt);
}

async function chat(client: AgentClient, arguments_: string[]): Promise<void> {
  const options = parseOptions(arguments_);
  const existing = option(options, 'session');
  const session = existing
    ? { id: existing }
    : await client.command<SessionSummary>('session.create', { title: 'CLI chat' });
  stdout.write(`Session ${session.id}. Type /exit to leave.\n`);
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const message = (await terminal.question('> ')).trim();
      if (!message) continue;
      if (message === '/exit' || message === '/quit') break;
      terminal.pause();
      await submitAndFollow(client, session.id, message);
      terminal.resume();
    }
  } finally {
    terminal.close();
  }
}

async function sessionCommand(client: AgentClient, arguments_: string[]): Promise<void> {
  const action = arguments_[0];
  if (action === 'list') {
    const sessions = await client.query<SessionSummary[]>('session.list');
    for (const session of sessions)
      stdout.write(`${session.id}\t${session.status}\t${session.title}\n`);
    return;
  }
  if (action === 'show' && arguments_[1]) {
    const snapshot = await client.query('session.snapshot', { sessionId: arguments_[1] });
    stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    return;
  }
  throw new Error('Usage: agent-harness session list|show <session-id>');
}

async function approvalCommand(client: AgentClient, arguments_: string[]): Promise<void> {
  const action = arguments_[0];
  if (action === 'list') {
    const sessions = await client.query<SessionSummary[]>('session.list');
    for (const session of sessions) {
      const snapshot = await client.query<SessionSnapshot>('session.snapshot', {
        sessionId: session.id,
      });
      for (const approval of snapshot.approvals ?? []) {
        if (approval.status === 'pending') {
          stdout.write(`${session.id}\t${approval.id}\t${approval.toolName}\n`);
        }
      }
    }
    return;
  }
  if (action === 'resolve') {
    const options = parseOptions(arguments_.slice(1));
    const sessionId = option(options, 'session');
    const approvalId = option(options, 'approval');
    const resolution = option(options, 'resolution');
    if (!sessionId || !approvalId || !resolution) {
      throw new Error(
        'Usage: agent-harness approval resolve --session ID --approval ID --resolution allowed-once|session-granted|rejected|cancelled',
      );
    }
    await client.command('approval.resolve', {
      sessionId,
      approvalId,
      resolution,
      idempotencyKey: randomUUID(),
    });
    stdout.write(`Resolved ${approvalId}: ${resolution}\n`);
    return;
  }
  throw new Error('Usage: agent-harness approval list|resolve ...');
}

async function submitAndFollow(
  client: AgentClient,
  sessionId: string,
  content: string,
): Promise<void> {
  const before = await client.query<SessionSnapshot>('session.snapshot', { sessionId });
  const follower = waitForTurn(client, sessionId, before.throughSeq);
  try {
    await client.command('input.submit', {
      sessionId,
      content,
      idempotencyKey: randomUUID(),
      startNewEvent: true,
      mode: 'queue',
    });
    await follower.promise;
  } catch (error) {
    follower.cancel();
    throw error;
  }
}

function waitForTurn(
  client: AgentClient,
  sessionId: string,
  afterSeq: number,
): { promise: Promise<void>; cancel: () => void } {
  let cancel = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    let done = false;
    const chunkedRequests = new Set<string>();
    const unsubscribe = client.subscribeSession(
      sessionId,
      afterSeq,
      (event) => {
        if (event.eventType === 'assistant.chunk') {
          const requestId = field(event, 'requestId');
          if (requestId) chunkedRequests.add(requestId);
          const content = field(event, 'content');
          if (content) stdout.write(content);
        } else if (event.eventType === 'assistant.message') {
          const content = field(event, 'content');
          const requestId = field(event, 'requestId');
          if (content && (!requestId || !chunkedRequests.has(requestId))) stdout.write(content);
        } else if (event.eventType === 'approval.requested') {
          stderr.write(`\nApproval required: ${field(event, 'toolName') ?? 'tool'}\n`);
          finish();
        } else if (event.eventType === 'interaction.requested') {
          stderr.write(
            '\nUser input required; continue this session from Electron or a later CLI.\n',
          );
          finish();
        } else if (event.eventType === 'turn.ended') {
          stdout.write('\n');
          finish();
        }
      },
      { onError: (error) => fail(error) },
    );
    cancel = () => {
      if (done) return;
      done = true;
      unsubscribe();
      resolve();
    };
    function finish(): void {
      if (done) return;
      done = true;
      unsubscribe();
      resolve();
    }
    function fail(error: unknown): void {
      if (done) return;
      done = true;
      unsubscribe();
      reject(error);
    }
  });
  return { promise, cancel };
}

function field(event: SessionLogEvent, key: string): string | undefined {
  if (!event.payload || typeof event.payload !== 'object') return undefined;
  const value = (event.payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function parseGlobalOptions(arguments_: string[]): CliContext {
  const args: string[] = [];
  let dataDir = process.env.AGENT_HARNESS_DATA_DIR?.trim() || defaultAppDataDir();
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === '--data-dir') {
      const value = arguments_[++index];
      if (!value) throw new Error('--data-dir requires a value');
      dataDir = value;
    } else {
      args.push(arguments_[index]!);
    }
  }
  return { dataDir, args };
}

function parseOptions(arguments_: string[]): Map<string, string | true> {
  const options = new Map<string, string | true>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2);
    if (name.endsWith('-stdin')) options.set(name, true);
    else {
      const value = arguments_[++index];
      if (!value) throw new Error(`--${name} requires a value`);
      options.set(name, value);
    }
  }
  return options;
}

function option(options: Map<string, string | true>, name: string): string | undefined {
  const value = options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function requireLogin(client: AgentClient): void {
  if (!client.accessToken) throw new Error('Please run agent-harness login first');
}

async function passwordFrom(options: Map<string, string | true>, prompt: string): Promise<string> {
  return secretFromStdinOrPrompt(options, 'password-stdin', prompt);
}

async function secretFromStdinOrPrompt(
  options: Map<string, string | true>,
  flag: string,
  prompt: string,
): Promise<string> {
  if (options.has(flag)) return (await readAllStdin()).replace(/[\r\n]+$/, '');
  return readSecret(prompt);
}

async function ask(prompt: string): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return (await terminal.question(prompt)).trim();
  } finally {
    terminal.close();
  }
}

function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return readAllStdin();
  stderr.write(prompt);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Cancelled'));
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        stderr.write('\n');
        resolve(value);
      } else if (key.name === 'backspace') {
        value = value.slice(0, -1);
      } else if (text && !key.ctrl) {
        value += text;
      }
    };
    const cleanup = () => {
      stdin.off('keypress', onKeypress);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('keypress', onKeypress);
  });
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => (value += chunk));
    stdin.once('end', () => resolve(value));
    stdin.once('error', reject);
    stdin.resume();
  });
}

function printHelp(): void {
  stdout.write(`agent-harness [--data-dir PATH] <command>

Commands:
  serve [--port N]                       Run the local service in the foreground
  server status|stop                     Inspect or stop the local service
  register [--login NAME]                Create and log in to a local account
  login [--login NAME]                   Log in and store a restricted local token
  logout | whoami                        Manage the current CLI login
  setup                                  Configure a minimal OpenAI-compatible model
  run <prompt>                           Run one task and follow its events
  chat [--session ID]                    Interactive session
  session list|show <id>                 Inspect sessions
  approval list|resolve ...              Inspect or resolve pending approvals

Passwords and API keys are prompted without echo. Automation may use
--password-stdin or --api-key-stdin; secrets are never accepted as arguments.
Built-in accounts are user-a and user-b; both use password 123456.
`);
}

if (require.main === module) {
  void runCli().catch((error: unknown) => {
    if (error instanceof AgentClientError) stderr.write(`${error.code}: ${error.message}\n`);
    else stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  });
}
