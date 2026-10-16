import { toErrorPayload } from '../../../packages/protocol/src/contracts/errors';
import { runServerProcess } from '../../../packages/server-core/src/index';

const args = process.argv.slice(2);
if (args[0] === 'serve') args.shift();
void runServerProcess(args).catch((error: unknown) => {
  const payload = toErrorPayload(error);
  process.stderr.write(`${payload.code}: ${payload.message}\n`);
  process.exitCode = 1;
});
