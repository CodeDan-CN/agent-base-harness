#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../ubuntu24.04" && pwd)/deploy.sh"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host.sh"

deploy_platform() { echo ubuntu22.04; }
deploy_host_plan() { echo 'Check Ubuntu 22.04/systemd; install apt dependencies and GCC 12; verify bubblewrap.'; }
deploy_usage() {
  cat <<'USAGE'
Usage: bash deployment/ubuntu22.04/deploy.sh [--port PORT] [--data-dir PATH] [--skip-build] [--migrate-files] [--dry-run]
Runtime + Web on Ubuntu 22.04 x86_64/aarch64, as an ordinary sudo user.
Default: 0.0.0.0:4317, agent-harness-web.service, $HOME/agent-harness-deploy/data/runtime.
AGENT_DEPLOY_ROOT overrides the deployment root; --data-dir must be inside its data directory.
Installs prerequisites, builds/verifies locally, backs up data and enables systemd.
--skip-build requires matching Ubuntu 22.04 package provenance and SHA-256.
--migrate-files explicitly migrates legacy credentials after the stopped backup.
Does not upload source or change firewall, system libraries or AppArmor policies.
USAGE
}
deploy_check_host() {
  ubuntu22_check_system
  ubuntu22_check_workspace "$DEPLOY_REPO"
  [[ -d /run/systemd/system ]] || deploy_fail 'A running systemd host is required.'
  command -v sudo >/dev/null || deploy_fail 'Configure sudo for this user first.'
}
deploy_prepare_host() { deploy_sudo_ready; ubuntu22_install_dependencies; }
deploy_build() { bash "$DEPLOY_REPO/deployment/ubuntu22.04/package.sh"; }
deploy_check_archive() {
  python3 "$DEPLOY_REPO/deployment/ubuntu22.04/package-provenance.py" check "$1/$2"
}
if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then deploy_main "$@"; fi
