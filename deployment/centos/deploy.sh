#!/usr/bin/env bash
set -euo pipefail

# Reuse the tested lifecycle without running Ubuntu's host provisioning.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../ubuntu24.04" && pwd)/deploy.sh"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host.sh"

deploy_platform() { echo centos; }
deploy_host_plan() { echo 'Check CentOS Stream 9/10, glibc and systemd; install dnf dependencies/GCC Toolset; verify bubblewrap without disabling SELinux.'; }

deploy_usage() {
  cat <<'EOF'
Usage: bash deployment/centos/deploy.sh [--port PORT] [--data-dir PATH] [--skip-build] [--migrate-files] [--dry-run]
CentOS Stream 9/10, x86_64/aarch64; run as an ordinary sudo user.
Default: 0.0.0.0:4317, agent-harness-web.service, /opt/agent-harness/data/runtime.
AGENT_DEPLOY_ROOT may select /opt/<name> (letters, digits, underscores and hyphens).
Installs dependencies, builds/verifies Runtime + Web locally, backs up data and enables systemd.
Preserves SELinux; adds scoped persistent file labels and validates systemd execution before cutover.
--skip-build requires a package + matching CentOS build provenance from this host family/version/architecture.
--migrate-files explicitly migrates legacy credentials after backing up the stopped data.
Does not modify firewall rules, repositories, system glibc or unrelated services.
EOF
}

deploy_check_host() {
  centos_check_system
  [[ -d /run/systemd/system ]] || deploy_fail 'A running systemd host is required.'
  command -v sudo >/dev/null || deploy_fail 'Configure sudo for this user first.'
  command -v dnf >/dev/null || deploy_fail 'dnf and working BaseOS/AppStream repositories are required.'
  [[ "$AGENT_DEPLOY_ROOT" =~ ^/opt/[a-zA-Z0-9_-]+$ ]] ||
    deploy_fail 'For CentOS use /opt/<name> as AGENT_DEPLOY_ROOT; home-directory SELinux labels are unsuitable for this service.'
  [[ ! -L "$AGENT_DEPLOY_ROOT" ]] || deploy_fail 'Deployment root must not be a symlink.'
  [[ ! -e "$AGENT_DEPLOY_ROOT" || ( -d "$AGENT_DEPLOY_ROOT" && -O "$AGENT_DEPLOY_ROOT" ) ]] ||
    deploy_fail 'Existing deployment root must be a directory owned by the deploying user.'
}

deploy_prepare_host() {
  deploy_sudo_ready
  centos_install_dependencies
  if [[ ! -e "$AGENT_DEPLOY_ROOT" ]]; then
    sudo install -d -m 0755 -o "$(id -u)" -g "$(id -g)" "$AGENT_DEPLOY_ROOT"
  fi
  if selinuxenabled; then sudo restorecon "$AGENT_DEPLOY_ROOT"; fi
}

deploy_build() { bash "$DEPLOY_REPO/deployment/centos/package.sh"; }

deploy_check_archive() {
  python3 "$DEPLOY_REPO/deployment/centos/package-provenance.py" check "$1/$2"
}

deploy_prepare_release() {
  local release=$1
  if selinuxenabled; then
    centos_label_path "$AGENT_DEPLOY_ROOT/releases(/.*)?" "$release/bin/agent-harness" bin_t
    centos_label_path "$AGENT_DEPLOY_ROOT/data(/.*)?" "$DEPLOY_DATA/database/app.db" var_lib_t
    sudo restorecon -RF "$release" "$AGENT_DEPLOY_ROOT/data"
  fi
  # These run under the service user in systemd's actual SELinux context, without
  # inheriting the build shell's GCC Toolset LD_LIBRARY_PATH. Old service stays up.
  sudo systemd-run --quiet --wait --pipe --collect --unit="agent-harness-check-$DEPLOY_RUN" \
    -p "User=$DEPLOY_USER" -p "WorkingDirectory=$AGENT_DEPLOY_ROOT" \
    -- "$release/bin/agent-harness" --help
  sudo systemd-run --quiet --wait --pipe --collect --unit="agent-harness-sandbox-$DEPLOY_RUN" \
    -p "User=$DEPLOY_USER" -p "WorkingDirectory=$AGENT_DEPLOY_ROOT" \
    -- /usr/bin/bwrap --unshare-net --ro-bind / / -- /bin/true
}

deploy_prepare_service() {
  if selinuxenabled; then
    sudo restorecon "$DEPLOY_UNIT"
    sudo restorecon -RF "$DEPLOY_DATA"
  fi
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then
  export AGENT_DEPLOY_ROOT="${AGENT_DEPLOY_ROOT:-/opt/agent-harness}"
  deploy_main "$@"
fi
