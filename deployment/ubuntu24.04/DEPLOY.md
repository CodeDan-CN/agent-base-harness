# Ubuntu Runtime + Web 一键部署

适用范围：Ubuntu 24.04+，x86_64 或 arm64，使用 systemd；仓库已有的真实平台验收是 Ubuntu 24.04.4 x86_64。
完整源码由用户自行上传。以有 sudo 权限的普通用户执行，不能在整个脚本前加 sudo，也不使用 root 构建和运行服务。
默认只构建 Runtime + Web，不构建 Desktop。2026-10-14 已在 Ubuntu 24.04.4 x86_64 验证环境准备、真实打包、凭据迁移、systemd 安装与重启。
该次从旧服务迁入，先完成 `package.sh`，再用 `deploy.sh --skip-build` 切换；具体服务器部署记录保存在本地，不纳入版本控制。

## 执行

在上传后的项目根目录运行：

```bash
bash deployment/ubuntu24.04/deploy.sh
```

需要系统权限时会提示输入 sudo 密码。首次安装不要求预装 Node/npm。
脚本成功输出 `DEPLOY_OK`，浏览器访问 `http://服务器IP:4317/`，在 Web 设置中配置模型服务、凭据和模型。
该入口默认监听 **0.0.0.0:4317**，不需要 SSH 隧道。

可选参数：

```bash
# 预览，不安装、不写文件、不启动服务；也可以在 Mac 运行。
bash deployment/ubuntu24.04/deploy.sh --dry-run

# 使用其他非特权端口（1024–65535）。
bash deployment/ubuntu24.04/deploy.sh --port 8080

# 自定义部署目录；首次部署和后续更新必须使用同一个目录、同一个用户。
AGENT_DEPLOY_ROOT=/home/ubuntu/agent-harness-deploy \
  bash deployment/ubuntu24.04/deploy.sh

# 已有 npm 时的等价入口。
npm run deploy:ubuntu

# 迁入已有安装时保留原数据路径和端口。
bash deployment/ubuntu24.04/deploy.sh --port 14317 \
  --data-dir "$HOME/agent-harness-deploy/data/service-test" --migrate-files

# 已在同一源码目录成功执行 package.sh 时可省略重复构建；仍会校验包摘要。
bash deployment/ubuntu24.04/deploy.sh --skip-build
```

部署目录仅接受绝对路径和英文字母、数字、下划线、连字符、点及斜线；不接受空格或 systemd 特殊字符。
服务名固定为 `agent-harness-web.service`，同机多实例不属于此入口范围。

## 自动执行的步骤

1. 确认 Ubuntu、systemd 和普通用户；按需安装构建工具、Python、bubblewrap、AppArmor 等 apt 依赖。
2. 测试 bwrap。失败且没有冲突策略时，安装仓库提供的 AppArmor 配置再验证；已有其他策略或本地修改时明确停止，不覆盖。
3. 锁定部署目录，检查已有服务归属。调用 `package.sh` 完成 Node 引导、依赖安装、类型检查、回归、Runtime/Web 打包和实际包功能验证。
4. 校验归档 SHA-256，解压到新版本目录，检查启动器/Web 文件，并通过 `systemd-analyze verify` 校验服务配置。
5. 停止本入口管理的旧服务，检查数据锁和端口，将完整数据目录、旧服务文件及旧版本路径保存到备份目录。
6. 原子切换 `current`，安装/启动服务；检查 systemd PID、Runtime discovery、健康接口的实例一致性及 Web 首页，再启用开机自启。

构建或归档验证失败时，旧服务继续运行。切换阶段失败时服务停止并禁用开机自启，保留现有数据、新旧程序与备份。
不自动启动旧版本，因为新程序可能已迁移数据库，单独回退程序不保证兼容。

脚本不修改 UFW、防火墙或云安全组。需要部署者允许预期客户端访问选定的 TCP 端口。
当前 Runtime 信任客户端声明的身份；公网开放时应在入口配置鉴权和 HTTPS，Web 本地登录不是服务端鉴权。

## 目录与服务

默认部署目录是当前用户的 `$HOME/agent-harness-deploy`，可以与源码目录分开：

```text
agent-harness-deploy/
  releases/<版本>-<时间>-<进程号>/   每次使用全新目录
  current -> releases/...          当前程序
  data/runtime/                   固定的数据库、凭据、工作区及 MCP 数据目录
  backups/<时间>-<进程号>/
    COMPLETE                      仅备份全部完成后生成
    data.tar.gz                   旧数据存在时生成；包含 SQLite、WAL 及其他资源
    agent-harness-web.service     旧服务存在时生成
    previous-release.txt          旧 current 存在时生成
  logs/deploy-*.log                部署日志
  logs/ubuntu-package-*.log        构建日志
```

数据和备份包含 API Key，应保留目录权限。脚本采用 `umask 077`，Runtime 数据目录为 0700，服务同样采用 `UMask=0077`。
旧版本和备份不自动清理，更新前需预留完整数据备份和新程序所需磁盘空间。

```bash
sudo systemctl status agent-harness-web --no-pager
sudo journalctl -u agent-harness-web -n 100 --no-pager
sudo journalctl -u agent-harness-web -f
sudo systemctl restart agent-harness-web
sudo systemctl stop agent-harness-web
curl --fail http://127.0.0.1:4317/healthz
```

## 后续更新与已有手工部署

上传新源码后，以同一用户、同一 `AGENT_DEPLOY_ROOT` 再运行同一命令。
自定义端口时每次都传 `--port`；省略会使用 4317。使用 `--data-dir` 时后续也传同一路径；已有服务与目标数据路径不一致会停止。
`--data-dir` 必须位于本部署目录的 `data/` 内。不要同时运行独立打包命令，或让其他 Runtime 打开同一个数据目录。

入口只更新带有自身管理标记且目录和用户匹配的服务。已有手工创建的同名服务、其他位置的 unit、服务 drop-in 或 masked unit 时会停止，避免误覆盖。
从前文手工部署迁入时，先备份并核对旧 unit 的 `User`、程序目录和 `--data-dir`，停止并禁用旧服务，
将旧 unit 移到备份位置后执行 `systemctl daemon-reload`，再运行本入口。
数据目录不同的安装必须先在停服后迁移完整数据；脚本不会猜测或自动迁移其他服务的数据。

4.7.6 等使用旧加密凭据文件的安装，可显式加 `--migrate-files`。脚本在停服、完整备份之后，
使用新包执行 `credentials migrate-files --data-dir 原数据目录`；迁移失败不切换版本、不启动新服务。
不传该选项时不会读取旧凭据文件。迁移步骤与自定义主密钥说明见 [凭据存储与迁移](../../docs/Runtime凭据存储与迁移.md)。

## 失败恢复

先看日志定位失败阶段。首次安装在切换前失败时，修正环境后可以直接重跑。
如果输出提示服务已停止/禁用，先检查备份是否有 `COMPLETE`；`.partial` 文件不是可用的完整备份。

要恢复升级前版本，选择该次更新的完整备份。以下操作会恢复旧数据，将失败版本产生的数据另存，不直接删除：

```bash
export AGENT_DEPLOY_ROOT="$HOME/agent-harness-deploy"
# 替换为本次失败更新打印的实际备份目录。
AGENT_BACKUP="$AGENT_DEPLOY_ROOT/backups/实际时间-进程号"

test -f "$AGENT_BACKUP/COMPLETE"
test -f "$AGENT_BACKUP/data.tar.gz"
test -f "$AGENT_BACKUP/previous-release.txt"
test -f "$AGENT_BACKUP/agent-harness-web.service"
```

上面的检查全部成功后再执行：

```bash
sudo systemctl stop agent-harness-web
AGENT_OLD_RELEASE="$(cat "$AGENT_BACKUP/previous-release.txt")"
test -x "$AGENT_OLD_RELEASE/bin/agent-harness"

mv "$AGENT_DEPLOY_ROOT/data/runtime" \
  "$AGENT_DEPLOY_ROOT/data/failed-$(date +%Y%m%d-%H%M%S)"
install -d -m 0700 "$AGENT_DEPLOY_ROOT/data/runtime"
tar -xzf "$AGENT_BACKUP/data.tar.gz" -C "$AGENT_DEPLOY_ROOT/data/runtime"

ln -s "$AGENT_OLD_RELEASE" "$AGENT_DEPLOY_ROOT/.restore-current"
mv -Tf "$AGENT_DEPLOY_ROOT/.restore-current" "$AGENT_DEPLOY_ROOT/current"
sudo install -m 0644 "$AGENT_BACKUP/agent-harness-web.service" \
  /etc/systemd/system/agent-harness-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-harness-web
sudo systemctl status agent-harness-web --no-pager
```

用旧服务对应端口检查 `/healthz` 和 Web。恢复流程只适用于有完整旧数据、旧程序和旧 unit 的更新备份。
尚未完成备份的失败需根据日志确认停服/切换位置；不要用不完整备份覆盖当前数据。

## 设计和验证边界

`deploy.sh` 负责部署编排，`package.sh` 仍只负责构建和验证，Runtime 业务语义保持不变。
部署按“准备与构建 → 停服备份 → 可选凭据迁移 → 切换与验收”执行，通过独立版本目录、部署锁、服务归属检查和固定数据目录避免覆盖其他应用。
生命周期测试使用临时目录和替代的系统命令，覆盖首次安装、重复更新、构建/校验失败、启动验收失败、服务归属冲突和运行中的数据锁。

```bash
bash -n deployment/ubuntu24.04/deploy.sh
bash deployment/ubuntu24.04/deploy.sh --dry-run
node node_modules/vitest/vitest.mjs run tests/unit/ubuntu-deploy.test.mjs
```

隔离测试不替代目标机验收。2026-10-14 的实机结果见部署报告；其他机器首次执行后仍应检查真实模型请求、Bash、Memory MCP、文件上传下载，以及重启后的数据和凭据可用性。
