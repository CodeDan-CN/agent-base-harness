#!/usr/bin/env bash
# Repeatable Ubuntu packaging. Host provisioning is documented in RUNBOOK.md.
set -euo pipefail
UBUNTU_PRODUCT=runtime
UBUNTU_DRY_RUN=0
UBUNTU_FORCE=()
for argument in "$@"; do
  case "$argument" in
    --runtime) UBUNTU_PRODUCT=runtime ;;
    --client) UBUNTU_PRODUCT=client ;;
    --all) UBUNTU_PRODUCT=all ;;
    --force) UBUNTU_FORCE=(--force) ;;
    --dry-run) UBUNTU_DRY_RUN=1 ;;
    --help|-h)
      echo 'Usage: bash deployment/ubuntu24.04/package.sh [--runtime|--client|--all] [--force] [--dry-run]'
      echo 'Default: Runtime + Web, archive smoke and runtime feature verification. --client builds AppImage + tar.gz.'
      echo 'Run on Ubuntu 24.04+ after one-time host provisioning in RUNBOOK.md; Node is bootstrapped from the fixed lock.'
      exit 0 ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done
UBUNTU_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ "$UBUNTU_DRY_RUN" = 1 ]]; then
  echo "Ubuntu packaging plan ($UBUNTU_PRODUCT):"
  echo '1. Check Ubuntu/CPU, compiler tools and (for Runtime) bubblewrap/AppArmor.'
  echo '2. Verify/bootstrap the locked Node; load build-env.sh domestic mirrors and build limits.'
  if [[ "$UBUNTU_PRODUCT" = runtime ]]; then
    echo '3. npm run install:runtime; npm run typecheck:runtime (no desktop dependencies).'
  else
    echo '3. npm ci; Electron binary version check; npm run typecheck.'
  fi
  if [[ "$UBUNTU_PRODUCT" != client ]]; then
    echo '4. Run Runtime, account and client-ID regressions; npm run pack:runtime -- --target linux-<host arch>.'
    echo '5. Check archive SHA-256; extract to a temporary directory; verify-runtime-features.mjs.'
  fi
  if [[ "$UBUNTU_PRODUCT" != runtime ]]; then
    echo '6. npm run build:desktop; electron-builder with electron-builder.linux.json.'
    echo '7. Verify pure client contents; write desktop-SHA256SUMS.'
  fi
  echo 'Outputs: release/runtime/linux-<arch>/ and/or release/desktop-linux/; no service switch.'
  exit 0
fi
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Run this script on the target Ubuntu machine; use --dry-run to preview elsewhere.' >&2
  exit 2
fi
for command in python3 curl tar xz file make gcc g++ sha256sum flock; do
  command -v "$command" >/dev/null || { echo "Missing $command; complete RUNBOOK.md section 4 first." >&2; exit 2; }
done
python3 - <<'PY'
import shlex
values = {}
with open('/etc/os-release') as source:
    for line in source:
        if '=' in line:
            key, value = line.rstrip().split('=', 1)
            values[key] = shlex.split(value)[0] if value else ''
version = tuple(map(int, values.get('VERSION_ID', '0').split('.')))
if values.get('ID') != 'ubuntu' or version < (24, 4):
    raise SystemExit('This entry requires Ubuntu 24.04 or newer; other distributions need separate validation.')
PY
case "$(uname -m)" in
  x86_64) UBUNTU_ARCH=x64 ;;
  aarch64|arm64) UBUNTU_ARCH=arm64 ;;
  *) echo 'Unsupported CPU architecture' >&2; exit 2 ;;
esac
if [[ "$UBUNTU_PRODUCT" != client ]]; then
  if ! command -v bwrap >/dev/null || ! bwrap --unshare-net --ro-bind / / -- /bin/true; then
    echo 'Restricted Runtime verification needs bubblewrap/AppArmor. Complete RUNBOOK.md section 5.1 first.' >&2
    exit 2
  fi
fi
cd "$UBUNTU_REPO"
mkdir -p .runtime-cache
exec 9>.runtime-cache/ubuntu-package.lock
flock -n 9 || { echo 'Another Ubuntu packaging run owns this checkout.' >&2; exit 2; }
export AGENT_DEPLOY_ROOT="${AGENT_DEPLOY_ROOT:-$HOME/agent-harness-deploy}"
mkdir -p "$AGENT_DEPLOY_ROOT"/{tools,downloads,logs}
UBUNTU_LOG="$AGENT_DEPLOY_ROOT/logs/ubuntu-package-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
exec > >(tee "$UBUNTU_LOG") 2>&1
UBUNTU_TEMP=''
trap 'if [[ -n "$UBUNTU_TEMP" ]]; then rm -rf -- "$UBUNTU_TEMP"; fi' EXIT
mapfile -t UBUNTU_NODE < <(python3 - "resources/runtime-locks/linux-$UBUNTU_ARCH.json" <<'PY'
import json, sys
entry = json.load(open(sys.argv[1]))['node']
for field in ['version', 'artifact', 'sha256']:
    print(entry[field])
for url in entry['urls']:
    print(url)
PY
)
UBUNTU_NODE_DIR="$AGENT_DEPLOY_ROOT/tools/node-v${UBUNTU_NODE[0]}-linux-$UBUNTU_ARCH"
if [[ ! -x "$UBUNTU_NODE_DIR/bin/node" ]]; then
  if [[ -e "$UBUNTU_NODE_DIR" ]]; then
    echo "Incomplete Node directory: $UBUNTU_NODE_DIR; inspect it before retrying." >&2; exit 2
  fi
  UBUNTU_ARCHIVE="$AGENT_DEPLOY_ROOT/downloads/${UBUNTU_NODE[1]}"
  if ! printf '%s  %s\n' "${UBUNTU_NODE[2]}" "$UBUNTU_ARCHIVE" | sha256sum --check --status; then
    UBUNTU_TEMP=$(mktemp -d "$AGENT_DEPLOY_ROOT/tools/.ubuntu-package.XXXXXX")
    UBUNTU_DOWNLOADED=0
    for url in "${UBUNTU_NODE[@]:3}"; do
      if curl --fail --location --connect-timeout 20 --max-time 600 --retry 2 -o "$UBUNTU_TEMP/node.tar.xz" "$url"; then
        printf '%s  %s\n' "${UBUNTU_NODE[2]}" "$UBUNTU_TEMP/node.tar.xz" | sha256sum --check -
        mv "$UBUNTU_TEMP/node.tar.xz" "$UBUNTU_ARCHIVE"
        UBUNTU_DOWNLOADED=1
        break
      fi
    done
    [[ "$UBUNTU_DOWNLOADED" = 1 ]] || { echo 'Node download failed' >&2; exit 1; }
    rm -rf -- "$UBUNTU_TEMP"
    UBUNTU_TEMP=''
  fi
  UBUNTU_TEMP=$(mktemp -d "$AGENT_DEPLOY_ROOT/tools/.ubuntu-package.XXXXXX")
  tar -xJf "$UBUNTU_ARCHIVE" -C "$UBUNTU_TEMP" --strip-components=1
  mv -T "$UBUNTU_TEMP" "$UBUNTU_NODE_DIR"
  UBUNTU_TEMP=''
fi
export PATH="$UBUNTU_NODE_DIR/bin:$PATH"
[[ "$(node --version)" = "v${UBUNTU_NODE[0]}" ]] || { echo 'Cached build Node does not match the lock' >&2; exit 2; }
[[ "$(node -p 'process.platform + "-" + process.arch')" = "linux-$UBUNTU_ARCH" ]] || exit 2
source deployment/ubuntu24.04/build-env.sh
if [[ "$UBUNTU_PRODUCT" = runtime ]]; then
  agent_use_local_node_headers "$UBUNTU_NODE_DIR"
  npm run install:runtime
  npm run typecheck:runtime
else
  npm ci --no-audit --no-fund
  ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -p 'process.versions.electron'
  npm run typecheck
fi
if [[ "$UBUNTU_PRODUCT" != client ]]; then
  node node_modules/vitest/vitest.mjs run --maxWorkers="${AGENT_TEST_WORKERS:-1}" \
    tests/unit/linux-platform.test.ts tests/unit/runtime-packaging.test.mjs \
    tests/unit/mcp-stdio-sandbox.test.ts tests/integration/mcp-progressive-runtime.test.ts \
    tests/integration/mcp-http-auth.test.ts \
    tests/unit/stage47-auth.test.ts tests/unit/stage47-lifecycle.test.ts \
    tests/unit/client-id.test.ts tests/unit/cli-accounts.test.ts tests/unit/mobile-transport.test.ts \
    tests/unit/stage47-electron-boundary.test.ts tests/unit/stage47-package.test.ts \
    tests/integration/stage47-gateway.test.ts tests/integration/session-file-upload.test.ts \
    tests/integration/sqlite-credentials.test.ts tests/integration/management-credentials.test.ts
  npm run pack:runtime -- --target "linux-$UBUNTU_ARCH" "${UBUNTU_FORCE[@]}"
  AGENT_TEST_RUNTIME_ROOT="$UBUNTU_REPO/.runtime-cache/linux-$UBUNTU_ARCH" \
    node node_modules/vitest/vitest.mjs run --maxWorkers="${AGENT_TEST_WORKERS:-1}" tests/integration/mcp-stdio-sandbox.test.ts
  UBUNTU_VERSION=$(node -p 'require("./build-support/server-package/package.json").version')
  UBUNTU_OUTPUT="$UBUNTU_REPO/release/runtime/linux-$UBUNTU_ARCH"
  UBUNTU_PACKAGE="agent-harness-runtime-linux-$UBUNTU_ARCH-$UBUNTU_VERSION.tgz"
  (cd "$UBUNTU_OUTPUT" && sha256sum -c "$UBUNTU_PACKAGE.sha256")
  UBUNTU_TEMP=$(mktemp -d "${TMPDIR:-/tmp}/agent-ubuntu-package.XXXXXX")
  tar -xzf "$UBUNTU_OUTPUT/$UBUNTU_PACKAGE" -C "$UBUNTU_TEMP" --strip-components=1
  AGENT_RUNTIME_EXECUTABLE="$UBUNTU_TEMP/bin/agent-harness" node scripts/verify-runtime-features.mjs
  rm -rf -- "$UBUNTU_TEMP"
  UBUNTU_TEMP=''
  echo "Runtime + Web: $UBUNTU_OUTPUT/$UBUNTU_PACKAGE"
fi
if [[ "$UBUNTU_PRODUCT" != runtime ]]; then
  npm run build:desktop
  node node_modules/electron-builder/cli.js --config deployment/ubuntu24.04/electron-builder.linux.json --linux --"$UBUNTU_ARCH" --publish never
  UBUNTU_DESKTOP="$UBUNTU_REPO/release/desktop-linux"
  UBUNTU_UNPACKED=linux-unpacked
  if [[ "$UBUNTU_ARCH" = arm64 ]]; then UBUNTU_UNPACKED=linux-arm64-unpacked; fi
  node scripts/verify-desktop-package.mjs "$UBUNTU_DESKTOP/$UBUNTU_UNPACKED/resources"
  UBUNTU_CLIENT_VERSION=$(node -p 'require("./package.json").version')
  UBUNTU_APPIMAGE_ARCH="$UBUNTU_ARCH"
  if [[ "$UBUNTU_ARCH" = x64 ]]; then UBUNTU_APPIMAGE_ARCH=x86_64; fi
  (cd "$UBUNTU_DESKTOP" && sha256sum \
    "agent-harness-client-$UBUNTU_CLIENT_VERSION-linux-$UBUNTU_APPIMAGE_ARCH.AppImage" \
    "agent-harness-client-$UBUNTU_CLIENT_VERSION-linux-$UBUNTU_ARCH.tar.gz" > desktop-SHA256SUMS)
  echo "Linux Desktop: $UBUNTU_DESKTOP (GUI verification: RUNBOOK.md section 9)"
fi
echo "UBUNTU_PACKAGE_OK ($UBUNTU_PRODUCT); log: $UBUNTU_LOG"
