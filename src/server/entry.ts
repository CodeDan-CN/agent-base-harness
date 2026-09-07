import { toErrorPayload } from '../shared/contracts/errors';
import { runServerProcess } from './index';

void runServerProcess().catch((error: unknown) => {
  const payload = toErrorPayload(error);
  process.stderr.write(`${payload.code}: ${payload.message}\n`);
  process.exitCode = 1;
});
