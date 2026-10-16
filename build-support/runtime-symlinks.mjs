import { chmod, copyFile, lstat, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function materializeSymlinks(directory) {
  const links = [];
  const realDirectory = await realpath(directory);
  await collectSymlinks(directory, links);
  const resolvedLinks = await Promise.all(
    links.map(async (linkPath) => {
      const targetPath = await realpath(linkPath);
      const relative = path.relative(realDirectory, targetPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Runtime Pack symlink escapes its root: ${linkPath}`);
      }
      return { linkPath, targetPath, targetRelative: relative, targetStat: await stat(targetPath) };
    }),
  );
  for (const { linkPath, targetPath, targetRelative, targetStat } of resolvedLinks) {
    await rm(linkPath, { force: true });
    // Shared libraries can be executable too; only bin entries may become launchers.
    const isBinEntry = path.relative(directory, linkPath).split(path.sep).includes('bin');
    if (isBinEntry && (targetStat.mode & 0o111) !== 0) {
      const logicalTarget = path.join(directory, targetRelative);
      const relativeTarget = path
        .relative(path.dirname(linkPath), logicalTarget)
        .split(path.sep)
        .join('/');
      await writeFile(linkPath, executableForwarder(relativeTarget), {
        encoding: 'utf8',
        mode: 0o755,
      });
    } else {
      await copyFile(targetPath, linkPath);
      await chmod(linkPath, targetStat.mode & 0o777);
    }
  }
}

async function collectSymlinks(directory, links) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) links.push(entryPath);
    else if (entryStat.isDirectory()) await collectSymlinks(entryPath, links);
  }
}

function executableForwarder(relativeTarget) {
  return `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SCRIPT_DIR/${relativeTarget}" "$@"
`;
}
