import { stderr } from 'node:process';
import { AgentClientError } from '../../../packages/client-sdk/src/agent-client';
import { runCli } from './index';

void runCli().catch((error: unknown) => {
  if (error instanceof AgentClientError) stderr.write(`${error.code}: ${error.message}\n`);
  else stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
  process.exitCode = 1;
});
