#!/usr/bin/env bash
# Wrap the matching, verified self-contained Runtime archive in an installable Debian package.
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ $(uname -s) = Linux ]] || { echo 'Build Debian Runtime packages on Linux.' >&2; exit 2; }
case "$(uname -m)" in
  x86_64) TARGET=linux-x64; DEB_ARCH=amd64 ;;
  aarch64|arm64) TARGET=linux-arm64; DEB_ARCH=arm64 ;;
  *) echo 'Unsupported CPU architecture' >&2; exit 2 ;;
esac
VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REPO/build-support/server-package/package.json")
DEB_VERSION="$VERSION-1"
OUTPUT="$REPO/release/runtime/$TARGET"
ARCHIVE="agent-harness-runtime-$TARGET-$VERSION.tgz"
for command in dpkg-deb sha256sum tar python3; do command -v "$command" >/dev/null; done
(cd "$OUTPUT" && sha256sum -c "$ARCHIVE.sha256")
STAGING=$(mktemp -d "${TMPDIR:-/tmp}/agent-runtime-deb.XXXXXX")
trap 'rm -rf -- "$STAGING"' EXIT
ROOT="$STAGING/root"
BUNDLE="$ROOT/opt/agent-harness-runtime"
DOC="$ROOT/usr/share/doc/agent-harness-runtime"
mkdir -p "$BUNDLE" "$DOC/examples" "$ROOT/usr/bin" "$ROOT/DEBIAN"
tar -xzf "$OUTPUT/$ARCHIVE" -C "$BUNDLE" --strip-components=1
python3 - "$BUNDLE/distribution-manifest.json" "$TARGET" "$VERSION" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
assert manifest['target']['platform'] + '-' + manifest['target']['arch'] == sys.argv[2], 'Wrong Runtime target'
assert manifest['version'] == sys.argv[3], 'Wrong Runtime version'
PY
ln -s /opt/agent-harness-runtime/bin/agent-harness "$ROOT/usr/bin/agent-harness-runtime"
cp "$REPO/deployment/ubuntu24.04/RUNTIME-DEB.md" "$DOC/README.md"
cp "$REPO/deployment/ubuntu24.04/bwrap-userns-restrict.apparmor" "$DOC/examples/"
SIZE=$(du -sk "$ROOT/opt" "$ROOT/usr" | awk '{size += $1} END {print size}')
cat > "$ROOT/DEBIAN/control" <<CONTROL
Package: agent-harness-runtime
Version: $DEB_VERSION
Section: devel
Priority: optional
Architecture: $DEB_ARCH
Maintainer: Agent Harness Team
Installed-Size: $SIZE
Depends: libc6 (>= 2.39), libgcc-s1, libstdc++6, libatomic1, zlib1g, libcrypt1, ca-certificates, bubblewrap, bash, coreutils
Description: Self-contained Agent Harness Runtime and Web client
 Includes Node.js, Python, Memory MCP, CLI, Web, and native SQLite.
 Client applications manage local accounts; Runtime trusts supplied user IDs.
 No service is automatically started and application data is not packaged.
CONTROL
chmod -R go-w,a+rX "$ROOT"
(cd "$ROOT" && find opt usr -type f -print0 | LC_ALL=C sort -z | xargs -0 md5sum > DEBIAN/md5sums)
DEB="agent-harness-runtime_${DEB_VERSION}_${DEB_ARCH}.deb"
# gzip limits memory pressure on small Ubuntu build hosts.
dpkg-deb --root-owner-group -Zgzip -z6 --build "$ROOT" "$STAGING/$DEB"
mv "$STAGING/$DEB" "$OUTPUT/$DEB"
(cd "$OUTPUT" && sha256sum "$DEB" > "$DEB.sha256" && sha256sum -c "$DEB.sha256")
echo "DEB_PACKAGE_OK: $OUTPUT/$DEB"
