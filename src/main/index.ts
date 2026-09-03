import { app, dialog, ipcMain, shell } from 'electron';
import { lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { RuntimeWorkerSupervisor } from './worker-supervisor';
import type { WorkerFactory, WorkerLike } from './worker-supervisor';
import { BridgeController } from './bridge-controller';
import { applyContentSecurityPolicy, createMainWindow, isAllowedNavigation } from './window';
import { IPC_CHANNELS, sessionFileOpenSchema } from '../shared/contracts/ipc';
import type { RpcEnvelope } from '../shared/contracts/ipc';
import { BridgeError, toErrorPayload } from '../shared/contracts/errors';
import { SystemClock } from '../shared/domain/ports';
import { JsonlLogger } from '../infrastructure/logging/logger';
import type { Logger } from '../infrastructure/logging/logger';
import type { WorkerBootstrapData } from '../worker/index';
import { sessionSubscriptionSchema } from '../shared/contracts/schemas';
import { extractSkillArchive } from './skill-archive';
import { loadBundledRuntime } from '../infrastructure/runtime/bundled-runtime-registry';
import { resolveSessionFile } from './session-file';

const devServerUrl = process.env.AGENT_CLIENT_DEV_SERVER_URL ?? '';
const useDevServer = devServerUrl.length > 0;
const isDev = useDevServer || !app.isPackaged;
const configuredAppDataDir = process.env.AGENT_CLIENT_APP_DATA?.trim();

if (configuredAppDataDir) {
  mkdirSync(configuredAppDataDir, { recursive: true });
  app.setPath('userData', configuredAppDataDir);
}

function appDataDir(): string {
  return app.getPath('userData');
}

function toRpcEnvelope(value: unknown): RpcEnvelope {
  if (typeof value === 'object' && value !== null && 'ok' in value) {
    return value as RpcEnvelope;
  }
  return { ok: true, result: value };
}

async function handleRpc(fn: () => Promise<unknown>): Promise<RpcEnvelope> {
  try {
    const result = await fn();
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: toErrorPayload(err) };
  }
}

function unauthorizedEnvelope(): RpcEnvelope {
  return { ok: false, error: { code: 'UNAUTHORIZED_SENDER', message: 'Unauthorized sender' } };
}

let supervisor: RuntimeWorkerSupervisor | null = null;
let controller: BridgeController | null = null;
let mainWindow: Electron.BrowserWindow | null = null;
let logger: Logger | null = null;
let allowedNavigations: string[] = [];
let shuttingDown = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

type IpcEvent = Electron.IpcMainInvokeEvent | Electron.IpcMainEvent;

function isTrustedSender(event: IpcEvent): boolean {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return false;
  const frameUrl = event.senderFrame?.url ?? '';
  return isAllowedNavigation(frameUrl, allowedNavigations);
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

if (hasSingleInstanceLock)
  void app.whenReady().then(async () => {
    const dataDir = appDataDir();
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
        pythonVersion: bundledRuntime.python.version,
        memoryMcpVersion: bundledRuntime.mcp.memory.version,
      });
    } else {
      mainLogger.warn('bundled runtime unavailable in development; using system interpreters');
    }

    const workerPath = path.join(__dirname, '..', 'worker', 'index.cjs');
    const factory: WorkerFactory = (data) =>
      new Worker(workerPath, { workerData: data }) as unknown as WorkerLike;

    supervisor = new RuntimeWorkerSupervisor({
      factory,
      workerData: (generation: number): WorkerBootstrapData => ({
        appDataDir: dataDir,
        generation,
        logDir: path.join(dataDir, 'logs'),
        debug: isDev,
        useSystemCredential: true,
        runtime: bundledRuntime ?? undefined,
      }),
      clock: new SystemClock(),
      logger: mainLogger,
    });

    const preloadPath = path.join(__dirname, '..', 'preload', 'index.cjs');
    const rendererUrl = useDevServer
      ? devServerUrl
      : path.join(__dirname, '..', 'renderer', 'index.html');
    allowedNavigations = useDevServer ? [devServerUrl] : [pathToFileURL(rendererUrl).href];

    const renderer = createMainWindow({
      preloadPath,
      rendererUrl,
      iconPath,
      dev: isDev,
      allowedNavigations,
    });
    mainWindow = renderer;
    applyContentSecurityPolicy(renderer.webContents.session, isDev);
    mainLogger.info('window created', { windowId: renderer.webContents.id });
    renderer.webContents.on('did-fail-load', (_e, code, desc) =>
      mainLogger.error('renderer load failed', { code, desc }),
    );

    controller = new BridgeController({
      dispatcher: supervisor,
      logger: mainLogger,
      isAuthorizedSender: (senderId: string) =>
        mainWindow !== null && mainWindow.webContents.id === Number(senderId),
      sendLifecycle: (event) => {
        mainWindow?.webContents.send(IPC_CHANNELS.lifecycle, event);
      },
      sendSessionEvents: (senderId, event) => {
        if (mainWindow?.webContents.id === Number(senderId)) {
          mainWindow.webContents.send(IPC_CHANNELS.sessionEvents, event);
        }
      },
    });

    ipcMain.handle(IPC_CHANNELS.query, (event, payload: unknown) => {
      if (!isTrustedSender(event)) return unauthorizedEnvelope();
      return handleRpc(() => controller!.handleQuery(String(event.sender.id), payload));
    });
    ipcMain.handle(IPC_CHANNELS.command, (event, payload: unknown) => {
      if (!isTrustedSender(event)) return unauthorizedEnvelope();
      return handleRpc(() => controller!.handleCommand(String(event.sender.id), payload));
    });
    ipcMain.on(IPC_CHANNELS.subscribe, (event, payload: unknown) => {
      if (!isTrustedSender(event)) return;
      if (payload === undefined) {
        controller!.handleSubscribe(String(event.sender.id));
        const state = supervisor?.getState();
        if (state) {
          event.sender.send(IPC_CHANNELS.lifecycle, {
            type: 'runtime',
            status: state.status,
            generation: state.generation,
          });
        }
        return;
      }
      const parsed = sessionSubscriptionSchema.safeParse(payload);
      if (parsed.success) controller!.handleSubscribe(String(event.sender.id), parsed.data);
    });
    ipcMain.on(IPC_CHANNELS.unsubscribe, (event, payload: unknown) => {
      if (!isTrustedSender(event)) return;
      const parsed = sessionSubscriptionSchema.pick({ kind: true }).safeParse(payload);
      controller!.handleUnsubscribe(
        String(event.sender.id),
        parsed.success ? 'session' : undefined,
      );
    });
    ipcMain.handle(IPC_CHANNELS.selectSkillDirectory, async (event) => {
      if (!isTrustedSender(event) || !mainWindow || !supervisor || !controller) {
        return unauthorizedEnvelope();
      }
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
          } else if (!stat.isDirectory()) {
            throw new BridgeError('INVALID_REQUEST', 'Select a Skill directory or ZIP file');
          }
          return await supervisor!.request({
            requestId: crypto.randomUUID(),
            userId: controller!.getActiveUserId(),
            windowId: String(event.sender.id),
            method: 'skill.install.directory',
            params: { sourcePath: selectedSkillPath },
          });
        } finally {
          extracted?.cleanup();
        }
      });
    });
    ipcMain.handle(IPC_CHANNELS.openSessionFile, async (event, payload: unknown) => {
      if (!isTrustedSender(event) || !controller) return unauthorizedEnvelope();
      return handleRpc(async () => {
        const parsed = sessionFileOpenSchema.safeParse(payload);
        if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid file request');
        if (controller!.getSubscribedSessionId(String(event.sender.id)) !== parsed.data.sessionId) {
          throw new BridgeError('INVALID_REQUEST', 'Session is not active');
        }
        const file = await resolveSessionFile({
          appDataDir: dataDir,
          userId: controller!.getActiveUserId(),
          sessionId: parsed.data.sessionId,
          target: parsed.data.target,
        });
        const openError = await shell.openPath(file);
        if (openError) throw new BridgeError('INTERNAL_ERROR', 'Unable to open file');
        return { opened: true };
      });
    });

    supervisor.setLifecycleHandler((event) => controller!.handleLifecycle(event));
    supervisor.setSessionEventHandler((batch) => controller!.handleSessionEvents(batch));

    try {
      await supervisor.start();
      const activeUserId = supervisor.getActiveUserId();
      controller.syncActiveUser(activeUserId ?? 'user-a');
    } catch (err) {
      mainLogger.error('supervisor start failed', {
        errorCode: err instanceof Error ? err.name : 'UNKNOWN',
      });
    }
  });

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void (async () => {
    await supervisor?.stop();
    app.quit();
  })();
});

app.on('window-all-closed', () => {
  app.quit();
});

export { toRpcEnvelope };
