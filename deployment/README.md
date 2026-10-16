# 部署与发行验证

Ubuntu 22.04 的 Runtime + Web：`bash deployment/ubuntu22.04/deploy.sh`，默认 **0.0.0.0:4317**，见 [22.04 一键部署说明](ubuntu22.04/README.md)。

这里集中维护目标机器操作步骤、部署配置及验收模板。构建逻辑继续复用仓库的 `scripts/`、`build-support/`；生产源码仍位于 `apps/` 和 `packages/`。

本轮目标是用户提供的 **Ubuntu 24.04.4 LTS（noble）**，已确认 x86_64 和 SSH 连接。本轮交付范围为 Linux Runtime＋Web、Linux Electron Desktop。手机 APK 和 Windows 打包不在本轮范围内。

CentOS Stream 9/10 的 Runtime + Web 使用独立入口：`bash deployment/centos/deploy.sh`。
默认 `/opt/agent-harness`、`0.0.0.0:4317`，依赖由 dnf 准备；详见 [CentOS 一键部署说明](centos/README.md)。CentOS 7/8 不支持；CentOS 实机验收仍待完成。

Ubuntu 从 [Ubuntu 24.04 详细操作步骤](ubuntu24.04/RUNBOOK.md) 开始。

源码上传到新服务器后，只部署 Runtime + Web 可直接执行 `bash deployment/ubuntu24.04/deploy.sh`。
该入口准备系统依赖、复用打包验证、安装版本、备份数据并配置 systemd 开机自启，默认监听 **0.0.0.0:4317**。
首次部署、更新及失败恢复见 [一键部署说明](ubuntu24.04/DEPLOY.md)。原 `package.sh` 继续只负责打包。

```text
deployment/
  README.md
  ubuntu24.04/
    RUNBOOK.md                    # 从环境准备到打包、运行、验收、回滚
    package.sh                    # 已固化的 Ubuntu 一键打包流程
    deploy.sh                     # Runtime + Web 一键部署（含首次环境准备和 systemd）
    DEPLOY.md                     # 一键部署参数、数据备份与恢复
    VALIDATION.md                 # 验收报告模板
    VALIDATION-20260911.md         # 本次实机结果
    build-env.sh                  # 国内镜像与构建缓存
    bwrap-userns-restrict.apparmor # Ubuntu 受限工具策略
    install-client-userns.sh       # 按准确程序路径配置 Chromium userns 权限
    electron-builder.linux.json   # Linux Desktop 专用配置
    agent-harness-test.service    # 独立测试服务模板，不自动安装
```

服务器独立工作区约定为 `/home/ubuntu/agent-harness-deploy/`，完整结构见操作步骤。仓库保存说明与配置；服务器上的下载缓存、安装包、日志、用户数据、账号和密钥不进入 Git。

现有背景资料：[平台打包入口与下载地址](../docs/Runtime多平台打包入口.md)、[Ubuntu 适配设计](../docs/Ubuntu24.04及以上Runtime打包部署与三端UI影响说明.md)。代码和本文的实际验证记录优先于历史方案中“拟新增”的描述。

日常构建入口：`npm run pack:ubuntu`（Runtime＋Web），或 `npm run pack:ubuntu -- --all`（包含 Linux Desktop）。首次依赖配置和命令边界见 RUNBOOK 的“一键打包入口”。
