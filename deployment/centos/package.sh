#!/usr/bin/env bash
# Build Runtime + Web on the target CentOS machine, including native SQLite.
set -euo pipefail
CENTOS_DRY_RUN=0
CENTOS_FORCE=()
for argument in "$@"; do
  case "$argument" in
    --runtime) ;;
    --force) CENTOS_FORCE=(--force) ;;
    --dry-run) CENTOS_DRY_RUN=1 ;;
    --help|-h)
      echo 'Usage: bash deployment/centos/package.sh [--force] [--dry-run]'
      echo 'Runtime + Web only. Run deploy.sh first to provision CentOS Stream 9/10 dependencies.'
      exit 0 ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done
CENTOS_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ "$CENTOS_DRY_RUN" = 1 ]]; then
  echo 'CentOS Stream 9/10 packaging plan (Runtime + Web):'
  echo '1. Check host, GCC and bubblewrap; bootstrap SHA-256-locked Node.'
  echo '2. npm run install:runtime, typecheck:runtime, Runtime/account/client regressions; compile native SQLite locally.'
  echo '3. Build linux-<arch> archive; test real sandbox and extracted Runtime features.'
  echo '4. Write CentOS provenance after verification; no service switch.'
  exit 0
fi
source "$CENTOS_REPO/deployment/centos/host.sh"
centos_check_system
centos_enable_toolchain
for command in python3 curl tar xz file make gcc g++ sha256sum flock; do
  command -v "$command" >/dev/null || centos_fail "Missing $command; run deployment/centos/deploy.sh to prepare dependencies."
done
centos_check_sandbox
case "$(uname -m)" in
  x86_64) CENTOS_ARCH=x64 ;;
  aarch64|arm64) CENTOS_ARCH=arm64 ;;
esac
cd "$CENTOS_REPO"
mkdir -p .runtime-cache
# Use the existing Linux build lock to serialize shared cache/output writers.
exec 9>.runtime-cache/ubuntu-package.lock
flock -n 9 || centos_fail 'Another Linux packaging run owns this checkout.'
export AGENT_DEPLOY_ROOT="${AGENT_DEPLOY_ROOT:-/opt/agent-harness}"
mkdir -p "$AGENT_DEPLOY_ROOT"/{tools,downloads,logs}
CENTOS_LOG="$AGENT_DEPLOY_ROOT/logs/centos-package-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
exec > >(tee "$CENTOS_LOG") 2>&1
CENTOS_TEMP=''
trap 'if [[ -n "$CENTOS_TEMP" ]]; then rm -rf -- "$CENTOS_TEMP"; fi' EXIT
mapfile -t CENTOS_NODE < <(python3 - "resources/runtime-locks/linux-$CENTOS_ARCH.json" <<'PY'
import json, sys
entry = json.load(open(sys.argv[1]))['node']
for field in ['version', 'artifact', 'sha256']:
    print(entry[field])
for url in entry['urls']:
    print(url)
PY
)
CENTOS_NODE_DIR="$AGENT_DEPLOY_ROOT/tools/node-v${CENTOS_NODE[0]}-linux-$CENTOS_ARCH"
if [[ ! -x "$CENTOS_NODE_DIR/bin/node" ]]; then
  if [[ -e "$CENTOS_NODE_DIR" ]]; then
    echo "Incomplete Node directory: $CENTOS_NODE_DIR; inspect it before retrying." >&2; exit 2
  fi
  CENTOS_ARCHIVE="$AGENT_DEPLOY_ROOT/downloads/${CENTOS_NODE[1]}"
  if ! printf '%s  %s\n' "${CENTOS_NODE[2]}" "$CENTOS_ARCHIVE" | sha256sum --check --status; then
    CENTOS_TEMP=$(mktemp -d "$AGENT_DEPLOY_ROOT/tools/.centos-package.XXXXXX")
    CENTOS_DOWNLOADED=0
    for url in "${CENTOS_NODE[@]:3}"; do
      if curl --fail --location --connect-timeout 20 --max-time 600 --retry 2 -o "$CENTOS_TEMP/node.tar.xz" "$url"; then
        printf '%s  %s\n' "${CENTOS_NODE[2]}" "$CENTOS_TEMP/node.tar.xz" | sha256sum --check -
        mv "$CENTOS_TEMP/node.tar.xz" "$CENTOS_ARCHIVE"
        CENTOS_DOWNLOADED=1
        break
      fi
    done
    [[ "$CENTOS_DOWNLOADED" = 1 ]] || { echo 'Node download failed' >&2; exit 1; }
    rm -rf -- "$CENTOS_TEMP"
    CENTOS_TEMP=''
  fi
  CENTOS_TEMP=$(mktemp -d "$AGENT_DEPLOY_ROOT/tools/.centos-package.XXXXXX")
  tar -xJf "$CENTOS_ARCHIVE" -C "$CENTOS_TEMP" --strip-components=1
  mv -T "$CENTOS_TEMP" "$CENTOS_NODE_DIR"
  CENTOS_TEMP=''
fi
export PATH="$CENTOS_NODE_DIR/bin:$PATH"
[[ "$(node --version)" = "v${CENTOS_NODE[0]}" ]] || { echo 'Cached build Node does not match the lock' >&2; exit 2; }
[[ "$(node -p 'process.platform + "-" + process.arch')" = "linux-$CENTOS_ARCH" ]] || exit 2
# Shared process-local mirror/cache settings; this does not provision Ubuntu.
source deployment/ubuntu24.04/build-env.sh
agent_use_local_node_headers "$CENTOS_NODE_DIR"
npm run install:runtime
npm run typecheck:runtime
node node_modules/vitest/vitest.mjs run --maxWorkers="${AGENT_TEST_WORKERS:-1}" \
  tests/unit/linux-platform.test.ts tests/unit/runtime-packaging.test.mjs \
  tests/unit/mcp-stdio-sandbox.test.ts tests/integration/mcp-progressive-runtime.test.ts \
  tests/integration/mcp-http-auth.test.ts \
  tests/unit/stage47-auth.test.ts tests/unit/stage47-lifecycle.test.ts \
  tests/unit/client-id.test.ts tests/unit/cli-accounts.test.ts tests/unit/mobile-transport.test.ts \
  tests/unit/stage47-electron-boundary.test.ts tests/unit/stage47-package.test.ts \
  tests/integration/stage47-gateway.test.ts tests/integration/session-file-upload.test.ts \
  tests/integration/sqlite-credentials.test.ts tests/integration/management-credentials.test.ts
npm run pack:runtime -- --target "linux-$CENTOS_ARCH" "${CENTOS_FORCE[@]}"
AGENT_TEST_RUNTIME_ROOT="$CENTOS_REPO/.runtime-cache/linux-$CENTOS_ARCH" \
  node node_modules/vitest/vitest.mjs run --maxWorkers="${AGENT_TEST_WORKERS:-1}" tests/integration/mcp-stdio-sandbox.test.ts
CENTOS_VERSION=$(node -p 'require("./build-support/server-package/package.json").version')
CENTOS_OUTPUT="$CENTOS_REPO/release/runtime/linux-$CENTOS_ARCH"
CENTOS_PACKAGE="agent-harness-runtime-linux-$CENTOS_ARCH-$CENTOS_VERSION.tgz"
(cd "$CENTOS_OUTPUT" && sha256sum -c "$CENTOS_PACKAGE.sha256")
CENTOS_TEMP=$(mktemp -d "${TMPDIR:-/tmp}/agent-centos-package.XXXXXX")
tar -xzf "$CENTOS_OUTPUT/$CENTOS_PACKAGE" -C "$CENTOS_TEMP" --strip-components=1
env -u LD_LIBRARY_PATH -u LIBRARY_PATH -u LD_PRELOAD \
  AGENT_RUNTIME_EXECUTABLE="$CENTOS_TEMP/bin/agent-harness" \
  "$CENTOS_NODE_DIR/bin/node" scripts/verify-runtime-features.mjs
rm -rf -- "$CENTOS_TEMP"
CENTOS_TEMP=''
echo "Runtime + Web: $CENTOS_OUTPUT/$CENTOS_PACKAGE"
python3 deployment/centos/package-provenance.py write "$CENTOS_OUTPUT/$CENTOS_PACKAGE"
echo "CENTOS_PACKAGE_OK (Runtime + Web); log: $CENTOS_LOG"
