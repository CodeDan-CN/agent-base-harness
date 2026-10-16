# 研究空白发现 Cloud / Edge MCP 服务器部署

目标：`ubuntu@1.117.229.167`，目录 `/home/ubuntu/research-gap-mcp-services`。

服务使用本地 Docker 中当前运行的 amd64 镜像，通过 SSH 加密传输后导入；版本摘要保存在服务器 `image-manifest.json`。源项目为 `/Users/codedan/local/project/research-gap-mcp-services`，服务器 `source/` 保留源码快照。

## 连接地址

服务器上的 Runtime 使用 Streamable HTTP：

```json
{
  "mcpServers": {
    "research-gap-cloud": { "url": "http://127.0.0.1:3001/mcp" },
    "research-gap-edge": { "url": "http://127.0.0.1:3002/mcp" }
  }
}
```

端口绑定服务器回环地址。Mac 如需访问，先建立 SSH 隧道（使用 13001/13002，避免与本地 Docker 端口冲突）：

```sh
ssh -N -L 13001:127.0.0.1:3001 -L 13002:127.0.0.1:3002 ubuntu@1.117.229.167
```

Mac 客户端使用 `http://127.0.0.1:13001/mcp` 与 `http://127.0.0.1:13002/mcp`。其他 Docker 容器内的 `127.0.0.1` 指向容器本身；如需容器互访，应接入此 Compose 网络并使用服务名。

## 管理

在服务器执行：

```sh
cd /home/ubuntu/research-gap-mcp-services
sudo docker compose -f compose.json ps
sudo docker compose -f compose.json logs --tail=100
sudo docker compose -f compose.json restart
curl --fail http://127.0.0.1:3001/healthz
curl --fail http://127.0.0.1:3002/healthz
```

`restart: unless-stopped` 配合已启用的 Docker 系统服务实现开机恢复。服务以镜像内的 node 用户运行，Docker stdout 日志按 10 MB × 3 轮转。

`cloud-mcp.env` / `edge-mcp.env` 是权限 0600 的配置文件，包含从本地运行容器继承的模型与 Tavily 凭据。勿提交、打印或分享这些文件。此次配置保留本地演示模式；服务器新建独立 SQLite 数据库，不迁移本地历史数据。

持久化卷：`research-gap-mcp-services_edge-data`、`research-gap-mcp-services_edge-logs`、`research-gap-mcp-services_cloud-logs`。JSONL 审计文件保存在日志卷中，未配置应用内轮转，需按需归档。

## 更新与停用

更新前保存现有镜像 ID / 标签和 compose、env 文件，备份 edge-data。导入新版本后运行 `sudo docker compose -f compose.json up -d --wait`，验证健康和工具调用；如失败，恢复先前镜像标签与配置后重新启动。涉及数据库结构变化时同时考虑数据回滚。

只停止这套服务：`sudo docker compose -f compose.json down`。不要添加 `-v`，以保留数据。不要清理机器上其他服务的镜像、容器或数据。

## 2026-09-11 验收结果

- 两个 amd64 镜像导入成功；Docker 导入前后的镜像 ID 因 manifest 表示变化而不同，已逐项核验 RootFS 全部 layer digest 和 Config 完全一致，记录于 `image-content-verification.json`。
- 两个服务 `/healthz` 返回正常，MCP `2026-07-28` 工具发现通过：Cloud 3 个、Edge 4 个。
- Cloud 实际调用 `run_topic_evidence_mapper` 成功，Tavily 返回 1 个来源，DeepSeek 返回结构化报告。运行 ID：`7c24d8f0-c512-40d7-864e-03a14c6a4520`。
- Edge 实际调用 `run_population_gap_detector` 成功，TREM2 演示查询命中 2 条记录并返回结构化报告。运行 ID：`31b6d649-7266-44ae-a4d6-ebdfa6deda96`。另一次无匹配记录的调用也成功返回。
- 两个容器重启后均 healthy，SQLite 的 5 条演示记录、2 条 completed 运行记录和 6 条审计事件保持一致，记录于 `persistence-verification.json`。
- 已配置自动重启，Docker 系统服务已 enabled；没有为验收重启整个宿主机。
- 本轮未修改 Runtime 中用户的 MCP 注册配置；上面的地址可在对应用户设置中添加。
