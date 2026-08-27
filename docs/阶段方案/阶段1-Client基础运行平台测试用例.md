# 阶段 1：Client 基础运行平台测试用例

- 文档状态：待评审
- 所属阶段：阶段 1（Client 基础运行平台落地）
- 更新日期：2026-08-18
- 设计依据：`docs/阶段方案/阶段1-Client基础运行平台开发架构设计.md`

## 1. 测试目的

本文档验证阶段 1 是否建立了可供后续 Runtime 和 Client 产品功能直接复用的正式底座，重点覆盖：

- Electron 四入口和安全边界。
- Runtime Worker 基础生命周期与重连。
- Stage 1 Bridge Contract。
- 双用户可信上下文和 SQLite 字段隔离。
- migration、Repository 和仅追加 EventStore。
- Model/Skill 配置持久化基础。
- 标准 Agent Skills 目录解析。
- Credential、宿主机环境和 ProcessRunner。
- 日志脱敏、健康检查、构建与 CI。

本测试不验证 Agent Turn/Step、模型流、Tool Loop 或运行中任务崩溃恢复。

阶段 1 没有产品 UI 测试。涉及 Renderer 的用例只验证空 React Root、Preload Bridge、安全配置和端到端 Smoke 链路，不验证页面布局、状态展示、用户交互或视觉效果。

## 2. 测试分级

### 2.1 优先级

| 优先级 | 含义                                                           |
| ------ | -------------------------------------------------------------- |
| P0     | 阻断阶段交付；安全边界、数据一致性、用户隔离或应用启动核心路径 |
| P1     | 阶段核心功能；失败会导致后续阶段无法可靠开发                   |
| P2     | 兼容性、诊断和非核心边界；不应长期跳过                         |

### 2.2 测试类型

| 类型        | 说明                                                     |
| ----------- | -------------------------------------------------------- |
| Unit        | 单模块、Fake 依赖、确定性输入输出                        |
| Contract    | IPC、Repository、Schema、错误码和端口契约                |
| Integration | SQLite、文件系统、Credential、ProcessRunner、真实 Worker |
| Security    | 越权、路径、IPC、环境变量和敏感信息负向测试              |
| E2E         | 启动完整 Electron Client 后验证用户可见行为              |
| Build       | 构建、产物边界和基础打包验证                             |

## 3. 测试环境与 Fixture

每个自动化测试使用独立临时目录，不读取或修改开发者真实应用数据：

```text
<temp>/app-data/
  database/app.db
  skills/user-a/
  skills/user-b/
  logs/
  cache/
```

固定 Fixture：

- `FixedClock`：按用例推进 UTC 时间。
- `SequentialIdProvider`：生成可断言 ID。
- `FakeCredentialStore`：内存保存，支持故障注入和访问审计。
- `WorkerFixture`：支持 ready、初始化失败、主动崩溃、启动超时和迟到响应。
- `SkillFixture`：合法 Skill、缺失 frontmatter、名称不一致、带 scripts、越界链接等目录。
- `ProcessFixture`：成功、非零退出、超时、取消、大输出、stderr 和环境变量回显程序。
- `IpcFixture`：合法 sender、非法 sender、旧 generation、大 payload 和 malformed payload。

真实操作系统 Credential Adapter 和 Electron 基础打包测试只在隔离的 CI/测试账户执行，测试结束清理创建的条目。

## 4. 进入与退出条件

### 4.1 进入条件

- 阶段 1 架构设计已评审。
- Stage 1 Schema、错误码和 migration 初稿已合入测试分支。
- 测试命令不会访问生产 app-data。
- Worker、Credential 和 ProcessRunner 都可注入 Fixture。

### 4.2 退出条件

- P0、P1 用例全部通过。
- P2 无阻断性失败，延期项有明确原因和责任阶段。
- 测试无随机重试掩盖的竞态失败。
- 代码覆盖不能代替属性测试和安全负向测试。
- Electron 开发构建、生产构建和基础启动 E2E 通过。

## 5. M01 工程脚手架与构建用例

| ID         | 优先级/类型   | 场景                         | 关键步骤                                   | 预期结果                                                   |
| ---------- | ------------- | ---------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| S1-M01-001 | P0 / Build    | TypeScript strict            | 执行类型检查                               | 四入口及共享代码无类型错误，不允许隐式 `any` 绕过 Contract |
| S1-M01-002 | P0 / Build    | 四入口生产构建               | 构建 Main、Preload、Renderer、Worker       | 四个产物成功生成且入口映射正确                             |
| S1-M01-003 | P0 / Security | Renderer 不包含 Node builtin | 扫描 Renderer bundle 并运行浏览器环境启动  | 不包含 `fs`、`child_process`、SQLite 等 Node 运行依赖      |
| S1-M01-004 | P1 / Build    | reference_ui 不进入产物      | 构建后扫描 source map/asset manifest       | 无 `reference_ui` 源码、Mock 数据和资源依赖                |
| S1-M01-005 | P1 / Build    | 开发启动                     | 启动 Vite 和 Electron 开发模式             | 主窗口可加载，Main/Preload/Worker 使用正式入口             |
| S1-M01-006 | P1 / Build    | 基础打包                     | 执行当前平台 unpacked/package smoke build  | 应用可启动，Worker 与 SQLite 资源路径正确                  |
| S1-M01-007 | P1 / Build    | Lint 和格式                  | 执行静态检查                               | 无阻断错误，生成文件按规则排除而非全局关闭检查             |
| S1-M01-008 | P1 / Security | 构建不含真实密钥             | 在测试环境设置哨兵 secret 后构建并扫描产物 | 产物、source map 和日志中不存在哨兵值                      |

## 6. M02 Electron Shell 与安全用例

| ID         | 优先级/类型   | 场景                       | 关键步骤                                               | 预期结果                                               |
| ---------- | ------------- | -------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| S1-M02-001 | P0 / Security | Renderer 无 Node 权限      | 在 Renderer 尝试访问 `require`、`process` 和 Node 模块 | 均不可用，页面仍正常运行                               |
| S1-M02-002 | P0 / Security | contextIsolation 生效      | 尝试篡改 Preload 内部对象或原型                        | 无法取得 ipcRenderer 或修改受信实现                    |
| S1-M02-003 | P0 / Security | 任意导航被阻止             | 页面请求导航到非允许 URL                               | 导航被拒绝并写安全日志                                 |
| S1-M02-004 | P0 / Security | 任意新窗口被阻止           | 调用 `window.open` 指向外部 URL                        | 不创建未受控 BrowserWindow                             |
| S1-M02-005 | P1 / Security | CSP 生效                   | 注入 inline/remote script Fixture                      | 脚本不执行并产生受控诊断                               |
| S1-M02-006 | P1 / E2E      | ready 前 Renderer Smoke    | 延迟 Worker ready，通过空壳调用 bootstrap              | Bridge 返回 `RUNTIME_NOT_READY`，React Root 保持挂载   |
| S1-M02-007 | P1 / E2E      | Worker 失败 Renderer Smoke | 让 Worker 连续初始化失败并通过空壳查询                 | Bridge 返回 `RUNTIME_UNAVAILABLE`，Renderer 进程不崩溃 |
| S1-M02-008 | P2 / Build    | DevTools 环境限制          | 分别使用开发/生产配置启动                              | 仅开发配置按策略开放 DevTools                          |

## 7. M03 Runtime Worker Supervisor 用例

| ID         | 优先级/类型      | 场景                   | 关键步骤                                     | 预期结果                                              |
| ---------- | ---------------- | ---------------------- | -------------------------------------------- | ----------------------------------------------------- |
| S1-M03-001 | P0 / Integration | 正常启动               | 创建 Worker 并等待 ready                     | 状态 `starting → ready`，generation=1                 |
| S1-M03-002 | P0 / Integration | ready 前请求           | Worker 初始化阻塞时发 query                  | 返回 `RUNTIME_NOT_READY`，Main 不代办业务             |
| S1-M03-003 | P0 / Integration | 异常退出自动重建       | ready 后触发 Worker 崩溃                     | 状态进入 restarting，创建更大 generation 并最终 ready |
| S1-M03-004 | P0 / Contract    | 未完成请求处理         | 请求处理中终止 Worker                        | 请求确定失败为 `RUNTIME_RESTARTED`，不永久 pending    |
| S1-M03-005 | P0 / Security    | 旧 generation 迟到响应 | 新 Worker ready 后发送旧 Worker 响应 Fixture | Main 丢弃旧响应，不转给 Renderer                      |
| S1-M03-006 | P0 / Integration | 重建后数据库可用       | 写入测试记录、重启 Worker、重新查询          | 数据仍存在，新 Worker 正常读取                        |
| S1-M03-007 | P1 / Integration | 启动超时               | Worker 不发送 ready                          | Supervisor 终止该实例并进入重试/failed                |
| S1-M03-008 | P1 / Integration | crash loop 阈值        | 连续触发超过阈值的启动失败                   | 进入 failed，不无限高速重启                           |
| S1-M03-009 | P1 / Integration | 手动重试               | failed 后调用内部重试动作                    | restartAttempt 重置或按策略更新，新 generation 启动   |
| S1-M03-010 | P1 / Integration | 正常关闭               | 应用退出时关闭 Worker                        | 状态 `ready → stopping → stopped`，数据库正确关闭     |
| S1-M03-011 | P1 / Contract    | 生命周期订阅           | 订阅后触发启动、重建和 ready                 | 事件顺序、generation 与状态一致，无重复终态           |
| S1-M03-012 | P1 / Data        | Worker 状态不持久化    | 检查 migration 和 SQLite 表                  | 不存在 worker/generation/restart 状态业务表           |
| S1-M03-013 | P1 / Data        | 不伪造 Agent 恢复事件  | 有测试 Session 时重启 Worker                 | `session_events` 不新增 interrupted/恢复类事件        |
| S1-M03-014 | P2 / Unit        | 退避策略               | 使用 FixedClock 触发多次退出                 | 延迟按有界策略增长且不超过上限                        |

## 8. M04 Bridge 与 IPC 用例

| ID         | 优先级/类型   | 场景                    | 关键步骤                               | 预期结果                                             |
| ---------- | ------------- | ----------------------- | -------------------------------------- | ---------------------------------------------------- |
| S1-M04-001 | P0 / Security | 原始 ipcRenderer 不暴露 | 检查 `window.agentClient` 和全局对象   | 只有白名单 API，无 send/on/invoke 原始引用           |
| S1-M04-002 | P0 / Security | 任意 channel            | 构造未注册 name                        | Preload/Main 拒绝为 `INVALID_REQUEST`                |
| S1-M04-003 | P0 / Security | 非法 sender             | 从未授权 WebContents 调用 IPC          | 返回/记录 `UNAUTHORIZED_SENDER`，Worker 不收到请求   |
| S1-M04-004 | P0 / Contract | malformed payload       | 缺字段、错类型、额外危险字段           | Schema 拒绝，稳定错误格式一致                        |
| S1-M04-005 | P0 / Security | 普通业务伪造 userId     | 在 `app.bootstrap` payload 塞入 userId | 字段被拒绝或忽略，实际 Scope 来自 Main               |
| S1-M04-006 | P0 / Contract | user.switch 合法特例    | 提交另一个内置用户 ID                  | 校验通过，返回新 bootstrap 起点                      |
| S1-M04-007 | P0 / Security | user.switch 隐藏用户    | 提交随机 userId                        | 返回 `USER_NOT_FOUND`，不创建新用户                  |
| S1-M04-008 | P1 / Contract | app.bootstrap Schema    | 调用并验证完整响应                     | 用户、Runtime、Schema 版本和 revisions 符合 Contract |
| S1-M04-009 | P1 / Contract | system.health 脱敏      | 调用 health                            | 无 SQL、密钥、堆栈和默认绝对解释器路径               |
| S1-M04-010 | P1 / Contract | requestId 贯穿          | 发起请求并检查日志/响应                | requestId 一致且不代替 user scope                    |
| S1-M04-011 | P1 / Contract | unsubscribe             | 建立订阅后取消并触发事件               | listener 不再调用，Main/Worker 资源释放              |
| S1-M04-012 | P1 / Security | 超大 payload            | 发送超过上限数据                       | Main 在转发 Worker 前拒绝                            |
| S1-M04-013 | P1 / Contract | Worker 响应 Schema 错误 | Worker Fixture 返回错误形状            | Main 映射 `INTERNAL_ERROR`，不透传脏数据             |
| S1-M04-014 | P2 / Contract | API 版本错误            | 使用不支持 apiVersion                  | 明确拒绝，不使用宽松 fallback                        |

## 9. M05 双用户与 User Context 用例

| ID         | 优先级/类型      | 场景                    | 关键步骤                                  | 预期结果                                                   |
| ---------- | ---------------- | ----------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| S1-M05-001 | P0 / Integration | 首次 seed               | 对空库启动 Worker                         | 恰好创建 user-a、user-b 和各自 revision/settings 行        |
| S1-M05-002 | P0 / Integration | seed 幂等               | 重启多次                                  | 用户和初始化行不重复，固定 ID 不改变                       |
| S1-M05-003 | P0 / Integration | 非法 active_user 修复   | 写入随机 active_user_id 后启动            | 回退 user-a 并修复设置                                     |
| S1-M05-004 | P0 / Security    | Session 跨用户读取      | A 创建 Session，B 使用相同 sessionId 查询 | B 得不到 A 数据                                            |
| S1-M05-005 | P0 / Security    | Model 跨用户引用        | B 默认模型指向 A 的 modelId               | 复合外键/Repository 拒绝，事务回滚                         |
| S1-M05-006 | P0 / Security    | Skill 跨用户可见性      | A 登记 Skill，查询 B Catalog              | B Snapshot 不出现该 Skill                                  |
| S1-M05-007 | P0 / E2E         | 用户切换清理订阅        | Harness 以 A 订阅后切换 B，再发送 A 事件  | A 事件不进入 B 的订阅回调                                  |
| S1-M05-008 | P1 / Integration | 切换持久化              | 切换到 B 后重启应用                       | 当前用户按设置恢复为 B                                     |
| S1-M05-009 | P1 / Security    | Repository 无 Scope API | 静态/类型测试业务 Repository              | 不存在不带 userId 的业务读取入口                           |
| S1-M05-010 | P1 / Security    | 跨用户失败日志          | 触发越权访问                              | Bridge 调用方只得通用错误，安全日志有 requestId 无对方内容 |

## 10. M06 SQLite 与 migration 用例

| ID         | 优先级/类型      | 场景                 | 关键步骤                         | 预期结果                                                         |
| ---------- | ---------------- | -------------------- | -------------------------------- | ---------------------------------------------------------------- |
| S1-M06-001 | P0 / Integration | 空库 migration       | 对不存在数据库启动               | 创建全部 Stage 1 表并记录 migration                              |
| S1-M06-002 | P0 / Integration | migration 幂等       | 在最新库重复启动                 | 不重复执行，不改变业务数据                                       |
| S1-M06-003 | P0 / Integration | checksum 不一致      | 修改已应用 migration checksum    | Worker 不 ready，health 报数据库错误                             |
| S1-M06-004 | P0 / Integration | migration 原子性     | 中途注入 SQL 失败                | 本次 migration 全部回滚，版本不前移                              |
| S1-M06-005 | P0 / Data        | foreign_keys 开启    | 插入不存在用户/跨用户外键        | SQLite 拒绝                                                      |
| S1-M06-006 | P1 / Integration | WAL 模式             | 启动后查询 PRAGMA                | journal_mode 为 WAL                                              |
| S1-M06-007 | P1 / Integration | busy_timeout         | 模拟短写锁竞争                   | 在期限内等待/按稳定错误失败，不永久阻塞                          |
| S1-M06-008 | P0 / Data        | JSON 合法性          | 向 JSON 列写入非法 JSON          | CHECK 或 Repository Schema 拒绝                                  |
| S1-M06-009 | P1 / Security    | Main/Renderer 不开库 | 监控数据库连接来源               | 常规业务连接只由 Worker 创建                                     |
| S1-M06-010 | P1 / Integration | 正常关闭 WAL         | 正常退出 Worker                  | 连接释放，下一实例可正常打开                                     |
| S1-M06-011 | P1 / Contract    | SQL 错误脱敏         | 注入唯一键/约束错误并经过 Bridge | Client 错误不包含 SQL 文本和路径                                 |
| S1-M06-012 | P1 / Data        | 表清单符合阶段       | 读取 sqlite_master               | 不存在 Driver lease、Worker 状态、Skill Manifest/secret 等提前表 |

## 11. M07 Session 与 EventStore 用例

| ID         | 优先级/类型      | 场景              | 关键步骤                       | 预期结果                              |
| ---------- | ---------------- | ----------------- | ------------------------------ | ------------------------------------- |
| S1-M07-001 | P0 / Integration | 创建 Session      | 为 A 创建 Session              | 记录 user_id=A、next_seq=1、version=0 |
| S1-M07-002 | P0 / Integration | 单事件追加        | expectedVersion=0 追加一个事件 | seq=1、version=1、next_seq=2          |
| S1-M07-003 | P0 / Integration | 批量连续追加      | 一次追加三个事件               | seq 连续且同事务提交                  |
| S1-M07-004 | P0 / Integration | 版本冲突          | 使用过期 expectedVersion       | 返回 `REVISION_CONFLICT`，无事件写入  |
| S1-M07-005 | P0 / Integration | 批次中途失败      | 第二个事件违反约束             | 整批和 Session version 全部回滚       |
| S1-M07-006 | P0 / Data        | Event 不可更新    | 通过业务 Repository 尝试修改   | 无该方法；直接保护测试按策略拒绝/检测 |
| S1-M07-007 | P0 / Security    | 跨用户 append     | B 对 A Session append          | 外键/Repository 拒绝                  |
| S1-M07-008 | P1 / Integration | afterSeq 回放     | 写入多事件后分页读取           | 只返回指定 seq 后数据，顺序稳定       |
| S1-M07-009 | P1 / Integration | eventId 幂等冲突  | 同用户重复 event_id            | 唯一约束拒绝且不破坏历史              |
| S1-M07-010 | P1 / Integration | Session 列表隔离  | A/B 各建 Session 后分别列表    | 各用户只看到自身记录                  |
| S1-M07-011 | P1 / Unit        | payload Schema    | 追加非法 payload               | Repository 在 SQL 前拒绝              |
| S1-M07-012 | P1 / Integration | Worker 重启后回放 | 写事件、重启 Worker、读取      | 历史和值完全一致，无额外恢复事件      |

## 12. M08 Model 配置用例

| ID         | 优先级/类型      | 场景                 | 关键步骤                      | 预期结果                                                |
| ---------- | ---------------- | -------------------- | ----------------------------- | ------------------------------------------------------- |
| S1-M08-001 | P0 / Integration | 创建模型服务         | A 创建服务                    | 记录属于 A，model_revision 在事务中递增                 |
| S1-M08-002 | P0 / Security    | 服务隔离             | B 查询 A serviceId            | 不返回 A 数据                                           |
| S1-M08-003 | P0 / Data        | 模型复合外键         | B 模型引用 A service          | 拒绝并回滚                                              |
| S1-M08-004 | P0 / Data        | 默认模型跨用户       | B 设置 A modelId              | 拒绝且 B revision 不变                                  |
| S1-M08-005 | P1 / Integration | 设置默认模型原子性   | 注入 revision 更新失败        | 默认模型和 revision 都不提交                            |
| S1-M08-006 | P1 / Data        | Credential 只存 ref  | 保存哨兵 secret 并检查 SQLite | 数据库只有 ref，没有明文                                |
| S1-M08-007 | P1 / Integration | 归档服务引用保护     | 归档含默认模型服务            | 按 Repository Contract 阻断或清晰归档，不产生悬空默认值 |
| S1-M08-008 | P1 / Contract    | 无真实 Provider 调用 | 运行全部 Stage 1 Model 测试   | 不产生网络请求                                          |

## 13. M09 Skill 目录与配置用例

| ID         | 优先级/类型      | 场景                        | 关键步骤                                       | 预期结果                                        |
| ---------- | ---------------- | --------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| S1-M09-001 | P0 / Integration | 合法标准 Skill              | 放置含 SKILL.md 的目录并扫描                   | 解析 name/description/resource base，记录 valid |
| S1-M09-002 | P0 / Integration | 带辅助目录                  | Skill 含 scripts/references/assets             | 可发现资源存在，但不执行脚本                    |
| S1-M09-003 | P0 / Security    | 扫描阶段零执行              | scripts 放置写哨兵文件脚本并扫描               | 哨兵文件未创建，进程未启动                      |
| S1-M09-004 | P0 / Integration | 缺失 SKILL.md               | 放置普通目录                                   | 不登记为有效 Skill或标记 invalid                |
| S1-M09-005 | P0 / Integration | 缺少 name/description       | 使用不完整 frontmatter                         | 标记 invalid，Catalog 不包含                    |
| S1-M09-006 | P1 / Integration | 名称不一致                  | 目录名和 frontmatter name 不一致               | 按规则标记 invalid，不宽松改名                  |
| S1-M09-007 | P0 / Security    | 根目录越界                  | 通过 `..` 或越界链接引用外部路径               | 校验拒绝，不读取外部内容                        |
| S1-M09-008 | P0 / Security    | 用户 Catalog 隔离           | 同路径只登记给 A                               | B Catalog 不出现 Skill                          |
| S1-M09-009 | P1 / Integration | revision 更新               | 新增、启用、停用 Skill                         | 每次有效配置变更原子递增当前用户 skill_revision |
| S1-M09-010 | P1 / Integration | metadata 兼容               | frontmatter 含 compatibility/metadata/未知字段 | 必填字段正常，已支持扩展保留，未知字段不赋权    |
| S1-M09-011 | P1 / Integration | 内容摘要变化                | 修改 SKILL.md 后重扫                           | content_digest 变化，旧 Snapshot 不被静默改写   |
| S1-M09-012 | P1 / Data        | 无自定义 Manifest 依赖      | 只提供标准 SKILL.md                            | 无 `skill.json` 也能成为 valid                  |
| S1-M09-013 | P1 / Data        | 无提前 Skill secret/tool 表 | 检查 migration                                 | 不存在自定义 Tool Manifest 和 Skill secret 表   |
| S1-M09-014 | P2 / Integration | source_type 预留值          | 写入合法/非法 source_type                      | 合法枚举可存，非法值被约束拒绝                  |

## 14. M10 Credential Store 用例

| ID         | 优先级/类型      | 场景          | 关键步骤                             | 预期结果                                  |
| ---------- | ---------------- | ------------- | ------------------------------------ | ----------------------------------------- |
| S1-M10-001 | P0 / Integration | 写入与读取    | A 写入哨兵 secret 后按 ref 读取      | 只有相同 Scope 可得到原值                 |
| S1-M10-002 | P0 / Security    | 跨用户读取    | B 使用 A ref 读取                    | 拒绝且不 fallback                         |
| S1-M10-003 | P0 / Security    | SQLite 无明文 | 完成写入后扫描数据库                 | 不存在哨兵值                              |
| S1-M10-004 | P0 / Security    | 日志无明文    | 对 set/get/delete 注入错误并扫描日志 | 不存在哨兵值                              |
| S1-M10-005 | P1 / Integration | status 脱敏   | 查询 configured/missing              | 只返回状态，不返回 value                  |
| S1-M10-006 | P1 / Integration | 删除          | 删除后查询/读取                      | status=missing，读取明确失败              |
| S1-M10-007 | P1 / Integration | Store 不可用  | Adapter 注入 unavailable             | health 显示 unavailable，普通错误稳定脱敏 |
| S1-M10-008 | P1 / Integration | 测试清理      | 完成真实平台 Adapter 测试            | 测试命名空间条目全部删除                  |

## 15. M11 宿主环境与 ProcessRunner 用例

| ID         | 优先级/类型      | 场景               | 关键步骤                                 | 预期结果                                                        |
| ---------- | ---------------- | ------------------ | ---------------------------------------- | --------------------------------------------------------------- |
| S1-M11-001 | P0 / Integration | Node 可用探测      | 使用已知 Node Fixture                    | 状态 available，版本可解析                                      |
| S1-M11-002 | P1 / Integration | Python 顺序探测    | python3 缺失、python 可用                | 按顺序回退并返回实际版本                                        |
| S1-M11-003 | P1 / Integration | 解释器全部缺失     | 清空测试 PATH/配置                       | 状态 missing，不阻止 Worker ready                               |
| S1-M11-004 | P1 / Integration | 非零退出           | 运行退出码 Fixture                       | 返回 exitCode、stdout/stderr，不作为 spawn infrastructure crash |
| S1-M11-005 | P0 / Integration | timeout            | 运行超时 Fixture                         | 到时终止进程并返回 timedOut                                     |
| S1-M11-006 | P0 / Integration | AbortSignal 取消   | 启动进程后取消                           | 进程被终止，Promise 确定结束                                    |
| S1-M11-007 | P1 / Integration | stdout/stderr      | Fixture 同时写两路                       | 分别采集且顺序规则明确                                          |
| S1-M11-008 | P1 / Integration | 输出上限           | 产生超大输出                             | 内存结果有界并带 truncated 标记                                 |
| S1-M11-009 | P0 / Security    | 环境变量 allowlist | 父进程设置 secret 哨兵，子进程回显 env   | 哨兵变量未传入                                                  |
| S1-M11-010 | P0 / Security    | cwd 越界           | 请求受控根外 cwd                         | Worker 拒绝，不启动进程                                         |
| S1-M11-011 | P0 / Security    | Renderer 任意执行  | 从 Renderer 尝试调用命令相关 API/channel | API 不存在或被白名单拒绝                                        |
| S1-M11-012 | P1 / Contract    | executable + args  | 参数含空格/特殊字符                      | 作为单独 argv 传递，不进行 shell 拼接                           |
| S1-M11-013 | P1 / Integration | spawn 失败         | executable 不存在                        | 返回稳定 process error，Worker 保持 ready                       |
| S1-M11-014 | P2 / Contract    | health 路径脱敏    | 查询解释器状态                           | 默认不向 Renderer返回绝对 executable 路径                       |

## 16. M12 日志与健康用例

| ID         | 优先级/类型      | 场景               | 关键步骤                           | 预期结果                                        |
| ---------- | ---------------- | ------------------ | ---------------------------------- | ----------------------------------------------- |
| S1-M12-001 | P0 / Contract    | health 完整性      | 正常启动后查询                     | Worker、DB、Credential、Skill、runtime 字段齐全 |
| S1-M12-002 | P0 / Security    | Secret 脱敏        | 在错误、URL、env 注入哨兵 secret   | 日志、IPC、health 均无哨兵值                    |
| S1-M12-003 | P1 / Contract    | request 关联       | 发起 Query 并检查 Main/Worker 日志 | requestId、generation 可关联                    |
| S1-M12-004 | P1 / Contract    | 用户关联           | A/B 分别执行操作                   | 日志 userId 正确且不记录正文数据                |
| S1-M12-005 | P1 / Integration | 数据库错误状态     | 注入 migration/连接失败            | health 显示 error，Worker 不虚假 ready          |
| S1-M12-006 | P1 / Integration | Skill invalidCount | 放入多个非法 Skill                 | health 计数正确，不泄漏外部路径内容             |
| S1-M12-007 | P1 / Integration | 日志轮转边界       | 产生超过阈值日志                   | 文件有界轮转，当前日志仍可写                    |
| S1-M12-008 | P2 / Security    | Client 错误无堆栈  | 触发内部异常                       | Bridge 只有稳定错误；堆栈仅按本地诊断策略保存   |

## 17. 跨模块 E2E 用例

| ID         | 优先级 | 场景             | 操作步骤                                    | 预期结果                                                             |
| ---------- | ------ | ---------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| S1-E2E-001 | P0     | 首次启动完整链路 | 使用空 app-data 启动 Client                 | migration、双用户 seed、Worker ready，空壳 bootstrap/health 调用成功 |
| S1-E2E-002 | P0     | Worker 崩溃重建  | Client ready 后触发 Worker Fixture 崩溃     | 生命周期依次收到 restarting/ready；旧响应被丢弃，数据未丢            |
| S1-E2E-003 | P0     | 双用户切换       | A/B 各准备隔离数据并反复切换                | 活动用户、Snapshot、订阅和 health 上下文一致，无串数据               |
| S1-E2E-004 | P0     | 安全边界检查     | 在 Renderer 执行 Node/IPC/命令/路径攻击脚本 | 所有越权入口不可用或被拒绝，应用继续运行                             |
| S1-E2E-005 | P1     | 环境缺失降级     | 模拟 Python 缺失启动                        | Client 和 Worker仍 ready，health Contract 返回 Python missing        |
| S1-E2E-006 | P1     | 数据持久化       | 写入 Session/Model/Skill 基础数据后重启应用 | 当前用户设置和数据恢复，另一用户仍隔离                               |
| S1-E2E-007 | P1     | 重启不执行 Skill | 安装带写文件脚本的 Skill 后重启             | 脚本从未运行，Catalog 摘要可恢复                                     |
| S1-E2E-008 | P1     | 生产构建启动     | 启动生产构建或 unpacked 包                  | 本地资源、Worker、SQLite、Preload 均可用，无开发服务依赖             |

## 18. 属性与并发测试

### 18.1 EventStore 属性

对随机事件批次和随机失败点验证：

- 成功追加后的 seq 严格连续。
- 失败追加不改变事件数、next_seq 和 version。
- 回放顺序等于提交顺序。
- 任意用户 B 操作不能改变用户 A EventStore。

### 18.2 配置 revision 属性

对 Model/Skill 随机 CRUD 序列验证：

- 成功变更恰好递增对应 revision。
- 失败或冲突不递增 revision。
- model 变更不改变 skill revision，反之亦然。
- 两个用户的 revision 独立。

### 18.3 Worker generation 属性

对随机启动、退出、迟到响应和重试序列验证：

- generation 单调递增。
- 只有当前 generation 可以进入 ready 和响应 Renderer。
- 每个请求最终成功或失败，不永久悬挂。
- failed 状态不会产生无限紧循环重启。

## 19. 非功能测试

| ID         | 优先级 | 指标                | 验收方式                                                   |
| ---------- | ------ | ------------------- | ---------------------------------------------------------- |
| S1-NFR-001 | P1     | 冷启动可诊断        | 每个启动阶段都有状态和超时，不以固定毫秒作为硬验收         |
| S1-NFR-002 | P1     | 数据库事务有界      | 外部 I/O 和 ProcessRunner 期间无开放 SQLite 写事务         |
| S1-NFR-003 | P1     | 输出内存有界        | ProcessRunner 超大输出不会造成无限内存增长                 |
| S1-NFR-004 | P1     | 日志有界            | 日志按配置轮转，不无限占用磁盘                             |
| S1-NFR-005 | P1     | 无随机竞态          | Worker 重建和用户切换测试连续运行多次无 flaky failure      |
| S1-NFR-006 | P2     | Renderer 空壳稳定性 | 空 React Root 可挂载、刷新和卸载，无产品组件与视觉验收要求 |

## 20. 阶段测试报告要求

阶段 1 完成时测试报告至少包含：

- 当前 commit、操作系统、Electron/Node 版本和数据库驱动版本。
- P0/P1/P2 通过、失败和跳过数量。
- migration 版本和表结构校验结果。
- Worker 重建 E2E 和跨用户负向测试结果。
- Renderer 安全边界扫描结果。
- Credential/日志敏感信息扫描结果。
- 生产构建与基础打包验证结果。
- 所有延期用例、原因、风险和进入哪个后续阶段。

阶段 1 只有在全部 P0/P1 通过且不存在已知跨用户、Credential、任意 IPC、任意命令执行或事件原子性问题时才能验收完成。
