# Ubuntu 24.04 及以上 Runtime 打包部署与三端 UI 影响说明

> 后续实施更新：已新增平台选择入口、Linux x64/arm64 Lock、通用打包参数与验证检查，并核验了 Linux 上游资产地址和摘要。最新命令与状态以 [Runtime 多平台打包入口](Runtime多平台打包入口.md) 为准。下文保留方案编写时的历史基线；Linux 加密凭据和 bubblewrap 沙箱已实现，本次执行状态见 [Ubuntu 操作步骤](../deployment/ubuntu24.04/RUNBOOK.md) 和 [实机报告](../deployment/ubuntu24.04/VALIDATION-20260911.md)。

本文初稿按 2026-09-11 实施前的工作区代码编写，以下“尚未实现”描述仅用于保留设计背景，不代表后续已执行状态。

这里的“三端 UI”按当前工程理解为 Web、Desktop、Mobile；CLI 另外说明。目标是把独立 Runtime 部署到 Ubuntu，让现有客户端通过网络继续使用。

**结论：工程架构已经支持远程连接，三端无需重写。正式交付 Ubuntu Runtime，必须补齐 Linux 平台打包、持久凭据存储、受限命令沙箱，再完成原生依赖与部署验收。仅更换 Node/Python 下载地址还不够。**

## 1. 当前已经具备什么，还缺什么

| 项目         | 当前代码事实                                                                             | Ubuntu 工作                                     |
| ------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 独立服务     | `apps/server` 提供 Server 与管理员入口，HTTP/SSE 位于 `packages/server-core`             | 复用现有入口和协议                              |
| Web 托管     | `build:server` 已构建 Server、管理员入口、SDK 和 Web                                     | 把 `dist/web` 一起装进平台包                    |
| 远程客户端   | Web、Desktop、Mobile 使用同一服务契约                                                    | 配置新的服务地址，做跨设备回归                  |
| Runtime Lock | `resources/runtime-lock.json` 只描述 `darwin-arm64`                                      | 新增 Linux x64 锁文件；arm64 独立增加           |
| 下载准备     | `prepare-runtime-pack.mjs` 的 `assertLock` 只接受 Darwin arm64，二进制检查也写死 `arm64` | 参数化目标、锁文件与架构检查                    |
| Runtime 校验 | `verify-runtime-pack.mjs` 固定比较 Node/Python 的 `arm64` 输出                           | 区分 Node 与 Python 在各平台的架构命名          |
| 分发打包     | `package-platform-runtime.mjs` 明确拒绝非 Darwin 平台                                    | 增加 Linux 目标，保留同平台同架构构建约束       |
| SQLite       | 平台打包已使用包内 Node 安装并加载 `better-sqlite3`                                      | 在 Ubuntu 24.04 同架构环境构建并检查 ELF 依赖   |
| 凭据         | Linux 默认走测试用 `FakeCredentialStore`，内容只存于 `Map`                               | 实现生产持久凭据适配器，保证重启后 API Key 可用 |
| 命令沙箱     | `ProcessRunner.sandboxCommand()` 在非 Darwin 上拒绝受限模式                              | 实现 Linux 沙箱后才能保持默认权限行为           |
| 数据目录     | 已支持 Linux XDG 数据路径                                                                | 服务部署显式指定 `/var/lib/agent-harness`       |
| 部署说明     | `DEPLOYMENT.md` 的 Ubuntu 阶段仍为“待完善”                                               | 增加 systemd、HTTPS、升级与验收流程             |

当前 `pack:server` 是需要系统 Node 和安装依赖的轻量 npm 包；`pack:runtime:macos` 才是现有自包含平台包链路。仓库目前没有 `pack:runtime:linux` 命令。

## 2. 明确支持边界和交付形式

第一版以 **Ubuntu 24.04 x86_64 → `linux-x64`** 为最低构建与验收基线。若服务器使用 ARM，再独立构建 **Ubuntu 24.04 aarch64 → `linux-arm64`**。两者不混用二进制和缓存。

Ubuntu 24.04 的 glibc 为 2.39 系列。较新 Ubuntu 构建出的原生模块可能要求更新的 glibc，所以应在最低支持版本构建，再到计划支持的较新版本逐一验收；“24.04 及以上”是兼容目标，不代表未来版本自动获得支持。[Ubuntu libc6 包信息](https://packages.ubuntu.com/noble/libc6)

本方案使用 GNU/Linux glibc 产物，不把 Alpine/musl、Windows、macOS 或 Linux Desktop 安装包合并为同一个目标。Node 自身的平台要求还需按选定版本检查，不能用 Node 可启动来推断整个 Runtime 的兼容性。[Node 官方构建说明](https://github.com/nodejs/node/blob/main/BUILDING.md)

建议沿用当前 `.tgz` 交付格式：

```text
release/runtime/linux-x64/
  agent-harness-runtime-linux-x64-<version>.tgz
  agent-harness-runtime-linux-x64-<version>.tgz.sha256

package/
  bin/agent-harness
  distribution-manifest.json
  package.json
  runtime/{bin,node,python,mcp,...}
  vendor/better-sqlite3/...
  service/dist/{server,client,cli,web}/...
```

`service/dist/cli` 是服务器管理员入口，由 `dist/admin` 复制而来；独立远程 CLI 是另一份产物。平台包版本当前来自 `build-support/server-package/package.json`，值为 `4.7.5`，不能误用根项目的 `0.1.0`。

“自包含”指随包交付 Node、Python、Memory MCP、服务代码和生产 Node 依赖。Linux 内核、glibc、系统证书、Shell，以及本方案选用的系统沙箱组件仍是宿主依赖。安装过程可以离线，模型 API 与远程 MCP 的调用是否需要网络由实际配置决定。

## 3. 必须完成的代码改动

### 3.1 将打包链路改为按平台选取 Lock

建议新增以下结构，保留现有 macOS 入口兼容性：

```text
resources/runtime-locks/darwin-arm64.json
resources/runtime-locks/linux-x64.json
resources/runtime-locks/linux-arm64.json       # 需要 ARM 时再添加
build-support/runtime-target.mjs             # 统一解析目标和锁文件
build-support/build-platform-runtime.mjs     # 串行编排准备、构建、打包、验证
```

这是拟新增结构，不是当前已经存在的文件。

实施规则：

1. 统一解析 `--target linux-x64`，默认可取当前 `process.platform/process.arch`，显式目标必须在支持表内。
2. 准备、缓存匹配、验证、打包全部使用同一份 Lock；不能只改下载脚本，其他脚本仍读旧的 Darwin Lock。
3. 保留构建主机和目标一致的检查。在相应架构的 Ubuntu 主机或 VM 构建，不复制 Mac 的 `node_modules`、`.service-cache`、`.runtime-cache/darwin-arm64`。
4. 锁定 Node/Python 的版本、真实上游文件名、镜像/官方 URL 和 SHA-256；MCP 的版本、integrity 与根 `package-lock.json` 保持一致。
5. 当前锁定版本是 Node `24.20.0`、Python `3.13.15`、Memory MCP `2026.7.4`。这是仓库记录，不是本次已核验存在的 Linux 发布资产；实施时先核对上游对应架构产物，缺失则显式调整版本并重新验证，不能猜摘要或静默使用 latest。

Linux 文件名与架构对照：

| 目标        | Node 归档命名                        | Python 目标三元组           | Node `process.arch` | Python `platform.machine()` |
| ----------- | ------------------------------------ | --------------------------- | ------------------- | --------------------------- |
| linux-x64   | `node-v<VERSION>-linux-x64.tar.xz`   | `x86_64-unknown-linux-gnu`  | `x64`               | 通常 `x86_64`               |
| linux-arm64 | `node-v<VERSION>-linux-arm64.tar.xz` | `aarch64-unknown-linux-gnu` | `arm64`             | 通常 `aarch64`              |

Python 从固定发布中选择适用的 `install_only`/`install_only_stripped` 资产，以实际资产列表为准；通用 x64 包避免无意选择要求更高 CPU 指令集的 v2/v3/v4 变体。[Python 发布资产](https://github.com/astral-sh/python-build-standalone/releases)、[运行与 CPU 兼容说明](https://gregoryszorc.com/docs/python-build-standalone/20240725/running.html)

`file` 在 Linux 上通常显示 `x86-64` 或 `ARM aarch64`，不能继续用字符串包含 `arm64` 作为通用条件。检查 ELF 类型/架构、执行版本探测，并把探测结果与 manifest 对照。已有缓存命中逻辑也要同步修改。

### 3.2 保证原生依赖与包内 Node 一致

继续沿用 `package-platform-runtime.mjs` 的正确流程：包内 Node 调用包内 npm，在临时目录安装生产依赖，实际加载 `better-sqlite3`，然后转存为 `vendor` 并取消交付包的安装期依赖与重建脚本。

需要补强：

- 为分发模板的完整生产依赖树保留可重复安装的 Lock；当前临时目录执行 `npm install`，只固定直接依赖不足以固定所有传递依赖。
- 用包内 Node 记录 `process.versions.modules`，验证 SQLite 建表、写入、查询和重启后读取。
- 检查 Node、Python、`better_sqlite3.node` 与 Python 扩展的动态库需求，确认最低系统上没有缺失库或高于基线的符号要求。
- 安装失败需要编译时，确保实际被 npm 调用的 node-gyp 与 Python 兼容。Python 3.12 及以上要求 node-gyp 10 及以上；不能照搬旧版依赖 `distutils` 的处理，也不能假定全局安装 node-gyp 就替换了实际调用版本。[node-gyp 官方安装要求](https://github.com/nodejs/node-gyp#installation)
- 构建阶段可以联网下载解释器、依赖和 Node headers；成品启动不应再联网安装这些组件。

还要审查 `materializeSymlinks()`：当前把“有执行位的符号链接目标”统一变成 Shell 转发器。Linux 的 `.so` 也可能有执行位，若其链接被改成 Shell 文件会破坏加载。应按文件用途区分可执行入口和共享库，保留或复制库的真实内容，并在最终安装后的包上验证 Python `ssl/sqlite3/ctypes/venv`、pip 和 npm/npx。不能只验证解压前的缓存。

### 3.3 实现 Linux 持久凭据存储

当前调用链：`service-host.ts` 在 Darwin 才默认启用系统凭据；`application.ts` 在未注入适配器且未启用系统凭据时创建 `FakeCredentialStore`。因此 Linux 上模型 API Key、MCP 密钥可能本次可用，但重启后丢失；数据库里的 `credentialRef` 并不包含秘密正文。

建议增加 `LinuxEncryptedCredentialStore`，实现既有 `CredentialStore` 接口，并在服务装配处按平台注入。业务数据库继续只存引用。无桌面 Ubuntu Server 不应默认依赖已登录的 GNOME Keyring/桌面会话。

建议方案为独立加密凭据文件或数据库，使用经认证的加密方式和独立主密钥，支持原子写入、替换、删除、版本标识、错误检测与备份恢复。服务使用固定非 root 用户，密文目录限制为该用户可访问；主密钥不打进产物、不写入业务日志，也不下发给 UI。

systemd 可通过 `LoadCredential=` 将主密钥文件交给服务，再由适配器读取 `$CREDENTIALS_DIRECTORY` 下的指定文件。**这个读取入口需要新实现，当前没有对应配置功能。**必须同时保证凭据目录、主密钥和 Runtime 进程环境不会通过 Bash/MCP 子进程暴露；仅加密落盘不能隔离同权限进程。systemd 能提供凭据传递，但不会替代应用的存取实现。[systemd v255 执行与凭据配置](https://github.com/systemd/systemd/blob/v255/man/systemd.exec.xml)

生产 Linux 缺少主密钥或凭据后端时应明确失败或报告不可用，不能静默降级到 Fake。Fake 仅由测试显式注入。验收必须覆盖“设置 Key → 调用 → 重启服务 → 重新登录 → 再次调用”。

### 3.4 补齐 Linux 受限命令执行

当前 `ProcessRunner.sandboxCommand()` 只实现 `/usr/bin/sandbox-exec`；非 Darwin 受限执行会抛出 `Restricted sandbox is unavailable on this platform`。`approval-required` 和 `guarded` 均会映射到受限的 `workspace-write`；其中用户批准一次操作后也不会自动变为全权限。

建议将平台沙箱装配从 `process-runner.ts` 拆成适配器，Linux 首版采用发行版提供的 Bubblewrap，并明确实现以下边界：

- 系统运行依赖和包内 Runtime 只读；按会话暴露 Workspace、临时目录和明确批准的额外路径。
- 服务数据库、其他用户工作区、凭据文件与主密钥不挂载进工具环境；避免用整个服务数据目录作为宽泛可读根。
- 根据 `allowNetwork` 建立或隔离网络，覆盖批准联网后的 DNS 和 HTTPS 行为。
- 维持现有 cwd/realpath 检查、环境 allowlist、超时、取消与子进程清理。
- 沙箱不可用时返回明确错误，不能把默认权限静默改成 `full-access`。

Bubblewrap 是构建沙箱的工具，安全策略取决于调用方设置，安装完成不等于适配完成。[Bubblewrap 官方说明](https://github.com/containers/bubblewrap)

Ubuntu 24.04 默认启用了 AppArmor 对非特权 user namespace 的限制，必须使用实际服务用户、实际 systemd 单元验证选定 Bubblewrap 版本与策略；不要通过全局关闭 AppArmor/user namespace 限制来“通过验收”。容器中构建可作为补充，但不能替代宿主系统的这项测试。[Ubuntu AppArmor 说明](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/)

`full-access` 本来就能绕过受限沙箱，在远程服务场景实际使用的是服务器进程的操作系统权限。它不构成公网多租户隔离。默认模式、显式全权限和本地 stdio MCP 的权限边界都应分别记录与验证。

## 4. 在 Ubuntu 构建机上怎么操作

### 4.1 准备原生构建环境

在干净的 Ubuntu 24.04 同架构构建机上执行：

```bash
uname -m
ldd --version
sudo apt-get update
sudo apt-get install -y \
  build-essential python3 python3-dev \
  ca-certificates curl git tar xz-utils file binutils
```

另外安装与 Linux Lock 一致的构建用 Node/npm。Node 通过固定版本官方归档和该发布的校验文件安装；不要直接假设 Ubuntu 默认 `apt install nodejs` 的版本符合项目要求。构建用 Python 与随包交付的 Python 可以不同。

将所需源码版本完整检出到 Ubuntu；如果当前开发改动尚未提交，需要先保存为明确可复现的源码快照，不能以为另一台机器 clone 后自动带有本机未提交改动。在仓库根目录执行：

```bash
node --version
npm --version
node -p 'process.platform + "-" + process.arch'
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build:server
```

这里仍安装开发依赖，因为构建需要 TypeScript/esbuild/Vite；`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 只避免纯服务构建下载桌面二进制。它不适用于后续要启动 Electron 的客户端测试任务。不要在服务构建机执行默认 `npm run dev` 或把 `npm run build` 当作仅服务构建。

若只想先确认服务入口能在 Ubuntu 启动，现有命令为：

```bash
AGENT_HARNESS_DATA_DIR="$PWD/app-data/ubuntu-smoke" \
  npm start -- --host 127.0.0.1 --port 4317
# 另一个终端
curl --fail http://127.0.0.1:4317/healthz
```

这只能做入口联调：仍有凭据持久化和沙箱缺口，而且未提供 Runtime Pack 时不具备等价的内置解释器/Memory MCP 配置。不能将这一步结果当作自包含发行验收。

### 4.2 完成改造后增加一键打包入口

建议新增以下命令；**当前仓库不能直接执行，需要先按第 3 节实现。**

```bash
npm run pack:runtime:linux -- --target linux-x64
npm run verify:runtime:linux -- --target linux-x64
```

`pack:runtime:linux` 应调用单个编排脚本，由它将目标参数逐步传给准备、校验、打包和最终验证；不要简单在多个 `&&` 命令后追加参数，导致只有最后一步收到目标。

编排顺序：解析目标 Lock → 准备 `.runtime-cache/linux-x64` → 验证解释器/MCP → `npm run build:server` → `prepare-server-package.mjs` → 安装平台生产依赖并加载验证 → 生成 `.tgz/.sha256` → 全新目录安装及服务验收。任何阶段失败均停止发布。

`distribution-manifest.json` 除已有版本/ABI 信息外，建议记录源码版本、Ubuntu 构建基线、架构、实际原生依赖版本、动态库要求、沙箱后端与凭据后端。发布物不包含数据、日志或密钥。

## 5. 在目标服务器上怎么部署

以下步骤以“Linux 适配已完成且平台包通过验收”为前提。采用版本目录加固定数据目录，示例中的版本号应按实际发布物替换。

### 5.1 校验与解压安装

在两个交付文件所在目录执行：

```bash
sha256sum -c agent-harness-runtime-linux-x64-4.7.5.tgz.sha256
sudo useradd --system --user-group --home-dir /var/lib/agent-harness \
  --shell /usr/sbin/nologin agent-harness
sudo install -d -m 0755 /opt/agent-harness/releases/4.7.5
sudo tar -xzf agent-harness-runtime-linux-x64-4.7.5.tgz \
  -C /opt/agent-harness/releases/4.7.5 --strip-components=1
sudo ln -s /opt/agent-harness/releases/4.7.5 /opt/agent-harness/current
sudo install -d -o agent-harness -g agent-harness -m 0700 /var/lib/agent-harness
```

这些是首次安装命令；已有用户、目录或 `current` 链接时按升级流程处理。最终发布前需验证直接解压路径，因为现有验证器主要覆盖 npm 安装路径。

直接解压后通过 `bin/agent-harness` 启动，可以避免目标机为了安装再预装 Node/npm。如果选择 `npm install ./包.tgz`，安装动作本身仍需要 npm。两条安装路径均应保留执行权限并验证可迁移性。

按发布清单安装宿主依赖。若采用上述 Bubblewrap 方案，安装发行版的 `bubblewrap`，并验证 AppArmor 策略。按第 3.3 节完成凭据后端初始化；以下 systemd 示例不会替你生成密钥。

### 5.2 配置 systemd

创建 `/etc/systemd/system/agent-harness.service`：

```ini
[Unit]
Description=Agent Harness Runtime
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=agent-harness
Group=agent-harness
WorkingDirectory=/var/lib/agent-harness
StateDirectory=agent-harness
StateDirectoryMode=0700
UMask=0077
Environment=SHELL=/bin/bash
ExecStart=/opt/agent-harness/current/bin/agent-harness serve --data-dir /var/lib/agent-harness --host 127.0.0.1 --port 4317
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
KillMode=control-group

[Install]
WantedBy=multi-user.target
```

实施凭据方案后，在 `[Service]` 增加例如 `LoadCredential=runtime-master-key:/etc/agent-harness/master.key`，并让 Linux 适配器读取相应文件。源主密钥应由运维初始化并限制访问。该行与适配器应一起交付，不能只添加配置便认为凭据已持久化。

`SHELL=/bin/bash` 用于无交互服务的环境探测；当前探测器依赖 `SHELL`，缺失时会显示 unsupported。systemd 的重启、停止和凭据目录语义按实际安装版本验证。[systemd v255 配置定义](https://github.com/systemd/systemd/blob/v255/man/systemd.exec.xml)

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agent-harness
sudo systemctl status agent-harness --no-pager
curl --fail http://127.0.0.1:4317/healthz
sudo journalctl -u agent-harness -n 100 --no-pager
```

需要交互式创建账号时，在服务运行后使用服务器管理员入口：

```bash
sudo -u agent-harness /opt/agent-harness/current/bin/agent-harness \
  --data-dir /var/lib/agent-harness register
```

随后在 Web/Desktop 登录，配置模型服务、API Key 和默认模型；Mobile 首版不提供这类管理入口。也可在受控初始化期间临时开放注册，完成后移除开关并重启。

### 5.3 HTTPS 与 SSE 反向代理

建议用独立域名根路径，例如 `https://agent.example.com`，将 Web、API 和 SSE 统一代理给回环端口。当前 Web 使用相对 API 地址，Gateway 校验浏览器 Origin 的 host 与请求 Host；反向代理要保留客户端访问的 Host。不要为了换服务器放宽成任意 CORS。

在已经配置好有效证书的 Nginx HTTPS `server` 块中加入：

```nginx
client_max_body_size 25m;

location / {
    proxy_pass http://127.0.0.1:4317;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

这是一段配置片段，不包含证书申请与完整站点定义。应用自身仍执行上传大小与归属校验；代理限额需要覆盖当前 20 MB 单文件上传。SSE 需要关闭响应缓冲并允许长连接，不能只确认首页可打开。[Nginx proxy 模块官方说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)

客户端统一填写公网域名。`127.0.0.1` 在客户端表示客户端自己，`0.0.0.0` 是监听地址；它们都不是手机/其他电脑应填写的远程服务地址。不建议首版部署在 `/agent/` 等路径前缀下，这需要另行检查 Vite 资源 base、API 和客户端 URL 拼接。

## 6. 三端 UI 到底要不要改

| 客户端      | 因 Runtime 换成 Ubuntu 是否需要重写 | 必要配置或验证                                                                                       | 可能的代码调整                                                                                       |
| ----------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Web         | 不需要                              | 随 Server 一起构建和托管，使用新的 HTTPS 域名；验证刷新、登录、SSE、上传下载                         | 修正平台和服务器执行位置的文案；若坚持前后端跨域部署则另做地址与 Origin 配置                         |
| Desktop     | 不需要                              | 首屏改服务器地址并重新登录；现有 macOS 客户端可以连接 Linux 服务                                     | 修改共享文案时重新发布客户端；只有要求 Desktop 本身在 Ubuntu 运行时，才另加 Linux 安装目标和桌面验收 |
| Mobile      | 不需要                              | 手动填写 HTTPS 地址；真实 Android 验证证书、流式响应、后台恢复；Runtime 保持 `mobile` 客户端类型兼容 | 现有首版不支持的附件/产物下载等不会因服务器迁移自动获得支持                                          |
| CLI（补充） | 不需要                              | 独立远程 CLI 使用 `--server https://agent.example.com` 登录                                          | 保持远程 CLI 与服务器管理员入口分工；不向客户端分发 discovery/bootstrap 文件                         |

**最低要求是地址、证书和连接回归；页面结构、聊天交互、HTTP/SSE、会话/队列/审批契约原则上保持现有设计。**在协议兼容的前提下，服务器操作系统变化不要求重发 Desktop/APK。

不过，代码中有几处已经不适合远程多端语义，建议随本次上线做小范围修正：

- `packages/app-ui/src/components/SettingsModal.tsx` 的主题描述“跟随 macOS 外观”改为“跟随设备系统外观”。这是客户端设备主题，与 Runtime 的操作系统无关。
- `packages/app-ui/src/App.tsx` 全权限确认中的“当前登录用户权限”应明确为“Runtime 服务进程的系统权限”，避免用户以为只是客户端设备权限。
- MCP 设置中的“本地”“localhost/127.0.0.1”注明指 Runtime 所在服务器；stdio 命令也在服务器运行。
- 工作区、上传后返回的绝对路径与模型产物路径属于 Ubuntu。客户端继续上传文件内容、通过认证接口下载，不把 Mac/手机路径当作服务器路径。

现有健康接口能报告凭据与解释器状态，但没有完整的 Linux 沙箱能力字段。若新增沙箱后端/持久凭据模式的展示，应同步更新 `packages/protocol`、SDK、共享 UI 和兼容测试；这是可选的能力提示增强，不是迁移操作系统必然要变更协议。

Mobile 已有 React 手机 UI 与 Android 壳源码，当前仓库文档仍明确标注 APK 编译和真机验收未完成。Ubuntu Runtime 打包不应顺带宣称手机已可正式发行，详见 [Mobile 首版](../apps/mobile/README.md)。

## 7. 正式交付前怎么验收

验收分三层；每个宣称支持的架构和 Ubuntu 版本都记录结果。

| 层次     | 必须证明的结果                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 平台包   | SHA-256 正确；错误架构被拒绝；离线 npm 安装和直接解压都能运行；没有系统 Node/Python 时仍使用内置解释器；最终包中 Python 扩展、pip/npm/npx、SQLite 与 Memory MCP 正常            |
| 服务功能 | 空数据目录启动、注册、模型配置与真实可控调用；凭据重启后保留；默认权限下 Bash 写入工作区、禁止越界写入与未授权联网；批准后的操作、超时/取消、MCP 启停、日志脱敏、会话恢复正常   |
| 三端联调 | Web/Desktop/Mobile 连接同一 Ubuntu 服务、同账号共享会话；流式输出、排队、停止、审批、掉线重连；Web/Desktop 上传下载；退出所有客户端后服务仍运行；重启后重新登录可以继续访问数据 |

现有验证器主要验证包安装、解释器、SQLite、入口帮助、服务发现、`/healthz` 和停止；不能替代 Linux 凭据持久性、沙箱与实际三端回归。干净 PATH 测试也不等于目标机完全没有 Node/Python，需要单独的最小环境测试。

实施完成后运行适当的静态与行为检查：

```bash
npm run typecheck
npm run lint
npm test
npm run verify:server-package
```

其中 `verify:server-package` 需要先生成本次的 Server npm 包，可由 `npm run pack:server` 连同构建一起执行，避免测试旧产物。新增平台适配测试要覆盖实际 Linux 执行，不能只改测试里的平台字符串。

客户端测试任务另行准备 Playwright 浏览器及 Electron/显示环境，然后运行现有 `verify:remote`；`verify:mobile` 覆盖的浏览器流程不能替代 Android 真机测试。现有脚本会创建本地测试 Server，因此跨主机/HTTPS 验收还需增加可指定 Ubuntu 测试服务地址的流程或执行对应人工用例。已有失败应区分历史基线和本次新增回归，不凭旧文档推断当前一定通过。

## 8. 升级、迁移与实施顺序

升级时先停止服务，备份完整数据目录和独立凭据材料，将新程序放入新版本目录，再切换 `current` 并启动。备份 SQLite 要保证一致性，可停服后连同相关文件整体备份。程序回滚若涉及数据库迁移，必须同时确认 schema 向后兼容，必要时恢复对应数据备份；只切回旧程序不保证成功。

如果从现有 Mac 迁移业务数据：先停止旧 Runtime 并备份，再迁移数据库、Skill、Workspace、记忆文件等用户资源；检查大小写敏感路径、绝对路径和 Mac 专用命令。Keychain 内容不在 SQLite 中，需要重新录入或使用明确的安全迁移流程。本地 MCP 里的 Mac 可执行路径也要调整为 Ubuntu 路径。不要复制旧平台二进制，不要让两个实例同时写同一份数据。

建议实施顺序：

1. 确定 Ubuntu 24.04 x64 基线，选定并核验 Linux 上游资产，完成平台 Lock 和统一目标解析。
2. 补齐 Linux 持久凭据与默认权限沙箱，先证明重启与工具执行行为成立。
3. 参数化打包/验证脚本，处理原生依赖与共享库链接，生成完整自包含包。
4. 在干净 Ubuntu 上完成解压、systemd、账号初始化、HTTPS 与 SSE 部署。
5. 调整共享文案，完成三端跨设备回归和升级恢复演练，再发布支持矩阵。

本次工作的主要改动落在 `build-support`、`resources`、`packages/execution` 和 `packages/server-core`；三端继续复用当前 UI 与网络边界。
