# Runtime 本地用户系统版本交付验收 · 2026-09-11

构建 ID：`20260911T141836Z`。Runtime 4.7.5；Debian 包版本 4.7.5-1。

同一份工作树快照包含两种压缩逻辑修复、models.dev 能力目录刷新/缓存，以及客户端本地账号与 Runtime 用户 ID 分区协议。源码不是干净 Git 检出，基准和文件摘要记录在交付目录 SOURCE-REVISION.txt / SOURCE-SHA256SUMS。

| 交付物 | 构建环境 | SHA-256 |
| --- | --- | --- |
| agent-harness-runtime-darwin-arm64-4.7.5.tgz | macOS Apple Silicon | `16fa2221228edd995bcfac85cd5d9e53ac7211104fdd4995c8d488ba9c9b6f81` |
| agent-harness-runtime-linux-x64-4.7.5.tgz | Ubuntu 24.04.4 / x86_64 / glibc 2.39 | `5f52180f426ad1d3b46c37c316ff70316231bc744101e3e56df6eebcbd20234c` |
| agent-harness-runtime_4.7.5-1_amd64.deb | 同一 Ubuntu 构建机，由上面的已验证归档生成 | `cf0fa290c704ddd31d27a5f76002292edeec3f1972b09eb529b88ed7ad1a8fbf` |

## 已完成验证

- macOS：全量 372 项通过、2 项平台跳过；类型检查和包构建通过。
- Ubuntu：全量 372 项通过、2 项 macOS 沙箱测试跳过；Linux bubblewrap 测试及真实包中的受限 Bash 通过。
- 两平台归档：包内 Node 24.20.0、Python 3.13.15、原生 SQLite 加载、离线安装、Web 启动和 CLI 检查通过。
- 两平台实际归档功能：本地确定性模型配置、模型请求鉴权、流式事件、受限 Bash、Node/Python、文件下载、联网审批、取消与队列、重启后会话和模型凭据、Memory MCP 持久化通过。
- `.deb`：`dpkg --install` 成功，`/usr/bin/agent-harness-runtime` 入口可运行；从 `/opt/agent-harness-runtime` 再次完成同套完整功能测试。
- `.deb`：`dpkg --verify` 输出为空，卸载成功，测试安装的程序与入口已移除。未替换原有 Runtime 服务；其 current 仍指向先前的 `20260911T020717Z-r2`，原有 health 为 ready。

全量 Linux 回归发现 Skill 测试夹具直接执行宿主 Node 绝对路径，在 bubblewrap 内不可见。夹具改为执行 Skill 自带 Bash 脚本后重跑通过；没有为了测试放宽沙箱。Node/Python 的真实包执行由独立功能脚本验证。该修正仅涉及测试，不改变归档中的 Runtime 实现。

Debian 验证脚本首次把 Python 的启动 shim 传给 ldd，提前退出并自动卸载；改为检查实际 python3.13 ELF 后，完整安装、功能、校验、卸载链路通过。未以首次安装成功代替最终验收。

## 交付与运行

本地交付目录：`release/handoff/20260911T141836Z-runtime/`（macOS tar 包、Ubuntu deb、摘要、README 和日志）。

服务器交付目录：`/home/ubuntu/agent-harness-deploy/artifacts/20260911T141836Z/`（Linux tar 包、deb、摘要与源码快照清单）。

服务器源码：`/home/ubuntu/agent-harness-deploy/builds/20260911T141836Z/src/`。

服务器日志：`/home/ubuntu/agent-harness-deploy/logs/20260911T141836Z/`；最终 Debian 验收日志以 `DEB_INSTALL_FEATURES_INTEGRITY_REMOVE_OK` 结束。

安装方式及主机 bubblewrap/AppArmor 配置见 [Debian Runtime 说明](RUNTIME-DEB.md)。`.deb` 不自动启动服务、不自动修改 AppArmor 策略。账号在客户端创建和校验，Runtime 信任客户端内部用户标识；当前注册入口仅接收账号和密码，不再提供手动关联标识，已有本地账号保留原数据归属。

测试未调用商业模型服务；没有构建 Electron 桌面安装包、Intel Mac 或 Linux ARM 包。
