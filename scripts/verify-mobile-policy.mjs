import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'agent-mobile-java-'));
const root = path.resolve(import.meta.dirname, '..');
try {
  for (const [command, args] of [
    [
      'javac',
      [
        '-d',
        temporary,
        path.join(
          root,
          'apps/mobile/android/app/src/main/java/com/agentharness/mobile/RemoteEndpoint.java',
        ),
        path.join(root, 'apps/mobile/android/test/RemoteEndpointTest.java'),
      ],
    ],
    ['java', ['-cp', temporary, 'com.agentharness.mobile.RemoteEndpointTest']],
  ]) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
