import { resolve } from 'node:path';
import { ServiceHost } from './service-host';
import { defaultAppDataDir } from './paths';

export interface ServeArguments {
  dataDir?: string;
  port?: number;
  debug?: boolean;
  runtimeRoot?: string;
}

export async function serve(arguments_: ServeArguments = {}): Promise<ServiceHost> {
  const host = new ServiceHost({
    dataDir: resolve(arguments_.dataDir ?? defaultAppDataDir()),
    port: arguments_.port,
    debug: arguments_.debug,
    runtimeRoot: arguments_.runtimeRoot,
  });
  await host.start();
  return host;
}

export async function runServerProcess(arguments_ = process.argv.slice(2)): Promise<void> {
  const parsed = parseServeArguments(arguments_);
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

export * from './auth-service';
export * from './gateway';
export * from './lifecycle';
export * from './paths';
export * from './service-host';
