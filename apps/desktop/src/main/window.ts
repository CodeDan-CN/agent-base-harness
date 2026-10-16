import { BrowserWindow } from 'electron';
import type { Session } from 'electron';
import { buildCspHeader, isAllowedNavigation } from './navigation';

export interface MainWindowOptions {
  preloadPath: string;
  rendererUrl: string;
  iconPath: string;
  dev: boolean;
  allowedNavigations: string[];
}

export function applyContentSecurityPolicy(session: Session, dev: boolean): void {
  const header = buildCspHeader(dev);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [header],
      },
    });
  });
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#141414',
    icon: options.iconPath,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 18 },
        }
      : {}),
    webPreferences: {
      preload: options.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: options.dev,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, options.allowedNavigations)) {
      event.preventDefault();
    }
  });

  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url, options.allowedNavigations)) {
      event.preventDefault();
    }
  });

  win.once('ready-to-show', () => win.show());

  if (options.rendererUrl.startsWith('http://') || options.rendererUrl.startsWith('https://')) {
    void win.loadURL(options.rendererUrl);
  } else {
    void win.loadFile(options.rendererUrl);
  }

  return win;
}

export { isAllowedNavigation, buildCspHeader };
