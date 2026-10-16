# Runtime 凭据存储与迁移

2026-09-14 起，模型和 MCP 的 API Key 统一由 Runtime 自己管理，macOS、Ubuntu/Linux、Windows 使用同一个 `SqliteCredentialStore`。本次选择明文 SQLite 存储，不创建独立加密文件、主密钥，也不在日常运行中调用系统钥匙串。

## 保存与读取

- 数据库：`<data-dir>/database/app.db`，新增 schema migration 16。
- `credential_secrets` 表按 `credential_ref` 保存真实密钥；模型/MCP 业务表继续保存原引用，无需改变客户端契约。
- 引用包含应用命名空间、userId、用途和实体 ID，不同用户、模型与 MCP 的凭据不会互相回退。
- 保存、替换、清除和实际调用均只访问 SQLite。旧 `useSystemCredential` 参数已废弃并忽略；测试需要替身时显式注入 `credentialStore`。
- 管理快照只检查业务表中的引用，凭据库访问次数为零。“已保存凭据”不保证密钥仍存在或连接成功，连接测试结果单独表达。
- 密钥不进入客户端响应、日志、事件或诊断。数据库、WAL 和数据库备份本身包含明文密钥，不作为普通诊断附件分享。

## 旧安装升级

默认启动不会读取旧钥匙串或加密文件，也不会自动迁移。已有引用但尚未迁移的密钥无法用于需要认证的调用，可以执行以下迁移，也可以在设置中重新输入并保存 API Key。

先停止拥有该数据目录的 Runtime，备份数据和旧凭据。迁移命令通过目录锁防止与正在运行的服务并发写入。

macOS 旧钥匙串：在原 macOS 系统账号上执行一次，只有这条显式命令会访问 `/usr/bin/security`。

```sh
node dist/admin/index.cjs credentials migrate-keychain --data-dir "/path/to/runtime-data"
```

旧 Linux 加密文件（以及使用过相同文件格式的安装）：

```sh
node dist/admin/index.cjs credentials migrate-files --data-dir "/path/to/runtime-data"
```

如果原加密文件使用了自定义主密钥，迁移时继续设置原来的 `AGENT_HARNESS_CREDENTIAL_KEY_FILE`。迁移完成后的日常 Runtime 不再使用该变量。

安装包内可用 `agent-harness credentials migrate-keychain|migrate-files --data-dir PATH`；上面的源码构建入口通过 `node scripts/build.mjs admin` 生成。

命令返回 `migrated`、`skipped`、`missing`、`failed` 数量，不输出密钥。`missing` 或 `failed` 非零时退出码为 1；钥匙串不存在或不可读取均可能计入 `missing`。修复来源或在设置中重新保存后可重试。

迁移覆盖模型、MCP 和归档配置；保持引用不变，写入后读回核验，已有 SQLite 密钥不覆盖，旧钥匙串/文件不删除。重复执行会跳过已迁移项。迁移会升级数据库，因此回退旧版本应恢复升级前数据库备份。

Windows 新安装直接使用 SQLite。若从 macOS 搬到 Windows，先在原 macOS 上迁移钥匙串，再停止服务并搬迁数据库；旧加密文件则应连同原主密钥保留到迁移完成。正常备份应使用 SQLite 备份机制，或在 Runtime 停止并关闭连接后复制数据库，避免遗漏仍在 WAL 中的数据。

## 验证范围

回归测试覆盖保存与重启读取、用户/用途隔离、替换和删除、快照零访问、旧存储零调用，以及迁移保留原值、失败重试、目录锁和旧加密格式。跨平台共用同一代码路径；Windows 和 Ubuntu 的原生安装包仍需在对应系统验收。
