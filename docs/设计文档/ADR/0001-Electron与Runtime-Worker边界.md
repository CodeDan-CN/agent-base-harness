# ADR-0001：Electron 与 Runtime Worker 边界

- 状态：Accepted
- 日期：2026-08-18

## 背景

Client 需要 React UI、模型流、工具执行、SQLite、本地文件与操作系统能力。Renderer 不能直接获得 Node 权限，Electron Main 也不应承载长时间 Agent Loop。

## 决策

- 使用 Electron + React + Vite + TypeScript。
- Renderer 只负责 UI。
- Preload 只暴露白名单强类型 Bridge。
- Main 负责窗口、活动用户、sender 校验、系统文件选择和 Worker 监护。
- 独立 Node Runtime Worker 承载应用服务、Runtime、SQLite、Provider/Tool Adapter 和 Projection。

## 理由

- 隔离 Renderer 与本地高权限能力。
- 避免模型、工具和同步短事务阻塞 UI/Main。
- 保持 Runtime/领域 Contract 可测试并可在未来替换 Client Shell。

## 影响

- 必须定义并测试 Main ↔ Worker 生命周期、generation、取消和重启语义。
- 原生 SQLite 依赖和 Worker 打包需要阶段 1 Spike。
- 所有跨进程输入输出必须 Schema 校验。

## 未采用

- Renderer 开启 Node integration。
- Electron Main 直接运行 Agent Loop。
- 第一版同时维护 Web 后端与桌面两套壳。
