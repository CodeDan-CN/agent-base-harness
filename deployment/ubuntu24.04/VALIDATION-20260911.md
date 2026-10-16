# Ubuntu 24.04.4 实机打包与验证记录（2026-09-11）

## 环境与范围

- 机器：Ubuntu 24.04.4 LTS / noble，x86_64，kernel 6.8.0-124-generic，glibc 2.39。
- 资源：4 CPU、约 3.6 GiB RAM、约 1.9 GiB swap，开始时约 21 GB 空闲磁盘。无物理图形桌面，使用 Xvfb。
- 工作区：`/home/ubuntu/agent-harness-deploy/`；run-id：`20260911T020717Z-r2`。
- 源码：开发机未提交工作区快照，基准 commit `578c34d72e4949dee2c5acbf725d76200efc0f92`。包含已有 apps/packages 拆分与本次 Linux 改动，不是该 commit 的干净检出。未提交或推送代码。
- 交付：Runtime 4.7.5（含 Web）；Desktop 0.1.0 / Electron 33.4.11。未构建 Android APK、Windows 或 Linux arm64。
- 系统自带 Node 18 保留；构建使用专用目录中的 Node 24.20.0。Runtime 包使用自身的 Node/Python。

## 下载与依赖

| 组件              | 实际版本/来源                                                      | 结果                                   |
| ----------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Node              | 24.20.0，nodejs.org 官方；Lock 保留 npmmirror 后备                 | 完整下载与固定 SHA-256 通过            |
| Python            | 3.13.15，20260807，南京大学 astral-sh/python-build-standalone 镜像 | 完整下载与上游固定 SHA-256 通过        |
| Electron          | 33.4.11，npmmirror electron                                        | 下载和 npm 包内清单校验通过            |
| AppImage 构建工具 | appimage-12.0.1，npmmirror electron-builder-binaries               | 下载与构建通过                         |
| Memory MCP        | @modelcontextprotocol/server-memory 2026.7.4                       | 固定 npm integrity，工具发现与读写通过 |
| SQLite            | better-sqlite3 13.0.3 / N-API，构建 Node ABI 137                   | Ubuntu 原生构建与实际加载通过          |

本次 GitHub Python/Electron 直连在连接检查中超时，Linux Python Lock 已切换为国内镜像，Electron 环境统一在 `build-env.sh` 设置。未关闭完整性校验，未修改系统全局 npm registry。下载镜像今后仍需在目标机验证，不承诺永久可用。

## 已验证

| 项目                 | 结果与证据                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型与静态检查       | 构建前 `npm run typecheck` 通过；本次修改的 TypeScript/脚本 ESLint 通过；RUNBOOK 22 个 Bash 代码块通过 `bash -n`                                           |
| Linux 回归           | 8 个测试文件、29 项全部通过：Linux 凭据/沙箱、Runtime/服务包、认证、生命周期、Electron 边界、网关和文件上传；`logs/runtime-fixed-build.log`                |
| Runtime 打包         | Linux 原生生成 `.tgz/.sha256`；`logs/runtime-final-build.log` 以 `FIXED_RUNTIME_BUILD_OK` 结束                                                             |
| 离线安装             | 对最终包执行 offline npm install 成功，安装时无需重新构建 SQLite                                                                                           |
| 解压直接运行         | 从交付 tgz 解压到 releases；SQLite `ldd` 无缺失库；实际服务使用包内 Node/Python                                                                            |
| 基础服务             | SQLite 读写、Python ssl/sqlite3/ctypes/venv、Web 首页、服务发现、空账号初始化、未配置模型拦截与正常退出通过                                                |
| 模型与 SSE           | 实际解压包连接本机确定性 OpenAI-compatible 测试服务，配置与鉴权、流式事件通过                                                                              |
| 工具执行             | 受限 Bash 在工作区调用包内 Node/Python，生成产物并经 HTTP 下载通过                                                                                         |
| 权限                 | 工作区写入、凭据目录不可见、越界写入拒绝、默认断网、显式联网审批、取消子进程通过                                                                           |
| 排队与取消           | 取消慢响应后，保留的下一条排队输入继续完成                                                                                                                 |
| 重启持久化           | 同一数据目录重启后重新登录，已有模型凭据仍能通过测试服务鉴权，会话继续使用                                                                                 |
| Memory MCP           | 使用最终包内程序发现工具、写入与读取图谱，重启 MCP 子进程后读回；此项为组件级验证                                                                          |
| 功能脚本             | `logs/final-verification.log` 含 `RUNTIME_FEATURES_OK`；没有使用或消耗商业模型 Key                                                                         |
| Desktop 交付内容     | AppImage、tar.gz 生成成功；纯客户端检查通过，不包含 Server/SQLite/Node/Python/MCP                                                                          |
| Desktop 启动         | linux-unpacked、实际 tar.gz 解压版和实际 AppImage 均在 Xvfb 下打开连接页面；AppImage 使用 FUSE 挂载启动                                                    |
| Chromium 沙箱        | Playwright 显式 `chromiumSandbox: true`，Electron Renderer `sandbox: true`；没有使用 `--no-sandbox`                                                        |
| Web/Desktop/CLI 联调 | 最终修复包通过：Web 刷新登录恢复、AppImage 登录/共享会话/上传、CLI 登录、ZIP 上传与文件下载；`logs/final-verification.log` 以 `FINAL_VERIFICATION_OK` 结束 |
| systemd              | 独立 `agent-harness-test` 启动/重启正常，实例 ID 随重启变化，health ready；未启用开机启动                                                                  |

补充验证发现旧 better-sqlite3 12.6.2 在 Node 24.20 下触发 `RemoveEnvironmentCleanupHook` 原生断言，首次网关集成测试失败。已升级至 13.0.3（N-API），8 个文件 / 29 项重测通过。初版目录 `20260911T020717Z` 的旧 Runtime 不作为最终交付物；最终目录使用 `-r2`。此选择依据 [better-sqlite3 官方发布记录](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0)；源码开发及轻量 Server 的 Node 要求同步改为 22+，自包含 Runtime 仍内置 24.20.0。

## 平台修复

1. Linux Python 入口是符号链接，原 `file` 架构检查发生误判；改为 `file -L`。成功归档加入摘要校验缓存，减少重试下载。
2. Linux 凭据改为 AES-256-GCM 加密文件，0700 目录 / 0600 文件，按引用绑定 AAD；缺失原密钥时拒绝重建，支持独立密钥文件。
3. Linux 受限 Bash 接入 bubblewrap，只挂载系统库、包内解释器和获准工作目录，默认隔离网络；合成父目录只读。
4. 管理员入口内联了 CLI 的自动执行条件，打包后会重复分发 `serve`；拆分 CLI 的库与启动文件，包验证增加错误输出检查与严格正常退出断言。
5. SQLite 升级至 13.0.3；最终 Runtime 移除其他平台预编译二进制，通过包内 node-gyp 强制原生编译并验证加载。
6. Ubuntu AppArmor 用户命名空间限制需要分别配置 bwrap 和 Chromium：安装专用 bwrap 能力收敛策略，以及准确客户端路径的 userns 策略。全局 `kernel.apparmor_restrict_unprivileged_userns=1` 保持启用。

默认凭据密钥与密文存于同机，不能防御已掌握服务系统账号的程序。`full-access` 和可信 stdio MCP 不在受限 Bash 的隔离承诺内。本次未把该部署描述为强多租户隔离产品。

## 交付文件

服务器目录：`/home/ubuntu/agent-harness-deploy/artifacts/20260911T020717Z-r2/`。

本地回传目录：`release/ubuntu24.04/20260911T020717Z-r2/`（二进制不进入 Git）。

| 文件                                             | 约大小  | SHA-256                                                            |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------ |
| agent-harness-runtime-linux-x64-4.7.5.tgz        | 108 MiB | `4362539e351f018f444dac07562b30fd6c345143a5e08add975e0b5371a1598c` |
| agent-harness-client-0.1.0-linux-x86_64.AppImage | 104 MiB | `3df80592a7127910c38c20f531bd0d70f31948536911840dc4923121f93ccbc9` |
| agent-harness-client-0.1.0-linux-x64.tar.gz      | 99 MiB  | `05c168447e3a26ed6ffff196ffc54a20140f5d321c5fbea028d26c066c64dba3` |

三份最终文件已完整回传到本地，逐项 SHA-256 校验全部通过。目录还包含 Runtime `.sha256` 和 `desktop-SHA256SUMS`。已构建包的 UI 无需针对 Ubuntu 重写；Desktop 安装包仍需匹配客户端 OS/CPU，不能把 Linux 包当成 Mac/Windows 包安装。Android APK 独立构建。

Mac arm64 的共享打包链路已同步重建并通过离线安装冒烟；修复后 Mac Runtime SHA-256 为 `c2a66c183db9c477636e9c95d985d2a61921f9772e1b7042791a5223ff726a1f`。Mac 网关/上传/包元数据 9 项回归通过。

## 当前服务与操作入口

- 服务名：`agent-harness-test`；程序：`current -> releases/20260911T020717Z-r2`。
- 数据：`data/service-test`，与各自动化测试临时数据隔离。此常驻实例没有预置账号或模型 Key。
- 监听：`127.0.0.1:14317`。未开放公网端口，未改动机器上的 Docker 或其他应用服务。
- 在本机建立 SSH 隧道后打开 `http://127.0.0.1:14317`；管理员按 RUNBOOK 第 7 节在服务器交互注册账号。
- 继续使用、停服、升级与回滚步骤见 [RUNBOOK](RUNBOOK.md)。systemd 未 enable，重启机器后需手动 start。

## 界面截图

本机 `test-results/ubuntu24.04/20260911T020717Z-r2/` 保存 `linux-web.png` 和 `linux-desktop.png`，已查看中文渲染与附件草稿。截图中“请先在设置中配置并选择默认模型”属于预期拦截测试；模型功能在另一独立临时实例中验证。Desktop 右上角现有“切换服务器”控件与状态区有布局重叠，记录为后续 UI 布局问题，本次没有重写三端 UI。

## 未覆盖项

- 真实 Ubuntu 图形桌面的中文输入法、窗口管理器、文件选择器人工验收。
- 真实外部模型提供商的流式/工具兼容性与计费请求；本次使用确定性本机测试服务。
- 公网 HTTPS/SSE 反向代理、手机跨网络连接；本轮服务只监听回环地址。
- 跨版本数据库迁移后的升级/回滚演练；本轮完成同版本服务重启与持久化。
- Linux arm64、CentOS、Ubuntu 更新版本、Windows、Android APK 构建与设备验收。

构建环境 npm audit 报告现有依赖告警，未执行会批量改动依赖的 audit fix。报告不等于对完整依赖树的安全审计或生产环境认证。

## 追加：一键入口复验

项目新增 `npm run pack:ubuntu`，入口为 `deployment/ubuntu24.04/package.sh`。在同一 Ubuntu 24.04.4 x64 服务器实际执行 `bash deployment/ubuntu24.04/package.sh --all`，正常结束并输出 `UBUNTU_PACKAGE_OK (all)`。

此次复用了专用 tools 目录中已校验的固定 Node 与下载缓存；由新脚本完成 npm ci、类型检查、8 个文件 / 29 项回归、Runtime 平台打包与离线安装、归档摘要、解压包模型/工具/持久化测试，以及 Desktop AppImage/tar.gz 构建、纯客户端检查和摘要生成。Client GUI 仍按 RUNBOOK 第 9 节单独验收。

复验日志：服务器 `/home/ubuntu/agent-harness-deploy/logs/ubuntu-package-20260911T031718Z-1082616.log`。此轮工作产物写入源码目录的 `release/runtime/linux-x64/` 和 `release/desktop-linux/`。本机验证了三种模式的预览、非法参数和错误宿主拦截；更新后的 RUNBOOK 共 24 个 Bash 代码块，语法检查通过。

## 追加：当前工作区 Runtime 重打包（20260911T033701Z-runtime）

按用户要求在 Ubuntu 24.04.4 x64 再次执行 `bash deployment/ubuntu24.04/package.sh`，只重新打包 Runtime＋Web。同步时本地工作区与服务器快照没有新增差异；构建前后核验了 320 个源码、构建配置、资源、测试和部署文件的 SHA-256，均与本次快照一致。Git 基准为 `578c34d72e4949dee2c5acbf725d76200efc0f92`，交付内容包含未提交工作区，不能只凭该 commit 重现。文件摘要保存在服务器 `reports/20260911T033701Z-runtime/source-files.sha256`。

- 类型及工程边界检查通过，8 个测试文件 / 29 项回归通过。
- Runtime 包构建、包内 Node/Python 离线安装冒烟和归档摘要检查通过。
- 解压包功能验证通过：模型配置、鉴权和流式输出、受限 Bash、包内解释器、产物下载、网络审批、取消和队列续跑、重启后的凭据/会话，以及 Memory MCP 读写持久化。
- 最终输出 `RUNTIME_FEATURES_OK` 和 `UBUNTU_PACKAGE_OK (runtime)`，退出码 0。仍使用本机确定性模型服务，未调用外部商业模型。
- 此次没有重打 Desktop/APK，也没有切换 systemd 服务；原 `current -> releases/20260911T020717Z-r2` 服务保持 active，`/healthz` 返回 ready。

产物：`agent-harness-runtime-linux-x64-4.7.5.tgz`，SHA-256：`71482478b472b19004029078c88b14014af9ca9b5e58ac1ea5030c60d933594f`。版本号仍为 4.7.5，用独立运行目录区分本次产物，避免覆盖此前交付归档。

服务器归档目录：`/home/ubuntu/agent-harness-deploy/artifacts/20260911T033701Z-runtime/`；构建日志：`/home/ubuntu/agent-harness-deploy/logs/ubuntu-package-20260911T033702Z-1101898.log`。

安装包和 `.sha256` 已完整回传到本地 `release/ubuntu24.04/20260911T033701Z-runtime/`，本地 `shasum -a 256 -c` 通过。同目录保存 `source-files.sha256` 与 `build-record.json` 供追溯；二进制及这些交付记录不进入 Git。
