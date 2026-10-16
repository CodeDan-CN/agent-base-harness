import { runServerProcess } from '../../../packages/server-core/src';
import { LocalConnector } from '../../../packages/server-core/src/local-connector';
import { defaultAppDataDir } from '../../../packages/server-core/src/paths';
import { runCli } from '../../cli/src';
import { migrateLegacyCredentials } from '../../../packages/server-core/src/migrate-legacy-credentials';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dataDir = process.env.AGENT_HARNESS_DATA_DIR?.trim() || defaultAppDataDir();
  const index = args.indexOf('--data-dir');
  if (index >= 0) {
    const value = args[index + 1];
    if (!value) throw new Error('--data-dir requires a value');
    dataDir = value;
    args.splice(index, 2);
  }
  if (args[0] === 'serve') return runServerProcess(['--data-dir', dataDir, ...args.slice(1)]);
  if (
    args[0] === 'credentials' &&
    ['migrate-keychain', 'migrate-files'].includes(args[1] ?? '') &&
    args.length === 2
  ) {
    const result = await migrateLegacyCredentials(
      dataDir,
      args[1] === 'migrate-keychain' ? 'keychain' : 'files',
    );
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.missing || result.failed) process.exitCode = 1;
    return;
  }
  const connector = new LocalConnector({ dataDir, clientKind: 'cli' });
  if (args[0] === 'server') {
    const { client, discovery } = await connector.connect();
    if (args[1] === 'stop') await client.stopService(connector.readBootstrapToken());
    else if (args[1] === 'status')
      process.stdout.write(
        JSON.stringify({ ...(await client.health()), baseUrl: discovery.baseUrl }) + '\n',
      );
    else throw new Error('Usage: agent-harness server status|stop');
    return;
  }
  if (!args.length || args[0] === '--help' || args[0] === 'help') {
    process.stdout.write(
      'Server: agent-harness serve [--data-dir PATH] [--host HOST] [--port PORT]\nAdmin: agent-harness server status|stop\nMigration (stop Runtime first): agent-harness credentials migrate-keychain|migrate-files --data-dir PATH\n',
    );
    return;
  }
  const { discovery } = await connector.connect();
  await runCli(['--server', discovery.baseUrl, ...args]);
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
