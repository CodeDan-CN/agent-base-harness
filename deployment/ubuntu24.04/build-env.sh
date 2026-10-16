# Source this file in the Ubuntu build shell. These settings are process-local.
export ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
export ELECTRON_BUILDER_CACHE="${AGENT_DEPLOY_ROOT:-$HOME/agent-harness-deploy}/downloads/electron-builder"
export electron_config_cache="${AGENT_DEPLOY_ROOT:-$HOME/agent-harness-deploy}/downloads/electron"
# Keep Electron's checksums from its integrity-checked npm package.
unset ELECTRON_SKIP_BINARY_DOWNLOAD electron_use_remote_checksums npm_config_electron_use_remote_checksums
# Build native modules against the local Node instead of waiting for GitHub prebuilds.
export npm_config_build_from_source=true
export npm_config_jobs="${npm_config_jobs:-2}"
export MAKEFLAGS="${MAKEFLAGS:--j2}"

# Official Node archives already contain headers covered by the archive SHA-256.
# Call only for Node Runtime builds, never for an Electron ABI rebuild.
agent_use_local_node_headers() {
  local node_dir=$1 header
  for header in node.h node_version.h common.gypi config.gypi; do
    if [[ ! -r "$node_dir/include/node/$header" ]]; then
      echo "Missing bundled Node header: $node_dir/include/node/$header" >&2
      return 1
    fi
  done
  export npm_package_config_node_gyp_nodedir="$node_dir"
}
