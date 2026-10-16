# CentOS 一键部署 Runtime + Web

此入口面向 **CentOS Stream 9/10，x86_64 或 aarch64**。普通用户需要 sudo 权限，服务器使用 systemd，BaseOS/AppStream 软件源及 npm、运行时下载地址可访问。无需预装 Node/npm。

**CentOS 7、CentOS Linux 8 和 Stream 8 不在此入口支持范围内。** CentOS 7 的系统 glibc 不满足锁定的官方 Node 24 二进制要求；脚本会在安装依赖前停止，不修改系统 glibc 或替换软件源。版本不明时先执行 `cat /etc/os-release`。

当前完成了本地脚本回归测试；尚未在 CentOS 实机完成构建和部署验收。Ubuntu 的实机结果不作为 CentOS 验收结果。

## 一条命令部署

把完整最新源码上传到服务器，在项目根目录以有 sudo 权限的普通用户执行（不要加 `sudo bash`）：

```bash
bash deployment/centos/deploy.sh
```

指定端口，例如 14317：

```bash
bash deployment/centos/deploy.sh --port 14317
```

成功时输出 `DEPLOY_OK`，访问 `http://服务器IP:4317/`（指定端口时相应替换）。默认监听 **0.0.0.0**。需要在云安全组和服务器防火墙放行所选 TCP 端口；脚本不自动变更这些规则。

源码须包含 `apps/`、`packages/`、`scripts/`、`tests/`、`build-support/`、`resources/`、`deployment/`、npm 工作区清单与锁文件。不要上传其他操作系统的 `node_modules/`。首次构建会下载依赖和解释器，需要预留时间、磁盘和内存。构建并发默认 2，低内存机器可执行：

```bash
npm_config_jobs=1 MAKEFLAGS=-j1 bash deployment/centos/deploy.sh
```

脚本依次：

1. 检查系统、用户、glibc 和部署目录，使用 `dnf` 补齐依赖；GCC 较旧时启用 GCC Toolset 13。
2. 校验 bubblewrap，准备固定版本及 SHA-256 的 Node，安装 npm 依赖，类型检查并运行回归测试。
3. 在目标机编译 SQLite 原生模块，构建 Runtime + Web，解压后验证实际包功能；不构建 Desktop。
4. 校验安装包来源，安装到新版本目录；按需添加限定于本部署目录的 SELinux 文件标签，使用 systemd 执行启动预检查。
5. 停止本脚本管理的旧服务，备份数据和旧 unit，切换新版本，验证 Runtime 实例和 Web 页面，配置开机自启。

构建或启动预检查失败发生在停旧服务之前。脚本不停止其他服务，不覆盖其他用户或其他部署入口创建的同名 unit。

## 目录与日常维护

默认目录：

```text
/opt/agent-harness/
  current -> releases/<version-run>/
  releases/          # 版本程序
  data/runtime/      # 持久业务数据
  backups/<run>/     # 停服数据备份、旧 unit、旧版本指针
  downloads/         # 下载缓存
  tools/             # 构建用 Node
  logs/              # 构建与部署日志
```

`AGENT_DEPLOY_ROOT` 可指定 `/opt/<名称>`（名称只含字母、数字、下划线或连字符）。CentOS 入口不使用 home 目录运行服务，以适配 SELinux；已有部署根目录须归当前部署用户所有。

更新源码后，以同一用户、相同根目录和端口再次执行部署命令。服务名固定为 `agent-harness-web.service`：

```bash
sudo systemctl status agent-harness-web --no-pager
sudo journalctl -u agent-harness-web -n 100 --no-pager
sudo systemctl restart agent-harness-web
```

其他参数：

| 参数                                        | 用途                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `--dry-run`                                 | 只显示流程，不安装或修改服务，可在本地预览                                                          |
| `--data-dir /opt/agent-harness/data/旧目录` | 保留同一部署根目录内的既有数据；每次升级使用相同参数                                                |
| `--migrate-files`                           | 备份后显式迁移旧文件凭据；常规升级不需要                                                            |
| `--skip-build`                              | 使用已经验证的 CentOS 包；必须附带匹配的 `.tgz.centos.json`，系统大版本、架构、glibc 和包摘要须一致 |

只打包、不部署：宿主依赖已准备后执行 `bash deployment/centos/package.sh`。可选 `--force` 重新准备运行时资源，或 `--dry-run` 预览。也提供 `npm run deploy:centos` 和 `npm run pack:centos` 入口。

不要直接使用 Ubuntu 机器生成的归档；其原生模块可能依赖更高版本的系统库。不要并发运行底层打包命令操作同一源码目录。

## SELinux 与失败处理

脚本保留 SELinux 状态，为本部署的 `releases/` 和 `data/` 分别配置持久的 `bin_t`、`var_lib_t` 文件标签，并执行 `restorecon`。已有冲突的本地标签规则会报错，不会静默覆盖。自定义安全策略仍可能阻止运行，查看：

```bash
sudo ausearch -m AVC -ts recent
sysctl user.max_user_namespaces
```

不要通过关闭 SELinux 来跳过失败检查。服务启动预检查使用实际 systemd 用户环境；包功能测试也移除 GCC Toolset 的动态库路径，避免只能在构建终端运行的问题。

切换后若健康检查失败，服务会停止并禁用，保留当前数据、新版本和停服备份。不会把已经迁移的数据直接交给旧程序。先查看部署日志和 journal；需要回退时按 [备份与人工恢复步骤](../ubuntu24.04/DEPLOY.md) 将旧版本指针与同次备份数据一起恢复，路径改为 `/opt/agent-harness`。只有包含 `COMPLETE` 的备份可用于恢复；恢复前再次保存当前数据。

平台要求参考 [Node 24 构建说明](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list)、[CentOS Stream 9](https://www.centos.org/stream9/) 和 [CentOS Stream 10](https://www.centos.org/centos10/)。
