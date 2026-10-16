#!/usr/bin/env bash
# Ubuntu 24.04: grant user namespaces to one trusted Chromium/Electron executable.
# Invoke explicitly after extracting and verifying the chosen client package.
set -euo pipefail
if [[ $# != 1 || ! -x "$1" ]]; then
  echo "Usage: bash $0 /absolute/path/to/trusted/executable" >&2
  exit 2
fi
CLIENT_EXE=$(realpath -- "$1")
case "$CLIENT_EXE" in
  *'"'*|*'\'*|*$'\n'*|*'{'*|*'}'*|*'['*|*']'*|*'*'*|*'?'*)
    echo 'Executable path contains unsupported AppArmor syntax' >&2; exit 2 ;;
esac
CLIENT_ID=$(printf '%s' "$CLIENT_EXE" | sha256sum | cut -c1-12)
CLIENT_PROFILE="agent-harness-client-$CLIENT_ID"
CLIENT_POLICY=$(mktemp)
trap 'rm -f "$CLIENT_POLICY"' EXIT
cat > "$CLIENT_POLICY" <<POLICY
# Exact executable only; Chromium's own sandbox remains enabled.
# Ubuntu 24.04 release notes document the unconfined + userns application profile.
abi <abi/4.0>,
include <tunables/global>
profile $CLIENT_PROFILE "$CLIENT_EXE" flags=(unconfined) {
  userns,
}
POLICY
sudo apparmor_parser -Q "$CLIENT_POLICY"
sudo install -m 0644 "$CLIENT_POLICY" "/etc/apparmor.d/$CLIENT_PROFILE"
sudo apparmor_parser -r "/etc/apparmor.d/$CLIENT_PROFILE"
printf 'Installed %s for %s\n' "$CLIENT_PROFILE" "$CLIENT_EXE"
