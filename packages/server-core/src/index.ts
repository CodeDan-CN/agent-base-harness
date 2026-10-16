import { resolve } from 'node:path';
import { ServiceHost } from './service-host';
import { defaultAppDataDir } from './paths';

export interface ServeArguments {
  dataDir?: string;
  port?: number;
  host?: string;
  webRoot?: string;
  allowWebRegistration?: boolean;
  debug?: boolean;
  runtimeRoot?: string;
}

export async function serve(arguments_: ServeArguments = {}): Promise<ServiceHost> {
  const environmentDataDir = process.env.AGENT_HARNESS_DATA_DIR?.trim();
  const environmentRuntimeRoot = process.env.AGENT_HARNESS_RUNTIME_ROOT?.trim();
  const environmentWebRoot = process.env.AGENT_HARNESS_WEB_ROOT?.trim();
  const host = new ServiceHost({
    dataDir: resolve(arguments_.dataDir ?? environmentDataDir ?? defaultAppDataDir()),
    port: arguments_.port,
    host: arguments_.host,
    webRoot: resolve(arguments_.webRoot ?? environmentWebRoot ?? resolve(__dirname, '..', 'web')),
    allowWebRegistration: arguments_.allowWebRegistration,
    debug: arguments_.debug,
    runtimeRoot: arguments_.runtimeRoot ?? (environmentRuntimeRoot || undefined),
  });
  await host.start();
  return host;
}

export async function runServerProcess(arguments_ = process.argv.slice(2)): Promise<void> {
  const parsed = parseServeArguments(arguments_);
  parsed.port ??= 4317;
  const host = await serve(parsed);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void host.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

export function parseServeArguments(arguments_: string[]): ServeArguments {
  const result: ServeArguments = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--data-dir') {
      const value = arguments_[++index];
      if (!value) throw new Error('--data-dir requires a value');
      result.dataDir = value;
    } else if (argument === '--port') {
      const value = Number(arguments_[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new Error('--port must be an integer between 0 and 65535');
      }
      result.port = value;
    } else if (argument === '--host') {
      const value = arguments_[++index]?.trim();
      if (!value) throw new Error('--host requires a value');
      result.host = value;
    } else if (argument === '--web-root') {
      const value = arguments_[++index]?.trim();
      if (!value) throw new Error('--web-root requires a value');
      result.webRoot = value;
    } else if (argument === '--allow-web-registration' || argument === '--allow-registration') {
      result.allowWebRegistration = true;
    } else if (argument === '--runtime-root') {
      const value = arguments_[++index];
      if (!value) throw new Error('--runtime-root requires a value');
      result.runtimeRoot = value;
    } else if (argument === '--debug') {
      result.debug = true;
    } else {
      throw new Error(`Unknown serve option: ${argument ?? ''}`);
    }
  }
  return result;
}

export * from './gateway';
export * from './lifecycle';
export * from './paths';
export * from './service-host';
