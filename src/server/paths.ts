import os from 'node:os';
import path from 'node:path';

export function defaultAppDataDir(platform = process.platform): string {
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Agent Harness');
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return path.join(localAppData || os.homedir(), 'Agent Harness');
  }
  const xdgData = process.env.XDG_DATA_HOME?.trim();
  return path.join(xdgData || path.join(os.homedir(), '.local', 'share'), 'agent-harness');
}

export interface ServicePaths {
  dataDir: string;
  serviceDir: string;
  lockFile: string;
  discoveryFile: string;
  bootstrapTokenFile: string;
  cliSessionFile: string;
}

export function servicePaths(dataDir = defaultAppDataDir()): ServicePaths {
  const resolved = path.resolve(dataDir);
  const serviceDir = path.join(resolved, 'server');
  return {
    dataDir: resolved,
    serviceDir,
    lockFile: path.join(serviceDir, 'instance.lock'),
    discoveryFile: path.join(serviceDir, 'discovery.json'),
    bootstrapTokenFile: path.join(serviceDir, 'bootstrap-token'),
    cliSessionFile: path.join(serviceDir, 'cli-session.json'),
  };
}
