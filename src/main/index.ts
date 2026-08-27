import { app, dialog, ipcMain } from 'electron';
import { lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { RuntimeWorkerSupervisor } from './worker-supervisor';
import type { WorkerFactory, WorkerLike } from './worker-supervisor';
import { BridgeController } from './bridge-controller';
import { applyContentSecurityPolicy, createMainWindow, isAllowedNavigation } from './window';
import { IPC_CHANNELS } from '../shared/contracts/ipc';
import type { RpcEnvelope } from '../shared/contracts/ipc';
import { BridgeError, toErrorPayload } from '../shared/contracts/errors';
import { SystemClock } from '../shared/domain/ports';
import { JsonlLogger } from '../infrastructure/logging/logger';
import type { Logger } from '../infrastructure/logging/logger';
import type { WorkerBootstrapData } from '../worker/index';
import { sessionSubscriptionSchema } from '../shared/contracts/schemas';
import { extractSkillArchive } from './skill-archive';

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
