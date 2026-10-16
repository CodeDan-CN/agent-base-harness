# Agent Harness Runtime Debian package

This package contains Runtime + Web + CLI, bundled Node/Python/Memory MCP and native SQLite. It is not the Electron desktop client. The current build is validated on Ubuntu 24.04 x86_64; the package declares glibc 2.39 or newer.

Install the amd64 build:

```sh
sudo apt install ./agent-harness-runtime_4.7.6-1_amd64.deb
agent-harness-runtime serve --host 127.0.0.1 --port 4317 --data-dir "$HOME/.local/share/agent-harness-runtime"
```

Open http://127.0.0.1:4317 in a browser. Run as your ordinary user. For a remote listener select `--host 0.0.0.0` and the intended networking setup. Files install under `/opt/agent-harness-runtime`, with `/usr/bin/agent-harness-runtime` as the launcher. Installation does not create accounts, modify existing services, start a daemon, or enable a systemd unit.

Accounts and password checks belong to each client. Registration accepts only an account name and password; an internal identifier is generated automatically and is not displayed or manually bound. Existing local accounts retain their stored data identity. Runtime does not accept the old account login endpoints. Embedded SDK clients accept `user: { id, loginName, displayName }`; raw API clients use URI-encoded JSON in `x-agent-user` plus `x-agent-client-kind`. These internal identifiers do not prove identity.

## Restricted tools on Ubuntu 24.04

The `bubblewrap` dependency must also have a working host AppArmor policy. Check as the ordinary service user:

```sh
bwrap --unshare-net --ro-bind / / -- /bin/true
```

If Ubuntu's user namespace restriction blocks it, an administrator should inspect existing bwrap policies and apply the supplied example only when it does not conflict:

```sh
sudo apparmor_parser -Q /usr/share/doc/agent-harness-runtime/examples/bwrap-userns-restrict.apparmor
sudo install -m 0644 /usr/share/doc/agent-harness-runtime/examples/bwrap-userns-restrict.apparmor /etc/apparmor.d/agent-harness-bwrap
sudo apparmor_parser -r /etc/apparmor.d/agent-harness-bwrap
```

The package deliberately leaves host AppArmor policy management to the administrator. It does not disable the global user namespace restriction. The build server already has this policy, and restricted tool execution is verified there.

## Upgrade and removal

Stop the instance you intend to upgrade, back up its data directory including encrypted credentials and the corresponding key, then install the replacement `.deb` and restart that instance. Record the actual package version, dated release directory and SHA-256 for each delivery.

```sh
sudo apt remove agent-harness-runtime
```

Removal deletes installed program files. Data in the explicitly chosen data directory and client-local accounts remain outside the package. Any AppArmor policy installed manually is also managed separately.

## Rebuild

On the matching Ubuntu architecture, run `npm run pack:ubuntu`, then `npm run pack:runtime:deb`. The latter wraps the verified archive, checks its SHA-256 and manifest, and emits `.deb` plus `.sha256` in `release/runtime/linux-x64/` (or the matching ARM directory). Runtime's application license is recorded in its package metadata; bundled components retain their own license files.
