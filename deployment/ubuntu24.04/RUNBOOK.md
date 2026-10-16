> 用户系统更新：账号由客户端本地管理，Runtime 信任内部 userId。注册仅填写账号和密码，标识由系统自动生成且不展示，不提供手动绑定入口；旧注册开放参数已无效果。已有本地账号沿用原数据。详见 [当前用户边界](../../docs/多端工程拆分与远程客户端架构.md#客户端用户与-runtime-数据归属)。

# Ubuntu 24.04.4 打包、部署与验证操作步骤

## 仅部署 Runtime + Web：一键入口

已上传完整源码的 Ubuntu 24.04+ 服务器，在项目根目录以有 sudo 权限的普通用户执行：

```bash
bash deployment/ubuntu24.04/deploy.sh
```

默认监听 **0.0.0.0:4317**。自动准备系统依赖与必要的 bwrap 策略、调用下述 `package.sh` 打包验证、
解压安装、停服备份、配置 `agent-harness-web.service` 并启动和启用开机自启。无需提前安装 Node/npm。
成功后浏览器访问 `http://服务器IP:4317/`；防火墙/云安全组由部署者放行。
参数、重复更新、已有手工服务与失败恢复见 [一键部署说明](DEPLOY.md)。
以下分步流程继续用于单独打包、Desktop 验证和排错。

## 0. 本次任务与执行原则

目标机器已远程确认为 Ubuntu 24.04.4 LTS / noble、x86_64、glibc 2.39，无桌面会话。本文是可重复执行步骤；本次结果单独记录在 [2026-09-11 验收报告](VALIDATION-20260911.md)。

本轮执行两条链路：

1. **Linux Runtime＋Web**：选择 Linux Node/Python 下载源，原生构建自包含包，完成安装、服务启动及功能验证。
2. **Linux Desktop Client**：构建 Electron 的 Linux AppImage 和 tar.gz，检查纯客户端边界，验证连接前述服务。Client 在这里指桌面客户端，不是 CLI。

Web 已包含在 Runtime 包中。Desktop 不携带 Runtime。手机本阶段仍以 Android APK 为后续独立交付，不在这台服务器上扩展 iOS 或 Windows 流程。

所有命令按章节顺序执行。标记“本机”的命令在开发电脑运行；其余命令在目标 Ubuntu 的 **Bash** 中运行。每个构建步骤返回成功后再进入下一步；管道日志使用 `set -o pipefail`，不能让 `tee` 掩盖失败。不要同时在同一份源码目录跑两次打包。

## 日常一键打包入口

本次验证过的流程已编入 `deployment/ubuntu24.04/package.sh`。在 **Ubuntu 构建机的项目根目录**执行：

这里的项目根目录指包含 `package.json`、`apps/`、`packages/` 和 `deployment/` 的目录。本次服务器放在 `/home/ubuntu/agent-harness-deploy/src`；`src` 只是存放完整项目的目录名，不是项目内部的源码子目录。先同步完整最新源码，排除 Mac 的 `node_modules`、构建产物和运行数据。以下三个实际打包命令按需三选一，不需要依次执行；仅更新 Runtime 时选择默认命令即可，Web 会随包重新构建。

```bash
npm run pack:ubuntu                 # 默认 Runtime + Web，含回归和实际包功能验证
npm run pack:runtime:deb            # 上一步成功后追加生成 Runtime .deb
npm run pack:ubuntu -- --client     # Linux Desktop：AppImage + tar.gz，含包内容检查
npm run pack:ubuntu -- --all        # 顺序打包 Runtime + Web 和 Linux Desktop
npm run pack:ubuntu -- --dry-run    # 只看执行流程，可在 Mac 上运行
```

如果机器还没有 Node/npm，可直接执行同一个入口：

```bash
bash deployment/ubuntu24.04/package.sh --all
```

**首次准备**：先按第 4 节安装系统工具和 Desktop 动态库，Runtime 验证还需第 5.1 节的 bubblewrap/AppArmor 配置。脚本检测缺失项并停止提示，不自动修改系统策略。Node 引导下载由脚本完成，不必再手工下载 Node 或提前 `npm ci`。首次准备后的每次打包只需上述一条命令。

脚本自动识别 Ubuntu/CPU，在专用 tools 目录检查并准备 Lock 指定的 Node，校验下载 SHA-256，加载国内镜像和编译并发设置；仅 Runtime 使用 `npm run install:runtime` 和 `npm run typecheck:runtime`，Client/All 使用全量 `npm ci` 和 `npm run typecheck`；Runtime 分支执行账号、凭据和客户端等回归、平台打包、离线安装、归档摘要、解压包功能测试；Client 分支执行桌面构建、electron-builder、纯客户端检查和摘要生成。`--force` 可转发给 Runtime 解释器准备步骤。仅 Runtime 构建不安装 Electron npm 包及桌面打包工具。

输出目录固定为 `release/runtime/linux-<arch>/` 和 `release/desktop-linux/`；完整日志保存在 `${AGENT_DEPLOY_ROOT:-$HOME/agent-harness-deploy}/logs/ubuntu-package-*.log`。脚本对同一工作区加锁，验证数据使用自动清理的临时目录，任何阶段失败就停止。它不会切换正在运行的 systemd 服务或覆盖服务数据。不要与其他底层打包命令同时操作同一工作区。

Client 分支完成的是构建和包内容验证；Xvfb/真实桌面联调仍按第 9 节执行。当前已实测 Ubuntu 24.04.4 x64；其他 Ubuntu 版本/ARM 需要在相应机器完成验证。下文保留逐步命令，供首次配置、排错和部署使用。

Runtime `.deb` 安装、依赖、AppArmor 与卸载约定见 [Debian Runtime 说明](RUNTIME-DEB.md)。它与下文 Desktop AppImage 是不同交付物，安装时不自动启动服务。

## 1. 目录隔离

仓库中的 `deployment/` 保存文档、配置和验收模板。服务器专门建立：

```text
/home/ubuntu/agent-harness-deploy/
  src/                     # 本轮完整源码快照，包括 deployment/
  downloads/               # 下载归档与校验信息
  tools/                   # 构建用 Node 等工具
  artifacts/<run-id>/       # 待交付 Runtime/Desktop 包和摘要
  releases/<run-id>/        # 从交付包解压的 Runtime 程序
  data/<run-id>/            # 每轮前台验收数据
  data/service-test/        # 独立 systemd 测试数据
  logs/<run-id>/            # 构建、测试及服务日志
  reports/<run-id>/         # 验收报告
  current -> releases/...  # 仅供本轮测试 systemd 服务使用
```

这与机器上已有应用或已有 `agent-harness` 服务分开。默认测试端口为回环地址 `127.0.0.1:14317`；若被占用，选择其他空闲端口并同步修改命令和服务模板。不得为了腾出端口停止未知进程。

约定用户为 `ubuntu`。若实际 SSH 用户或 home 不同，统一替换目录及 `agent-harness-test.service` 中的 `User`、工作目录、程序和数据路径。构建与 Electron 使用普通用户，不使用 root 运行客户端。

## 2. 连接与环境确认

执行者需先获得 SSH 的主机/用户名/端口，以及本机已有的密钥路径或 SSH 配置别名。不要将密码、私钥或 API Key 写入本文、Git、命令行参数或日志。

本机示例：以下假设已在本机 SSH 配置中设置 `agent-build` 别名；它不是已知的实际服务器地址。

```bash
ssh agent-build
```

Ubuntu 上先只读确认环境：

```bash
cat /etc/os-release
uname -m
uname -r
ldd --version
id
df -h . /tmp
free -h
command -v node npm python3 git tar xz file
printf 'DISPLAY=%s\n' "${DISPLAY:-unset}"
ss -ltn
sudo -n true
```

`sudo -n true` 只检查当前是否可以免交互提权，失败不表示机器不可用；安装系统依赖时需要使用已授权的 sudo 方式。不要收集完整环境变量、SSH 配置正文或用户 home 文件列表。

建议准备至少约 15 GB 可用磁盘和 4 GB 内存作为本轮工作余量；这是工作预算，不是产品最低配置。磁盘不足时先记录情况，不清理其他应用的数据。

```bash
export AGENT_DEPLOY_ROOT="$HOME/agent-harness-deploy"
export AGENT_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$AGENT_DEPLOY_ROOT"/{src,downloads,tools,artifacts,releases,data,logs,reports}
mkdir -p "$AGENT_DEPLOY_ROOT"/{artifacts,logs,reports,data}/"$AGENT_RUN_ID"
chmod 700 "$AGENT_DEPLOY_ROOT/data" "$AGENT_DEPLOY_ROOT/logs"
set -o pipefail
```

记录本次 `AGENT_RUN_ID`。后续重开终端时重新设置相同值，不要生成另一个时间戳后误读上一轮目录。

## 3. 传入完整源码

当前工作区存在未提交的新目录和改动，单纯从旧 commit clone 不能得到本轮脚本。优先提交/固定这次要验证的版本后检出；如果传工作区快照，必须包含未提交的 `apps/`、`packages/`、`build-support/`、`scripts/`、`deployment/`、Lock 和根构建配置，并记录这是工作区快照。

本机在项目根目录执行以下快照同步。此方案要求两端已有 rsync，并且目标 `src/` 为本轮专用的新目录；重做不同快照时使用新的工作区，不对混有其他文件的目录执行清空操作。

```bash
ssh agent-build 'mkdir -p /home/ubuntu/agent-harness-deploy/src'
rsync -az \
  --exclude='.git/' --exclude='node_modules/' \
  --exclude='dist/' --exclude='dist-*/' --exclude='release/' \
  --exclude='.runtime-cache/' --exclude='.service-cache/' \
  --exclude='app-data/' --exclude='test-results/' --exclude='playwright-report/' \
  --exclude='server_info/' --exclude='.env' --exclude='.env.*' --exclude='*.log' \
  --exclude='*.pem' --exclude='*.key' --exclude='*.db*' \
  --exclude='*.sqlite*' --exclude='reference_ui/' \
  --exclude='.gradle/' --exclude='local.properties' \
  ./ agent-build:/home/ubuntu/agent-harness-deploy/src/
```

同步前确认源码目录中没有其他自定义秘密文件；以上排除项不等于任意路径的秘密扫描。不要直接把 Mac 的依赖或 Runtime 缓存复制到 Linux。

Ubuntu 上：

```bash
cd "$AGENT_DEPLOY_ROOT/src"
test -f scripts/pack-runtime.mjs
test -f resources/runtime-locks/linux-x64.json
test -f deployment/ubuntu24.04/electron-builder.linux.json
cp deployment/ubuntu24.04/VALIDATION.md \
  "$AGENT_DEPLOY_ROOT/reports/$AGENT_RUN_ID/VALIDATION.md"
sha256sum package.json package-lock.json resources/runtime-locks/linux-*.json \
  > "$AGENT_DEPLOY_ROOT/reports/$AGENT_RUN_ID/source-locks.sha256"
```

如果用 Git 检出，另记录 `git rev-parse HEAD` 和 `git status --short`；使用 rsync 的快照没有 `.git`，由开发机提供基准 commit 和改动说明。根 `.gitignore` 已为 `scripts/pack-runtime.mjs` 与打包测试补充例外，后续提交时确认它们出现在提交内容中。

## 4. 构建工具与 Node 引导安装

本轮还需要 Desktop，使用全量 `npm ci`；仅服务构建请使用 `npm run install:runtime`，无需设置 `ELECTRON_SKIP_BINARY_DOWNLOAD`。

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential python3 python3-dev ca-certificates curl git rsync \
  tar xz-utils file binutils ripgrep xvfb xauth dbus-x11 bubblewrap \
  libgtk-3-0t64 libasound2t64 libnss3 libgbm1 libxss1 libxtst6 libx11-xcb1 libdrm2 libfuse2t64
unset ELECTRON_SKIP_BINARY_DOWNLOAD
```

按真实 CPU 选择架构：

```bash
case "$(uname -m)" in
  x86_64) export AGENT_BUILD_ARCH=x64 ;;
  aarch64|arm64) export AGENT_BUILD_ARCH=arm64 ;;
  *) printf 'Unsupported CPU architecture\n' >&2; exit 1 ;;
esac
export AGENT_BUILD_TARGET="linux-$AGENT_BUILD_ARCH"
export AGENT_RUNTIME_LOCK="$AGENT_DEPLOY_ROOT/src/resources/runtime-locks/$AGENT_BUILD_TARGET.json"
```

若尚无与 Lock 一致的 Node，用系统 Python 读取已经核验的 Lock，下载官方 Node 并校验，不使用滚动 latest 地址：

```bash
mapfile -t AGENT_NODE_META < <(python3 - "$AGENT_RUNTIME_LOCK" <<'PY'
import json, sys
entry = json.load(open(sys.argv[1]))['node']
for field in ['version', 'artifact', 'sha256']:
    print(entry[field])
print(entry['urls'][0])
PY
)
test "${#AGENT_NODE_META[@]}" -eq 4
export AGENT_BUILD_NODE_DIR="$AGENT_DEPLOY_ROOT/tools/node-${AGENT_NODE_META[0]}-$AGENT_BUILD_ARCH"
curl --fail --location --retry 2 \
  --output "$AGENT_DEPLOY_ROOT/downloads/${AGENT_NODE_META[1]}" "${AGENT_NODE_META[3]}"
printf '%s  %s\n' "${AGENT_NODE_META[2]}" \
  "$AGENT_DEPLOY_ROOT/downloads/${AGENT_NODE_META[1]}" | sha256sum --check -
mkdir -p "$AGENT_BUILD_NODE_DIR"
tar -xJf "$AGENT_DEPLOY_ROOT/downloads/${AGENT_NODE_META[1]}" \
  -C "$AGENT_BUILD_NODE_DIR" --strip-components=1
export PATH="$AGENT_BUILD_NODE_DIR/bin:$PATH"
node --version
npm --version
node -p 'process.platform + "-" + process.arch'
```

摘要不一致立即停止。已存在的工具目录先检查版本，不能把不同归档叠加解压到同一目录。`npm ci` 和后续打包都使用当前 PATH 的构建 Node；平台包内部原生依赖由包内 Node 安装，SQLite 13.0.3 使用包内 node-gyp 强制原生编译并剔除其他平台预编译文件。源码开发和轻量 Server 需要 Node 22+；避免旧 SQLite 与 Node 24.20 的清理钩子崩溃组合。

Node/Python 当前固定为 24.20.0 / 3.13.15（Python 发布 20260807）。Python 使用常规 GNU/Linux `install_only_stripped`，不使用 musl、freethreaded 或更高 CPU 指令集变体。两个架构的真实链接、摘要来源及后备源见 [下载源说明](../../docs/Runtime多平台打包入口.md#linux-下载地址)。

Node 首选官方、npmmirror 为相同文件/摘要的后备源。Python 的两个 Linux Lock 已改为南京大学镜像；Electron 和 electron-builder 工具使用 npmmirror。本机 GitHub 直连超时，因此本轮不使用 GitHub 下载回退。Python 保持上游 SHA-256，Electron 使用 npm 安装包内的校验清单；不设置跳过校验。已校验的解释器归档缓存在 `.runtime-cache/archives/`，重试时先重新校验缓存。

## 5. 安装项目依赖与基础检查

```bash
cd "$AGENT_DEPLOY_ROOT/src"
source deployment/ubuntu24.04/build-env.sh
npm ci 2>&1 | tee "$AGENT_DEPLOY_ROOT/logs/$AGENT_RUN_ID/npm-ci.log"
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -p 'process.versions.electron'
npm run typecheck 2>&1 | tee "$AGENT_DEPLOY_ROOT/logs/$AGENT_RUN_ID/typecheck.log"
npm run lint 2>&1 | tee "$AGENT_DEPLOY_ROOT/logs/$AGENT_RUN_ID/lint.log"
npx --no-install vitest run tests/unit/runtime-packaging.test.mjs \
  2>&1 | tee "$AGENT_DEPLOY_ROOT/logs/$AGENT_RUN_ID/packaging-tests.log"
```

若 Electron 缺动态库，先执行第 9 节的浏览器/显示依赖安装，再重试版本探测；这一阶段不使用 `--no-sandbox` 绕过启动错误。静态检查若出现历史失败，记录确切输出并与基线区分，不改成“全部通过”。

Runtime 一键脚本会用已校验的构建 Node 自带 `include/node`；平台包原生编译则显式使用包内 Node 的头文件，不再额外下载头文件或 `SHASUMS256.txt`。配置采用 `npm_package_config_node_gyp_nodedir`，只用于 Node Runtime 构建，不能拿 Node 头文件重建 Electron 模块。

`better-sqlite3` 需要源编译时，检查 npm 实际使用的 node-gyp 版本，系统 Python 3.12+ 需 node-gyp 10+。不要仅安装全局 node-gyp 后假定问题解决。[node-gyp 官方要求](https://github.com/nodejs/node-gyp#installation)

### 5.1 Ubuntu 受限工具进程的 AppArmor 配置

2026-09-12 修复：stdio MCP（含内置 memory）也接入同一 bubblewrap 提供器。系统目录与捆绑 Runtime 只读，每个用户/Agent/服务实例仅可写自己的数据目录，HOME/临时文件也位于该目录。自定义 stdio 的程序与依赖需要位于系统目录、捆绑 Runtime 或当前实例目录；不挂载整个宿主根目录、用户 Home 或 Runtime 数据根。沙箱缺失或被系统拒绝时停止启动，不降级为无沙箱执行。连接测试返回可显示的 `errorCode` 和 `message`；外部客户端需使用这些字段替换统一失败提示。

打包验证现在必须经过 Runtime 的 `mcp-server.test`，完整功能烟测再经过 `mcp_load` 和实际记忆工具，并在服务重启后读取同一条记忆。直接用 MCP SDK 启动 memory 不再代表 Runtime 的 stdio 路径验收通过。`package.sh` 会额外运行真实 stdio 隔离回归；独立执行方式如下（先准备对应平台 Runtime）：

```bash
AGENT_TEST_RUNTIME_ROOT="$PWD/.runtime-cache/linux-$(node -p process.arch)" \
  node node_modules/vitest/vitest.mjs run tests/integration/mcp-stdio-sandbox.test.ts
```

本次代码修复与验证边界见 [Linux MCP 修复记录](MCP-STDIO-20260912.md)。

Linux 的 `guarded` / `approval-required` Bash 通过 bubblewrap 隔离挂载和网络。Ubuntu 24.04 的 AppArmor 用户命名空间限制可能允许创建 namespace、却拒绝 namespace 初始化所需能力。本仓库附带基于上游 `bwrap-userns-restrict` 的专用配置；父 bwrap 仅在初始化阶段获得所需能力，执行子进程时叠加 `unpriv_bwrap` 禁止 capability。全局用户命名空间限制继续启用。

```bash
cd "$AGENT_DEPLOY_ROOT/src"
sudo apparmor_parser -Q deployment/ubuntu24.04/bwrap-userns-restrict.apparmor
sudo install -m 0644 deployment/ubuntu24.04/bwrap-userns-restrict.apparmor \
  /etc/apparmor.d/agent-harness-bwrap
sudo apparmor_parser -r /etc/apparmor.d/agent-harness-bwrap
npx --no-install vitest run tests/unit/linux-platform.test.ts
```

应在第 5 节 Linux 沙箱测试前安装该策略；已有受管理 bwrap 策略的机器先检查冲突，不能覆盖其他配置。此文件针对 Ubuntu 24.04 的 AppArmor ABI 4.0 适配，其他发行版需重新验证。参考 [Ubuntu 用户命名空间说明](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007) 和 [上游 bwrap 配置](https://gitlab.com/apparmor/apparmor/-/raw/master/profiles/apparmor/profiles/extras/bwrap-userns-restrict)。

Runtime 凭据已统一改用同一 SQLite 数据库的 `credential_secrets` 表保存明文，Linux 不再创建加密文件或主密钥。`AGENT_HARNESS_CREDENTIAL_KEY_FILE` 仅供旧文件的一次性迁移使用。升级旧安装前先停止服务并备份，再执行 `credentials migrate-files`，见[凭据存储与迁移](../../docs/Runtime凭据存储与迁移.md)。数据库及 WAL、备份包含 API Key；`full-access` 与用户授权的 stdio MCP 属于可信执行边界，不是多租户隔离。

## 6. Runtime＋Web 打包

先预览目标和流程，再实际运行：

```bash
npm run pack:runtime -- --target "$AGENT_BUILD_TARGET" --dry-run
npm run pack:runtime -- --target "$AGENT_BUILD_TARGET" \
  2>&1 | tee "$AGENT_DEPLOY_ROOT/logs/$AGENT_RUN_ID/runtime-build.log"
```

也可以执行 `npm run pack:runtime` 交互选择 Linux 和 CPU。流程自动包含解释器准备、Memory MCP 校验、Server/Admin/SDK/Web 构建、SQLite 安装与加载、`.tgz/.sha256` 生成及离线安装冒烟。**不再单独打一个 Web 安装包。**

```bash
export AGENT_RUNTIME_VERSION="$(node -p 'require("./build-support/server-package/package.json").version')"
export AGENT_RUNTIME_PACKAGE="agent-harness-runtime-$AGENT_BUILD_TARGET-$AGENT_RUNTIME_VERSION.tgz"
export AGENT_RUNTIME_OUTPUT="$AGENT_DEPLOY_ROOT/src/release/runtime/$AGENT_BUILD_TARGET"
(cd "$AGENT_RUNTIME_OUTPUT" && sha256sum -c "$AGENT_RUNTIME_PACKAGE.sha256")
cp "$AGENT_RUNTIME_OUTPUT/$AGENT_RUNTIME_PACKAGE" \
  "$AGENT_RUNTIME_OUTPUT/$AGENT_RUNTIME_PACKAGE.sha256" \
  "$AGENT_DEPLOY_ROOT/artifacts/$AGENT_RUN_ID/"
```

当前 Runtime 版本来自服务分发模板，Desktop 版本来自根 `package.json`，两者可能不同。记录真实版本，不手动把文件名统一后误认为内部版本已经变更。

## 7. 从交付包解压并运行

这里验证实际 `.tgz`，不直接运行源码目录的 `dist/server`。

```bash
export AGENT_RUNTIME_DIR="$AGENT_DEPLOY_ROOT/releases/$AGENT_RUN_ID"
export AGENT_TEST_DATA="$AGENT_DEPLOY_ROOT/data/$AGENT_RUN_ID"
test ! -e "$AGENT_RUNTIME_DIR"
mkdir -p "$AGENT_RUNTIME_DIR"
tar -xzf "$AGENT_DEPLOY_ROOT/artifacts/$AGENT_RUN_ID/$AGENT_RUNTIME_PACKAGE" \
  -C "$AGENT_RUNTIME_DIR" --strip-components=1
"$AGENT_RUNTIME_DIR/bin/agent-harness" --help
"$AGENT_RUNTIME_DIR/runtime/node/bin/node" --version
"$AGENT_RUNTIME_DIR/runtime/python/bin/python3" -c \
  'import ssl, sqlite3, ctypes, venv; print(ssl.OPENSSL_VERSION)'
ldd "$AGENT_RUNTIME_DIR/runtime/node/bin/node"
ldd "$AGENT_RUNTIME_DIR/vendor/better-sqlite3/build/Release/better_sqlite3.node"
```

动态库检查不能出现 `not found`，也不能有高于目标系统的 `GLIBC/GLIBCXX` 需求。发现错误时修复构建基线或依赖，再重新打包，不在目标机替换核心系统 libc。

确认 14317 未被占用后，在当前终端以前台方式启动：

```bash
"$AGENT_RUNTIME_DIR/bin/agent-harness" serve \
  --data-dir "$AGENT_TEST_DATA" --host 127.0.0.1 --port 14317 \
  2>&1 | tee "$AGENT_DEPLOY_ROOT/logs/$AGENT_RUN_ID/runtime-foreground.log"
```

另开 SSH 终端，重新设置本轮目录变量，然后：

```bash
curl --fail http://127.0.0.1:14317/healthz
curl --fail http://127.0.0.1:14317/ \
  -o "$AGENT_DEPLOY_ROOT/reports/$AGENT_RUN_ID/web-index.html"
"$AGENT_RUNTIME_DIR/bin/agent-harness" --data-dir "$AGENT_TEST_DATA" register
```

`register` 是服务器管理员入口，交互创建临时测试账号；不用公开远程注册开关。不要保存包含账号密码/Token 的完整接口响应。

本机用 SSH 隧道访问 Web，避免为基础验收开放公网端口：

```bash
ssh -N -L 14317:127.0.0.1:14317 agent-build
# 浏览器打开 http://127.0.0.1:14317
```

客户端填写地址时，回环地址必须有明确含义：同一台 Ubuntu 的 Desktop 可直接使用该地址；开发电脑只有建立上面的隧道后才能使用它。

## 8. Linux Desktop 打包

本轮新增专用 [electron-builder 配置](electron-builder.linux.json)，不改变 macOS 默认发行目标。输出 AppImage 和 tar.gz；若后续必须 `.deb`，再补维护者信息、依赖声明和 dpkg 安装/卸载验收。

```bash
cd "$AGENT_DEPLOY_ROOT/src"
npm run build:desktop 2>&1 | tee "$AGENT_DEPLOY_ROOT/logs/$AGENT_RUN_ID/desktop-build.log"
npx --no-install electron-builder \
  --config deployment/ubuntu24.04/electron-builder.linux.json \
  --linux --"$AGENT_BUILD_ARCH" --publish never \
  2>&1 | tee "$AGENT_DEPLOY_ROOT/logs/$AGENT_RUN_ID/desktop-package.log"
```

此配置已在本次 Ubuntu x64 构建中产出两种交付包。它仅包含桌面 Main/Preload/Renderer 和图标，禁止携带 Server、SQLite、Memory MCP 或 Node/Python Runtime Pack。配置方式参考 [electron-builder 配置](https://www.electron.build/configuration/) 与 [Linux 目标](https://www.electron.build/linux/)。

```bash
export AGENT_DESKTOP_OUTPUT="$AGENT_DEPLOY_ROOT/src/release/desktop-linux"
case "$AGENT_BUILD_ARCH" in
  x64) export AGENT_DESKTOP_DIR="$AGENT_DESKTOP_OUTPUT/linux-unpacked" ;;
  arm64) export AGENT_DESKTOP_DIR="$AGENT_DESKTOP_OUTPUT/linux-arm64-unpacked" ;;
esac
export AGENT_DESKTOP_EXECUTABLE="$AGENT_DESKTOP_DIR/agent-harness-client"
test -x "$AGENT_DESKTOP_EXECUTABLE"
node scripts/verify-desktop-package.mjs "$AGENT_DESKTOP_DIR/resources"
(cd "$AGENT_DESKTOP_OUTPUT" && sha256sum *.AppImage *.tar.gz > desktop-SHA256SUMS)
cp "$AGENT_DESKTOP_OUTPUT/"*.AppImage "$AGENT_DESKTOP_OUTPUT/"*.tar.gz \
  "$AGENT_DESKTOP_OUTPUT/desktop-SHA256SUMS" "$AGENT_DEPLOY_ROOT/artifacts/$AGENT_RUN_ID/"
```

现有 `verify-desktop-package.mjs` 虽然默认指向 Mac 目录，但接受 resources 路径参数，因此这里可复用。它是包内容检查，不是 Linux GUI 运行证明。

## 9. Linux 客户端运行测试

### 9.1 无桌面的云服务器：自动回归

Electron 需要显示环境。无物理桌面时用 Xvfb 提供虚拟显示，参考 [Electron 无界面 CI 测试说明](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci)。

在首次启动 Desktop 前，为已验证的目标文件配置（需要 sudo）：

```bash
cd "$AGENT_DEPLOY_ROOT/src"
npx --no-install playwright install --with-deps --no-shell chromium
bash deployment/ubuntu24.04/install-client-userns.sh "$AGENT_DESKTOP_EXECUTABLE"
# 实际运行 AppImage 时，应传 AppImage 本身的绝对路径，再运行它。
# Web 自动化浏览器也可能需要同样权限；先安装 Playwright 浏览器：
export PLAYWRIGHT_CHANNEL=chromium
AGENT_BROWSER_EXE="$(node --input-type=module -e 'import {chromium} from "playwright"; console.log(chromium.executablePath())')"
bash deployment/ubuntu24.04/install-client-userns.sh "$AGENT_BROWSER_EXE"
```

该脚本创建按路径摘要命名的 `/etc/apparmor.d/agent-harness-client-*`，仅为传入路径开放 userns；不修改 sysctl，不赋予 setuid，不使用路径通配符。`flags=(unconfined)` 配合 `userns` 是 Ubuntu 为此类应用提供的策略形式，它不是应用文件访问隔离策略；Chromium 自己的 namespace/seccomp 沙箱继续启用。只对可信且已校验的程序执行，移动文件后需为新路径配置。依据 [Ubuntu 24.04 发布说明](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890)。

```bash
cd "$AGENT_DEPLOY_ROOT/src"
npm run build:cli
export AGENT_RUNTIME_EXECUTABLE="$AGENT_RUNTIME_DIR/bin/agent-harness"
export AGENT_VALIDATION_OUTPUT="$AGENT_DEPLOY_ROOT/reports/$AGENT_RUN_ID"
node scripts/verify-runtime-features.mjs \
  2>&1 | tee "$AGENT_DEPLOY_ROOT/logs/$AGENT_RUN_ID/runtime-features.log"
dbus-run-session -- xvfb-run -a \
  node scripts/verify-remote-clients.mjs \
  2>&1 | tee "$AGENT_DEPLOY_ROOT/logs/$AGENT_RUN_ID/desktop-remote-smoke.log"
```

必须保留上一步导出的 `AGENT_DESKTOP_EXECUTABLE`，否则脚本测试开发版 Electron 而不是打包客户端。先确认 `test -x "$AGENT_DESKTOP_EXECUTABLE"`。

**必须设置 `AGENT_RUNTIME_EXECUTABLE`。** 两个脚本会用交付包启动独立临时实例，测试后退出并删除临时数据。`verify-runtime-features` 使用本机确定性 OpenAI-compatible 测试服务，覆盖模型配置、鉴权、SSE、审批、包内 Node/Python 工具执行、产物下载、取消与队列续跑、重启凭据和 Memory MCP 持久化；不代表真实商业模型兼容性验收。`verify-remote-clients` 覆盖 Web/打包 Desktop/CLI 登录、共享会话、文件操作与客户端退出独立性。不设置上述变量时后者仍默认源码 Server。

Ubuntu AppArmor/Chromium 沙箱问题与 Runtime 的 bubblewrap 工具沙箱分别处理。本次遇到 userns 能力拒绝及 SUID helper 错误，已用准确程序路径的 AppArmor 配置解决。自动化脚本显式使用 `chromiumSandbox: true`，不会采用 Playwright 默认关闭沙箱的行为。

### 9.2 与实际 Runtime 包联调

有 Ubuntu 图形桌面的终端运行：

```bash
AGENT_HARNESS_SERVER_URL=http://127.0.0.1:14317 \
  "$AGENT_DESKTOP_EXECUTABLE"
```

使用第 7 节的测试账号，验收登录、新建/切换会话、Web/Desktop 共享会话、附件、产物下载、断线和客户端退出后的服务存活。真实模型调用使用专门测试凭据与限定任务，通过 UI 输入秘密，不打印 Key。

无图形环境时执行 9.1 的 Xvfb 自动化场景，它已有界面与接口断言并连接解压后的 Runtime。它仍不能替代真实桌面的输入法、窗口管理器和文件选择器人工验收。

另外把最终 AppImage/tar.gz 放到有图形环境的 Ubuntu 测试机，校验摘要并从交付包启动，验证中文输入、窗口缩放、文件选择和下载。测试 `linux-unpacked` 不等于验证 AppImage 加载器。AppImage 若缺 FUSE，记录宿主依赖并安装匹配版本，或使用 tar.gz 分发路径；两者结果分开填写。

## 10. Runtime 完整功能门槛

| 场景                   | 应有结果                                   | 当前说明                                                 |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------- |
| 首次登录与模型配置     | 空账号开始，配置成功后可发起任务           | 待实测                                                   |
| SSE/排队/取消/断线恢复 | 输出持续更新，恢复后会话一致               | 待实测；首页成功不能替代                                 |
| API Key 持久化         | 重启并重新登录后仍能调用模型               | 已实现 SqliteCredentialStore；凭据与业务数据库一起持久化 |
| 默认权限 Bash          | 允许工作区内操作，阻止未批准越界写入和联网 | 已实现 bubblewrap；先完成第 5.1 节策略与边界测试         |
| 审批与显式全权限       | 权限边界与界面声明一致                     | 不通过默认改成 full-access 绕过                          |
| Memory MCP             | 工具可发现，记忆能写入并在重启后读回       | 打包准备的 listTools 成功不等于记忆持久验收              |
| 客户端独立性           | 关闭 Web/Desktop 后 Runtime 继续工作       | 待实测                                                   |

构建、功能、真实桌面、外部模型与公网访问分别记录结果，不将未执行场景算作通过。具体适配背景见 [Ubuntu 实施设计](../../docs/Ubuntu24.04及以上Runtime打包部署与三端UI影响说明.md)。

## 11. 独立 systemd 测试服务

使用单独的 `agent-harness-test` 服务名。先在前台终端按 Ctrl+C 正常退出本次实例，再检查端口；不要停止机器上未知的正式服务。

下面的配置是测试模板，不含生产凭据初始化。它使用 `data/service-test`，与前台每轮测试数据分开，需在这个实例单独初始化测试账号。首次设置 `current` 前确认其不存在：

```bash
test ! -e "$AGENT_DEPLOY_ROOT/current"
test ! -L "$AGENT_DEPLOY_ROOT/current"
ln -s "$AGENT_RUNTIME_DIR" "$AGENT_DEPLOY_ROOT/current"
install -d -m 0700 "$AGENT_DEPLOY_ROOT/data/service-test"
sudo install -m 0644 deployment/ubuntu24.04/agent-harness-test.service \
  /etc/systemd/system/agent-harness-test.service
sudo systemctl daemon-reload
sudo systemctl start agent-harness-test
sudo systemctl status agent-harness-test --no-pager
curl --fail http://127.0.0.1:14317/healthz
sudo journalctl -u agent-harness-test -n 100 --no-pager
sudo systemctl restart agent-harness-test
curl --fail http://127.0.0.1:14317/healthz
```

重启后等服务 ready 再测试；若立即 curl 遇到拒绝连接，先查看状态，不把启动时间误判成业务失败。测试默认不启用开机启动；需要常驻时另行执行 `systemctl enable`。收尾使用 `sudo systemctl stop agent-harness-test`，保留数据与报告。

需要跨设备生产访问时再配置有效 HTTPS 证书和同源反向代理，保留 Host、关闭 SSE 响应缓冲，验证大文件上传限制与长连接，详见 [HTTPS 部署示例](../../docs/Ubuntu24.04及以上Runtime打包部署与三端UI影响说明.md#53-https-与-sse-反向代理)。SSH 隧道验收不能代替公网 HTTPS 验收。

## 12. 升级、回滚、交付

升级只处理这套测试服务：停止 `agent-harness-test` → 确认退出 → 备份对应数据目录及独立凭据材料 → 将新包解压到新的 releases 目录 → 切换自己的 `current` → 启动并验证。不要覆盖旧 releases 或复用已有解压目录。

回滚先确认数据库 schema 与旧程序兼容；不兼容时同时恢复升级前的数据及凭据备份。仅切换软链接不保证数据库可回滚。任何时候不允许两个实例同时写同一个数据目录。

最终填写 `reports/<run-id>/VALIDATION.md`，并提供：

- Runtime `.tgz` 和 `.sha256`。
- Linux Desktop `.AppImage`、`.tar.gz` 与 `desktop-SHA256SUMS`。
- 实际 OS/CPU、源码版本或快照标识、依赖版本、下载源和摘要验证记录。
- 包冒烟、真实包联调、GUI、凭据/沙箱、systemd 与升级恢复的分别结论。
- 未解决问题、复现步骤和日志位置。日志分享前去除令牌、Key、密码和用户正文。

留给后续执行者的明确指令：先读本文件与项目 `AGENT.md`；在本轮独立目录操作，确认真实环境后使用相应架构，不复制 Mac 二进制；失败时保留日志并修复后重跑受影响步骤；凭据、沙箱和实际包联调必须在新目标机器重新验收；未实测项目写“待执行/阻塞”，不得以构建成功代替全部功能完成。
