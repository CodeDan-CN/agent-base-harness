# Client-owned identity (2026-09-11)

Account registration, passwords and login sessions now belong to clients. Runtime trusts the `x-agent-user` URI-encoded JSON header (`id`, `loginName`, `displayName`) plus `x-agent-client-kind`, and initializes data partitions on first use. The SDK supports an explicit `user` option for integrations. `/v1/auth/*` returns 410; user Bearer tokens and remote registration are retired. Legacy registration flags are ignored. Host bootstrap authorization for service stop remains separate. Registration generates an internal ID automatically; users neither enter nor bind an ID. Existing client accounts retain their data partitions. This mode does not verify identity claims.

# @agent-harness/server

The Agent Harness modular-monolith distribution. One package contains the Gateway, Runtime,
Web client, Node client, and `agent-harness` CLI. The default listener remains loopback-only.

```sh
npm install /path/to/agent-harness-server-4.7.7.tgz
npx agent-harness serve
```

In another terminal, create the first local account and configure a model before running a task:

```sh
npx agent-harness register
npx agent-harness setup
npx agent-harness run "Hello"
```

Clients initialize the built-in local account only when it does not already exist. Existing
accounts and passwords are preserved. The package contains no model credentials or default
provider. The service and `/healthz` start without a model; add an enabled model in settings
and select it in the chat composer before submitting a task.

After publishing to the private registry, the tarball path can be replaced with
`@agent-harness/server@4.7.7`.

Node.js 22 or newer is required. The package installs a platform-native `better-sqlite3` binary,
so install dependencies on the computer that will run the service instead of copying
`node_modules` from another computer.

Release candidates are verified in a clean directory by loading SQLite, running the CLI, starting
the service, and calling its loopback health endpoint.

## 4.7.7 upgrade: SQLite credentials

Keep the same Runtime data directory and client account/internal user ID. Model settings,
model-service endpoints, MCP definitions and saved references are preserved. Embedding models
configured through a Runtime model service share this migration; embedding configuration owned
by a separate application is outside this package's migration scope.

API keys now live in plaintext in `database/app.db` (`credential_secrets`, schema migration 16).
Normal startup, snapshots, connection tests and model/MCP requests do not access Keychain or
legacy encrypted files. Database backups and WAL files may contain API keys.

Existing API keys need a one-time migration, or can be re-entered in settings. Stop the old
Runtime and back up its database before running the new package's admin launcher. On the
original macOS host/account, run:

```sh
/path/to/new/package/bin/agent-harness credentials migrate-keychain --data-dir "/original/data-dir"
/path/to/new/package/bin/agent-harness serve --data-dir "/original/data-dir"
```

For legacy encrypted credential files use `credentials migrate-files` instead; retain the
original `AGENT_HARNESS_CREDENTIAL_KEY_FILE` setting if a custom master key was used. The
server-only npm package exposes the same commands through `npx agent-harness`.

The migration reports only `migrated`, `skipped`, `missing`, `failed` counts. It preserves existing
SQLite values and all source credentials, verifies imported values, includes archived model/MCP
configurations, and is safe to repeat. Any `missing`/`failed` count produces exit code 1: resolve
unreadable source entries or re-enter those keys before relying on authenticated calls.

Startup does not automatically migrate. A snapshot showing a saved reference does not prove
its key has been migrated or its connection has succeeded. To roll back to an older Runtime,
restore the pre-upgrade database backup because the older schema validator rejects version 16.

## Web client

Start the service on all interfaces:

```sh
npx agent-harness --data-dir /var/lib/agent-harness serve --host 0.0.0.0 --port 4317
```

Open `http://SERVER_IP:4317/`. The Runtime serves the bundled Web client and API from the same
origin. Register with an account name and password in the Web client, add a model in settings,
then select the model and thinking options in the composer. User IDs are internal and are not
shown or requested. Runtime trusts client-supplied identity; it does not expose registration or
password verification.

The Electron client connects to the server URL you configure. It does not include or start a
Runtime. Web and Runtime remain available after all desktop clients exit. The default service
port is 4317. Legacy registration flags are ignored.

## 2026-09-11 Runtime fixes

- Business memory compaction replaces covered Session/Event QA without duplicating it in model requests. The two summary layers fail independently.
- Execution compaction preserves tool call/result pairs, materializes checkpoints in the active request, and supports repeated compaction while retaining original events.
- Model capability metadata refreshes from models.dev with validated atomic caching, offline fallback, and a manual refresh control in model settings. Manual overrides remain authoritative. The bundled catalog includes DeepSeek Flash's 1,000,000-token context.
- Production hosts check the catalog in the background; network failure keeps the last valid catalog. No model credentials are sent to models.dev. Current requests retain their captured configuration; updated capabilities apply at the next Step.
