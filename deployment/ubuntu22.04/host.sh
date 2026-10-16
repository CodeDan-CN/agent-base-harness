#!/usr/bin/env bash
ubuntu22_fail() { echo "Ubuntu 22.04 error: $*" >&2; exit 1; }
ubuntu22_check_release() {
  local ID='' VERSION_ID=''
  . "${1:-/etc/os-release}"
  [[ "$ID" = ubuntu && "$VERSION_ID" = 22.04 ]] || ubuntu22_fail 'This entry requires Ubuntu 22.04.'
}
ubuntu22_check_system() {
  [[ "$(uname -s)" = Linux ]] || ubuntu22_fail 'Run on Ubuntu 22.04; --dry-run works elsewhere.'
  [[ "$(id -u)" != 0 ]] || ubuntu22_fail 'Run as an ordinary sudo user, not root.'
  ubuntu22_check_release
  case "$(uname -m)" in
    x86_64|aarch64|arm64) ;;
    *) ubuntu22_fail 'Only x86_64 and aarch64 are supported.' ;;
  esac
}
# Check before apt provisioning and before opening the build lock. Uploaded
# source trees and previous sudo builds can leave these paths owned by root.
ubuntu22_check_workspace() {
  local repo=$1 path
  for path in "$repo" "$repo/.runtime-cache" "$repo/.runtime-cache/ubuntu-package.lock" \
    "$repo/node_modules" "$repo/dist" "$repo/release" "$repo/build-support/server-package"; do
    if [[ -e "$path" && ( ! -w "$path" || ( -d "$path" && ! -x "$path" ) ) ]]; then
      echo "Build path is not writable by $(id -un): $path" >&2
      echo 'Use a writable source checkout. If this project directory should belong to you, run:' >&2
      printf '  sudo chown -R %q -- %q\n' "$(id -u):$(id -g)" "$repo" >&2
      ubuntu22_fail 'Fix source permissions, then rerun without sudo before bash.'
    fi
  done
}
ubuntu22_enable_toolchain() {
  command -v gcc-12 >/dev/null && command -v g++-12 >/dev/null ||
    ubuntu22_fail 'GCC 12 is required; run deploy.sh to install dependencies.'
  export CC="$(command -v gcc-12)" CXX="$(command -v g++-12)"
}
ubuntu22_check_sandbox() {
  if ! bwrap --unshare-net --ro-bind / / -- /bin/true; then
    ubuntu22_fail 'bubblewrap cannot create a sandbox. Check container permissions, user namespaces and AppArmor logs. No Ubuntu 24.04 AppArmor policy was installed.'
  fi
}
ubuntu22_install_dependencies() {
  local dependency installed
  local missing=()
  for dependency in build-essential gcc-12 g++-12 python3 python3-dev ca-certificates curl git tar xz-utils \
    file binutils util-linux bubblewrap ripgrep libatomic1; do
    installed=$(dpkg-query -W -f='${db:Status-Status}' "$dependency" 2>/dev/null || true)
    [[ "$installed" = installed ]] || missing+=("$dependency")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    sudo apt-get update
    sudo apt-get install -y "${missing[@]}"
  fi
  ubuntu22_enable_toolchain
  ubuntu22_check_sandbox
}
