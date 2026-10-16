# Protocol

当前协议事实源为 src/contracts 中的 Zod Schema、src/domain 中的公共类型、src/client 中的 Renderer-safe 导出及投影。
保持现有 HTTP /v1/commands、/v1/queries 与 SSE runtime-event 协议；API_VERSION 与 healthz.protocolVersion 用于兼容性检查。

Android 实现时从同一事实源生成对应客户端契约；本次不手工维护第二份 OpenAPI/Kotlin 定义。
此包禁止依赖 Node、Electron、服务器和存储实现。
