# Runtime 多平台打包入口

## 交付物

| 交付物         | 包含内容                                                                | 平台关系                                  |
| -------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| Runtime 平台包 | Server、Web、管理员 CLI、SDK、Node、Python、Memory MCP、SQLite 原生依赖 | 匹配服务器操作系统和 CPU 架构             |
| Desktop 安装包 | Electron Main/Preload/Renderer                                          | 匹配客户端操作系统/架构，与服务器平台无关 |
| Web            | 浏览器页面，默认随 Runtime 托管                                         | 使用受支持的浏览器，无需安装客户端        |
| Mobile APK     | Android 壳和本地手机页面                                                | 只适用于 Android，不包含 Runtime          |
| 独立 CLI       | 远程客户端                                                              | 需要客户端 Node 环境，通过服务 URL 连接   |

Mac Desktop、Windows Desktop 和 Android APK 可以连接同一台 Ubuntu Runtime，但 Mac `.app/.dmg` 不能作为 Windows 安装包。Linux Desktop 已有独立发行配置和 Ubuntu x64 构建；Windows 桌面发行仍需单独配置与验收。Runtime 菜单不构建 Desktop/APK。

Ubuntu 的日常构建推荐 `npm run pack:ubuntu`；它自动准备锁定 Node、镜像、项目依赖并串联回归、打包和解压包功能验证。`-- --client` 仅打桌面包，`-- --all` 打两类包。首次机器准备见 [Ubuntu 操作步骤](../deployment/ubuntu24.04/RUNBOOK.md#日常一键打包入口)。以下 `pack:runtime` 为通用底层入口，保留交互平台选择和单独打包能力。

## 选择与构建

```bash
npm run pack:runtime
```

选 macOS / Linux / Windows → 选 CPU 架构 → 检查目标支持情况及本机系统/架构 → 串行打包。选错平台会在下载和构建前停止。

```bash
# 在任意开发机只读预览 Linux 流程
npm run pack:runtime -- --target linux-x64 --dry-run

# 在对应系统与 CPU 的构建机实际执行
npm run pack:runtime -- --target linux-x64
npm run pack:runtime -- --target linux-arm64
npm run pack:runtime:macos

# 强制重新准备解释器
npm run pack:runtime -- --target linux-x64 --force

# 在目标机器对已有产物重新验收
node build-support/verify-platform-runtime.mjs --target linux-x64
node build-support/verify-platform-runtime.mjs --target linux-x64 /path/to/runtime.tgz
```

不带 `--target` 的非交互调用会报错。macOS 当前支持 `darwin-arm64`；Linux 已接入 `linux-x64/linux-arm64` 打包代码，其中 x64 已完成 Ubuntu 实机打包，arm64 未实测。Windows 菜单明确报告未实现，不生成产物：还需要 Windows 归档/目录布局、启动器、原生模块构建、凭据/进程适配及 Windows 实机验收。

`scripts/pack-runtime.mjs` 编排以下步骤，并在任一步失败时停止：

1. `runtime-target.mjs` 解析目标并选择固定 Lock。
2. `prepare-runtime-pack.mjs` 下载固定归档、校验 SHA-256，准备 Node/Python/MCP。
3. `verify-runtime-pack.mjs` 验证解释器、npm、pip、架构和 Memory MCP 工具发现。
4. 构建 Server、管理员 CLI、SDK 和 Web 静态资源。
5. `prepare-server-package.mjs` 整理服务目录。
6. `package-platform-runtime.mjs` 用包内 Node 安装生产依赖、验证 SQLite，生成启动器、manifest、`.tgz/.sha256`。
7. `verify-platform-runtime.mjs` 在新目录离线 npm 安装，验证解释器、Python 扩展、SQLite、服务发现、Web 首页、首次注册、未配置模型拦截和正常退出。

`runtime:prepare`、`runtime:verify` 支持 `-- --target ...`；不传目标时采用本机系统和架构。Mac Lock 仍在 `resources/runtime-lock.json`，Linux Lock 在 `resources/runtime-locks/`。产物位于 `release/runtime/<target>/`。

## Linux 下载地址

2026-09-11 已从 Node 官方校验清单和 GitHub 发布 API 核对以下文件名及摘要。Node 优先官方地址，npmmirror 为同文件同摘要的后备源；Python 使用南京大学镜像（原始版本与摘要来自 Astral 发布）。本次服务器 GitHub 直连超时，已实际下载镜像 x64 文件并校验。

| 目标        | 组件                      | 下载地址                                                                                                                                                                                        |
| ----------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| linux-x64   | Node 24.20.0              | [Node GNU/Linux x64](https://nodejs.org/download/release/v24.20.0/node-v24.20.0-linux-x64.tar.xz)                                                                                               |
| linux-arm64 | Node 24.20.0              | [Node GNU/Linux arm64](https://nodejs.org/download/release/v24.20.0/node-v24.20.0-linux-arm64.tar.xz)                                                                                           |
| linux-x64   | Python 3.13.15 / 20260807 | [Python GNU/Linux x64](https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/20260807/cpython-3.13.15%2B20260807-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz)    |
| linux-arm64 | Python 3.13.15 / 20260807 | [Python GNU/Linux arm64](https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/20260807/cpython-3.13.15%2B20260807-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz) |

摘要已写入两份 Linux Lock，来源为 [Node SHASUMS256.txt](https://nodejs.org/download/release/v24.20.0/SHASUMS256.txt) 和 [Python 固定发布 API 的资产 digest](https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/20260807)。选择常规 CPython GNU/Linux 产物，未选择 freethreaded、musl 或更高指令集变体。

Electron 下载配置位于 `deployment/ubuntu24.04/build-env.sh`：Electron 使用 `https://registry.npmmirror.com/-/binary/electron/`，electron-builder 工具使用 `https://registry.npmmirror.com/-/binary/electron-builder-binaries/`。构建前 source 该文件；不改全局 npm registry。切源不改变版本和摘要，也不跳过完整性校验。

## 验证状态与剩余工作

本地已通过目标选择、参数拒绝、架构检查、流程预览和共享库链接处理的 5 项测试；修改文件的 ESLint 检查通过。通过新入口完整构建并验证 macOS arm64 `.tgz`，包含 Web 首页与 Python 扩展的新增检查。Linux x64 的实机结果见 [2026-09-11 报告](../deployment/ubuntu24.04/VALIDATION-20260911.md)；Windows 不在已实现或已验证范围。

Linux 已实现加密持久凭据与 bubblewrap 受限 Bash。安装前按 [Ubuntu 操作步骤](../deployment/ubuntu24.04/RUNBOOK.md) 配置依赖和 AppArmor，执行对应环境的凭据、工具、审批、MCP、SSE 和客户端验收。真实桌面、外部模型与升级恢复结果单独记录。

构建机需要 Node/npm 和构建工具；成品运行使用包内 Node/Python。npm 安装动作仍需要 npm，完全没有 Node/npm 的目标机可直接解压后使用 `bin/agent-harness`，该路径仍须单独验收。

手机暂时只做 APK 可以使用 `npm run pack:mobile`。当前目标是开发签名 APK，正式交付前需要 Android 工具链编译、真机验收和发行签名；Runtime 打包不会自动执行这些步骤。

## CentOS 包能否在 Ubuntu 运行

可能可以，但不能只凭两个系统都是 Linux 就保证兼容。必须匹配 CPU、glibc（不能混用 musl）、libstdc++ 和其他动态库，并在目标机加载 SQLite 原生模块、Python 扩展及实际工具。较旧 glibc 基线构建通常更有利于移植到较新系统；反向移植通常受限，但任何方向仍需验证。旧 CentOS 本身也未必满足当前 Node 的最低要求。

本次明确采用 Ubuntu 24.04.4 原生构建并在同机验收，未验证 CentOS，也不宣称 Ubuntu 更新版本或 Linux arm64 自动通过。若要统一覆盖多个发行版，应另设最低兼容构建基线和逐发行版验收矩阵。
