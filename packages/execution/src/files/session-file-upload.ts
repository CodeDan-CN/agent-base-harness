import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from '../../../protocol/src/contracts/errors';
import {
  MAX_SESSION_FILE_BYTES,
  sessionFileNameSchema,
  type UploadedSessionFile,
} from '../../../protocol/src/contracts/session-file';

/** Store opaque bytes in the owning Session; only the returned path enters user input. */
export async function storeSessionFile(input: {
  appDataDir: string;
  userId: string;
  sessionId: string;
  name: string;
  bytes: Uint8Array;
}): Promise<UploadedSessionFile> {
  for (const segment of [input.userId, input.sessionId, input.name]) {
    if (!sessionFileNameSchema.safeParse(segment).success) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid file name or Session scope');
    }
  }
  if (input.bytes.byteLength > MAX_SESSION_FILE_BYTES) {
    throw new BridgeError('INVALID_REQUEST', '文件超过 20 MB');
  }
  let directory = await realpath(input.appDataDir);
  for (const segment of ['workspaces', input.userId, input.sessionId, 'attachments']) {
    directory = path.join(directory, segment);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new BridgeError('INVALID_REQUEST', 'Upload directory must not be a symbolic link');
    }
  }
  // Each selection gets its own directory, so equal names never replace previous uploads.
  const uploadDirectory = await mkdtemp(path.join(directory, 'file-'));
  const target = path.join(uploadDirectory, input.name);
  try {
    await writeFile(target, input.bytes, { flag: 'wx', mode: 0o600 });
    return { name: input.name, path: target, size: input.bytes.byteLength };
  } catch (error) {
    await rm(uploadDirectory, { recursive: true, force: true });
    throw error;
  }
}
