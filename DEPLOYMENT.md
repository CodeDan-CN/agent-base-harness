# Agent Harness Runtime 部署指南

Ubuntu 22.04 的 Runtime + Web：`bash deployment/ubuntu22.04/deploy.sh`，默认 **0.0.0.0:4317**，见 [22.04 一键部署说明](deployment/ubuntu22.04/README.md)。

CentOS Stream 9/10：在项目根目录运行 `bash deployment/centos/deploy.sh`，默认 **0.0.0.0:4317**。
使用有 sudo 权限的普通用户，自动准备依赖并部署 Runtime + Web；详见 [CentOS 一键部署](deployment/centos/README.md)。CentOS 7/8 不支持，CentOS 实机验收仍待完成。

只部署 Ubuntu Runtime + Web：完整源码上传后，在项目根目录运行 `bash deployment/ubuntu24.04/deploy.sh`。
默认 **0.0.0.0:4317**，包含首次环境准备、构建验证、安装、数据备份及 systemd 开机自启。
请以有 sudo 权限的普通用户执行；详见 [一键部署说明](deployment/ubuntu24.04/DEPLOY.md)。

本轮 Ubuntu 24.04.4 的独立部署目录、逐步指令、Linux Desktop 配置与验收模板集中在 [deployment/](deployment/README.md)。执行入口为 [Ubuntu 操作步骤](deployment/ubuntu24.04/RUNBOOK.md)。

## 当前多端部署入口

生产环境只部署 Server，Web 随 Server 同源托管。Desktop 是独立客户端安装包，Mobile 只保留 apps/mobile 目录。完整划分见 [多端工程架构](docs/多端工程拆分与远程客户端架构.md)。

```bash
npm install
npm run build:server
npm start -- --host 0.0.0.0 --port 4317
```

账号在各客户端本地创建和校验。Runtime 统一信任客户端的内部用户标识；`--allow-registration` 不再控制注册。注册仅填写账号和密码，用户标识自动生成且不对用户展示，不提供手动绑定入口；已有本地账号的数据归属保持不变。详见多端工程架构的用户边界章节。SSE 路由关闭代理缓冲，服务重启不会使本地登录失效。
Desktop 首屏填写服务器地址；CLI 使用 --server URL。所有 Workspace、模型凭据、MCP、Node/Python 都属于服务器。
客户端上传 Skill ZIP 并下载服务器产物，不向服务器提交客户端本机文件路径。

源码开发使用 npm run dev（Runtime + Web + Desktop），开发数据默认在 app-data/development。只启动某个端可使用 dev:server、dev:web、dev:desktop；Mobile 不参加默认开发。

以下自包含平台 Runtime 的构建细节继续适用，仅用于服务器交付，桌面安装包不再携带这些资源。

本文档描述 Agent Harness Runtime 的三平台自包含打包与部署流程。三个阶段使用相同的交付原则：每个平台包均携带固定版本的 Node.js、Python、Memory MCP、Runtime 服务、CLI 以及与内置 Node ABI 匹配的原生依赖，目标电脑不需要预装 Node.js 或 Python。

## 阶段一：macOS 部署

### 1. 当前支持范围

当前已完成并验证的目标为：

- 操作系统：macOS
- CPU 架构：Apple Silicon（arm64）
- 平台标识：`darwin-arm64`
- Node.js：24.20.0
- Python：3.13.15
- Memory MCP：2026.7.4
- `better-sqlite3`：12.6.2

Intel Mac 需要单独构建 `darwin-x64` 包，不能直接使用 `darwin-arm64` 产物。

### 2. 构建环境

macOS 平台包必须在对应架构的真实 macOS 环境中构建。构建机需要：

- 已安装项目开发依赖；
- 能访问 Runtime Lock 中配置的 Node.js、Python 下载地址；
- 能访问 npm Registry；
- 具备构建 Node.js 原生模块所需的 Xcode Command Line Tools；
- 当前工作区已经通过 `npm run install:runtime` 安装 Runtime 构建依赖；完整桌面开发可使用 `npm ci`。

Runtime 版本、下载地址和 SHA-256 固定在 `resources/runtime-lock.json`。构建过程不会使用滚动版本地址替换锁定内容。

### 3. 生成自包含 Runtime

在仓库根目录执行：

```bash
npm run pack:runtime:macos
```

该命令依次执行：

1. 下载或复用锁定的 macOS arm64 Node.js、Python 和 Memory MCP Runtime Pack；
2. 校验 Runtime Pack 的版本、架构、摘要、Node、npm、Python、pip 和 Memory MCP；
3. 构建 Server、Client SDK 和 CLI；
4. 使用包内 Node.js 重新安装并构建 `better-sqlite3`，确保原生模块 ABI 与包内 Node.js 一致；
5. 写入平台启动器和分发清单；
6. 生成 `@agent-harness/runtime-darwin-arm64` scoped npm 包及对应 SHA-256 文件；
7. 在新的临时目录中离线执行 `npm install`，并在不使用系统 Node.js/Python 的环境中执行完整 Smoke Test。

任何一步失败都会导致打包命令失败，不应交付未通过验证的产物。

### 4. 构建产物

产物位于：

```text
release/runtime/darwin-arm64/
├── agent-harness-runtime-darwin-arm64-<version>.tgz
└── agent-harness-runtime-darwin-arm64-<version>.tgz.sha256
```

压缩包结构如下：

```text
package/
├── bin/
│   └── agent-harness
├── distribution-manifest.json
├── package.json
├── vendor/
│   └── better-sqlite3/
├── runtime/
│   ├── runtime-manifest.json
│   ├── runtime-lock.json
│   ├── bin/
│   ├── node/
│   ├── python/
│   └── mcp/
└── service/
    ├── dist/
    │   ├── server/
    │   ├── client/
    │   └── cli/
    └── README.md
```

其中：

- `bin/agent-harness` 是部署方使用的统一入口；
- `runtime/` 包含内置 Node.js、Python 和 Memory MCP；
- `service/` 包含 Runtime 服务、CLI 和 Client SDK；
- `vendor/` 包含已经按内置 Node ABI 构建的原生依赖；平台包不声明外部生产依赖，避免 npm 在安装时重建或替换原生模块；
- `distribution-manifest.json` 记录版本、目标平台、运行时版本和 Node Modules ABI；
- `.sha256` 文件用于传输后完整性校验。

### 5. 构建后的自动验收

`pack:runtime:macos` 会自动验证：

- npm 包可以在离线模式下正常安装；
- 启动器具有执行权限；
- 内置 Node.js 和 Python 可以运行；
- Memory MCP 包完整且工具可发现；
- `better-sqlite3` 可以被内置 Node.js 加载，并能完成建表、写入和查询；
- CLI 帮助命令可以运行；
- Runtime 可以从解压目录启动；
- 服务发现文件可以正常生成；
- 回环地址 `/healthz` 返回正确实例；
- Runtime 可以响应 `SIGTERM` 并正常退出。

如需对已有产物重新执行验收：

```bash
npm run verify:runtime:macos
```

### 6. 交付前校验

在构建机执行：

```bash
cd release/runtime/darwin-arm64
shasum -a 256 -c agent-harness-runtime-darwin-arm64-<version>.tgz.sha256
```

将以下两个文件一起交付：

```text
agent-harness-runtime-darwin-arm64-<version>.tgz
agent-harness-runtime-darwin-arm64-<version>.tgz.sha256
```

不要交付 `.runtime-cache`、开发机 `node_modules`、数据库、日志、`.env` 或用户凭据。

### 7. 目标 Mac 部署

把两个交付文件复制到目标 Mac 的同一目录，然后校验：

```bash
shasum -a 256 -c agent-harness-runtime-darwin-arm64-<version>.tgz.sha256
```

使用本地文件安装：

```bash
npm install ./agent-harness-runtime-darwin-arm64-<version>.tgz
```

发布到私有 npm Registry 后也可以直接安装 scoped 包：

```bash
npm install @agent-harness/runtime-darwin-arm64@<version>
```

确认 CLI 可用并以前台方式启动 Runtime：

```bash
npx agent-harness --help
npx agent-harness serve
```

指定数据目录和端口：

```bash
npx agent-harness --data-dir /path/to/agent-harness-data serve --port 4317
```

未指定端口时，Runtime 会选择可用的本地端口并把服务发现信息写入数据目录。未指定 `--host` 时 Gateway 只监听 `127.0.0.1`；服务器 Web 部署可以显式传入 `--host 0.0.0.0`，具体安全要求见下文“Web 服务器部署”。

### 8. 日常 CLI 操作

在另一个终端使用同一数据目录执行：

```bash
npx agent-harness --data-dir /path/to/agent-harness-data server status
npx agent-harness --data-dir /path/to/agent-harness-data register
npx agent-harness --data-dir /path/to/agent-harness-data setup
npx agent-harness --data-dir /path/to/agent-harness-data run "你好"
npx agent-harness --data-dir /path/to/agent-harness-data login
npx agent-harness --data-dir /path/to/agent-harness-data session list
npx agent-harness --data-dir /path/to/agent-harness-data server stop
```

首次安装不创建演示账号或固定密码，也不携带模型服务、API Key 或默认模型。Runtime 与
`/healthz` 在未配置模型时仍可正常启动；接入方先通过 bootstrap credential 注册自己的本地
账号，再配置模型服务、凭据、模型并设置默认模型。完成这些步骤前，任务提交会稳定返回
`MODEL_NOT_CONFIGURED`，不会进入 Agent 执行链路。

目标 Mac 需要 Node.js/npm 来下载安装 npm 包；安装完成后，`agent-harness` 启动器和 Runtime 工具均使用包内 Node.js/Python，不使用系统解释器。

### 9. 数据与升级注意事项

- Runtime 程序目录和用户数据目录必须分开；
- 升级时不要覆盖或删除已有数据目录；
- 新版本应解压到新的版本目录；
- 停止旧 Runtime 后，再使用新版本和原数据目录启动；
- 正式升级前应备份 SQLite 数据库及相关用户资源；
- 不要在两台 Runtime 实例中同时打开同一个数据目录；
- 不要从另一台电脑复制 `node_modules` 替换平台包中的原生依赖。

### 10. 当前发布边界

当前产物已完成内部功能和干净环境 Smoke Test，但仍属于内部测试交付包。正式对外分发前还需要补齐：

- Apple Developer ID 签名；
- macOS 公证和 staple；
- Gatekeeper 干净机验证；
- Intel Mac 的 `darwin-x64` 构建与验证；
- 正式版本发布、回滚和升级记录。

轻量 npm 包和自包含平台包用途不同：

- `npm run pack:server` 生成轻量 npm 包，目标电脑需要 Node.js 并在安装时下载依赖；
- `npm run pack:runtime:macos` 生成自包含 macOS scoped npm 包；npm 安装过程不再下载生产依赖，Runtime 执行不依赖系统 Node.js/Python。

跨电脑部署应优先使用自包含平台包。

## 阶段二：Ubuntu 部署

已在 Ubuntu 24.04.4 x86_64 原生构建 `@agent-harness/runtime-linux-x64` 并执行服务功能验证。具体命令按 [RUNBOOK](deployment/ubuntu24.04/RUNBOOK.md)，实测范围见 [2026-09-11 报告](deployment/ubuntu24.04/VALIDATION-20260911.md)。

Ubuntu 24.04 及以上的具体改造清单、打包步骤、systemd/HTTPS 部署和 Web/Desktop/Mobile 影响，见 [Ubuntu Runtime 打包部署与三端 UI 影响说明](docs/Ubuntu24.04及以上Runtime打包部署与三端UI影响说明.md)。该文档保留实施前设计背景，实际状态以 deployment/ 中的操作步骤与实机报告为准。

## 阶段三：Windows 部署

待完善。目标包为 `@agent-harness/runtime-win32-x64`，需要在真实 Windows x64 环境中构建原生依赖、提供 Windows 启动器并执行与 macOS 等价的验收。

## Web 服务器部署

Web 页面与 Electron 共用 `packages/app-ui/src` 中的正式 React 界面，Web 专属入口位于 `apps/web/`，构建产物为 `dist/web/`。Runtime 会从同一 Origin 提供页面、API 与 SSE 事件流，因此不需要单独配置 CORS。

构建并在所有 IPv4 网卡上启动：

```bash
npm run install:runtime
npm run typecheck:runtime
npm run build:web
npm run build:server
node dist/server/index.cjs \
  --data-dir /var/lib/agent-harness \
  --host 0.0.0.0 \
  --port 4317 \
  --web-root dist/web
```

源码开发用 `npm run dev:server` 单独运行 Runtime，`npm run dev:web` 启动浏览器开发界面；完整开发使用 `npm run dev`。

Desktop 只连接已运行的 Server。生产启动 Server 后，即使所有 Desktop 都已退出，Web 和 Runtime 仍可用。

旧版 Electron 可能曾在 `~/Library/Application Support/agent-base-harness` 或 `~/Library/Application Support/Agent Harness` 保存服务器数据。升级时显式用 `--data-dir` 指定原目录；本次不自动搬迁或删除数据，也不自动停止已运行的旧服务。
