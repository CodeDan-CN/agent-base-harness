#!/usr/bin/env bash
# Source can also be loaded by lifecycle tests without touching the host.
set -euo pipefail

deploy_fail() { echo "Deployment error: $*" >&2; exit 1; }

# Distribution adapters override these hooks while sharing backup/cutover logic.
deploy_platform() { echo ubuntu; }
deploy_host_plan() { echo 'Check Ubuntu/systemd/non-root user; install missing apt dependencies and bwrap policy if needed.'; }
deploy_check_archive() { :; }
deploy_prepare_release() { :; }
deploy_prepare_service() { :; }

deploy_usage() {
  cat <<'EOF'
Usage: bash deployment/ubuntu24.04/deploy.sh [--port PORT] [--data-dir PATH] [--skip-build] [--migrate-files] [--dry-run]
Deploy Runtime + Web on Ubuntu 24.04+ as the current non-root sudo user.
Default: 0.0.0.0:4317, agent-harness-web.service.
AGENT_DEPLOY_ROOT defaults to $HOME/agent-harness-deploy.
Installs prerequisites, builds/verifies, backs up stopped data, installs and enables systemd.
Does not upload source or change firewall/cloud security-group rules.
--data-dir preserves an existing directory inside AGENT_DEPLOY_ROOT/data.
--skip-build uses the current version's already verified package (checksum still checked).
--migrate-files explicitly migrates legacy encrypted credentials after the stopped backup.
EOF
}

deploy_check_host() {
  [[ "$(uname -s)" = Linux ]] || deploy_fail 'Run on Ubuntu; --dry-run is available elsewhere.'
  [[ "$(id -u)" != 0 ]] || deploy_fail 'Run as an ordinary sudo user, without sudo before this script.'
  [[ -d /run/systemd/system ]] || deploy_fail 'A running systemd host is required.'
  (
    . /etc/os-release
    [[ "$ID" = ubuntu && "$VERSION_ID" =~ ^[0-9]+\.[0-9]+$ ]] || exit 1
    [[ "${VERSION_ID%%.*}" -gt 24 || ( "${VERSION_ID%%.*}" -eq 24 && "${VERSION_ID##*.}" -ge 4 ) ]]
  ) || deploy_fail 'Ubuntu 24.04 or newer is required.'
  command -v sudo >/dev/null || deploy_fail 'Install/configure sudo for this user first.'
}

deploy_systemd_dir() { echo /etc/systemd/system; }

deploy_sudo_ready() {
  # sudo -v may request a password even when commands are allowed with NOPASSWD.
  if ! sudo -n true 2>/dev/null; then sudo -v; fi
}

deploy_prepare_host() {
  deploy_sudo_ready
  local dependency installed
  local missing=()
  for dependency in build-essential python3 python3-dev ca-certificates curl git tar xz-utils \
    file binutils util-linux bubblewrap apparmor apparmor-utils ripgrep; do
    installed=$(dpkg-query -W -f='${db:Status-Status}' "$dependency" 2>/dev/null || true)
    [[ "$installed" = installed ]] || missing+=("$dependency")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    sudo apt-get update
    sudo apt-get install -y "${missing[@]}"
  fi
  if ! bwrap --unshare-net --ro-bind / / -- /bin/true; then
    local policy=/etc/apparmor.d/agent-harness-bwrap matches
    # Do not replace a machine's independently managed policy.
    matches=$(sudo rg -l 'profile[[:space:]]+(bwrap|unpriv_bwrap)|/usr/bin/bwrap' \
      /etc/apparmor.d --glob '!agent-harness-bwrap' || [[ $? = 1 ]])
    [[ -z "$matches" ]] || deploy_fail "Existing bwrap policy needs administrator review: $matches"
    if [[ -e "$policy" ]] && ! cmp -s "$DEPLOY_REPO/deployment/ubuntu24.04/bwrap-userns-restrict.apparmor" "$policy"; then
      deploy_fail "Locally modified AppArmor policy: $policy"
    fi
    sudo apparmor_parser -Q "$DEPLOY_REPO/deployment/ubuntu24.04/bwrap-userns-restrict.apparmor"
    sudo install -m 0644 "$DEPLOY_REPO/deployment/ubuntu24.04/bwrap-userns-restrict.apparmor" "$policy"
    sudo apparmor_parser -r "$policy"
    bwrap --unshare-net --ro-bind / / -- /bin/true || deploy_fail 'bubblewrap still cannot start.'
  fi
}

deploy_lock() {
  exec 9>"$AGENT_DEPLOY_ROOT/.deploy.lock"
  flock -n 9 || deploy_fail 'Another deployment is using this directory.'
}

deploy_check_service() {
  local fragment dropins
  # A not-yet-installed unit can make systemctl show return a nonzero status.
  fragment=$(systemctl show "$DEPLOY_SERVICE" -p FragmentPath --value 2>/dev/null || true)
  dropins=$(systemctl show "$DEPLOY_SERVICE" -p DropInPaths --value 2>/dev/null || true)
  [[ -z "$dropins" ]] || deploy_fail 'Existing systemd overrides need administrator review.'
  [[ -z "$fragment" || "$fragment" = "$DEPLOY_UNIT" ]] || deploy_fail "Service is owned elsewhere: $fragment"
  [[ ! -L "$DEPLOY_UNIT" ]] || deploy_fail "Refusing symlink/masked unit: $DEPLOY_UNIT"
  if [[ -f "$DEPLOY_UNIT" ]]; then
    grep -Fxq "# Managed by agent-harness $DEPLOY_PLATFORM deploy.sh" "$DEPLOY_UNIT" &&
      grep -Fxq "# Deployment root: $AGENT_DEPLOY_ROOT" "$DEPLOY_UNIT" &&
      grep -Fxq "User=$DEPLOY_USER" "$DEPLOY_UNIT" &&
      grep -Fq -- "--data-dir $DEPLOY_DATA --host " "$DEPLOY_UNIT" ||
      deploy_fail "Refusing to overwrite an unmanaged/different user's service: $DEPLOY_UNIT"
    DEPLOY_EXISTING=1
  fi
  if [[ -L "$AGENT_DEPLOY_ROOT/current" ]]; then
    local previous
    previous=$(readlink -f "$AGENT_DEPLOY_ROOT/current")
    [[ -d "$previous" && "$previous" = "$AGENT_DEPLOY_ROOT/releases/"* ]] ||
      deploy_fail 'current must point to an existing release inside this deployment.'
  elif [[ -e "$AGENT_DEPLOY_ROOT/current" ]]; then
    deploy_fail 'current exists and is not a release symlink.'
  fi
  [[ "$DEPLOY_EXISTING" = 0 || -L "$AGENT_DEPLOY_ROOT/current" ]] ||
    deploy_fail 'Existing service has no current release; inspect it before deploying.'
}

deploy_build() { bash "$DEPLOY_REPO/deployment/ubuntu24.04/package.sh"; }

deploy_render_unit() {
  cat <<EOF
# Managed by agent-harness $DEPLOY_PLATFORM deploy.sh
# Deployment root: $AGENT_DEPLOY_ROOT
[Unit]
Description=Agent Harness Runtime and Web
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$DEPLOY_USER
WorkingDirectory=$AGENT_DEPLOY_ROOT
UMask=0077
Environment=SHELL=/bin/bash
ExecStart=$AGENT_DEPLOY_ROOT/current/bin/agent-harness serve --data-dir $DEPLOY_DATA --host 0.0.0.0 --port $DEPLOY_PORT
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF
}

deploy_assert_idle() {
  python3 - "$DEPLOY_DATA/server/instance.lock" "$DEPLOY_PORT" <<'PY'
import json, os, socket, sys
if os.path.exists(sys.argv[1]):
    with open(sys.argv[1]) as source:
        pid = json.load(source)['pid']
    if not isinstance(pid, int) or pid <= 0:
        raise SystemExit('Invalid Runtime lock; inspect before deployment.')
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        pass
    else:
        raise SystemExit('Runtime data is still in use; no backup or service switch performed.')
with socket.socket() as listener:
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('0.0.0.0', int(sys.argv[2])))
PY
}

deploy_health_once() {
  local pid
  pid=$(systemctl show "$DEPLOY_SERVICE" -p MainPID --value)
  python3 - "$DEPLOY_DATA" "$DEPLOY_PORT" "$pid" <<'PY'
import json, os, sys, urllib.request
try:
    with open(os.path.join(sys.argv[1], 'server', 'discovery.json')) as source:
        discovery = json.load(source)
    assert discovery['pid'] == int(sys.argv[3]) > 0
    assert os.path.realpath(discovery['dataDir']) == os.path.realpath(sys.argv[1])
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base = 'http://127.0.0.1:' + sys.argv[2]
    with opener.open(base + '/healthz', timeout=2) as response:
        health = json.load(response)
    assert health['status'] == 'ready' and health['instanceId'] == discovery['instanceId']
    with opener.open(base + '/', timeout=2) as response:
        assert response.status == 200 and 'text/html' in response.headers.get('Content-Type', '')
except Exception:
    sys.exit(1)
PY
}

deploy_wait_ready() {
  local attempt
  for attempt in {1..30}; do
    if systemctl is-active --quiet "$DEPLOY_SERVICE" && deploy_health_once; then return 0; fi
    sleep 2
  done
  deploy_fail 'Runtime/Web health check failed; inspect the systemd journal.'
}

deploy_cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$status" != 0 ]]; then
    echo "Deployment failed (exit $status). Log: ${DEPLOY_LOG:-not started}" >&2
    if [[ "$DEPLOY_CUTOVER" = 1 ]]; then
      sudo systemctl stop "$DEPLOY_SERVICE" || true
      sudo systemctl disable "$DEPLOY_SERVICE" || true
      echo 'Service left stopped/disabled. No automatic database rollback was attempted.' >&2
      echo "Backup (if completed): ${DEPLOY_BACKUP:-none}; releases and current data are preserved." >&2
      echo "Inspect: sudo journalctl -u $DEPLOY_SERVICE -n 100 --no-pager" >&2
    fi
  fi
  exit "$status"
}

deploy_main() {
  DEPLOY_PORT=4317
  DEPLOY_DRY_RUN=0
  DEPLOY_SKIP_BUILD=0
  DEPLOY_MIGRATE_FILES=0
  DEPLOY_DATA_OPTION=''
  DEPLOY_EXISTING=0
  DEPLOY_CUTOVER=0
  DEPLOY_BACKUP=''
  DEPLOY_SERVICE=agent-harness-web.service
  DEPLOY_PLATFORM=$(deploy_platform)
  DEPLOY_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  export AGENT_DEPLOY_ROOT="${AGENT_DEPLOY_ROOT:-$HOME/agent-harness-deploy}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) [[ $# -ge 2 ]] || deploy_fail '--port requires a value'; DEPLOY_PORT=$2; shift 2 ;;
      --data-dir) [[ $# -ge 2 ]] || deploy_fail '--data-dir requires a value'; DEPLOY_DATA_OPTION=$2; shift 2 ;;
      --skip-build) DEPLOY_SKIP_BUILD=1; shift ;;
      --migrate-files) DEPLOY_MIGRATE_FILES=1; shift ;;
      --dry-run) DEPLOY_DRY_RUN=1; shift ;;
      --help|-h) deploy_usage; return ;;
      *) deploy_fail "Unknown option: $1" ;;
    esac
  done
  [[ "$DEPLOY_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && [[ "$DEPLOY_PORT" -ge 1024 && "$DEPLOY_PORT" -le 65535 ]] ||
    deploy_fail 'Port must be an integer from 1024 to 65535 (non-root service).'
  # Keep generated systemd arguments literal: no whitespace, specifiers or environment expansion.
  [[ "$AGENT_DEPLOY_ROOT" =~ ^/[a-zA-Z0-9_./-]+$ && "$AGENT_DEPLOY_ROOT" != / ]] ||
    deploy_fail 'AGENT_DEPLOY_ROOT must be an absolute path using letters, digits, _, -, . and /.'
  [[ -z "$DEPLOY_DATA_OPTION" || "$DEPLOY_DATA_OPTION" =~ ^/[a-zA-Z0-9_./-]+$ ]] ||
    deploy_fail 'Data directory must be an absolute path without spaces or systemd special characters.'
  if [[ "$DEPLOY_DRY_RUN" = 1 ]]; then
    echo "Deploy Runtime + Web: 0.0.0.0:$DEPLOY_PORT; $DEPLOY_SERVICE; $AGENT_DEPLOY_ROOT"
    echo "1. $(deploy_host_plan)"
    echo '2. Lock deployment and check service ownership; run package.sh (Runtime + Web only).'
    echo '3. Verify archive checksum; extract a new release and validate systemd unit.'
    echo '4. Stop managed service; back up data, old unit and current symlink.'
    echo '5. Switch release, start service, verify instance + Web, enable on boot.'
    echo 'Failure during cutover leaves service stopped/disabled, preserving data and backups.'
    echo 'No changes made; firewall and cloud security groups are managed separately.'
    echo "Options: skip-build=$DEPLOY_SKIP_BUILD; migrate-files=$DEPLOY_MIGRATE_FILES; data=${DEPLOY_DATA_OPTION:-default}"
    return
  fi
  deploy_check_host
  DEPLOY_USER=$(id -un)
  [[ "$DEPLOY_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || deploy_fail 'Unsupported service user name.'
  deploy_prepare_host
  umask 077
  mkdir -p "$AGENT_DEPLOY_ROOT"
  AGENT_DEPLOY_ROOT=$(cd "$AGENT_DEPLOY_ROOT" && pwd -P)
  [[ "$AGENT_DEPLOY_ROOT" =~ ^/[a-zA-Z0-9_./-]+$ && "$AGENT_DEPLOY_ROOT" != / ]] || deploy_fail 'Unsupported canonical deployment path.'
  deploy_lock
  local directory
  for directory in releases data backups logs; do
    [[ ! -L "$AGENT_DEPLOY_ROOT/$directory" ]] || deploy_fail "Refusing symlink directory: $directory"
    mkdir -p "$AGENT_DEPLOY_ROOT/$directory"
  done
  DEPLOY_DATA="${DEPLOY_DATA_OPTION:-$AGENT_DEPLOY_ROOT/data/runtime}"
  [[ ! -L "$DEPLOY_DATA" ]] || deploy_fail 'Runtime data directory must not be a symlink.'
  DEPLOY_DATA=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$DEPLOY_DATA")
  [[ "$DEPLOY_DATA" =~ ^/[a-zA-Z0-9_./-]+$ && "$DEPLOY_DATA" = "$AGENT_DEPLOY_ROOT/data/"* ]] ||
    deploy_fail 'Data directory must be inside this deployment root/data, without systemd special characters.'
  DEPLOY_UNIT="$(deploy_systemd_dir)/$DEPLOY_SERVICE"
  DEPLOY_RUN="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  DEPLOY_LOG="$AGENT_DEPLOY_ROOT/logs/deploy-$DEPLOY_RUN.log"
  exec > >(tee "$DEPLOY_LOG") 2>&1
  trap deploy_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  deploy_check_service
  if [[ "$DEPLOY_SKIP_BUILD" = 0 ]]; then deploy_build; fi
  local arch version archive output release unit_candidate
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) deploy_fail 'Unsupported CPU architecture' ;;
  esac
  version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$DEPLOY_REPO/build-support/server-package/package.json")
  [[ "$version" =~ ^[a-zA-Z0-9._+-]+$ ]] || deploy_fail 'Invalid package version.'
  archive="agent-harness-runtime-linux-$arch-$version.tgz"
  output="$DEPLOY_REPO/release/runtime/linux-$arch"
  deploy_check_archive "$output" "$archive"
  (cd "$output" && sha256sum -c "$archive.sha256")
  release="$AGENT_DEPLOY_ROOT/releases/$version-$DEPLOY_RUN"
  mkdir "$release"
  tar -xzf "$output/$archive" -C "$release" --strip-components=1
  deploy_prepare_release "$release"
  "$release/bin/agent-harness" --help >/dev/null
  [[ -f "$release/service/dist/web/index.html" ]] || deploy_fail 'Package is missing Web assets.'
  unit_candidate="$release/$DEPLOY_SERVICE"
  deploy_render_unit > "$unit_candidate"
  # ExecStart uses the stable symlink, which may not exist on first install yet.
  sed "s|$AGENT_DEPLOY_ROOT/current/bin/agent-harness|$release/bin/agent-harness|" \
    "$unit_candidate" > "$release/verify.service"
  systemd-analyze verify "$release/verify.service"
  rm "$release/verify.service"
  deploy_sudo_ready
  DEPLOY_CUTOVER=1
  if [[ "$DEPLOY_EXISTING" = 1 ]]; then sudo systemctl stop "$DEPLOY_SERVICE"; fi
  deploy_assert_idle
  DEPLOY_BACKUP="$AGENT_DEPLOY_ROOT/backups/$DEPLOY_RUN"
  mkdir "$DEPLOY_BACKUP"
  [[ ! -f "$DEPLOY_UNIT" ]] || cp "$DEPLOY_UNIT" "$DEPLOY_BACKUP/$DEPLOY_SERVICE"
  [[ ! -L "$AGENT_DEPLOY_ROOT/current" ]] || readlink "$AGENT_DEPLOY_ROOT/current" > "$DEPLOY_BACKUP/previous-release.txt"
  if [[ -d "$DEPLOY_DATA" ]]; then
    tar -czf "$DEPLOY_BACKUP/data.tar.gz.partial" -C "$DEPLOY_DATA" .
    mv "$DEPLOY_BACKUP/data.tar.gz.partial" "$DEPLOY_BACKUP/data.tar.gz"
  fi
  touch "$DEPLOY_BACKUP/COMPLETE"
  install -d -m 0700 "$DEPLOY_DATA"
  if [[ "$DEPLOY_MIGRATE_FILES" = 1 ]]; then
    "$release/bin/agent-harness" credentials migrate-files --data-dir "$DEPLOY_DATA"
  fi
  ln -s "$release" "$AGENT_DEPLOY_ROOT/.current-$DEPLOY_RUN"
  mv -Tf "$AGENT_DEPLOY_ROOT/.current-$DEPLOY_RUN" "$AGENT_DEPLOY_ROOT/current"
  sudo install -m 0644 "$unit_candidate" "$DEPLOY_UNIT"
  deploy_prepare_service
  sudo systemctl daemon-reload
  sudo systemctl start "$DEPLOY_SERVICE"
  deploy_wait_ready
  sudo systemctl enable "$DEPLOY_SERVICE"
  DEPLOY_CUTOVER=0
  echo "DEPLOY_OK: http://<server-ip>:$DEPLOY_PORT/ (listening on 0.0.0.0)"
  echo "Data: $DEPLOY_DATA; backup: $DEPLOY_BACKUP; log: $DEPLOY_LOG"
  echo "Status: sudo systemctl status $DEPLOY_SERVICE --no-pager"
  echo 'Allow the selected TCP port in your firewall/cloud security group for intended clients.'
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then deploy_main "$@"; fi
