# Ubuntu 22.04 一键部署 Runtime + Web

在 Ubuntu 22.04 服务器上传完整源码，在项目根目录用有 sudo 权限的普通用户执行：

```bash
bash deployment/ubuntu22.04/deploy.sh --port 14317
```

省略 `--port` 时端口为 4317。监听地址固定为 **0.0.0.0**；成功后访问 `http://服务器IP:14317/`。按需在服务器防火墙和云安全组放行端口。

脚本会安装依赖和 GCC 12、引导下载并校验固定版本 Node、编译 SQLite 原生模块、构建和测试 Runtime + Web，然后备份数据、安装 systemd 服务、检查健康状态并启用开机自启。无需预装 Node/npm，不构建 Desktop。Ubuntu 22.04 不加载 Ubuntu 24.04 的 AppArmor 4.0 策略；bubblewrap 无法启动时会停止并报告问题。

## 上传后出现 Permission denied

源码和构建目录必须能由部署用户写入。若用 root 解压到了 `/opt/software/agent-base-harness`，确认该项目应由当前用户维护后执行：

```bash
sudo chown -R "$(id -u):$(id -g)" -- /opt/software/agent-base-harness
cd /opt/software/agent-base-harness
bash deployment/ubuntu22.04/deploy.sh --port 14317
```

不要改用 `sudo bash`，脚本会拒绝 root 运行。新版脚本在安装依赖前检查源码根目录、构建目录和锁文件的写权限，并给出修复提示。已经安装好的系统依赖会复用，不需要卸载重装。

## Web + Runtime 不安装 Electron

Electron、electron-builder 和 @electron/rebuild 已归属 `apps/desktop` 的开发依赖。部署脚本执行 `npm run install:runtime`，只安装根目录构建工具、Server/Web/CLI 和共享 packages 工作区，再执行 `npm run typecheck:runtime`。不会安装桌面工作区，也不会下载 Electron npm 包、二进制或桌面专属的 node-gyp。

旧版日志中 `codeload.github.com/electron/node-gyp/...` 的错误来自全量安装桌面依赖。**请同步最新完整源码**，尤其是根目录 `package.json`、`package-lock.json`、`tsconfig.runtime.json`、`apps/desktop/package.json` 和 `deployment/`；只替换部署脚本或锁文件不够。以普通用户重新运行原部署命令即可；`npm ci` 会清理旧的工作区依赖后按选定范围安装。

完整桌面开发仍使用 `npm ci` 和 `npm run typecheck`。锁文件仍保留桌面依赖用于全量安装，但 Runtime 安装不会获取这些包。浏览器兼容性数据包 `electron-to-chromium` 可能作为前端工具链依赖存在，它不包含 Electron 程序。

## SQLite 安装时下载 Node 头文件超时

如果错误发生在 `better-sqlite3` 的 `node-gyp rebuild`，并指向 `nodejs.org/.../SHASUMS256.txt` 的 `ETIMEDOUT`，是原生构建工具重复联网下载头文件失败。`build-from-source` / `jobs` 的 npm warning 不是这次退出的原因。

脚本现在使用已下载并通过归档 SHA-256 校验的 Node 安装目录中的 `include/node`。源码依赖使用构建 Node 自带头文件；最终安装包使用包内 Node 自带头文件。缺少头文件时立即报错，不回退到网络下载。相关修复在 `deployment/ubuntu24.04/build-env.sh`、各平台 `package.sh` 和 `build-support/package-platform-runtime.mjs`，需一起同步。

尚未同步修复、且使用本文固定 Node 24.20.0 的 x86_64 服务器，可以临时指定现有头文件后重跑：

```bash
npm_package_config_node_gyp_nodedir="$HOME/agent-harness-deploy/tools/node-v24.20.0-linux-x64" \
  bash deployment/ubuntu22.04/deploy.sh --port 14317
```

此路径必须与当前构建 Node 版本/架构一致；自定义部署根目录需相应替换。新版脚本自动选择路径，不需要手动设置。配置方式见 [node-gyp 官方说明](https://github.com/nodejs/node-gyp#environment-variables)。

## 部署与维护

- 支持入口：Ubuntu **22.04**，x86_64/aarch64。24.04 请用其原有入口。
- 软件源：需启用正常可用的 Jammy main/universe、updates/security（GCC 12 来自相应软件源）。
- 源码需包含 `apps/`、`packages/`、`scripts/`、`tests/`、`build-support/`、`resources/`、`deployment/`、工作区清单及锁文件；不要上传 Mac 的 `node_modules/`。
- 默认部署根目录：`$HOME/agent-harness-deploy`，可用 `AGENT_DEPLOY_ROOT` 覆盖。
- 数据：`data/runtime/`；版本：`releases/`；当前版本链接：`current`；备份：`backups/`；日志：`logs/`。
- 服务名：`agent-harness-web.service`。仅更新由同一入口、同一用户、同一根目录管理的服务。

```bash
sudo systemctl status agent-harness-web --no-pager
sudo journalctl -u agent-harness-web -n 100 --no-pager
sudo systemctl restart agent-harness-web
```

更新时使用同一用户、根目录、数据目录与端口重复执行部署命令。构建和包校验失败不会停止旧服务；切换后的健康检查失败会停止并禁用服务，保留数据与备份，不自动回滚数据库。人工恢复流程见 [备份与恢复](../ubuntu24.04/DEPLOY.md)。

| 参数                               | 用途                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `--dry-run`                        | 只显示流程，可在 Mac 上使用                                              |
| `--port 14317`                     | 指定 1024–65535 的监听端口                                               |
| `--data-dir /绝对路径/data/旧目录` | 保留部署根目录内的既有数据目录                                           |
| `--skip-build`                     | 使用当前版本已验证的包，要求 SHA-256 与 `.ubuntu22.04.json` 来源记录匹配 |
| `--migrate-files`                  | 停服备份后显式迁移旧文件凭据                                             |

只打包：依赖准备后执行 `bash deployment/ubuntu22.04/package.sh`，可加 `--force` 或 `--dry-run`。也提供 `npm run deploy:ubuntu22`、`npm run pack:ubuntu22`。此流程使用 `.tgz` 包，不使用 Ubuntu 24.04 专用 `.deb`。

安装包必须在匹配的 Ubuntu 22.04/CPU 架构上构建并验证，不能复用 Ubuntu 24.04 的原生模块。低内存机器可设置 `npm_config_jobs=1 MAKEFLAGS=-j1`。

## 本地 Docker 验证环境

`Dockerfile.test` 是带 systemd 的测试宿主镜像；实际服务器仍直接执行部署脚本。镜像创建普通 sudo 用户 `deployuser`。以下命令用于专用的本地测试容器，不挂载宿主源码、数据或 Docker socket：

```bash
docker build -t agent-harness-ubuntu22-test:local \
  -f deployment/ubuntu22.04/Dockerfile.test deployment/ubuntu22.04

docker run -d --name agent-harness-ubuntu22-test \
  --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  -p 127.0.0.1:14318:14317 agent-harness-ubuntu22-test:local
```

测试容器的额外权限用于运行真实 systemd 和嵌套 bubblewrap；不作为生产容器权限配置。从项目根目录复制完整构建源码（不包含宿主依赖、数据或密钥），然后执行部署：

```bash
set -o pipefail
COPYFILE_DISABLE=1 tar --no-xattrs --exclude=node_modules --exclude=.DS_Store --exclude=__pycache__ \
  -cf - apps packages scripts tests build-support resources deployment \
  package.json package-lock.json tsconfig*.json vite*.ts vitest.config.mjs eslint.config.mjs \
  | docker exec -i agent-harness-ubuntu22-test tar -xf - -C /home/deployuser/src
docker exec agent-harness-ubuntu22-test chown -R deployuser:deployuser /home/deployuser/src
```

上述 `COPYFILE_DISABLE` / `--no-xattrs` 用于 Mac 复制；Linux 可去掉。随后运行：

```bash
docker exec --user deployuser --workdir /home/deployuser/src \
  agent-harness-ubuntu22-test bash deployment/ubuntu22.04/deploy.sh --port 14317
```

浏览器使用 `http://127.0.0.1:14318/`。Docker Desktop 使用自己的 Linux 内核，容器测试不等同于 Ubuntu 22.04 原生内核/AppArmor 策略验收；ARM64 结果不能冒充 x86_64 结果。实际验证记录见同目录 `VALIDATION-20261015.md`。
