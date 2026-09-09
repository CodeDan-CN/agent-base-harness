import { app, dialog, ipcMain, shell } from 'electron';
import { lstatSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentClientError, type AgentClient } from '../client/agent-client';
import { LocalConnector } from '../client/local-connector';
import { JsonlLogger, type Logger } from '../infrastructure/logging/logger';
import { loadBundledRuntime } from '../infrastructure/runtime/bundled-runtime-registry';
import { BridgeError, toErrorPayload } from '../shared/contracts/errors';
import {
  IPC_CHANNELS,
  sessionFileOpenSchema,
  sessionSubscriptionRequestSchema,
  sessionUnsubscriptionRequestSchema,
  type LifecycleEvent,
  type RpcEnvelope,
} from '../shared/contracts/ipc';
import { commandRequestSchema, queryRequestSchema } from '../shared/contracts/schemas';
import { registerRequestSchema } from '../shared/contracts/auth';
import { extractSkillArchive } from './skill-archive';
import { resolveSessionFile } from './session-file';
import { applyContentSecurityPolicy, createMainWindow, isAllowedNavigation } from './window';

const devServerUrl = process.env.AGENT_CLIENT_DEV_SERVER_URL ?? '';
const useDevServer = devServerUrl.length > 0;
const isDev = useDevServer || !app.isPackaged;
const configuredAppDataDir = process.env.AGENT_CLIENT_APP_DATA?.trim();

if (configuredAppDataDir) {
  mkdirSync(configuredAppDataDir, { recursive: true });
  app.setPath('userData', configuredAppDataDir);
}

let mainWindow: Electron.BrowserWindow | null = null;
let logger: Logger | null = null;
let allowedNavigations: string[] = [];
let serviceClient: AgentClient | null = null;
let serviceStatus: LifecycleEvent = { type: 'runtime', status: 'starting', generation: 1 };
let lifecycleTimer: ReturnType<typeof setInterval> | null = null;
const sessionUnsubscribers = new Map<string, () => void>();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

type IpcEvent = Electron.IpcMainInvokeEvent | Electron.IpcMainEvent;

function isTrustedSender(event: IpcEvent): boolean {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return false;
  return isAllowedNavigation(event.senderFrame?.url ?? '', allowedNavigations);
}

function unauthorizedEnvelope(): RpcEnvelope {
  return { ok: false, error: { code: 'UNAUTHORIZED_SENDER', message: 'Unauthorized sender' } };
}

async function handleRpc(fn: () => Promise<unknown>): Promise<RpcEnvelope> {
  try {
    return { ok: true, result: await fn() };
  } catch (error) {
    if (error instanceof AgentClientError) {
      return {
        ok: false,
        error: {
          code: error.code as ReturnType<typeof toErrorPayload>['code'],
          message: error.message,
        },
      };
    }
    return { ok: false, error: toErrorPayload(error) };
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

if (hasSingleInstanceLock) {
  void app
    .whenReady()
    .then(startDesktop)
    .catch((error: unknown) => {
      logger?.error('desktop startup failed', {
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
      });
      dialog.showErrorBox('Agent Harness', '本地运行服务启动失败，请查看日志后重试。');
      app.quit();
    });
}

async function startDesktop(): Promise<void> {
  const dataDir = app.getPath('userData');
  logger = new JsonlLogger({
    dir: path.join(dataDir, 'logs'),
    fileName: 'main.log',
    console: isDev,
  });
  const mainLogger = logger;
  const iconPath = isDev
    ? path.join(app.getAppPath(), 'resources', 'icon.png')
    : path.join(process.resourcesPath, 'icon.png');
  if (process.platform === 'darwin') app.dock.setIcon(iconPath);

  const runtimeTarget = `${process.platform}-${process.arch}`;
  const runtimeRoot = isDev
    ? path.join(app.getAppPath(), '.runtime-cache', runtimeTarget)
    : path.join(process.resourcesPath, 'runtimes', runtimeTarget);
  const bundledRuntime = loadBundledRuntime(runtimeRoot, { required: !isDev });
  if (bundledRuntime) {
    mainLogger.info('bundled runtime ready', {
      platform: bundledRuntime.platform,
      arch: bundledRuntime.arch,
      nodeVersion: bundledRuntime.node.version,
    });
  }

  const serverEntry = isDev
    ? path.join(__dirname, '..', 'server', 'index.cjs')
    : path.join(process.resourcesPath, 'service', 'server', 'index.cjs');
  const connector = new LocalConnector({
    dataDir,
    clientKind: 'electron',
    serverEntry,
    launch: (resolvedDataDir) => {
      const arguments_ = [serverEntry, '--data-dir', resolvedDataDir];
      if (bundledRuntime) arguments_.push('--runtime-root', runtimeRoot);
      if (isDev) arguments_.push('--debug');
      const executable = isDev ? process.execPath : bundledRuntime?.node.executable;
      if (!executable) throw new Error('Bundled Node.js runtime is unavailable');
      const child = spawn(executable, arguments_, {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          ...(isDev ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          ...(!isDev
            ? { NODE_PATH: path.join(process.resourcesPath, 'service', 'node_modules') }
            : {}),
        },
      });
      child.unref();
    },
  });
  // Development launches must use the server bundle built for this run. The
  // production service remains independent and survives desktop restarts.
  const connection = isDev ? await connector.restart() : await connector.connectOrStart();
  serviceClient = connection.client;
  serviceStatus = { type: 'runtime', status: 'ready', generation: 1 };
  mainLogger.info('connected to local service', {
    instanceId: connection.discovery.instanceId,
    servicePid: connection.discovery.pid,
  });

  const preloadPath = path.join(__dirname, '..', 'preload', 'index.cjs');
  const rendererUrl = useDevServer
    ? devServerUrl
    : path.join(__dirname, '..', 'renderer', 'index.html');
  allowedNavigations = useDevServer ? [devServerUrl] : [pathToFileURL(rendererUrl).href];
  mainWindow = createMainWindow({
    preloadPath,
    rendererUrl,
    iconPath,
    dev: isDev,
    allowedNavigations,
  });
  applyContentSecurityPolicy(mainWindow.webContents.session, isDev);
  installIpcHandlers(connector, dataDir);
  startLifecycleProbe(connector);
}

function installIpcHandlers(connector: LocalConnector, dataDir: string): void {
  ipcMain.handle(IPC_CHANNELS.authRegister, (event, payload: unknown) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    return handleRpc(async () => {
      const parsed = registerRequestSchema.safeParse(payload);
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid registration');
      const result = await serviceClient!.register(connector.readBootstrapToken(), parsed.data);
      return { expiresAt: result.expiresAt, user: result.user };
    });
  });
  ipcMain.handle(IPC_CHANNELS.authLogin, (event, payload: unknown) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    return handleRpc(async () => {
      if (!payload || typeof payload !== 'object') {
        throw new BridgeError('INVALID_REQUEST', 'Invalid login');
      }
      const { loginName, password } = payload as Record<string, unknown>;
      if (typeof loginName !== 'string' || typeof password !== 'string') {
        throw new BridgeError('INVALID_REQUEST', 'Invalid login');
      }
      const result = await serviceClient!.login(loginName, password);
      return { expiresAt: result.expiresAt, user: result.user };
    });
  });
  ipcMain.handle(IPC_CHANNELS.authLogout, (event) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    return handleRpc(async () => {
      await serviceClient!.logout();
      return { loggedOut: true };
    });
  });
  ipcMain.handle(IPC_CHANNELS.authMe, (event) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    return handleRpc(() => serviceClient!.me());
  });
  ipcMain.handle(IPC_CHANNELS.query, (event, payload: unknown) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    return handleRpc(async () => {
      const parsed = queryRequestSchema.safeParse(payload);
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid request');
      return serviceClient!.query(parsed.data.method, parsed.data.params);
    });
  });
  ipcMain.handle(IPC_CHANNELS.command, (event, payload: unknown) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    return handleRpc(async () => {
      const parsed = commandRequestSchema.safeParse(payload);
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid request');
      return serviceClient!.command(parsed.data.method, parsed.data.params);
    });
  });
  ipcMain.on(IPC_CHANNELS.subscribe, (event, payload: unknown) => {
    if (!isTrustedSender(event)) return;
    const senderId = String(event.sender.id);
    if (payload === undefined) {
      event.sender.send(IPC_CHANNELS.lifecycle, serviceStatus);
      return;
    }
    const parsed = sessionSubscriptionRequestSchema.safeParse(payload);
    if (!parsed.success) return;
    const { afterSeq, sessionId, subscriptionId } = parsed.data;
    const subscriptionKey = `${senderId}\u0000${subscriptionId}`;
    sessionUnsubscribers.get(subscriptionKey)?.();
    const unsubscribe = serviceClient!.subscribeSession(
      sessionId,
      afterSeq,
      (runtimeEvent) => {
        if (mainWindow?.webContents.id !== Number(senderId)) return;
        mainWindow.webContents.send(IPC_CHANNELS.sessionEvents, {
          type: 'events',
          subscriptionId,
          sessionId,
          fromSeq: runtimeEvent.seq,
          toSeq: runtimeEvent.seq,
          events: [runtimeEvent],
        });
      },
      {
        onError: () => {
          mainWindow?.webContents.send(IPC_CHANNELS.sessionEvents, {
            type: 'resync-required',
            subscriptionId,
            sessionId,
            expectedSeq: afterSeq + 1,
            receivedSeq: afterSeq + 1,
          });
        },
      },
    );
    sessionUnsubscribers.set(subscriptionKey, unsubscribe);
  });
  ipcMain.on(IPC_CHANNELS.unsubscribe, (event, payload: unknown) => {
    if (!isTrustedSender(event)) return;
    const senderId = String(event.sender.id);
    const parsed = sessionUnsubscriptionRequestSchema.safeParse(payload);
    if (!parsed.success) return;
    const subscriptionKey = `${senderId}\u0000${parsed.data.subscriptionId}`;
    sessionUnsubscribers.get(subscriptionKey)?.();
    sessionUnsubscribers.delete(subscriptionKey);
  });
  ipcMain.handle(IPC_CHANNELS.selectSkillDirectory, async (event) => {
    if (!isTrustedSender(event) || !mainWindow) return unauthorizedEnvelope();
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Agent Skill 目录或 ZIP',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Agent Skill ZIP', extensions: ['zip'] }],
    });
    const sourcePath = selected.filePaths[0];
    if (selected.canceled || !sourcePath) return { ok: true, result: { cancelled: true } };
    return handleRpc(async () => {
      let selectedSkillPath = sourcePath;
      let extracted: Awaited<ReturnType<typeof extractSkillArchive>> | undefined;
      try {
        const stat = lstatSync(sourcePath);
        if (stat.isFile()) {
          if (path.extname(sourcePath).toLocaleLowerCase() !== '.zip') {
            throw new BridgeError('INVALID_REQUEST', 'Select a Skill directory or ZIP file');
          }
          extracted = await extractSkillArchive(sourcePath);
          selectedSkillPath = extracted.skillRoot;
        }
        return serviceClient!.command('skill.install.directory', { sourcePath: selectedSkillPath });
      } finally {
        extracted?.cleanup();
      }
    });
  });
  ipcMain.handle(IPC_CHANNELS.openSessionFile, async (event, payload: unknown) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    return handleRpc(async () => {
      const parsed = sessionFileOpenSchema.safeParse(payload);
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid file request');
      const current = await serviceClient!.me();
      const file = await resolveSessionFile({
        appDataDir: dataDir,
        userId: current.user.id,
        sessionId: parsed.data.sessionId,
        target: parsed.data.target,
      });
      const openError = await shell.openPath(file);
      if (openError) throw new BridgeError('INTERNAL_ERROR', 'Unable to open file');
      return { opened: true };
    });
  });
}

function startLifecycleProbe(connector: LocalConnector): void {
  lifecycleTimer = setInterval(() => {
    void serviceClient
      ?.health()
      .then(() => setServiceStatus('ready'))
      .catch(async () => {
        try {
          // The desktop does not own Runtime. If the independent service was
          // restarted, reconnect to it and let the renderer re-authenticate
          // against the new in-memory session state.
          const connection = await connector.connectOrStart();
          serviceClient = connection.client;
          setServiceStatus('ready');
        } catch {
          setServiceStatus('failed');
        }
      });
  }, 2000);
}

function setServiceStatus(status: 'ready' | 'failed'): void {
  if (serviceStatus.type === 'runtime' && serviceStatus.status === status) return;
  serviceStatus = { type: 'runtime', status, generation: 1 };
  mainWindow?.webContents.send(IPC_CHANNELS.lifecycle, serviceStatus);
}

app.on('before-quit', () => {
  if (lifecycleTimer) clearInterval(lifecycleTimer);
  lifecycleTimer = null;
  for (const unsubscribe of sessionUnsubscribers.values()) unsubscribe();
  sessionUnsubscribers.clear();
  // Runtime belongs to the independent service. Desktop exit deliberately does not stop it.
});

app.on('window-all-closed', () => app.quit());
