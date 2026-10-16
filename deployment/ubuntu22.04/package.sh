#!/usr/bin/env bash
# Build Runtime + Web on the target Ubuntu 22.04 machine, including native SQLite.
set -euo pipefail
UBUNTU22_DRY_RUN=0
UBUNTU22_FORCE=()
for argument in "$@"; do
  case "$argument" in
    --runtime) ;;
    --force) UBUNTU22_FORCE=(--force) ;;
    --dry-run) UBUNTU22_DRY_RUN=1 ;;
    --help|-h)
      echo 'Usage: bash deployment/ubuntu22.04/package.sh [--force] [--dry-run]'
      echo 'Runtime + Web only. Run deploy.sh first to provision Ubuntu 22.04 dependencies.'
      exit 0 ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done
UBUNTU22_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ "$UBUNTU22_DRY_RUN" = 1 ]]; then
  echo 'Ubuntu 22.04 packaging plan (Runtime + Web):'
  echo '1. Check host, GCC and bubblewrap; bootstrap SHA-256-locked Node.'
  echo '2. npm run install:runtime, typecheck:runtime, Runtime/account/client regressions; compile native SQLite locally.'
  echo '3. Build linux-<arch> archive; test real sandbox and extracted Runtime features.'
  echo '4. Write Ubuntu 22.04 provenance after verification; no service switch.'
  exit 0
fi
source "$UBUNTU22_REPO/deployment/ubuntu22.04/host.sh"
ubuntu22_check_system
ubuntu22_check_workspace "$UBUNTU22_REPO"
ubuntu22_enable_toolchain
for command in python3 curl tar xz file make gcc g++ sha256sum flock; do
  command -v "$command" >/dev/null || ubuntu22_fail "Missing $command; run deployment/ubuntu22.04/deploy.sh to prepare dependencies."
done
ubuntu22_check_sandbox
case "$(uname -m)" in
  x86_64) UBUNTU22_ARCH=x64 ;;
  aarch64|arm64) UBUNTU22_ARCH=arm64 ;;
esac
cd "$UBUNTU22_REPO"
mkdir -p .runtime-cache
# Use the existing Linux build lock to serialize shared cache/output writers.
exec 9>.runtime-cache/ubuntu-package.lock
flock -n 9 || ubuntu22_fail 'Another Linux packaging run owns this checkout.'
export AGENT_DEPLOY_ROOT="${AGENT_DEPLOY_ROOT:-$HOME/agent-harness-deploy}"
mkdir -p "$AGENT_DEPLOY_ROOT"/{tools,downloads,logs}
UBUNTU22_LOG="$AGENT_DEPLOY_ROOT/logs/ubuntu22-package-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
exec > >(tee "$UBUNTU22_LOG") 2>&1
UBUNTU22_TEMP=''
trap 'if [[ -n "$UBUNTU22_TEMP" ]]; then rm -rf -- "$UBUNTU22_TEMP"; fi' EXIT
mapfile -t UBUNTU22_NODE < <(python3 - "resources/runtime-locks/linux-$UBUNTU22_ARCH.json" <<'PY'
import json, sys
entry = json.load(open(sys.argv[1]))['node']
for field in ['version', 'artifact', 'sha256']:
    print(entry[field])
for url in entry['urls']:
    print(url)
PY
)
UBUNTU22_NODE_DIR="$AGENT_DEPLOY_ROOT/tools/node-v${UBUNTU22_NODE[0]}-linux-$UBUNTU22_ARCH"
if [[ ! -x "$UBUNTU22_NODE_DIR/bin/node" ]]; then
  if [[ -e "$UBUNTU22_NODE_DIR" ]]; then
    echo "Incomplete Node directory: $UBUNTU22_NODE_DIR; inspect it before retrying." >&2; exit 2
  fi
  UBUNTU22_ARCHIVE="$AGENT_DEPLOY_ROOT/downloads/${UBUNTU22_NODE[1]}"
  if ! printf '%s  %s\n' "${UBUNTU22_NODE[2]}" "$UBUNTU22_ARCHIVE" | sha256sum --check --status; then
    UBUNTU22_TEMP=$(mktemp -d "$AGENT_DEPLOY_ROOT/tools/.ubuntu22-package.XXXXXX")
    UBUNTU22_DOWNLOADED=0
    for url in "${UBUNTU22_NODE[@]:3}"; do
      if curl --fail --location --connect-timeout 20 --max-time 600 --retry 2 -o "$UBUNTU22_TEMP/node.tar.xz" "$url"; then
        printf '%s  %s\n' "${UBUNTU22_NODE[2]}" "$UBUNTU22_TEMP/node.tar.xz" | sha256sum --check -
        mv "$UBUNTU22_TEMP/node.tar.xz" "$UBUNTU22_ARCHIVE"
        UBUNTU22_DOWNLOADED=1
        break
      fi
    done
    [[ "$UBUNTU22_DOWNLOADED" = 1 ]] || { echo 'Node download failed' >&2; exit 1; }
    rm -rf -- "$UBUNTU22_TEMP"
    UBUNTU22_TEMP=''
  fi
  UBUNTU22_TEMP=$(mktemp -d "$AGENT_DEPLOY_ROOT/tools/.ubuntu22-package.XXXXXX")
  tar -xJf "$UBUNTU22_ARCHIVE" -C "$UBUNTU22_TEMP" --strip-components=1
  mv -T "$UBUNTU22_TEMP" "$UBUNTU22_NODE_DIR"
  UBUNTU22_TEMP=''
fi
export PATH="$UBUNTU22_NODE_DIR/bin:$PATH"
[[ "$(node --version)" = "v${UBUNTU22_NODE[0]}" ]] || { echo 'Cached build Node does not match the lock' >&2; exit 2; }
[[ "$(node -p 'process.platform + "-" + process.arch')" = "linux-$UBUNTU22_ARCH" ]] || exit 2
# Shared process-local mirror/cache settings; host provisioning is handled by host.sh.
source deployment/ubuntu24.04/build-env.sh
agent_use_local_node_headers "$UBUNTU22_NODE_DIR"
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
npm run pack:runtime -- --target "linux-$UBUNTU22_ARCH" "${UBUNTU22_FORCE[@]}"
AGENT_TEST_RUNTIME_ROOT="$UBUNTU22_REPO/.runtime-cache/linux-$UBUNTU22_ARCH" \
  node node_modules/vitest/vitest.mjs run --maxWorkers="${AGENT_TEST_WORKERS:-1}" tests/integration/mcp-stdio-sandbox.test.ts
UBUNTU22_VERSION=$(node -p 'require("./build-support/server-package/package.json").version')
UBUNTU22_OUTPUT="$UBUNTU22_REPO/release/runtime/linux-$UBUNTU22_ARCH"
UBUNTU22_PACKAGE="agent-harness-runtime-linux-$UBUNTU22_ARCH-$UBUNTU22_VERSION.tgz"
(cd "$UBUNTU22_OUTPUT" && sha256sum -c "$UBUNTU22_PACKAGE.sha256")
UBUNTU22_TEMP=$(mktemp -d "${TMPDIR:-/tmp}/agent-ubuntu22-package.XXXXXX")
tar -xzf "$UBUNTU22_OUTPUT/$UBUNTU22_PACKAGE" -C "$UBUNTU22_TEMP" --strip-components=1
env -u LD_LIBRARY_PATH -u LIBRARY_PATH -u LD_PRELOAD \
  AGENT_RUNTIME_EXECUTABLE="$UBUNTU22_TEMP/bin/agent-harness" \
  "$UBUNTU22_NODE_DIR/bin/node" scripts/verify-runtime-features.mjs
rm -rf -- "$UBUNTU22_TEMP"
UBUNTU22_TEMP=''
echo "Runtime + Web: $UBUNTU22_OUTPUT/$UBUNTU22_PACKAGE"
python3 deployment/ubuntu22.04/package-provenance.py write "$UBUNTU22_OUTPUT/$UBUNTU22_PACKAGE"
echo "UBUNTU22_PACKAGE_OK (Runtime + Web); log: $UBUNTU22_LOG"
