import { app, dialog, ipcMain, screen, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentClientError, AgentClient } from '../../../../packages/client-sdk/src/agent-client';
import { FileAccountStorage } from '../../../../packages/client-sdk/src/node-account-storage';
import { BridgeError, toErrorPayload } from '../../../../packages/protocol/src/contracts/errors';
import {
  IPC_CHANNELS,
  sessionFileOpenSchema,
  sessionSubscriptionRequestSchema,
  sessionUnsubscriptionRequestSchema,
  type LifecycleEvent,
  type RpcEnvelope,
} from '../../../../packages/protocol/src/contracts/ipc';
import {
  commandRequestSchema,
  queryRequestSchema,
} from '../../../../packages/protocol/src/contracts/schemas';
import { registerRequestSchema } from '../../../../packages/protocol/src/contracts/auth';
import { sessionFileUploadSchema } from '../../../../packages/protocol/src/contracts/session-file';
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
let officeWindowBounds: { before: Electron.Rectangle; expanded: Electron.Rectangle } | null = null;
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
      console.error('desktop startup failed', {
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
      });
      dialog.showErrorBox('Agent Harness', '客户端启动失败，请查看日志后重试。');
      app.quit();
    });
}

async function startDesktop(): Promise<void> {
  const dataDir = configuredAppDataDir ?? app.getPath('userData');
  const iconPath = isDev
    ? path.join(app.getAppPath(), 'resources', 'icon.png')
    : path.join(process.resourcesPath, 'icon.png');
  if (process.platform === 'darwin') app.dock.setIcon(iconPath);

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
  installIpcHandlers();
  ipcMain.handle('window.set-office-open', (event, open: unknown) => {
    if (!isTrustedSender(event)) return false;
    if (typeof open !== 'boolean' || !mainWindow) return false;
    if (open) {
      if (officeWindowBounds || mainWindow.isMaximized() || mainWindow.isFullScreen()) return true;
      const before = mainWindow.getBounds();
      const workArea = screen.getDisplayMatching(before).workArea;
      const width = Math.min(workArea.width, Math.max(before.width, 1740));
      if (width <= before.width) return true;
      const x = Math.max(
        workArea.x,
        Math.min(
          before.x - Math.round((width - before.width) / 2),
          workArea.x + workArea.width - width,
        ),
      );
      const expanded = { ...before, x, width };
      mainWindow.setBounds(expanded);
      officeWindowBounds = { before, expanded };
    } else if (officeWindowBounds) {
      const { before, expanded } = officeWindowBounds;
      officeWindowBounds = null;
      const current = mainWindow.getBounds();
      if (
        !mainWindow.isMaximized() &&
        !mainWindow.isFullScreen() &&
        current.width === expanded.width &&
        current.x === expanded.x &&
        current.y === expanded.y
      ) {
        mainWindow.setBounds(before);
      }
    }
    return true;
  });
  ipcMain.handle('connection.get', (event) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    let baseUrl = process.env.AGENT_HARNESS_SERVER_URL?.trim() ?? '';
    if (!baseUrl) {
      try {
        baseUrl =
          JSON.parse(readFileSync(path.join(dataDir, 'connection.json'), 'utf8')).baseUrl ?? '';
      } catch {
        /* First launch has no saved server. */
      }
    }
    return { ok: true, result: { baseUrl } };
  });
  ipcMain.handle('connection.set', (event, value: unknown) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    return handleRpc(async () => {
      if (typeof value !== 'string') throw new BridgeError('INVALID_REQUEST', '请输入服务器地址');
      const url = new URL(value);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new BridgeError('INVALID_REQUEST', '请输入有效的 HTTP/HTTPS 服务器地址');
      }
      const baseUrl = url.href.replace(/\/$/, '');
      const client = new AgentClient({
        baseUrl,
        clientKind: 'electron',
        accountStorage: new FileAccountStorage(path.join(dataDir, 'local-accounts')),
        fetch: (input, init) =>
          fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15000) }),
      });
      const health = await client.health();
      if (health.protocolVersion !== 1)
        throw new BridgeError('INVALID_REQUEST', '服务器协议版本不兼容');
      for (const unsubscribe of sessionUnsubscribers.values()) unsubscribe();
      sessionUnsubscribers.clear();
      serviceClient = client;
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path.join(dataDir, 'connection.json'), JSON.stringify({ baseUrl }), {
        mode: 0o600,
      });
      setServiceStatus('ready');
      return { baseUrl };
    });
  });
  startLifecycleProbe();
}

function installIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.authRegister, (event, payload: unknown) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    return handleRpc(async () => {
      const parsed = registerRequestSchema.safeParse(payload);
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid registration');
      const result = await serviceClient!.registerRemote(parsed.data);
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
      properties: ['openFile'],
      filters: [{ name: 'Agent Skill ZIP', extensions: ['zip'] }],
    });
    const sourcePath = selected.filePaths[0];
    if (selected.canceled || !sourcePath) return { ok: true, result: { cancelled: true } };
    return handleRpc(async () => {
      if (path.extname(sourcePath).toLowerCase() !== '.zip')
        throw new BridgeError('INVALID_REQUEST', '请选择 Skill ZIP');
      const bytes = await readFile(sourcePath);
      return serviceClient!.installSkill(
        new Blob([new Uint8Array(bytes)]),
        path.basename(sourcePath),
      );
    });
  });
  ipcMain.handle(IPC_CHANNELS.uploadSessionFile, async (event, payload: unknown) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    return handleRpc(async () => {
      const parsed = sessionFileUploadSchema.safeParse(payload);
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid file upload');
      return serviceClient!.uploadSessionFile(
        parsed.data.sessionId,
        new Blob([parsed.data.bytes]),
        parsed.data.name,
      );
    });
  });
  ipcMain.handle(IPC_CHANNELS.openSessionFile, async (event, payload: unknown) => {
    if (!isTrustedSender(event)) return unauthorizedEnvelope();
    return handleRpc(async () => {
      const parsed = sessionFileOpenSchema.safeParse(payload);
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid file request');
      if (!mainWindow) throw new BridgeError('INTERNAL_ERROR', 'Window unavailable');
      const selected = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.basename(parsed.data.target) || 'download',
      });
      if (selected.canceled || !selected.filePath) return { opened: false };
      const blob = await serviceClient!.downloadSessionFile(
        parsed.data.sessionId,
        parsed.data.target,
      );
      await writeFile(selected.filePath, Buffer.from(await blob.arrayBuffer()));
      shell.showItemInFolder(selected.filePath);
      return { opened: true };
    });
  });
}

function startLifecycleProbe(): void {
  lifecycleTimer = setInterval(() => {
    void serviceClient
      ?.health()
      .then(() => setServiceStatus('ready'))
      .catch(() => setServiceStatus('failed'));
  }, 5000);
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
