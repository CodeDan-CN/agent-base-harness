# Ubuntu 22.04 本地 Docker 验证记录

时间：2026-10-15（Asia/Shanghai）。结论：**ARM64 的 Runtime + Web 一键部署、更新备份及 systemd 自启动通过**。

## 环境

- Docker Desktop 4.56.0 / Engine 29.1.3，Mac ARM64 宿主。
- 基础镜像 `ubuntu:22.04`，拉取摘要 `sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401`。
- 测试镜像 `agent-harness-ubuntu22-test:local`，镜像 ID `665b4c2b74c3386d8c88fa419c4c25ffa01a27c449335715c40534688d74c000`。
- 容器 `agent-harness-ubuntu22-test`；Ubuntu 22.04.5，aarch64，glibc 2.35，systemd 249，GCC 12.3。
- 内核来自 Docker Desktop：`6.12.54-linuxkit`。测试容器使用 privileged/private cgroup namespace 以运行 systemd 和嵌套 bubblewrap，未挂载宿主源码、数据或 Docker socket。
- 源码复制到 `/home/deployuser/src`，所有构建和部署命令以普通 sudo 用户 `deployuser` 执行。
- Runtime 4.7.7，固定 Node 24.20.0 / Python 3.13.15 / Memory MCP 2026.7.4。

## 实际执行与结果

```bash
bash deployment/ubuntu22.04/deploy.sh --port 14317
```

从只有 systemd/sudo 的测试宿主开始，脚本自动安装依赖、引导 Node、编译并安装服务，最终输出 `UBUNTU22_PACKAGE_OK` 和 `DEPLOY_OK`。

| 检查                              | 结果                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| 本地部署脚本回归                  | 21 项通过，覆盖 22.04、既有 Ubuntu 和 CentOS 路径                                              |
| 容器类型检查和工作区边界          | 通过                                                                                           |
| 容器 Runtime/凭据/账号/上传等回归 | 15 个文件，77 项通过                                                                           |
| 固定 Node/Python 和 Memory MCP    | 版本、启动、9 个 MCP 工具验证通过                                                              |
| 安装包验证                        | 解压、独立安装和服务 smoke 通过                                                                |
| 真实 MCP stdio 沙箱集成           | 3 项通过                                                                                       |
| 实际包功能测试                    | `RUNTIME_FEATURES_OK`                                                                          |
| 模型与工具功能                    | 本地模拟 Provider 鉴权/流式响应、受限 Bash、Node/Python、产物下载、网络授权、取消/排队输入通过 |
| 持久化                            | 凭据、模型、会话和 Memory MCP 的服务重启持久化通过                                             |
| Web                               | 宿主访问 HTTP 200，内置浏览器显示登录页                                                        |
| systemd                           | `User=deployuser`、active/running、enabled，监听 `0.0.0.0:14317`                               |
| systemd 用户环境下的 bubblewrap   | transient unit 实际执行通过                                                                    |
| 容器整体重启                      | 服务自动启动，健康端点 ready，测试数据保留                                                     |

附加升级测试：

1. 在部署数据目录创建测试标记文件，记录当前版本链接和服务 PID。
2. 暂时移走 `.ubuntu22.04.json`，执行 `--skip-build`：预期失败，旧版本链接和服务 PID 均不变，旧服务继续 active。
3. 恢复来源记录，执行 `bash deployment/ubuntu22.04/deploy.sh --skip-build --port 14317`：成功切换新 release。
4. 验证当前数据保留标记文件；同次 `COMPLETE` 备份中的 `data.tar.gz` 也包含相同内容。
5. `docker restart agent-harness-ubuntu22-test` 后，Web HTTP 200、Runtime ready，标记文件仍存在。

## 保留的验证产物

容器内：

- 安装包：`/home/deployuser/src/release/runtime/linux-arm64/agent-harness-runtime-linux-arm64-4.7.7.tgz`
- SHA-256：`feaa9e631cc2d28a91223e4c1d45502a2ad1731d0a5859c895d655e87972db89`
- 构建日志：`/home/deployuser/agent-harness-deploy/logs/ubuntu22-package-20261015T005557Z-1992.log`
- 首次部署日志：`/home/deployuser/agent-harness-deploy/logs/deploy-20261015T005557Z-76.log`
- 更新日志：`/home/deployuser/agent-harness-deploy/logs/deploy-20261015T010005Z-3623.log`
- 更新备份：`/home/deployuser/agent-harness-deploy/backups/20261015T010005Z-3623/`
- 来源拒绝日志：`/tmp/ubuntu22-rejected-deploy.log`

测试服务保留运行，宿主访问地址为 <http://127.0.0.1:14318/>。不需要继续运行时：

```bash
docker stop agent-harness-ubuntu22-test
# 后续继续使用；systemd 会自动启动已启用的服务
docker start agent-harness-ubuntu22-test
```

## 验证边界

本次没有验证 x86_64 构建、Ubuntu 原生 5.15 内核或实际服务器的 AppArmor 策略。Docker 特权环境通过不表示普通 Docker 容器也能运行嵌套沙箱。未使用付费外部模型；模型调用测试采用本地确定性 Provider。浏览器只确认了登录页渲染，业务功能由实际包功能测试覆盖。未验证 Desktop、`.deb` 或真实服务器防火墙。

## GitHub 下载失败修复补验

用户 x86_64 服务器日志显示 `npm ci` 因下载 `codeload.github.com/electron/node-gyp/tar.gz/06b29a...` 时 `ECONNRESET` 退出。此前 Node 的国内镜像下载和 SHA-256 已成功。

根目录新增 npm override：`@electron/node-gyp: 10.2.0-electron.2`，锁文件对应条目改用 npm registry tarball 及其 SHA-512。上游提交对比确认，与原 GitHub 提交相比只有包版本号变化。其余锁定包条目未变化。

在既有 Ubuntu 22.04 ARM64 容器中，临时将 `github.com` / `codeload.github.com` 解析到 127.0.0.1，指定全新 npm cache，执行 `npm ci`：32 秒安装 771 个包成功，日志确认 `@electron/node-gyp` 从 registry 获取 HTTP 200/cache miss。随后 node-gyp CLI 版本输出、类型检查以及 77 项 Runtime 回归全部通过。测试结束恢复容器 hosts。日志：`/tmp/agent-harness-npm-no-github.log`。

本次补验覆盖安装路径和回归，未重新执行整包部署或验证 x86_64 实机；原有完整部署结果见上文。服务器应用修复需同时更新根目录 `package.json` 和 `package-lock.json`。

## Web + Runtime 与 Desktop 依赖拆分补验

Electron、electron-builder、@electron/rebuild 从根目录移至 `apps/desktop` 的 devDependencies。新增 `install:runtime`，只选择根目录、Server/Web/CLI 和 packages 工作区；新增 `typecheck:runtime`，排除 Desktop/Mobile 源码。Ubuntu 22.04、CentOS 和 Ubuntu 24.04 的仅 Runtime 分支均使用新入口；Ubuntu 24.04 的 Client/All 保留全量安装。

相对上一轮 node-gyp 修复后的锁文件，本次只改变根目录和 `apps/desktop` 两个工作区条目，已锁定包的版本、下载地址、完整性摘要均未改变。

实际验证：

- Ubuntu 22.04 ARM64 容器指定全新 npm cache，运行完整部署入口。源码依赖安装由 771 个包减少到 473 个包。
- 检查实际 `node_modules/.package-lock.json`：无 Electron、electron-builder、`@electron/*` 或 app-builder-lib，也无 Desktop 工作区链接。HTTP 下载日志中无 Electron/桌面 node-gyp 请求。`electron-to-chromium` 作为前端兼容性数据保留。
- Runtime 类型检查、工作区边界、77 项 Runtime 回归与 3 项真实 MCP 沙箱集成通过；本地 21 项部署脚本回归通过。
- 在另一个隔离目录全量 `npm ci --ignore-scripts` 后，三个桌面工具仍正确安装并提升至根目录，完整类型检查、Desktop Main/Preload/Renderer 构建通过，electron-builder 正确识别 Electron 33.4.11。本轮未下载/启动 Electron 二进制，也未生成桌面安装包。
- 最终安装包功能测试输出 `RUNTIME_FEATURES_OK`，部署输出 `UBUNTU22_PACKAGE_OK` / `DEPLOY_OK`；systemd active/running/enabled，User=deployuser，监听 0.0.0.0:14317，宿主 Web HTTP 200，升级前数据标记保留。备份目录为 `/home/deployuser/agent-harness-deploy/backups/20261015T041246Z-1032/`。
- 安装包 SHA-256：`5fcddbdbf457cec243826c8989b5f5e4477bcaae6ed9ae1f9a29f3d9f7971ef1`。这次输出取代前文列出的旧安装包，历史日志保留。

日志保留在宿主 `/tmp/agent-harness-runtime-only-deploy.log`、`/tmp/agent-harness-desktop-split-check.log`；容器完整部署日志为 `/home/deployuser/agent-harness-deploy/logs/deploy-20261015T041246Z-1032.log`。本轮仍只验证 ARM64，没有验证用户的 x86_64 实机。

服务器使用修复需同步完整最新源码，包含根目录清单与锁文件、`tsconfig.runtime.json`、`apps/desktop/package.json` 和 `deployment/`，再用普通 sudo 用户重跑原部署命令。

## Node 头文件下载超时修复补验

用户 x86_64 主机在 `better-sqlite3@13.0.3` 的 `node-gyp@12.4.0 rebuild` 中获取 `SHASUMS256.txt` 超时。修复后，源码安装使用 SHA-256 校验过的构建 Node 归档自带头文件；最终平台包的安装生命周期和显式 SQLite 重编译均使用包内 Node 头文件。使用 node-gyp 支持的 `npm_package_config_node_gyp_nodedir`，不关闭 TLS 或跳过校验。

Ubuntu 22.04 ARM64 容器以普通用户执行完整部署，同时指定：

```bash
npm_package_config_node_gyp_devdir=/tmp/agent-harness-empty-header-cache-20261015
npm_package_config_node_gyp_dist_url=http://127.0.0.1:9/unreachable
npm_config_foreground_scripts=true
```

前两项使头文件缓存为空、下载地址不可访问。源码 `npm ci` 成功，日志显示本地 `include/node/common.gypi`；最终 SQLite 源编译也成功，检查生成的 `config.gypi` 确认使用平台包内 `runtime/node`。头文件缓存目录未创建。Runtime 类型检查和 77 项回归通过；本地 24 项部署/头文件选择测试通过，包括路径含空格、缺少头文件立即失败、共享环境不会为 Desktop 隐式选择 Node 头文件。

新安装包 SHA-256：`1a81dd3f65712c2faf20243fcff4a0ad60b59ea6d686dc868e94b1e8d20be8e1`，替代前一轮输出。宿主完整日志：`/tmp/agent-harness-local-headers-deploy.log`。测试仍为 ARM64 Docker，不代表已验证用户 x86_64 服务器。

最终验收：3 项真实 MCP 沙箱集成、解压安装包功能测试 `RUNTIME_FEATURES_OK`、`UBUNTU22_PACKAGE_OK` 和 `DEPLOY_OK` 全部通过；HTTP `/healthz` 为 ready，升级前数据标记仍保留。部署日志为 `/home/deployuser/agent-harness-deploy/logs/deploy-20261015T051543Z-2982.log`。
