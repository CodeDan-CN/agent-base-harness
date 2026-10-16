#!/usr/bin/env bash
# CentOS-specific checks shared by the deployment and packaging entry points.

centos_fail() { echo "CentOS error: $*" >&2; exit 1; }

centos_check_release() {
  local ID='' VERSION_ID='' PRETTY_NAME='unknown'
  . "${1:-/etc/os-release}"
  [[ "$ID" = centos ]] || centos_fail "Expected CentOS Stream, found $PRETTY_NAME. Use the matching distribution entry point."
  case "${VERSION_ID%%.*}" in
    9|10) ;;
    7) centos_fail 'CentOS 7 is incompatible with the pinned official Node 24 runtime (glibc >= 2.28 required). Use CentOS Stream 9/10 or Ubuntu 24.04+.' ;;
    *) centos_fail "This entry targets CentOS Stream 9/10; found $PRETTY_NAME. No repository or system-library replacements were made." ;;
  esac
  CENTOS_MAJOR=${VERSION_ID%%.*}
}

centos_check_system() {
  [[ "$(uname -s)" = Linux ]] || centos_fail 'Run on CentOS Stream; --dry-run works on other hosts.'
  [[ "$(id -u)" != 0 ]] || centos_fail 'Run as an ordinary sudo user, not root.'
  centos_check_release
  local libc version major minor
  libc=$(getconf GNU_LIBC_VERSION) || centos_fail 'GNU glibc is required.'
  version=${libc##* }
  [[ "$version" =~ ^[0-9]+\.[0-9]+$ ]] || centos_fail "Cannot identify glibc: $libc"
  major=${version%%.*}; minor=${version##*.}
  [[ "$major" -gt 2 || ( "$major" -eq 2 && "$minor" -ge 28 ) ]] || centos_fail "glibc 2.28+ required, found $version."
  case "$(uname -m)" in
    x86_64|aarch64|arm64) ;;
    *) centos_fail 'Only x86_64 and aarch64 are supported.' ;;
  esac
}

centos_enable_toolchain() {
  local compiler_version
  compiler_version=$(g++ -dumpfullversion -dumpversion 2>/dev/null || echo 0)
  if [[ "${compiler_version%%.*}" -lt 12 ]]; then
    [[ -r /opt/rh/gcc-toolset-13/enable ]] || centos_fail 'GCC 12+ is required; install gcc-toolset-13-gcc and gcc-toolset-13-gcc-c++ through deploy.sh.'
    # Red Hat's environment script can reference initially unset environment variables.
    set +u
    . /opt/rh/gcc-toolset-13/enable
    set -u
  fi
  compiler_version=$(g++ -dumpfullversion -dumpversion)
  [[ "${compiler_version%%.*}" -ge 12 ]] || centos_fail 'GCC Toolset activation did not provide GCC 12+.'
  export CC="$(command -v gcc)" CXX="$(command -v g++)"
}

centos_check_sandbox() {
  if ! bwrap --unshare-net --ro-bind / / -- /bin/true; then
    centos_fail 'bubblewrap cannot start. Inspect user.max_user_namespaces and SELinux AVCs (sudo ausearch -m AVC -ts recent). SELinux and namespace policy have not been disabled.'
  fi
}

centos_install_dependencies() {
  local dependency compiler_version
  local missing=()
  for dependency in gcc gcc-c++ make python3 python3-devel ca-certificates git tar gzip xz \
    file binutils util-linux bubblewrap libstdc++ libatomic libselinux-utils policycoreutils policycoreutils-python-utils; do
    rpm -q "$dependency" >/dev/null 2>&1 || missing+=("$dependency")
  done
  # Stream minimal images may provide curl-minimal; do not replace a working curl.
  command -v curl >/dev/null || missing+=(curl)
  if [[ ${#missing[@]} -gt 0 ]]; then sudo dnf install -y "${missing[@]}"; fi
  compiler_version=$(g++ -dumpfullversion -dumpversion)
  if [[ "${compiler_version%%.*}" -lt 12 && ! -r /opt/rh/gcc-toolset-13/enable ]]; then
    sudo dnf install -y gcc-toolset-13-gcc gcc-toolset-13-gcc-c++ gcc-toolset-13-binutils
  fi
  centos_enable_toolchain
  centos_check_sandbox
}

centos_label_path() {
  local expression=$1 sample=$2 expected_type=$3 context
  context=$(matchpathcon -n "$sample")
  if [[ "$context" != *":$expected_type:"* ]]; then
    # -a refuses an existing conflicting local rule. Do not silently modify it.
    sudo semanage fcontext -a -t "$expected_type" "$expression" ||
      centos_fail "Cannot add SELinux label for $expression; inspect existing local fcontext rules."
  fi
}
